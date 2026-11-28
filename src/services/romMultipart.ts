/**
 * 大文件分片上传 + 断点续传（后台专用）。
 *
 * ## 为什么存在
 *
 * 后台传 100MB 的游戏时，报的错是「网络错误：无法连接 Worker（检查地址与 CORS）」——
 * 但 Worker 是好的。原因可能是 **Cloudflare 的请求体上限在 Worker 前按站点套餐执行**，
 * 也可能是上行连接被中间网络重置；这两种情况都可能没有 Worker 日志。Cloudflare 当前文档列出
 * Free / Pro 100 MB、Business 200 MB、Enterprise 可自助调至 5 GB，超限响应为 413；
 * 不能把所有无响应 / `onerror` 都断言成超限。分片上传把单请求限制在 8 MiB，也让失败只需重传一片。
 *
 * 另一半原因是单发 PUT 本身太脆：国内上行几百 KB/s ~ 几 MB/s，100MB 要占用一条连接好几分钟，
 * 中间任何一次 TCP reset / Wi-Fi 切换 / 代理超时，整个 100MB 从 0 重来。这解释了「有的时候」。
 *
 * 分片把这两件事一起解决：上限按**单个请求**算，8MB 一片离上限很远；断了只重传那一片。
 *
 * ## 账本记在哪
 *
 * R2 的 Workers binding 没有 listParts，complete 时必须由调用方把每一片的
 * {partNumber, etag} 全部报回来。所以「传到哪了」这份账只能记在这边（localStorage）：
 *   - uploadId 和已传分片本身活在 R2 里，跨刷新、跨 Worker 冷启动都在
 *   - 但换浏览器 / 清了站点数据就续不上了，只能重开一次（残留分片由「ROM 存储」页清理）
 *
 * ## 续传的前提：文件身份必须对得上
 *
 * 恢复时先用文件名、字节数、lastModified 和分片大小找回候选会话，再逐片核对完整分片摘要。
 * 只凭头 / 中 / 尾样本无法证明中间字节相同；漏掉逐片核验会把两版镜像静默拼成损坏对象。
 */
import { encodeKey, explainRomStatus, getRomApi, getRomToken, guessUploadType, romUrlForKey } from './roms'
import type { UploadProgress, UploadResult } from './roms'
import { fingerprintRomPart, fingerprintRomUploadFile } from './romFingerprint'
import { isIntegrityKey, type RomIntegrityManifestPayload } from './romIntegrityData'

/**
 * 一片 8MB。R2 的约束是「除最后一片外所有片必须等大，且不小于 5MB，最多 10000 片」，
 * 所以这个值一旦改了，**旧的续传记录就作废**（下面的身份校验会带上 partSize，自动作废）。
 */
export const PART_SIZE = 8 * 1024 * 1024
/**
 * HTTP/2 下多条大 PUT 共用一条连接，边缘或中间网络重置连接时会让多片同时失败。
 * 首片单路取得真实上行样本，再选择 1–4 路；失败自动降为单路并逐档恢复到本次测速上限。
 */
const INITIAL_CONCURRENCY = 1
const MAX_CONCURRENCY = 4
/** 常规首片传到 1 MiB 且至少观测 250 ms 后才试探性放开第二路，避免把浏览器缓冲突发当成真实上行。 */
const EARLY_SAMPLE_BYTES = 1024 * 1024
const EARLY_SAMPLE_MIN_MS = 250
const EARLY_SAMPLE_MAX_CONCURRENCY = 2
/** 有同 Worker 的近期成功测速时，减半首片观察量；仍先单路发出，避免首片鉴权失败时多传一片。 */
const WARM_UPLOAD_TTL_MS = 10 * 60 * 1000
const WARM_UPLOAD_SAMPLE_BYTES = 512 * 1024
/** 单片重试次数（含首次）。连接级重置需要给浏览器足够时间重建 HTTP/2 会话。 */
const ATTEMPTS = 5
const RECOVERY_SUCCESS_PARTS = 4
const MAX_PARTS = 10000

const STORE_KEY = '8bitgo.rom.multipart'
const CREATE_REQUEST_STORE_KEY = `${STORE_KEY}.create-request`
/** 一周没动过的记录直接丢：那个 uploadId 大概率早就被 R2 清了，留着只会误导 */
const STORE_TTL = 7 * 24 * 60 * 60 * 1000
const STORE_MAX = 20
/** 留空间给站点其它状态；多个大文件的分片账本不能把单个 localStorage 配额吃满后整笔写失败。 */
const STORE_MAX_CHARS = 1_500_000
/** 大文件每片都同步序列化整份续传账本会形成平方级主线程开销；短批次最多丢四片账本，远端可安全覆写重传。 */
const PART_STATE_SAVE_INTERVAL_MS = 1_000
const PART_STATE_SAVE_MAX_DIRTY_PARTS = 4
/** 控制请求只传少量 JSON；无进展超过一分钟通常是线路已断，不能让后台页永久转圈。 */
export const WORKER_REQUEST_TIMEOUT_MS = 60_000
/** Cloudflare 5xx 的最大 Retry-After；防止错误响应把后台上传无限期挂起。 */
const MAX_RETRY_AFTER_MS = 120_000

export interface PendingUpload {
  /** 最终对象 key */
  key: string
  uploadId: string
  /** Worker 那边的标记对象，用来在「ROM 存储」页列出残留 */
  marker: string
  partSize: number
  fileName: string
  fileSize: number
  lastModified: number
  /** 取头、中、尾各 64 KiB 的 SHA-256，用于找回同一会话；是否复用远端片另由完整分片摘要决定。 */
  fileFingerprint: string
  /** Worker 创建会话的幂等 ID；响应丢失后可用它取回同一 uploadId。 */
  requestId?: string
  /** 与创建参数绑定的签名；完成响应不确定时只认同一代对象。 */
  requestSignature?: string
  /** Worker 明确支持后，把分片号放请求头，所有分片共用一个 URL 以复用浏览器 CORS 预检缓存。 */
  partNumberInHeader?: boolean
  contentType?: string
  /** 只有浏览器已核对本地内容后才允许续传复用；无版本号按旧 v1 核验，清单路径使用 v2。 */
  parts: { partNumber: number; etag: string; contentHash?: string; contentHashVersion?: 1 | 2 }[]
  updatedAt: number
}

interface WarmUploadProfile {
  apiOrigin: string
  concurrency: number
  measuredMbps: number
  at: number
}

/** 仅保存在当前页内存：网络切换 / 刷新自然失效，不把管理员的上行情况写进持久存储。 */
let warmUploadProfile: WarmUploadProfile | null = null

function uploadApiOrigin(api: string): string {
  try {
    return new URL(api, typeof location === 'undefined' ? 'https://8bitgo.invalid' : location.href).origin
  } catch {
    return api
  }
}

/**
 * 同一管理页近期连续上传时复用成功测速，只减少本次首片的观察字节数，不直接增加并发。
 * 当前请求仍由首片真实进度确认后才会放开第二路；过期或换 Worker 时使用完整样本。
 */
export function warmUploadSampleBytes(
  api: string,
  preferred: number,
  now = Date.now(),
): number {
  const preferredSafe = Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(preferred) || 1))
  const profile = warmUploadProfile
  if (preferredSafe < 2 || !profile || profile.apiOrigin !== uploadApiOrigin(api) || now - profile.at < 0 || now - profile.at >= WARM_UPLOAD_TTL_MS) return EARLY_SAMPLE_BYTES
  if (profile.concurrency < 2 || profile.measuredMbps <= 0) return EARLY_SAMPLE_BYTES
  return WARM_UPLOAD_SAMPLE_BYTES
}

function rememberWarmUpload(api: string, profile: ReturnType<MultipartUploadGate['snapshot']>): void {
  if (!profile.calibrated || profile.hadFailure || profile.measuredMbps <= 0 || profile.limit < 2) return
  warmUploadProfile = {
    apiOrigin: uploadApiOrigin(api),
    concurrency: profile.limit,
    measuredMbps: profile.measuredMbps,
    at: Date.now(),
  }
}

interface CreateRequestRecord {
  requestId: string
  contentType: string
  partSize: number
  fileName: string
  fileSize: number
  lastModified: number
  fileFingerprint: string
  updatedAt: number
}

/** 上传过程里 HTTP 层面的失败。fatal 表示重试没有意义（uploadId 作废、分片对不上） */
class UploadHttpError extends Error {
  status: number
  fatal: boolean
  code: string
  payload: Record<string, unknown> | null
  retryAfterMs?: number
  constructor(
    message: string,
    status: number,
    fatal = false,
    code = '',
    payload: Record<string, unknown> | null = null,
    retryAfterMs?: number,
  ) {
    super(message)
    this.status = status
    this.fatal = fatal
    this.code = code
    this.payload = payload
    this.retryAfterMs = retryAfterMs
  }
}

/** complete 的 200 响应无法确认结果；这时不能盲目重试已经可能完成的合并。 */
class CompletionUncertainError extends Error {}

/** 同一批次的其他分片已失败；排队中的分片应退出，不要再额外消耗上行流量。 */
class MultipartStoppedAfterSiblingFailure extends Error {}

/** 组内另一张盘失败或调用方取消；有强摘要账本时保留已确认分片，否则安全清理会话。 */
class MultipartUploadAborted extends Error {
  constructor() {
    super('上传已取消')
    this.name = 'AbortError'
  }
}

/** 这个 Worker 还没部署分片接口（老版本）。roms.ts 收到它会退回单发 PUT */
export class MultipartUnsupportedError extends Error {}

/** 可重试的传输 / 网关故障应收敛并发，避免同一故障窗口内继续并发重发大分片。 */
function isUploadTransportFailureStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 ||
    status === 502 || status === 503 || status === 504 ||
    (status >= 520 && status <= 524)
}

/** 解析秒数或 HTTP 日期形式的 Retry-After；错误值不改变本地退避策略。 */
function parseRetryAfterMs(value: string | null, now = Date.now()): number | undefined {
  const header = value?.trim()
  if (!header) return undefined
  const seconds = /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : NaN
  const delayMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now
  if (!Number.isFinite(delayMs) || delayMs < 0) return undefined
  return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(delayMs))
}

interface UploadWaiter {
  onAbort?: () => void
  resolve: () => void
}

function waitForUploadSlot(
  waiters: UploadWaiter[],
  signal: AbortSignal | undefined,
  claim: () => void,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(new MultipartUploadAborted())
  return new Promise((resolve, reject) => {
    const waiter: UploadWaiter = {
      resolve: () => {
        if (waiter.onAbort) signal?.removeEventListener('abort', waiter.onAbort)
        claim()
        resolve()
      },
    }
    if (signal) {
      waiter.onAbort = () => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
        if (waiter.onAbort) signal.removeEventListener('abort', waiter.onAbort)
        reject(new MultipartUploadAborted())
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
      // 防止信号恰好在监听器安装前取消，导致请求永远留在队列里。
      if (signal.aborted) {
        waiter.onAbort()
        return
      }
    }
    waiters.push(waiter)
  })
}

/**
 * 所有分片和重试共用一个并发闸。一次 HTTP/2 连接级错误会同时打掉多个 XHR；如果每个 XHR
 * 各自立刻重试，就会再次挤进同一条刚重建的连接，形成失败风暴。这里先收敛到单路，连续四片
 * 成功后再恢复正常并发。闸门只影响正在传输的请求，不改变 R2 uploadId 或已保存的续传账本。
 */
export class MultipartUploadGate {
  private active = 0
  private peakActive = 0
  private transferActive = 0
  private peakTransferActive = 0
  private limit: number
  private readonly preferred: number
  private successStreak = 0
  private calibrated = false
  private calibratedTarget = 1
  private measuredMbps = 0
  private hadFailure = false
  private runSequence = 0
  private calibrationRunId: number | null = null
  private calibrationStartedAt: number | null = null
  private calibrationProgressBytes = 0
  private provisionalTarget = false
  private provisionalFailure = false
  private readonly waiters: UploadWaiter[] = []
  private readonly now: () => number
  private readonly hints: UploadNetworkHints
  private readonly earlySampleBytes: number

  constructor(
    preferred = MAX_CONCURRENCY,
    initial = Math.min(INITIAL_CONCURRENCY, preferred),
    now: () => number = monotonicNow,
    hints: UploadNetworkHints = browserUploadNetworkHints(),
    earlySampleBytes = EARLY_SAMPLE_BYTES,
  ) {
    this.preferred = Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(preferred)))
    this.limit = Math.max(1, Math.min(this.preferred, Math.floor(initial)))
    this.now = now
    this.hints = hints
    this.earlySampleBytes = Math.max(1, Math.floor(earlySampleBytes))
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new MultipartUploadAborted())
    if (this.active < this.limit) {
      this.activate()
      return Promise.resolve()
    }
    return waitForUploadSlot(this.waiters, signal, () => this.activate())
  }

  private activate() {
    this.active++
    this.peakActive = Math.max(this.peakActive, this.active)
  }

  /** putPart 只在 XHR 真正发送时调用；本闸门名额可能仍在等共享多文件预算。 */
  recordTransferActivity(active: boolean) {
    if (active) {
      this.transferActive++
      this.peakTransferActive = Math.max(this.peakTransferActive, this.transferActive)
    } else {
      this.transferActive = Math.max(0, this.transferActive - 1)
    }
  }

  private drain() {
    while (this.active < this.limit && this.waiters.length) this.waiters.shift()?.resolve()
  }

  private transportFailed(error: unknown) {
    if (typeof error !== 'object' || error === null || !('status' in error)) return false
    const status = Number(error.status)
    // HTTP 408 与 Cloudflare 520–524 也代表当前传输 / 边缘路径未能完成；收敛到单路后再恢复。
    return isUploadTransportFailureStatus(status)
  }

  private calibrate(sampleBytes: number, elapsedMs: number, provisional: boolean, maxConcurrency = this.preferred) {
    // 早期进度样本只负责试探第二路；首片完整成功后用整片耗时修正，避免把浏览器发送缓冲突发当成真实上行。
    const refiningProvisionalSample = this.calibrated && this.provisionalTarget && !provisional
    if ((this.calibrated && !refiningProvisionalSample) || sampleBytes <= 0 || elapsedMs <= 0) return
    this.measuredMbps = uploadMbps(sampleBytes, elapsedMs)
    this.calibratedTarget = Math.min(
      this.preferred,
      adaptiveUploadConcurrency(sampleBytes, elapsedMs, this.hints),
    )
    this.limit = Math.min(this.calibratedTarget, provisional ? EARLY_SAMPLE_MAX_CONCURRENCY : maxConcurrency)
    // 即使早期样本算出的目标本身只有两路，也必须等首片完整结束后校正这个暂定目标。
    this.provisionalTarget = provisional
    this.calibrated = true
    this.successStreak = 0
    this.drain()
  }

  private observeProgress(runId: number, bytes: number) {
    if (this.calibrated || runId !== this.calibrationRunId || this.calibrationStartedAt === null) return
    const loaded = Number.isFinite(bytes) ? Math.max(0, Math.floor(bytes)) : 0
    if (loaded < this.calibrationProgressBytes) return
    this.calibrationProgressBytes = loaded
    if (loaded < this.earlySampleBytes) return
    const elapsedMs = this.now() - this.calibrationStartedAt
    if (elapsedMs < EARLY_SAMPLE_MIN_MS) return
    this.calibrate(loaded, elapsedMs, true)
  }

  async run<T>(task: (
    reportProgress: (bytes: number) => void,
    markStarted: () => void,
    markUploadComplete: () => void,
  ) => Promise<T>, sampleBytes = 0, onErrorBeforeDrain?: (error: unknown) => void, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal)
    const runId = ++this.runSequence
    let startedAt = this.now()
    let uploadCompletedAt: number | null = null
    if (!this.calibrated && sampleBytes > 0 && this.calibrationRunId === null) {
      this.calibrationRunId = runId
      this.calibrationStartedAt = startedAt
    }
    const markStarted = () => {
      // 多文件共用传输预算时，闸门可能先排队；计时要从真正发送请求体开始，不能把排队时间算成慢网。
      startedAt = this.now()
      if (!this.calibrated && runId === this.calibrationRunId) {
        this.calibrationStartedAt = startedAt
        this.calibrationProgressBytes = 0
      }
    }
    const markUploadComplete = () => { uploadCompletedAt ??= this.now() }
    try {
      const value = await task((bytes) => this.observeProgress(runId, bytes), markStarted, markUploadComplete)
      if (!this.calibrated && sampleBytes > 0) {
        this.calibrate(sampleBytes, Math.max(1, (uploadCompletedAt ?? this.now()) - startedAt), false)
      } else if (this.provisionalTarget && runId === this.calibrationRunId) {
        // 早期样本只放行第二路；首片完整成功后按整片吞吐校正目标，再放开其余并发。
        // 同组其它分片若刚发生网络失败，完整样本只更新目标，实际并发仍从单路逐步恢复。
        this.calibrate(
          sampleBytes,
          Math.max(1, (uploadCompletedAt ?? this.now()) - startedAt),
          false,
          this.provisionalFailure ? 1 : this.preferred,
        )
        this.provisionalFailure = false
        this.drain()
      } else if (this.limit < (this.calibrated ? this.calibratedTarget : this.preferred) && ++this.successStreak >= RECOVERY_SUCCESS_PARTS) {
        this.limit++
        this.successStreak = 0
        this.drain()
      }
      return value
    } catch (error) {
      this.hadFailure = true
      // 让调用方先记录致命失败，再在 finally 里唤醒排队任务；否则下一片可能在错误回调前已经发出。
      try { onErrorBeforeDrain?.(error) } catch { /* 错误观测不能覆盖真正的上传失败 */ }
      if (this.provisionalTarget) {
        // 首片或同组分片失败都先收回试探并发；首片失败作废早期样本，同组其它片失败则保留完整样本校正机会。
        this.limit = 1
        this.successStreak = 0
        if (runId === this.calibrationRunId) {
          this.provisionalTarget = false
          this.provisionalFailure = false
          this.calibrated = false
          this.calibratedTarget = 1
          this.measuredMbps = 0
          this.calibrationRunId = null
          this.calibrationStartedAt = null
          this.calibrationProgressBytes = 0
        } else {
          this.provisionalFailure = true
        }
      }
      if (!this.calibrated && runId === this.calibrationRunId) {
        this.calibrationRunId = null
        this.calibrationStartedAt = null
        this.calibrationProgressBytes = 0
      }
      if (this.transportFailed(error)) {
        this.limit = 1
        this.successStreak = 0
      }
      throw error
    } finally {
      this.active--
      this.drain()
    }
  }

  snapshot() {
    return {
      active: this.active,
      peakActive: this.peakActive,
      transferActive: this.transferActive,
      peakTransferActive: this.peakTransferActive,
      limit: this.limit,
      waiting: this.waiters.length,
      successStreak: this.successStreak,
      calibrated: this.calibrated,
      measuredMbps: this.measuredMbps,
      hadFailure: this.hadFailure,
    }
  }
}

export interface UploadNetworkHints {
  saveData?: boolean
  effectiveType?: string
  downlinkMbps?: number
  rttMs?: number
  deviceMemoryGb?: number
  hardwareConcurrency?: number
}

const monotonicNow = () => typeof performance !== 'undefined' ? performance.now() : Date.now()
const uploadMbps = (bytes: number, elapsedMs: number) => bytes > 0 && elapsedMs > 0
  ? (bytes * 8) / (elapsedMs * 1000)
  : 0

export function browserUploadNetworkHints(): UploadNetworkHints {
  const navigator = globalThis.navigator as {
    hardwareConcurrency?: number
    deviceMemory?: number
    connection?: { effectiveType?: string; saveData?: boolean; downlink?: number; rtt?: number }
  } | undefined
  return {
    saveData: navigator?.connection?.saveData,
    effectiveType: navigator?.connection?.effectiveType,
    downlinkMbps: navigator?.connection?.downlink,
    rttMs: navigator?.connection?.rtt,
    deviceMemoryGb: navigator?.deviceMemory,
    hardwareConcurrency: navigator?.hardwareConcurrency,
  }
}

/**
 * 第一片本来就必须上传；用它到当前 Cloudflare Anycast 入口的真实吞吐选择后续并发，
 * 不额外制造测速对象。并发只负责藏住高 RTT / 单连接拥塞窗口，最多四路，慢网和省流量模式收缩。
 */
export function adaptiveUploadConcurrency(
  sampleBytes: number,
  elapsedMs: number,
  hints: UploadNetworkHints = {},
): number {
  const effectiveType = String(hints.effectiveType ?? '').toLowerCase()
  if (hints.saveData || effectiveType === 'slow-2g' || effectiveType === '2g') return 1

  const sampledMbps = uploadMbps(sampleBytes, elapsedMs)
  const hasMeasuredUpload = sampleBytes > 0 && Number.isFinite(elapsedMs) && elapsedMs > 0
  const hintedMbps = Number.isFinite(hints.downlinkMbps) ? Math.max(0, hints.downlinkMbps ?? 0) : 0
  const mbps = sampledMbps || hintedMbps
  const rtt = Number.isFinite(hints.rttMs) ? Math.max(0, hints.rttMs ?? 0) : 0
  let concurrency = 2
  // effectiveType 是按 RTT 推测的下载网络等级；第一片已有真实上行样本后应以样本为准。
  if ((effectiveType === '3g' && !hasMeasuredUpload) || (mbps > 0 && mbps < 3)) concurrency = 1
  else if (mbps >= 24 && (rtt === 0 || rtt < 180)) concurrency = 4
  else if (mbps >= 8 || rtt >= 180) concurrency = 3

  // 每路 XHR 都可能短暂持有一片请求体；低内存或双核设备不能为了跑满网卡把后台标签页挤死。
  if ((hints.deviceMemoryGb ?? Infinity) <= 2 || (hints.hardwareConcurrency ?? Infinity) <= 2) {
    concurrency = Math.min(concurrency, 2)
  }
  return Math.max(1, Math.min(MAX_CONCURRENCY, concurrency))
}

export function preferredUploadConcurrency(hints: UploadNetworkHints = browserUploadNetworkHints()): number {
  const type = String(hints.effectiveType || '').toLowerCase()
  if (hints.saveData || type === 'slow-2g' || type === '2g') return 1
  const memoryGb = Number(hints.deviceMemoryGb)
  const cores = Number(hints.hardwareConcurrency)
  const lowMemory = Number.isFinite(memoryGb) && memoryGb > 0 && memoryGb <= 2
  const lowCpu = Number.isFinite(cores) && cores > 0 && cores <= 2
  if (lowMemory || lowCpu) return 2
  // 3G 是按 RTT / 下载推测的网络等级，只允许首片单路起步；真实上行测速决定后续 1–4 路。
  // 未公开 hardwareConcurrency 的浏览器也不能被误判成双核。
  return 4
}

/**
 * 所有并行文件共用一个传输预算。每份文件自己的闸门仍按实测上行调整，
 * 但两个 PS1 多盘文件不会各自跑到四路、合计占满八条上行连接。
 */
export class UploadTransferPool {
  private active = 0
  private limit = preferredUploadConcurrency()
  private successStreak = 0
  private readonly waiters: UploadWaiter[] = []

  private ceiling() {
    return preferredUploadConcurrency()
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new MultipartUploadAborted())
    this.limit = Math.min(this.limit, this.ceiling())
    if (this.active < this.limit) {
      this.active++
      return Promise.resolve()
    }
    return waitForUploadSlot(this.waiters, signal, () => { this.active++ })
  }

  private drain() {
    this.limit = Math.min(this.limit, this.ceiling())
    while (this.active < this.limit && this.waiters.length) this.waiters.shift()?.resolve()
  }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal)
    try {
      const result = await task()
      const target = this.ceiling()
      if (this.limit < target && ++this.successStreak >= RECOVERY_SUCCESS_PARTS) {
        this.limit++
        this.successStreak = 0
      }
      return result
    } catch (error) {
      const status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : -1
      const oldWorkerFallback = requiresLegacyPartNumber(error)
      if (!oldWorkerFallback && isUploadTransportFailureStatus(status)) {
        this.limit = 1
        this.successStreak = 0
      }
      throw error
    } finally {
      this.active--
      this.drain()
    }
  }
}

const uploadTransferPool = new UploadTransferPool()

/* ---------------- 本地账本 ---------------- */

function readStore(): Record<string, PendingUpload> {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    const data = raw ? (JSON.parse(raw) as Record<string, PendingUpload>) : {}
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

function writeStore(store: Record<string, PendingUpload>) {
  try {
    // 新记录优先，并同时限制条数和字符量；大文件每片带摘要后账本会增长，不能让一次超额写入
    // 使整个 localStorage.setItem 失败、连最新那局都无法续传。
    const now = Date.now()
    const candidates = Object.values(store)
      .filter((p) => now - p.updatedAt < STORE_TTL)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, STORE_MAX)
    const encoded: string[] = []
    let chars = 2
    for (const record of candidates) {
      const entry = `${JSON.stringify(record.key)}:${JSON.stringify(record)}`
      const nextChars = chars + entry.length + (encoded.length ? 1 : 0)
      if (nextChars > STORE_MAX_CHARS) continue
      encoded.push(entry)
      chars = nextChars
    }
    localStorage.setItem(STORE_KEY, `{${encoded.join(',')}}`)
  } catch {
    /* 存不下就退化成「不能续传」，不影响这次上传本身 */
  }
}

interface PendingStateWrite {
  state: PendingUpload
  dirtyParts: number
  timer: ReturnType<typeof setTimeout>
}

const pendingStateWrites = new Map<string, PendingStateWrite>()

function discardPendingStateWrite(key: string) {
  const pending = pendingStateWrites.get(key)
  if (!pending) return
  clearTimeout(pending.timer)
  pendingStateWrites.delete(key)
}

function flushPendingStateWrite(key: string): boolean {
  const pending = pendingStateWrites.get(key)
  if (!pending) return false
  clearTimeout(pending.timer)
  pendingStateWrites.delete(key)
  saveState(pending.state)
  return true
}

function flushPendingStateWrites() {
  for (const key of pendingStateWrites.keys()) flushPendingStateWrite(key)
}

function scheduleStateSave(state: PendingUpload) {
  const existing = pendingStateWrites.get(state.key)
  if (existing) {
    existing.state = state
    existing.dirtyParts++
    if (existing.dirtyParts >= PART_STATE_SAVE_MAX_DIRTY_PARTS) flushPendingStateWrite(state.key)
    return
  }
  const pending: PendingStateWrite = {
    state,
    dirtyParts: 1,
    timer: setTimeout(() => flushPendingStateWrite(state.key), PART_STATE_SAVE_INTERVAL_MS),
  }
  pendingStateWrites.set(state.key, pending)
}

if (typeof window !== 'undefined') {
  // 离页或切到后台时尽量把最近完成的片写进账本；异常崩溃时最多安全重传四片。
  window.addEventListener('pagehide', flushPendingStateWrites)
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushPendingStateWrites()
    })
  }
}

function saveState(state: PendingUpload) {
  discardPendingStateWrite(state.key)
  const store = readStore()
  store[state.key] = { ...state, updatedAt: Date.now() }
  writeStore(store)
}

function clearState(key: string) {
  discardPendingStateWrite(key)
  const store = readStore()
  delete store[key]
  writeStore(store)
  clearCreateRequest(key)
}

function readCreateRequests(): Record<string, CreateRequestRecord> {
  try {
    const raw = localStorage.getItem(CREATE_REQUEST_STORE_KEY)
    const data = raw ? JSON.parse(raw) as Record<string, CreateRequestRecord> : {}
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

function saveCreateRequest(key: string, record: CreateRequestRecord) {
  try {
    const now = Date.now()
    const records = Object.entries(readCreateRequests())
      .filter(([, item]) => Number.isFinite(item?.updatedAt) && now - item.updatedAt < STORE_TTL)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .filter(([savedKey]) => savedKey !== key)
      .slice(0, STORE_MAX - 1)
    records.unshift([key, record])
    localStorage.setItem(CREATE_REQUEST_STORE_KEY, JSON.stringify(Object.fromEntries(records)))
  } catch {
    /* 本地配额不足时仍允许上传，只是无法在创建响应丢失后自动找回会话。 */
  }
}

function clearCreateRequest(key: string) {
  try {
    const records = readCreateRequests()
    delete records[key]
    localStorage.setItem(CREATE_REQUEST_STORE_KEY, JSON.stringify(records))
  } catch {
    /* 清理本地恢复提示失败不影响 R2 会话和最终对象。 */
  }
}

/** 本浏览器记着的未完成上传，新的在前 */
export function listPendingUploads(): PendingUpload[] {
  return Object.values(readStore()).filter((p) => Boolean(p.fileFingerprint && p.uploadId)).sort((a, b) => b.updatedAt - a.updatedAt)
}

/** File 才有身份可校验；从 zip 里解出来的 Blob 没有名字和时间，只能不续传 */
function identityOf(file: Blob): { fileName: string; lastModified: number } | null {
  const f = file as File
  if (typeof f.name !== 'string' || !f.name) return null
  if (typeof f.lastModified !== 'number' || !Number.isFinite(f.lastModified)) return null
  return { fileName: f.name, lastModified: f.lastModified }
}

function newMultipartRequestId(): string {
  // 随机 ID 只用于去重，不承载权限；旧浏览器缺少 Web Crypto 时仍允许正常上传。
  const bytes = new Uint8Array(16)
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes)
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * 找出同一元数据对应的会话；已上传片要经 verifyResumableParts 核验后才会加入续传账本。
 */
function resumableFor(key: string, file: Blob, ident: { fileName: string; lastModified: number }, partSize: number, contentType: string): PendingUpload | null {
  const found = readStore()[key]
  if (!found || !found.uploadId) return null
  if (found.fileSize !== file.size || found.partSize !== partSize) return null
  if (found.fileName !== ident.fileName || found.lastModified !== ident.lastModified) return null
  if (found.contentType && found.contentType !== contentType) return null
  if (!Array.isArray(found.parts)) return null
  const total = Math.max(1, Math.ceil(file.size / partSize))
  // 记录里出现越界的片号说明这份账本已经不可信了，宁可重传
  if (found.parts.some((p) => !p || typeof p !== 'object' || !p.etag || !Number.isInteger(p.partNumber) || p.partNumber < 1 || p.partNumber > total)) return null
  if (new Set(found.parts.map((p) => p.partNumber)).size !== found.parts.length) return null
  // 本地样本指纹只负责找回会话；远端已完成片必须再按完整分片摘要逐片核验后才能复用。
  return { ...found, partNumberInHeader: found.partNumberInHeader === true }
}

/**
 * 续传只保留和当前文件逐字节一致的远端分片。文件头/中/尾样本相同并不能证明中间所有字节相同；
 * 逐片核验可避免管理员换了同名同大小镜像后，把两版 ROM 静默拼在一起。
 */
async function verifyResumableParts(
  file: Blob,
  state: PendingUpload,
  partSize: number,
  fingerprint: string,
  onProgress?: (checked: number, total: number) => void,
  integrityPartFingerprint?: (start: number, size: number) => Promise<string>,
): Promise<void> {
  const previous = state.parts
  const verified: PendingUpload['parts'] = []
  let cursor = 0
  let checked = 0
  let lastReportedAt = 0
  if (previous.length) onProgress?.(0, previous.length)
  lastReportedAt = monotonicNow()
  const reportChecked = () => {
    checked += 1
    const now = monotonicNow()
    if (checked === previous.length || now - lastReportedAt >= 150) {
      lastReportedAt = now
      onProgress?.(checked, previous.length)
    }
  }
  const worker = async () => {
    for (;;) {
      const part = previous[cursor++]
      if (!part) return
      const contentHash = part.contentHash
      if (!contentHash || !/^[a-f0-9]{32}$/i.test(contentHash)) {
        reportChecked()
        continue
      }
      if (part.contentHashVersion !== undefined && part.contentHashVersion !== 2 && part.contentHashVersion !== 1) {
        reportChecked()
        continue
      }
      if (part.contentHashVersion === 2 && !integrityPartFingerprint) {
        // v2 指纹来自必校验清单块；没有同一份清单任务时不能用旧算法猜测验证。
        reportChecked()
        continue
      }
      const start = (part.partNumber - 1) * partSize
      const length = Math.min(partSize, file.size - start)
      if (length <= 0) {
        reportChecked()
        continue
      }
      try {
        const hash = part.contentHashVersion === 2
          ? await integrityPartFingerprint!(start, length)
          : await fingerprintRomPart(file.slice(start, start + length))
        if (hash === contentHash.toLowerCase()) verified.push(part)
      } catch {
        // 无法读回本地分片时不信任远端副本；runner 会用当前文件重新覆盖该片号。
      } finally {
        reportChecked()
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, previous.length) }, () => worker()))
  state.parts = verified.sort((a, b) => a.partNumber - b.partNumber)
  state.fileFingerprint = fingerprint
}

/** 创建请求先落本地账，再访问 Worker；响应丢失后同一个文件可用原 requestId 找回会话。 */
function createRequestFor(key: string, file: Blob, ident: { fileName: string; lastModified: number }, partSize: number, fingerprint: string, contentType: string): CreateRequestRecord | null {
  const found = readCreateRequests()[key]
  if (!found || !/^[a-z0-9_-]{16,128}$/i.test(found.requestId || '') || !Number.isFinite(found.updatedAt) ||
      Date.now() - found.updatedAt >= STORE_TTL || found.partSize !== partSize) return null
  if (found.fileSize !== file.size || found.fileName !== ident.fileName || found.lastModified !== ident.lastModified) return null
  if (!found.fileFingerprint || found.fileFingerprint !== fingerprint || found.contentType !== contentType) return null
  return found
}

/* ---------------- 与 Worker 的四次对话 ---------------- */

interface Ctx {
  api: string
  token: string
}

export async function askJson<T>(
  ctx: Ctx,
  url: string,
  init: RequestInit,
  what: string,
  signal?: AbortSignal,
  timeoutMs = WORKER_REQUEST_TIMEOUT_MS,
): Promise<T> {
  if (signal?.aborted) throw new MultipartUploadAborted()
  const controller = new AbortController()
  let timedOut = false
  const abortFromCaller = () => controller.abort()
  signal?.addEventListener('abort', abortFromCaller, { once: true })
  if (signal?.aborted) abortFromCaller()
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    const res = await fetch(url, {
      ...init,
      // 整个响应正文都受同一个时限保护；只限制响应头会让 res.json() 在弱网下仍无限等待。
      signal: controller.signal,
      headers: { Authorization: `Bearer ${ctx.token}`, ...(init.headers ?? {}) },
    })
    let data: (T & { error?: string; fatal?: boolean; code?: string }) | null = null
    try {
      data = await res.json() as (T & { error?: string; fatal?: boolean; code?: string })
    } catch (error) {
      if (signal?.aborted) throw new MultipartUploadAborted()
      if (timedOut) throw new UploadHttpError(`${what}响应超时，连接暂时没有完成`, 0)
      // JSON 格式错误通常是地址 / Worker 配错；读取流本身中断则是弱网，幂等请求可以安全重试。
      if (!(error instanceof SyntaxError)) throw new UploadHttpError(`${what}响应正文未完整接收`, 0)
    }
    if (signal?.aborted) throw new MultipartUploadAborted()
    if (timedOut) throw new UploadHttpError(`${what}响应超时，连接暂时没有完成`, 0)
    if (!res.ok) {
      // 老版本 Worker 上，对着一个 key 发 POST 只会得到 405 / 404 —— 那是「没部署分片接口」，
      // 不是「上传失败」，要能和真失败区分开
      if (res.status === 404 || res.status === 405) throw new MultipartUnsupportedError(what)
      throw new UploadHttpError(
        data?.error || explainRomStatus(res.status, what).message,
        res.status,
        Boolean(data?.fatal),
        typeof data?.code === 'string' ? data.code : '',
        data && typeof data === 'object' ? data as Record<string, unknown> : null,
        parseRetryAfterMs(res.headers.get('Retry-After')),
      )
    }
    // 地址填成了本站域名时会落到 SSR 兜底路由，回的是 200 + 一个 HTML 页面（roms.ts 里
    // 那个「200 + HTML」的坑）。这里拿不到 JSON 就必须报错，否则后面读 data.uploadId 才炸
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new UploadHttpError(`${what}失败：Worker 返回的不是有效 JSON（地址是不是填成了站点域名？）`, res.status)
    }
    return data
  } catch (error) {
    if (signal?.aborted) throw new MultipartUploadAborted()
    if (timedOut) throw new UploadHttpError(`${what}响应超时，连接暂时没有完成`, 0)
    if (error instanceof UploadHttpError || error instanceof MultipartUnsupportedError) throw error
    // fetch 抛出来的是 TypeError('Failed to fetch')；包成 status 0 的网络错误，上层才知道可安全续传重试。
    throw new UploadHttpError(`${what}失败：无法连接 Worker（网络中断或跨域被拒）`, 0)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

async function createUpload(ctx: Ctx, key: string, file: Blob, ident: { fileName: string; lastModified: number } | null, partSize: number, fingerprint: string, requestId: string, signal?: AbortSignal): Promise<PendingUpload> {
  const data = await withRetry(
    async () => {
      try {
        return await askJson<{ uploadId: string; marker: string; requestSignature?: string; partNumberInHeader?: boolean }>(
          ctx,
          `${ctx.api}/${encodeKey(key)}?uploads`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // contentType 只有开始时能设，complete() 不收 —— 漏了封面图会变成提示下载
            body: JSON.stringify({ contentType: file.type || guessUploadType(key), size: file.size, name: ident?.fileName ?? '', requestId, integrityRequired: isIntegrityKey(key) }),
          },
          '开始分片上传',
          signal,
        )
      } catch (error) {
        // Worker 创建会话后若写续传标记失败且首次 abort 也失败，会把 uploadId 一并返回。
        // 先尝试清理并确认成功，才允许重试；否则再建一个会话会留下更多无法续传的残片。
        if (error instanceof UploadHttpError && error.code === 'multipart_marker_write_failed' && error.payload?.cleanupRequired === true) {
          const uploadId = error.payload.uploadId
          const marker = error.payload.marker
          if (typeof uploadId === 'string' && uploadId && typeof marker === 'string' && marker.startsWith('_uploads/')) {
            try {
              await abortUpload(ctx, key, uploadId, marker)
            } catch (cleanupError) {
              throw new Error(`${error.message}；自动清理仍未确认，请到「ROM 存储」检查残留分片（${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}）`)
            }
          } else {
            throw new Error(`${error.message}；Worker 返回的清理信息无效，请到「ROM 存储」检查残留分片`)
          }
        }
        throw error
      }
    },
    3,
    (error) => error instanceof UploadHttpError && !error.fatal && (
      error.status === 0 || [502, 503, 504].includes(error.status) ||
      (error.status === 503 && ['storage_unavailable', 'multipart_marker_write_failed', 'multipart_marker_race_lost'].includes(error.code))
    ),
    signal,
  )
  if (typeof data.uploadId !== 'string' || !data.uploadId || typeof data.marker !== 'string' || !data.marker.startsWith('_uploads/')) {
    throw new Error('Worker 未返回有效的 uploadId 或残留标记；请核查 Worker 地址和版本')
  }
  return {
    key,
    uploadId: data.uploadId,
    marker: data.marker ?? '',
    partSize,
    fileName: ident?.fileName ?? '',
    fileSize: file.size,
    lastModified: ident?.lastModified ?? 0,
    fileFingerprint: fingerprint,
    requestId,
    requestSignature: data.requestSignature,
    // 老 Worker 没有能力标记，继续走查询参数，升级前后的客户端 / Worker 可以交错部署。
    partNumberInHeader: data.partNumberInHeader === true,
    contentType: file.type || guessUploadType(key),
    parts: [],
    updatedAt: Date.now(),
  }
}

/** 传一片。用 XHR 而不是 fetch：只有 XHR 能报上传进度 */
function workerTimingMs(header: string | null): number | undefined {
  for (const metric of header?.split(',') ?? []) {
    if (!/^\s*worker(?:;|$)/i.test(metric)) continue
    const duration = /(?:^|;)\s*dur=(\d+(?:\.\d+)?)(?:;|$)/i.exec(metric)?.[1]
    const value = duration === undefined ? NaN : Number(duration)
    if (Number.isFinite(value) && value >= 0) return value
  }
  return undefined
}

function putPart(
  ctx: Ctx,
  state: PendingUpload,
  partNumber: number,
  blob: Blob,
  onLoaded: (bytes: number, serverWaitMs?: number) => void,
  partNumberInHeader: boolean,
  onStart?: () => void,
  onUploadComplete?: () => void,
  onTransferActivity?: (active: boolean) => void,
  signal?: AbortSignal,
): Promise<string> {
  const query = `?uploadId=${encodeURIComponent(state.uploadId)}`
  const url = `${ctx.api}/${encodeKey(state.key)}${query}${partNumberInHeader ? '' : `&partNumber=${partNumber}`}`
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new MultipartUploadAborted())
      return
    }
    const xhr = new XMLHttpRequest()
    let uploadStartedAt: number | null = null
    let uploadFinishedAt: number | null = null
    let uploadFinishedEvent = false
    xhr.open('PUT', url)
    xhr.setRequestHeader('Authorization', `Bearer ${ctx.token}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    if (partNumberInHeader) xhr.setRequestHeader('X-8BG-Part-Number', String(partNumber))

    /**
     * 卡死检测。XHR 自带的 timeout 是「整片的总时长」，上行慢的时候会把正常的传输也判死；
     * 这里改成盯**有没有进展**：45 秒一个字节都没动就主动 abort，交给外面重试这一片。
     * 没有它的话，一条半死的连接能把整次上传永远挂在那儿（正是「传一半没反应」那种现象）。
     */
    let lastAt = Date.now()
    let stalled = false
    let transferActive = false
    const watchdog = window.setInterval(() => {
      if (Date.now() - lastAt > 45_000) {
        stalled = true
        window.clearInterval(watchdog)
        xhr.abort()
      }
    }, 5_000)
    const abortFromSignal = () => xhr.abort()
    const markTransferActivity = (active: boolean) => {
      if (transferActive === active) return
      transferActive = active
      onTransferActivity?.(active)
    }
    const done = () => {
      window.clearInterval(watchdog)
      markTransferActivity(false)
      signal?.removeEventListener('abort', abortFromSignal)
    }

    xhr.upload.onprogress = (e) => {
      if (signal?.aborted) return
      lastAt = Date.now()
      if (e.lengthComputable) onLoaded(e.loaded)
    }
    // XMLHttpRequest 的 upload 事件避开 CORS 预检和响应等待：它们会影响用户总耗时，却不代表上行链路速度。
    xhr.upload.onloadstart = () => {
      uploadStartedAt = monotonicNow()
      onStart?.()
    }
    xhr.upload.onload = () => {
      uploadFinishedAt = monotonicNow()
      uploadFinishedEvent = true
      onUploadComplete?.()
    }
    xhr.onerror = () => {
      done()
      reject(signal?.aborted ? new MultipartUploadAborted() : new UploadHttpError('上传连接被浏览器或边缘网络重置', 0))
    }
    xhr.onabort = () => {
      done()
      reject(signal?.aborted
        ? new MultipartUploadAborted()
        : new UploadHttpError(stalled ? '这一片 45 秒没有任何进展，已中断重试' : '上传连接已中断', 0))
    }
    xhr.onload = () => {
      // 旧浏览器若缺少 upload.load，退回完整响应时间；现代浏览器以正文送完为测速终点。
      if (!uploadFinishedEvent) onUploadComplete?.()
      done()
      if (signal?.aborted) {
        reject(new MultipartUploadAborted())
        return
      }
      const data = (() => {
        try {
          return JSON.parse(xhr.responseText) as { etag?: string; error?: string; fatal?: boolean; partNumberInHeader?: boolean }
        } catch {
          return null
        }
      })()
      if (xhr.status >= 200 && xhr.status < 300 && data?.etag) {
        // 只有成功响应才能确认当前边缘实际运行的 Worker 版本；一次 status=0 可能只是网络抖动，
        // 不应因此让余下每片都改用带不同查询串的旧协议，重新触发 CORS 预检。
        if (partNumberInHeader) {
          if (data.partNumberInHeader === true) state.partNumberInHeader = true
        } else {
          state.partNumberInHeader = data.partNumberInHeader === true
        }
        const workerMs = workerTimingMs(xhr.getResponseHeader?.('Server-Timing') ?? null)
        const uploadMs = uploadStartedAt !== null && uploadFinishedAt !== null
          ? Math.max(0, uploadFinishedAt - uploadStartedAt)
          : undefined
        const serverWaitMs = workerMs !== undefined && uploadMs !== undefined
          ? Math.max(0, workerMs - uploadMs)
          : undefined
        onLoaded(blob.size, serverWaitMs)
        resolve(data.etag)
        return
      }
      if (xhr.status === 404 || xhr.status === 405) {
        reject(new MultipartUnsupportedError('传分片'))
        return
      }
      reject(new UploadHttpError(
        data?.error || explainRomStatus(xhr.status, '传分片').message,
        xhr.status,
        Boolean(data?.fatal),
        '',
        null,
        parseRetryAfterMs(xhr.getResponseHeader?.('Retry-After') ?? null),
      ))
    }
    // 兼容不派发 upload.loadstart 的旧 XHR；现代浏览器随后会用真实正文起点校正一次。
    onStart?.()
    try {
      signal?.addEventListener('abort', abortFromSignal, { once: true })
      if (signal?.aborted) abortFromSignal()
      else {
        markTransferActivity(true)
        xhr.send(blob)
      }
    } catch (error) {
      done()
      reject(error instanceof Error ? error : new Error('无法开始上传分片'))
    }
  })
}

/** 只识别旧 Worker 无法解析新分片号协议的两种响应，其他 400 必须原样失败。 */
function requiresLegacyPartNumber(error: unknown): boolean {
  return error instanceof UploadHttpError && (
    (error.status === 0 && error.message === '上传连接被浏览器或边缘网络重置') ||
    (error.status === 400 && /partNumber.*整数/.test(error.message))
  )
}

/** 这些状态码重试多少次都一样：口令不对、片太大、uploadId 作废 */
function retryable(err: unknown): boolean {
  if (err instanceof MultipartUnsupportedError) return false
  if (!(err instanceof UploadHttpError)) return false
  if (err.fatal) return false
  return !(err.status === 400 || err.status === 401 || err.status === 403 || err.status === 409 || err.status === 413)
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) {
    reject(new MultipartUploadAborted())
    return
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', abort)
    resolve()
  }, ms)
  const abort = () => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    reject(new MultipartUploadAborted())
  }
  signal?.addEventListener('abort', abort, { once: true })
})

/** 可重试的错误就退避重试，其余立刻抛 */
async function withRetry<T>(run: () => Promise<T>, attempts: number, shouldRetry: (error: unknown) => boolean = retryable, signal?: AbortSignal): Promise<T> {
  let last: unknown
  let retryAfterMs = 0
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) throw new MultipartUploadAborted()
    if (i > 0) {
      await sleep(Math.max(600 * 2 ** (i - 1) + Math.random() * 400, retryAfterMs), signal)
      retryAfterMs = 0
    }
    try {
      return await run()
    } catch (err) {
      last = err
      if (!shouldRetry(err)) throw err
      retryAfterMs = err instanceof UploadHttpError ? err.retryAfterMs ?? 0 : 0
    }
  }
  throw last
}

async function putPartWithRetry(
  ctx: Ctx,
  state: PendingUpload,
  partNumber: number,
  blob: Blob,
  onLoaded: (bytes: number, serverWaitMs?: number) => void,
  gate: MultipartUploadGate,
  stopRequested: () => boolean = () => false,
  stopOnFatalError?: (error: unknown) => void,
  signal?: AbortSignal,
): Promise<string> {
  const noteFatalError = (error: unknown, usedHeaderProtocol: boolean) => {
    // 老 Worker 会用 400 表示不认识请求头里的分片号；这属于协议降级信号，不是上传致命错误。
    if (usedHeaderProtocol && requiresLegacyPartNumber(error)) return
    if (!(error instanceof MultipartStoppedAfterSiblingFailure) && !retryable(error)) stopOnFatalError?.(error)
  }
  let last: unknown
  // 本片一旦发现头协议不可达，就让本片后续重试先走旧参数；会话级能力等成功响应确认后再更新。
  let forceLegacyForPart = false
  let retryAfterMs = 0
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new MultipartUploadAborted()
    if (stopRequested()) throw new MultipartStoppedAfterSiblingFailure()
    // 连接级错误后不能在几百毫秒内把多条 PUT 一起塞回刚重建的 HTTP/2 会话。
    if (attempt > 0) {
      await sleep(Math.max(Math.min(12_000, 1_500 * 2 ** (attempt - 1)) + Math.random() * 1_000, retryAfterMs), signal)
      retryAfterMs = 0
    }
    const useHeaderProtocol = state.partNumberInHeader === true && !forceLegacyForPart
    const beforeDrain = (error: unknown) => noteFatalError(error, useHeaderProtocol)
    try {
      return await gate.run((reportProgress, markStarted, markUploadComplete) => {
        // runner 可能在并发闸门里排队；错误要在拿到连接之后再检查一次，避免首片 403 后仍发送后续大分片。
        if (signal?.aborted) throw new MultipartUploadAborted()
        if (stopRequested()) throw new MultipartStoppedAfterSiblingFailure()
        return uploadTransferPool.run(() => {
          if (signal?.aborted) throw new MultipartUploadAborted()
          if (stopRequested()) throw new MultipartStoppedAfterSiblingFailure()
          return putPart(ctx, state, partNumber, blob, (bytes, serverWaitMs) => {
            reportProgress(bytes)
            onLoaded(bytes, serverWaitMs)
          }, useHeaderProtocol, markStarted, markUploadComplete,
          (active) => gate.recordTransferActivity(active), signal)
        }, signal)
      }, blob.size, beforeDrain, signal)
    } catch (err) {
      if (err instanceof MultipartStoppedAfterSiblingFailure) throw err
      if (useHeaderProtocol && requiresLegacyPartNumber(err)) {
        // 在并发闸之外为本片回退，让闸门先看到 status 0 / 400 并收敛并发。
        // 旧 Worker 的成功响应没有能力标记时才会降级整局；新 Worker 会在响应中确认能力。
        forceLegacyForPart = true
        onLoaded(0)
        try {
          return await gate.run((reportProgress, markStarted, markUploadComplete) => {
            if (signal?.aborted) throw new MultipartUploadAborted()
            if (stopRequested()) throw new MultipartStoppedAfterSiblingFailure()
            return uploadTransferPool.run(() => {
              if (signal?.aborted) throw new MultipartUploadAborted()
              if (stopRequested()) throw new MultipartStoppedAfterSiblingFailure()
              return putPart(ctx, state, partNumber, blob, (bytes, serverWaitMs) => {
                reportProgress(bytes)
                onLoaded(bytes, serverWaitMs)
              }, false, markStarted, markUploadComplete,
              (active) => gate.recordTransferActivity(active), signal)
            }, signal)
          }, blob.size, (error) => noteFatalError(error, false), signal)
        } catch (fallbackError) {
          if (fallbackError instanceof MultipartStoppedAfterSiblingFailure) throw fallbackError
          last = fallbackError
        }
      } else {
        last = err
      }
      // 重试要从 0 字节重新算这一片的进度，否则进度条会往前虚报
      onLoaded(0)
      if (!retryable(last)) throw last
      retryAfterMs = last instanceof UploadHttpError ? last.retryAfterMs ?? 0 : 0
    }
  }
  throw last
}

async function completeUpload(
  ctx: Ctx,
  state: PendingUpload,
  integrityManifest?: RomIntegrityManifestPayload,
): Promise<{ size: number; etag?: string; integrityPublished?: boolean }> {
  const data = await askJson<{ ok: boolean; key: string; size: number; etag?: string; integrityPublished?: boolean }>(
    ctx,
    `${ctx.api}/${encodeKey(state.key)}?uploadId=${encodeURIComponent(state.uploadId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parts: state.parts
          .map(({ partNumber, etag }) => ({ partNumber, etag }))
          .sort((a, b) => a.partNumber - b.partNumber),
        marker: state.marker,
        requestId: state.requestId,
        requestSignature: state.requestSignature,
        size: state.fileSize,
        ...(integrityManifest ? { integrityRequired: true, integrityManifest } : {}),
      }),
    },
    '合并分片',
  )
  if (data.ok !== true || data.key !== state.key) {
    // 200 但缺少确认字段时，合并可能已发生；重复 complete 可能把真实成功说成失败。
    throw new CompletionUncertainError(`Worker 未确认 ${state.key} 的分片合并；请到「ROM 存储」核查对象`)
  }
  const size = Number(data?.size)
  if (!Number.isSafeInteger(size) || size !== state.fileSize) {
    // R2 已合并成功，不能再重试 complete；更不能把错误大小假装成原文件大小去绑定。
    throw new CompletionUncertainError(`R2 已完成上传，但对象大小是 ${data?.size ?? '未知'} 字节，原文件是 ${state.fileSize} 字节；请到「ROM 存储」核查这个 key`)
  }
  return { size, etag: data.etag || undefined, integrityPublished: data.integrityPublished === true }
}

async function abortUpload(ctx: Ctx, key: string, uploadId: string, marker: string): Promise<void> {
  const qs = new URLSearchParams({ uploadId })
  if (marker) qs.set('marker', marker)
  const data = await askJson<{ ok: boolean }>(ctx, `${ctx.api}/${encodeKey(key)}?${qs.toString()}`, { method: 'DELETE' }, '清理分片')
  if (data.ok !== true) throw new Error('Worker 未确认分片清理成功')
}

/* ---------------- 主流程 ---------------- */

/**
 * 分片上传一个文件；同一个 key + 同一个文件时自动从上次断掉的地方接着传。
 *
 * 失败时**故意保留**本地续传记录：管理员重新选同一个文件再点一次上传，
 * 就从下一片开始，不用把已经传上去的几十 MB 再传一遍。
 * 只有「这次上传已经作废」（uploadId 过期、分片对不上）才会清掉记录并 abort ——
 * 否则会卡在「续传 → 失败 → 续传」的死循环里。
 */
export async function uploadRomMultipart(
  file: Blob,
  key: string,
  onProgress?: UploadProgress,
  signal?: AbortSignal,
  integrityManifestTask?: Promise<RomIntegrityManifestPayload>,
  atomicIntegrityUpload = false,
  integrityPartFingerprint?: (start: number, size: number) => Promise<string>,
  integrityCapabilityTask?: Promise<boolean>,
): Promise<UploadResult> {
  const ctx: Ctx = { api: getRomApi(), token: getRomToken() }
  const partSize = PART_SIZE
  const total = Math.max(1, Math.ceil(file.size / partSize))
  if (total > MAX_PARTS) throw new Error(`文件太大：${total} 片超过 R2 的 10000 片上限`)
  if (signal?.aborted) throw new MultipartUploadAborted()

  const ident = identityOf(file)
  const fingerprint = ident ? await fingerprintRomUploadFile(file) : null
  const contentType = file.type || guessUploadType(key)
  const resumable = Boolean(ident && fingerprint)
  const resumedState = ident && fingerprint ? resumableFor(key, file, ident, partSize, contentType) : null
  const pendingCreate = ident && fingerprint ? createRequestFor(key, file, ident, partSize, fingerprint, contentType) : null
  const hadPendingCreate = Boolean(pendingCreate)
  const requestId = resumedState?.requestId || pendingCreate?.requestId || newMultipartRequestId()
  if (!resumedState && resumable && ident && fingerprint && !pendingCreate) {
    saveCreateRequest(key, {
      requestId,
      contentType,
      partSize,
      fileName: ident.fileName,
      fileSize: file.size,
      lastModified: ident.lastModified,
      fileFingerprint: fingerprint,
      updatedAt: Date.now(),
    })
  }
  const state = resumedState ?? (await createUpload(ctx, key, file, ident, partSize, fingerprint ?? '', requestId, signal))
  if (resumedState && fingerprint) {
    await verifyResumableParts(file, state, partSize, fingerprint, (checked, total) => {
      onProgress?.(0, {
        parts: Math.max(1, Math.ceil(file.size / partSize)),
        done: 0,
        resumed: 0,
        concurrency: 1,
        checkingParts: checked,
        checkingTotal: total,
      })
    }, integrityPartFingerprint)
  }
  if (integrityManifestTask && integrityCapabilityTask) {
    try {
      // Worker 能力探测与创建空会话并行；门槛仍在第一片 ROM 上行之前，旧 Worker 不会收到游戏内容。
      atomicIntegrityUpload = await integrityCapabilityTask
    } catch (error) {
      const canReuseSession = Boolean(resumedState || hadPendingCreate)
      let cleanupConfirmed = canReuseSession
      if (!canReuseSession) {
        try {
          await abortUpload(ctx, state.key, state.uploadId, state.marker)
          cleanupConfirmed = true
          clearState(key)
        } catch {
          if (resumable) saveState(state)
        }
      } else if (resumable) {
        saveState(state)
      }
      if (!cleanupConfirmed) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`${reason}；能力确认前没有上传 ROM 字节，但分片会话清理未确认，请到「ROM 存储」检查残留`)
      }
      throw error
    }
  }
  const resumed = resumedState ? resumedState.parts.length : 0
  if (resumable) saveState(state)
  const preferredConcurrency = preferredUploadConcurrency()
  const uploadGate = new MultipartUploadGate(
    preferredConcurrency,
    INITIAL_CONCURRENCY,
    monotonicNow,
    browserUploadNetworkHints(),
    warmUploadSampleBytes(ctx.api, preferredConcurrency),
  )

  /** 除最后一片外都是 partSize —— R2 要求「除末片外等大」，这也是身份校验要带上 partSize 的原因 */
  const sizeOfPart = (n: number) => Math.min(partSize, file.size - (n - 1) * partSize)
  const finished = new Set(state.parts.map((p) => p.partNumber))
  /** 每片当前已上传的字节数（含正在传的那几片），进度条按它们的和算 */
  const loaded = new Map<number, number>()
  let loadedBytes = 0
  let serverWaitTotalMs = 0
  let serverWaitSamples = 0
  let hashWaitTotalMs = 0
  let hashWaitSamples = 0
  for (const n of finished) {
    const bytes = sizeOfPart(n)
    loaded.set(n, bytes)
    loadedBytes += bytes
  }

  // XHR 在四路并发时一秒可触发数百次 progress。旧实现每次都遍历所有分片并触发 React 更新，
  // 大 ROM 会把主线程浪费在 O(分片数 × 事件数) 的求和与渲染上，反过来拖慢加密和网络回调。
  // 改为按差值维护总量，并把 UI 限到约 12fps；每片完成和最终完成仍强制即时上报。
  let lastReportedAt = 0
  let reportTimer: number | null = null
  const emitProgress = () => {
    reportTimer = null
    lastReportedAt = performance.now()
    // 封顶 99%：合并分片还要花一两秒，先跳到 100% 再卡住会让人以为卡死了
    const pct = Math.min(99, Math.round((loadedBytes / Math.max(1, file.size)) * 100))
    const network = uploadGate.snapshot()
    onProgress?.(pct, {
      parts: total,
      done: finished.size,
      resumed,
      concurrency: network.limit,
      peakConcurrency: network.peakTransferActive,
      measuredMbps: network.calibrated ? network.measuredMbps : undefined,
      serverWaitMs: serverWaitSamples > 0
        ? Math.round((serverWaitTotalMs / serverWaitSamples) * 10) / 10
        : undefined,
      serverWaitSamples: serverWaitSamples || undefined,
      hashWaitMs: hashWaitSamples > 0
        ? Math.round((hashWaitTotalMs / hashWaitSamples) * 10) / 10
        : undefined,
      hashWaitSamples: hashWaitSamples || undefined,
    })
  }
  const report = (force = false) => {
    const elapsed = performance.now() - lastReportedAt
    if (force || elapsed >= 80) {
      if (reportTimer !== null) window.clearTimeout(reportTimer)
      emitProgress()
      return
    }
    if (reportTimer === null) reportTimer = window.setTimeout(emitProgress, 80 - elapsed)
  }
  const setLoaded = (n: number, bytes: number, serverWaitMs?: number) => {
    if (typeof serverWaitMs === 'number' && Number.isFinite(serverWaitMs) && serverWaitMs >= 0) {
      // 并发分片完成顺序不稳定；展示平均确认等待，避免最后完成的一片偶然拖慢或偏快导致误判。
      serverWaitTotalMs += serverWaitMs
      serverWaitSamples++
    }
    const previous = loaded.get(n) ?? 0
    const safe = Math.max(0, Math.min(sizeOfPart(n), bytes))
    if (safe === previous) return
    loaded.set(n, safe)
    loadedBytes += safe - previous
    report()
  }
  const stopScheduledReport = () => {
    if (reportTimer !== null) window.clearTimeout(reportTimer)
    reportTimer = null
  }
  report(true)

  // 最多允许 10,000 片；游标直接分配下一片，避免先建整份队列并反复 shift 搬动数组。
  let nextPartNumber = 1
  let failure: unknown = null

  const runner = async () => {
    for (;;) {
      if (failure) return
      if (signal?.aborted) {
        failure = new MultipartUploadAborted()
        return
      }
      while (nextPartNumber <= total && finished.has(nextPartNumber)) nextPartNumber++
      if (nextPartNumber > total) return
      const n = nextPartNumber++
      const start = (n - 1) * partSize
      const blob = file.slice(start, start + sizeOfPart(n))
      try {
        // 摘要与 XHR 同时读各自的小块，正常上传不多一次整文件扫描，断点恢复则能核验已在 R2 的字节。
        const hashTask = resumable
          ? Promise.resolve().then(() => integrityPartFingerprint
              ? integrityPartFingerprint(start, blob.size)
              : fingerprintRomPart(blob)).then(
              (hash) => ({ hash, version: integrityPartFingerprint ? 2 as const : 1 as const, settledAt: performance.now() }),
              () => ({ hash: null, version: null, settledAt: performance.now() }),
            )
          : null
        const etag = await putPartWithRetry(ctx, state, n, blob, (bytes, serverWaitMs) => {
          setLoaded(n, bytes, serverWaitMs)
        }, uploadGate, () => failure !== null, (error) => { failure ??= error }, signal)
        const uploadFinishedAt = performance.now()
        const hashResult = hashTask ? await hashTask : null
        if (hashResult) {
          // 已提前算完的分片计为 0，等待中的分片计实际延迟，避免均值只包含慢摘要样本。
          hashWaitTotalMs += Math.max(0, hashResult.settledAt - uploadFinishedAt)
          hashWaitSamples++
        }
        const contentHash = hashResult?.hash ?? null
        // R2 已确认本次分片来自当前文件；摘要失败只禁用这片的未来复用，不能把成功上传报成失败。
        // 续传核验会主动重传没有摘要的旧片，因此安全性不变，也避免管理员因浏览器加密 API 短暂故障重传整局。
        state.parts.push({
          partNumber: n,
          etag,
          ...(contentHash ? { contentHash, ...(hashResult?.version === 2 ? { contentHashVersion: 2 as const } : {}) } : {}),
        })
        finished.add(n)
        setLoaded(n, sizeOfPart(n))
        // 短间隔批量落账，避免每个 8 MiB 分片都重写不断增长的整份账本。
        if (resumable) scheduleStateSave(state)
        report(true)
      } catch (err) {
        // 保留最先发生的真实上传错误；后续排队 runner 只会收到停止哨兵。
        if (!(err instanceof MultipartStoppedAfterSiblingFailure)) failure ??= err
        return
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(preferredConcurrency, Math.max(1, total - finished.size)) }, () => runner()))
  if (signal?.aborted) failure ??= new MultipartUploadAborted()
  if (failure) {
    stopScheduledReport()
    // 致命错误可能在第一次进度节流回调前结束并发分片；补发最终快照，避免匿名性能样本漏记真实峰值。
    emitProgress()
    throw await explainFailure(failure, ctx, state, total, resumable)
  }

  // 合并前必须持久化所有已确认 ETag；complete 不确定时仍可按完整账本安全恢复。
  if (resumable) flushPendingStateWrite(state.key)

  // SHA-256 与分片上行并行；在不可逆的 R2 complete 前等待摘要，避免哈希失败后留下
  // 已发布但被完整性闸门永久拦截的对象。可续传文件保留已传分片，下次只重试摘要与合并。
  let integrityManifest: RomIntegrityManifestPayload | undefined
  if (integrityManifestTask) {
    try { integrityManifest = await integrityManifestTask }
    catch (error) { throw await explainFailure(error, ctx, state, total, resumable) }
  }
  if (signal?.aborted) {
    const error = new MultipartUploadAborted()
    throw await explainFailure(error, ctx, state, total, resumable)
  }

  let completed: { size: number; etag?: string; integrityPublished?: boolean }
  try {
    // 值得多试两次：分片全都已经在 R2 上了，只差这一个请求，
    // 因为一次网络抖动就把几十 MB 判成失败太可惜
    // 合并是有副作用的提交点：从这里开始不再响应取消，最多三次幂等请求各自受 60 秒时限保护；
    // 否则首次响应若在 R2 完成后丢失，客户端会误报失败并留下看似可续传的旧 uploadId。
    completed = await withRetry(() => completeUpload(ctx, state, atomicIntegrityUpload ? integrityManifest : undefined), 3, retryable)
  } catch (err) {
    if (err instanceof CompletionUncertainError) {
      clearState(key)
      throw err
    }
    throw await explainFailure(err, ctx, state, total, resumable)
  }

  stopScheduledReport()
  clearState(key)
  const network = uploadGate.snapshot()
  rememberWarmUpload(ctx.api, network)
  onProgress?.(100, {
    parts: total,
    done: total,
    resumed,
    concurrency: network.limit,
    peakConcurrency: network.peakTransferActive,
    measuredMbps: network.calibrated ? network.measuredMbps : undefined,
    serverWaitMs: serverWaitSamples > 0
      ? Math.round((serverWaitTotalMs / serverWaitSamples) * 10) / 10
      : undefined,
    serverWaitSamples: serverWaitSamples || undefined,
    hashWaitMs: hashWaitSamples > 0
      ? Math.round((hashWaitTotalMs / hashWaitSamples) * 10) / 10
      : undefined,
    hashWaitSamples: hashWaitSamples || undefined,
  })
  return { key, url: romUrlForKey(key), size: completed.size, etag: completed.etag,
    integrityPublished: completed.integrityPublished }
}

/**
 * 把失败翻译成人话，并决定「这次上传还能不能续」。
 *
 * 不能续的三种情况都要 abort，否则分片在 R2 默认 7 天中止前仍占用存储；
 * 自定义生命周期可能更长（binding 没有 listMultipartUploads，只能靠标记对象）：
 *   1. Worker 还没部署分片接口 —— 上层会退回单发 PUT，这个 uploadId 不会再被用到
 *   2. uploadId 作废 / 分片对不上（fatal）—— 再续也只会在 complete 那步失败
 *   3. 文件没有身份可校验（从 zip 解出来的 Blob）—— 本来就不支持续传
 */
async function explainFailure(err: unknown, ctx: Ctx, state: PendingUpload, total: number, resumable: boolean): Promise<unknown> {
  // 口令不对 / 过期是**可以修好**的，不能因此把已经传上去的分片扔掉 ——
  // 填对口令重新点一次就能接着传，abort 掉才是真的白传
  const authProblem = err instanceof UploadHttpError && (err.status === 401 || err.status === 403)
  const fatal =
    !authProblem &&
    (err instanceof MultipartUnsupportedError || (err instanceof UploadHttpError && (err.fatal || !retryable(err))))
  let cleanupConfirmed = true
  if (!resumable || fatal) {
    try {
      await abortUpload(ctx, state.key, state.uploadId, state.marker)
    } catch {
      cleanupConfirmed = false
    }
    clearState(state.key)
  } else {
    if (!flushPendingStateWrite(state.key)) saveState(state)
  }

  if (err instanceof MultipartUnsupportedError && cleanupConfirmed) return err
  const base = err instanceof Error ? err.message : String(err)
  const at = `已传 ${state.parts.length}/${total} 片`
  if (!cleanupConfirmed) return new Error(`${base}（${at}；自动清理未确认，请到「ROM 存储」检查残留分片）`)
  if (!resumable) return new Error(`${base}（${at}，这次的分片已清理）`)
  if (fatal) return new Error(`${base}（本次分片上传已作废，续传记录已清理，请重新上传）`)
  return new Error(`${base}（${at}；重新选同一个文件再点上传，会从第 ${state.parts.length + 1} 片继续）`)
}

/* ---------------- 残留清理（「ROM 存储」页用） ---------------- */

export interface OrphanUpload {
  marker: string
  key: string
  uploadId: string
  size: number
  name: string
  at: string
}

/**
 * 列出桶里所有未完成的分片上传。
 *
 * 数据来自 Worker 写的标记对象，所以**跨浏览器可见** ——
 * 本地那份 localStorage 记录只够自己续传，别人机器上失败留下的残留得靠这个才看得见。
 */
export async function listOrphanUploads(): Promise<OrphanUpload[]> {
  const api = getRomApi()
  const token = getRomToken()
  if (!api || !token) return []
  const uploads: OrphanUpload[] = []
  const seen = new Set<string>()
  let cursor = ''
  for (;;) {
    const url = `${api}/multipart${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
    // 老版本 Worker 没这个接口，当成「没有残留」，不要在页面上报错。
    if ((res.status === 404 || res.status === 405) && !cursor) return []
    if (!res.ok) throw explainRomStatus(res.status, '读取未完成的分片上传')
    const data = (await res.json()) as { uploads?: OrphanUpload[]; truncated?: boolean; cursor?: string }
    uploads.push(...(data.uploads ?? []))
    if (!data.truncated) return uploads.sort((a, b) => String(b.at).localeCompare(String(a.at)))
    if (!data.cursor || seen.has(data.cursor)) throw new Error('R2 残留列表分页中断；请刷新后重试，当前列表不完整')
    seen.add(data.cursor)
    cursor = data.cursor
  }
}

/** 放弃一次残留的分片上传：R2 里的分片和标记一起清掉，本地记录也顺手删了 */
export async function abortOrphanUpload(item: OrphanUpload): Promise<void> {
  const ctx: Ctx = { api: getRomApi(), token: getRomToken() }
  if (item.key && item.uploadId) {
    await abortUpload(ctx, item.key, item.uploadId, item.marker)
  } else if (item.marker) {
    // 标记里连 key 都没有（不该出现，除非被手工改过）：至少把标记删掉，别让列表永远清不空
    const data = await askJson<{ ok: boolean }>(ctx, `${ctx.api}/multipart?marker=${encodeURIComponent(item.marker)}`, { method: 'DELETE' }, '清理残留标记')
    if (data.ok !== true) throw new Error('Worker 未确认残留标记清理成功')
  }
  const local = readStore()[item.key]
  if (local?.uploadId === item.uploadId) clearState(item.key)
}
