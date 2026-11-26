/**
 * 加载进度：把「正在下载多少 / 共多少」从各个运行时里统一收上来。
 *
 * 为什么需要它：以前播放器只有「加载中…」一句话，玩家分不清是在下 200KB 的 NES ROM
 * 还是在下 NDS 核心的 wasm 和资源包 —— 后者在慢网络上要几十秒，
 * 期间画面全黑，看起来就像坏了。
 *
 * 能报真实字节数的只有「适配器自己去 fetch」的那几个（jsnes / jsdos / ruffle 的远程 SWF）。
 * iframe 型的引擎各有各的办法：webretro 同源，父窗口能读到它自己的 <progress>；
 * EmulatorJS 的下载全走 XHR，在 iframe 里把 XMLHttpRequest 包一层就能拿到字节数
 * （见 adapters/emulatorjs.ts 的 installProgressTap）—— 它自己那套文字进度 UI 我们
 * 一个字都不用碰，反正整个加载期间都被遮罩盖着。
 */
import { diagLog } from '@/services/startupDiagnostics'
import { memoryRomBlob, memoryRomOf } from '@/services/memoryRom'
import { rememberRomHostForUrl } from '@/services/romHosts'
import {
  isRomRouteOpen,
  rankRomRoutes,
  recordRomRouteFailure,
  recordRomRouteTransfer,
  romRouteEffectiveRate,
  romRouteHealthSummary,
  romRouteOrigin,
  romRouteRate,
  ROUTE_MIN_SAMPLE_BYTES,
} from '@/services/romRouteHealth'
import type { PlatformId } from '@/types'
import type { LoadPhase, LoadProgress, RuntimeId } from './types'
import {
  downloadResumeStore,
  type DownloadResumeSnapshot,
  type DownloadResumeStore,
} from './downloadResume'
import { windowsLaunchDelayMs, WINDOWS_GRAPHICS_SIGNAL_FALLBACK_MS, WINDOWS_LAUNCH_VERIFY_MS } from './windowsLaunch'

/** 进度回调节流：下载一个几十 MB 的 ROM 会触发上千次 chunk，全都 setState 会把主线程拖垮 */
const THROTTLE_MS = 120

export interface ProgressSink {
  (p: LoadProgress): void
}

/** 错误响应必须及时取消正文：R2/代理的 HTML 错误页或坏 Range 可能很大，不能在切备用源时继续占连接。 */
function validateResponse(res: Response, check?: (res: Response) => void): void {
  if (!res.ok) {
    void res.body?.cancel().catch(() => {})
    throw new Error(`HTTP ${res.status}`)
  }
  try {
    check?.(res)
  } catch (error) {
    void res.body?.cancel().catch(() => {})
    throw error
  }
}

/**
 * 包一层节流。同时保证两件事：
 *   - 第一帧立刻发出去，进度条不会先空着一段时间
 *   - 最后一帧（done=true）一定发得出去，不会停在 97% 上
 */
export function throttleProgress(sink: ProgressSink | undefined): (p: LoadProgress, flush?: boolean) => void {
  if (!sink) return () => {}
  let last = 0
  let first = true
  return (p, flush) => {
    const now = Date.now()
    if (flush || first || now - last >= THROTTLE_MS) {
      first = false
      last = now
      sink(p)
    }
  }
}

/**
 * 带进度的下载。
 *
 * 三种拿不到准确总量的情况都要兜住，否则进度条会卡死或者冲过头：
 *
 *   1. **没有 Content-Length**（分块传输、部分 CDN）——
 *      total 为 undefined，只报已下载字节，UI 转不确定态。
 *
 *   2. **响应被 gzip / br 压缩过** —— Content-Length 是**压缩后**的大小，
 *      而流里读出来的是**解压后**的字节，比例会冲过 100%。这里把 ratio 夹在 1 以内，
 *      并且一旦发现超了就把 total 抹掉转成不确定态，免得进度条先满了又继续走。
 *      （ROM 是二进制，正常不该被压缩，但 CDN 配错的情况见得多了。）
 *
 *   3. **浏览器不给 body 流**（极老的环境、某些 Service Worker 场景）——
 *      退回一次性 arrayBuffer()，只报开始和结束两帧。
 */

/**
 * 连续多久没有任何字节到达，就认定这次下载已经卡死（毫秒）。
 *
 * ⚠️ 这个看门狗补的是**最要命的一类缺陷**：`fetch` 本身**没有超时**。
 * 中间设备把连接静默丢掉（DROP 而不是 RST）时，浏览器不会报错，而是慢慢等 TCP
 * 超时 —— 实测三十几秒起步，有些网络下永远不来。这期间：
 *
 *   · 我们这条 `await` 永远不返回；
 *   · 没有任何进度事件，所以播放器那套「阶段预算」只会让条子自己慢慢爬；
 *   · 玩家看到的是永远转不完的加载遮罩，而且**没有任何错误可重试**。
 *
 * 30 秒取自本仓库自己的先例（systemSource 的系统镜像用 20s 首字节 / 25s 停滞）。
 * 正常情况下大文件是**持续有字节**的，只有真断了才会连续 30 秒一个字节都没有，
 * 所以这个阈值不会误伤慢网络。
 */
export const STALL_MS = 30_000
/** 普通网络取 256 KiB；明确弱网改取 128 KiB，避免慢线路上等太久才开始比较线路。 */
const FIRST_RANGE_SAMPLE_BYTES = 256 * 1024
const WEAK_NETWORK_FIRST_RANGE_SAMPLE_BYTES = 128 * 1024
/** 线路比速可以先用 64 KiB 同口径样本，不必等并发估算的完整样本。 */
const EARLY_ROUTE_SAMPLE_BYTES = 64 * 1024
/** 响应头已到、正文仍迟迟没有字节时，提前问同一对象的备用线路。 */
const EARLY_ROUTE_STALL_MS = 1_500
const ALTERNATE_ROUTE_SAMPLE_BYTES = 64 * 1024
const ALTERNATE_ROUTE_MIN_SAMPLE_BYTES = 32 * 1024
const ALTERNATE_ROUTE_SAMPLE_TIMEOUT_MS = 1_500
/** 首次线路探测没结果时，只有首片又多收了 512 KiB 才允许复测一次。 */
const ALTERNATE_ROUTE_REPROBE_BYTES = 512 * 1024
const ALTERNATE_ROUTE_MAX_PROBES = 2
const SLOW_ROUTE_MIN_FILE_BYTES = 512 * 1024
/** 和自适应并发的弱网档位保持一致；2G / 省流量设备不触发额外线路请求。 */
const SLOW_ROUTE_MIN_MBPS = 3
/**
 * 一个分片请求这么久还没回响应头，就在另一条线路上同时请求同一个 Range，谁的响应头先到用谁。
 * 2026-11-18《西游释厄传》浏览器实测：rom.8bitgo.com 建连卡了 11.4 秒，同一时刻 download.8bitgo.com 0.17 秒。
 * 实际延时取「这个值、6×RTT 提示、3×本次已见响应头耗时」中最大的，高 RTT 网络上不会每片都白发一份。
 */
const ROUTE_HEADERS_HEDGE_MS = 2_500
/** 尾部对冲：空出来的一路每隔这么久看一眼还在下的片 */
const TAIL_HEDGE_POLL_MS = 400
/** 预计还要这么久以上才下完的片才值得在另一条线路上重下 */
const TAIL_HEDGE_MIN_REMAINING_MS = 2_000
/** 比已知最快线路慢这么多的线路，不再分新片给它（对冲和失败换线仍可用它兜底） */
const SLOW_ROUTE_SHARE = 0.4

class SlowRomRouteError extends Error {
  readonly sampledMbps: number
  readonly elapsedMs: number
  readonly alternateMbps: number
  /** 实测更快的那条线路；外层整局换到它 */
  readonly route: string

  constructor(sampledMbps: number, elapsedMs: number, alternateMbps: number, route = '') {
    super(`首段吞吐 ${sampledMbps.toFixed(1)} Mbps，备用线路 ${alternateMbps.toFixed(1)} Mbps`)
    this.name = 'SlowRomRouteError'
    this.sampledMbps = sampledMbps
    this.elapsedMs = elapsedMs
    this.alternateMbps = alternateMbps
    this.route = route
  }
}

interface StallGuard {
  signal: AbortSignal
  /** 每收到一块数据就调一次，重新计时 */
  touch(): void
  /** 这次中止是「卡死」引起的吗（用来把 AbortError 换成玩家看得懂的话） */
  stalled(): boolean
  /** 只停计时、摘掉父 signal 的监听；成功返回时用，不打断任何请求 */
  stop(): void
  /**
   * 失败收尾用：中止这只看门狗名下仍在跑的请求（首片测速后抢先发出的后续分片等）。
   * 只调 stop() 的话，这些请求既不会再被卡死计时掐掉，也收不到调用方的 abort（父监听已摘），
   * 首片永久失败后还会在后台把几片 8MB 下完。不算「卡死」，stalled() 仍是 false。
   */
  abort(): void
}

/**
 * 包一层「多久没字节就动手掐掉」。
 *
 * 掐断用的是内部的 AbortController：调用方自己的 signal 另接一路，
 * 两者都中止同一个请求，但**能不能分辨是谁掐的**很关键 ——
 * 玩家离开页面时我们照旧抛 AbortError（上层当「取消」处理，不报错），
 * 卡死时则抛一条带原因的错，让遮罩变成可以重试的错误态。
 */
function createStallGuard(parent: AbortSignal | undefined, stallMs: number): StallGuard {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let didStall = false
  const abortFromParent = () => controller.abort()

  const clear = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const touch = () => {
    clear()
    timer = setTimeout(() => {
      didStall = true
      controller.abort()
    }, stallMs)
  }
  if (parent) {
    if (parent.aborted) controller.abort()
    else parent.addEventListener('abort', abortFromParent, { once: true })
  }

  return {
    signal: controller.signal,
    touch,
    stalled: () => didStall,
    stop: () => {
      clear()
      parent?.removeEventListener('abort', abortFromParent)
    },
    abort: () => {
      clear()
      controller.abort()
    },
  }
}

/*
  ROM 下载的「网络层失败」（断网、连接被重置、DNS / TLS 失败、卡死没字节）：
  重试和备用线路都用完了才会抛到调用方。它和「文件坏了 / 404 / 格式不对」是两回事 ——
  换另一种语言的 ROM 走的是同一条网络，只会把整条语言链逐个白下一遍（AGENTS §2.35）。
  调用方据此把错误标成 'network'，播放器只允许切同语言的备用源。
*/
const networkFailures = new WeakSet<object>()
const romContentFailures = new WeakSet<object>()
const NETWORK_FAILURE_TEXT = /failed to fetch|networkerror|network error|load failed|fetch failed|network connection was lost|err_[a-z_]*(?:network|connection|internet|timed_out|http2)|^HTTP (?:408|425|429|5\d\d)\b|^下载不完整：/i

export function markRomNetworkFailure<T>(error: T): T {
  if (error && typeof error === 'object') networkFailures.add(error as object)
  return error
}

export function markRomContentFailure<T>(error: T): T {
  if (error && typeof error === 'object') romContentFailures.add(error as object)
  return error
}

export function isRomContentFailure(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && romContentFailures.has(error as object))
}

/** 这个错误是 ROM 传输的网络层失败吗（见上）；文本兜底兼容跨 iframe / 下载器包装后丢掉原异常类型的情况。 */
export function isRomNetworkFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if (networkFailures.has(error)) return true
  const message = String((error as { message?: unknown }).message ?? '')
  if (/\bHTTP (?:408|425|429|5\d\d)\b|读盘失败：期望 206，实际 (?:408|425|429|5\d\d)\b/i.test(message)) return true
  if (/下载连接长时间没有数据/i.test(message)) return true
  if (NETWORK_FAILURE_TEXT.test(message)) return true
  return message.startsWith(STALL_MESSAGE_PREFIX)
}

/** 卡死时统一这条文案：说清楚是「一个字节都没再来」，而不是笼统的网络错误 */
const STALL_MESSAGE_PREFIX = '下载卡住了：'
const stallMessage = (stallMs: number) => `${STALL_MESSAGE_PREFIX}${Math.round(stallMs / 1000)} 秒没有收到任何数据`
export async function fetchWithProgress(
  url: string,
  opts: {
    phase?: LoadPhase
    onProgress?: ProgressSink
    signal?: AbortSignal
    /** 拿到响应头之后的校验钩子，比如挡掉返回 HTML 的错误页 */
    check?: (res: Response) => void
    /** 需要整块 ArrayBuffer 的调用方可设上限，防止未知长度的响应耗尽标签页内存。 */
    maxBytes?: number
    /** 外站包装 ZIP 不应另留一份 HTTP 缓存，真正缓存的是解出的 ROM。 */
    cache?: RequestCache
    /** 同一个本站 R2 对象的备用域名；只有当前来源失败时才依次尝试。 */
    alternateUrls?: readonly string[]
    /** 覆盖「多久没字节算卡死」，只给测试用 */
    stallMs?: number
  } = {},
): Promise<ArrayBuffer> {
  const phase = opts.phase ?? 'rom'
  const progress = throttleProgress(opts.onProgress)
  let highWater = 0
  const emit = (value: LoadProgress, flush = false) => {
    highWater = Math.max(highWater, value.loaded ?? 0)
    return progress({ ...value, loaded: highWater, ratio: value.total ? Math.min(highWater / value.total, 1) : value.ratio }, flush)
  }
  const stallMs = opts.stallMs ?? STALL_MS
  const candidates = [url, ...new Set((opts.alternateUrls ?? []).filter((candidate) => candidate && candidate !== url))]
  emit({ phase, loaded: 0 }, true)

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]
    const guard = createStallGuard(opts.signal, stallMs)
    // 首字节也要有期限：连接建立不起来 / 服务端不回响应头，是和「传一半停住」不同的病。
    guard.touch()
    try {
      const res = await fetch(candidate, { signal: guard.signal, ...(opts.cache ? { cache: opts.cache } : {}) })
      validateResponse(res, opts.check)

      const encoded = Boolean(res.headers.get('content-encoding'))
      const len = Number(res.headers.get('content-length'))
      // 压缩过的响应，Content-Length 对不上解压后的字节数，直接当作未知总量
      const total = !encoded && Number.isFinite(len) && len > 0 ? len : undefined
      if (total !== undefined && total > (opts.maxBytes ?? Infinity)) {
        void res.body?.cancel().catch(() => {})
        // 已经超过硬上限，换节点重试只会再白下同样多字节；让调用方立刻止损。
        throw new RangeError('文件过大，无法在浏览器内存中解包')
      }

      if (!res.body) {
        const buf = await res.arrayBuffer()
        if (buf.byteLength > (opts.maxBytes ?? Infinity)) throw new RangeError('文件过大，无法在浏览器内存中解包')
        if (total !== undefined && buf.byteLength !== total) {
          throw new Error(`下载不完整：应为 ${total} 字节，实际收到 ${buf.byteLength} 字节`)
        }
        emit({ phase, loaded: buf.byteLength, total: buf.byteLength, ratio: 1 }, true)
        return buf
      }

      const { chunks, loaded } = await drain(res.body, phase, total, emit, opts.maxBytes, guard.touch)
      const out = new Uint8Array(loaded)
      let at = 0
      for (const c of chunks) {
        out.set(c, at)
        at += c.byteLength
      }
      emit({ phase, loaded, total: loaded, ratio: 1 }, true)
      return out.buffer
    } catch (error) {
      // 失败收尾：掐掉还挂着的响应体（校验失败 / 超上限后不再读），别让它在后台继续占连接。
      // 只中止本看门狗自己的 controller，stalled() 的判定不受影响。
      guard.abort()
      let failure: unknown = error
      if (guard.stalled()) failure = markRomNetworkFailure(new Error(stallMessage(stallMs)))
      else if (isNetworkFetchError(failure) && NETWORK_FAILURE_TEXT.test(String((failure as Error).message))) markRomNetworkFailure(failure)
      if (opts.signal?.aborted || failure instanceof RangeError || index === candidates.length - 1) throw failure
      const host = (value: string) => {
        try { return new URL(value, typeof location === 'undefined' ? 'https://8bitgo.invalid' : location.href).host }
        catch { return value }
      }
      console.warn(`[download] ${host(candidate)} 下载失败，切换到 ${host(candidates[index + 1])}：`, failure)
    } finally {
      guard.stop()
    }
  }
  throw new Error('没有可用的下载来源')
}

/**
 * 把响应流读成分片，边读边报进度。fetchWithProgress 和 fetchBlobWithProgress 共用。
 *
 * 抽出来不是为了少写几行，是因为**下载完整性那道校验**必须两条路都有：
 * 浏览器通常会把 Content-Length 不足变成网络异常，但代理 / Service Worker 自造的
 * Response 不一定如此。少了这道口，「流正常结束」就会被当成「文件完整」，
 * 玩家拿到半截 ROM，核心报的却是「格式错误」——查起来完全指错方向。
 */
async function drain(
  body: ReadableStream<Uint8Array>,
  phase: LoadPhase,
  totalHint: number | undefined,
  emit: (p: LoadProgress, flush?: boolean) => void,
  maxBytes = Infinity,
  touch?: () => void,
): Promise<{ chunks: Uint8Array[]; loaded: number }> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = totalHint
  let loaded = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      // 有字节到达就推迟「卡死」判定：卡死看的是**流停了**，不是**流慢**
      touch?.()
      if (loaded + value.byteLength > maxBytes) {
        // 真实流量越过硬上限时不能把同一份畸形回包当瞬时网络错误反复重下。
        throw new RangeError('文件过大，无法在浏览器内存中解包')
      }
      chunks.push(value)
      loaded += value.byteLength
      // 万一还是超了（服务器给的 Content-Length 本身就不对），转不确定态而不是显示 120%
      if (total !== undefined && loaded > total) total = undefined
      // 进度回调只更新同步状态；逐网络块 await 一个 void 会额外排微任务，拖慢大 ROM 的流读取。
      emit({ phase, loaded, total, ratio: total ? Math.min(loaded / total, 1) : undefined })
    }
    if (total !== undefined && loaded !== total) {
      throw new Error(`下载不完整：应为 ${total} 字节，实际收到 ${loaded} 字节`)
    }
    return { chunks, loaded }
  } catch (error) {
    // Chromium 的磁盘缓存 / IDB Blob 偶发 NotReadableError 时要释放坏流，重试才不会留住旧文件引用。
    await reader.cancel(error).catch(() => {})
    throw error
  } finally {
    try { reader.releaseLock() } catch { /* 已被浏览器释放时无需再处理 */ }
  }
}

/**
 * 带进度的下载，但**结果是 Blob，不是 ArrayBuffer**。
 *
 * ── 为什么要有这个分身 ──────────────────────────────────────
 * 光盘镜像（PS1 一张几百 MB，PS2 一张几 GB）不能走 ArrayBuffer 那条路。
 * `new Uint8Array(loaded)` 要的是一整块**连续**内存，几百 MB 的连续分配在手机上
 * 本来就容易失败；更要命的是它之后还要再拷一份进 Blob、引擎再 XHR 回来一份，
 * 峰值内存是文件本身的两三倍 —— 一张 700MB 的盘足够让移动端浏览器直接把标签页杀掉。
 *
 * `new Blob(chunks)` 不需要连续内存，浏览器还会把大 Blob 落到磁盘上。
 * 这样从下载到交给引擎，全程只有分片在内存里待过。
 *
 * ⚠️ 小 ROM 不要改用这个：卡带机那几 MB 走 ArrayBuffer 更直接，
 * 而且 jsnes / js-dos 那几个适配器本来就要字节本体去嗅探格式。
 */
export interface BlobFetchOptions {
  phase?: LoadPhase
  onProgress?: ProgressSink
  signal?: AbortSignal
  check?: (res: Response) => void
  /** Blob 的 MIME。引擎那边只看扩展名，这里给什么都不影响解析 */
  type?: string
  /** 分片大小。默认 CHUNK_BYTES，测试里调小好造多片场景 */
  chunkBytes?: number
  /** 单片最多重试几次。默认 CHUNK_RETRIES */
  retries?: number
  /** 注入 fetch，只给测试用 */
  fetchImpl?: typeof fetch
  /** 覆盖「多久没字节算卡死」，只给测试用 */
  stallMs?: number
  /** 下载前就限制响应总量；不能等完整 Blob 到手后才让格式校验发现异常大文件。 */
  maxBytes?: number
  /**
   * 同一对象在另一条 CDN 线路上的地址（romHosts.ts 的 alternateRomUrl）。首段采样（普通 256 KiB、弱网提示下 128 KiB）吞吐低于 3Mbps
   * 且备用线路实测快 15%，或当前线路重试用尽时，整局改用这里；断点分片按 resumeKey 存，已下的片不重下。
   */
  alternateUrl?: string
  /** 同一本站 R2 对象的额外备用域名；alternateUrl 仍作为兼容的单线路备用。 */
  alternateUrls?: readonly string[]
  /** 外站 ZIP 的完整归档不留 HTTP 副本；续传片由独立 IndexedDB 管。 */
  cache?: RequestCache
  /**
   * 带内容版本的持久化键。设置后，完整分片会落进临时 IndexedDB，刷新页面只补缺失片。
   * 没有可靠版本号时必须留空，否则同一个 URL 被覆盖后可能把两代 ROM 拼在一起。
   */
  resumeKey?: string
  /** 注入临时分片仓库，只给测试用；生产默认使用 downloadResumeStore。 */
  resumeStore?: DownloadResumeStore
  /**
   * 整份不超过这个字节数时，结果留在 JS 内存里（memoryRomBlob 替身），全程一个真 Blob 都不建；
   * 超过的照常走 Blob —— 宁可让那一份按老路失败，也不把几百 MB 放进 JS 内存让标签页被杀。
   * 设了它就不写续传片（续传片本身就是 IndexedDB 里的 Blob）。
   *
   * 2026-11-15 大陆华为浏览器 17 / Android 9《拳皇 97 风云再起 Plus》两次访问 5 局：ROM 每次都下完，
   * 一读就 NotReadableError；作废续传片、不带续传整包重下后，`new Blob(网络分片)` 照样读不出 ——
   * 这台浏览器的 Blob 存储本身坏了，只有不经过 Blob 才能开局。
   */
  inMemoryUpTo?: number
  /**
   * 自适应并发的硬上限。生产默认最多四路；测试可设成 1 固定旧的串行时序。
   * 这不是“越大越快”：每一路都可能暂存一个完整分片，低内存设备还会被运行时提示继续压低。
   */
  maxConcurrency?: number
  /** 注入浏览器网络提示，只给纯函数回归与不实现 Network Information API 的测试环境使用。 */
  networkHints?: ChunkNetworkHints
  /**
   * 线路记分板（services/romRouteHealth.ts）：记下每条线路的真实吞吐与故障，开局按它选线路；
   * 带 romv 的同一对象还会按它把分片分到几条线路上、慢片换线路对冲、失败片换线路重试。
   * 默认开；注入 fetchImpl 的测试默认关，免得假域名写进记分板、打乱测试固定的请求顺序。
   */
  routeHealth?: boolean
  /** 覆盖「响应头多久没到就去另一条线路」，同时缩短尾部对冲的判定门槛；只给测试用 */
  routeHedgeMs?: number
}

/** 外层交给每一轮下载的线路池（当前线路 + 尚未放弃的备用线路），不对外暴露 */
type GuardedFetchOptions = BlobFetchOptions & { routePool?: readonly string[] }

/**
 * 同一对象的几种线路写法里，哪些可以**混着取分片**：路径和查询串（含 romv）完全一样、只差域名。
 * romv 是对象 ETag，Worker 对版本不符的请求回 412，所以带 romv 的几条线路给出的字节必然一致；
 * 不带 romv 的地址绝不混片（R2 原地换包时会把两代 ROM 拼在一起），只做整局换线路。
 */
export function sameObjectRoutes(url: string, candidates: readonly string[]): string[] {
  const identity = (value: string) => {
    try {
      const parsed = new URL(value)
      return parsed.searchParams.get('romv') ? `${parsed.pathname}${parsed.search}` : ''
    } catch {
      return ''
    }
  }
  const self = identity(url)
  if (!self) return [url]
  const seen = new Set([romRouteOrigin(url)])
  const pool = [url]
  for (const candidate of candidates) {
    const origin = romRouteOrigin(candidate)
    if (!origin || seen.has(origin) || identity(candidate) !== self) continue
    seen.add(origin)
    pool.push(candidate)
  }
  return pool
}

export interface ChunkNetworkHints {
  saveData?: boolean
  effectiveType?: string
  downlinkMbps?: number
  rttMs?: number
  deviceMemoryGb?: number
  hardwareConcurrency?: number
}

/**
 * 一片多大。8MB 是在「重传代价」和「请求开销」之间取的：
 * 断一次只白下 8MB，而一张 600MB 的盘也才 75 个请求，HTTP/2 下开销可以忽略。
 */
export const CHUNK_BYTES = 8 * 1024 * 1024
/** 先限制分片表长度：错误的 Content-Range / 本地续传记录不能让 Array.from 直接耗尽标签页。 */
const MAX_BLOB_PARTS = 16_384

export interface BlobChunkWarmOptions {
  /** 必须是内容寻址的键；热区片和正式下载会按这个键安全接续。 */
  resumeKey: string
  /** 已由后台元数据核实的对象大小；预热不信服务器自报的另一个总长。 */
  expectedBytes: number
  /** 预热前几个顺序分片；仅用于首读热点，绝不在悬停时偷下整张盘。 */
  chunks?: number
  chunkBytes?: number
  fetchImpl?: typeof fetch
  resumeStore?: DownloadResumeStore
  cache?: RequestCache
  /** 第一片可额外核验格式头；失败时整组临时片作废。 */
  checkPart?: (blob: Blob, index: number) => Promise<void> | void
  /** 覆盖预热网络停滞时限；仅供回归测试缩短等待。 */
  stallMs?: number
}

/** 同一块 CHD 被快速进出 / 多个按钮事件触发时只保留一组热区请求。 */
const blobChunkWarmTasks = new Map<string, Promise<void>>()
const blobChunkWarmControllers = new Map<string, AbortController>()

/**
 * 把大文件最先会读到的少量 Range 片提前落进续传仓库。
 *
 * 这不是“边下边玩”：调用方仍须完整下载才能把媒体塞进 EmulatorJS 的 MEMFS。它的作用是
 * 把桌面端悬停开始按钮的几百毫秒至数秒空档，变成下一次正式下载可复用的首段字节；首片同时
 * 验证 Range 能力，服务端若忽略 Range（200）立即取消，绝不偷偷把整张 CHD 当预热下完。
 */
export function prewarmBlobChunks(url: string, opts: BlobChunkWarmOptions): Promise<void> {
  const chunkBytes = opts.chunkBytes ?? CHUNK_BYTES
  const chunks = opts.chunks ?? 1
  const key = opts.resumeKey
  if (!url || !key || !Number.isSafeInteger(opts.expectedBytes) || opts.expectedBytes <= 0 ||
      !Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || !Number.isInteger(chunks) || chunks <= 0) {
    return Promise.resolve()
  }
  const existing = blobChunkWarmTasks.get(key)
  if (existing) return existing

  const warmController = new AbortController()
  const task = (async () => {
    const store = opts.resumeStore ?? downloadResumeStore
    let snapshot: DownloadResumeSnapshot | null = null
    try {
      const loaded = await withResumeTimeout(store.load(key, chunkBytes), RESUME_LOAD_TIMEOUT_MS)
      if (loaded === RESUME_TIMED_OUT) return
      snapshot = loaded
      if (snapshot && snapshot.total !== opts.expectedBytes) {
        const cleared = await withResumeTimeout(store.clear(key), RESUME_CLEAR_TIMEOUT_MS)
        if (cleared === RESUME_TIMED_OUT) return
        snapshot = null
      }
    } catch {
      // 预热只是加速。储存层坏了时不要再发 Range，免得白下又无处复用。
      return
    }

    const count = Math.ceil(opts.expectedBytes / chunkBytes)
    if (count > MAX_BLOB_PARTS) return
    const wanted = Math.min(chunks, count)
    const fetcher = opts.fetchImpl ?? fetch
    for (let index = 0; index < wanted; index += 1) {
      if (snapshot?.parts.has(index)) continue
      const start = index * chunkBytes
      const end = Math.min(opts.expectedBytes, start + chunkBytes) - 1
      const guard = createStallGuard(warmController.signal, opts.stallMs ?? STALL_MS)
      guard.touch()
      try {
        const response = await fetcher(url, {
          signal: guard.signal,
          headers: { Range: `bytes=${start}-${end}` },
          ...(opts.cache ? { cache: opts.cache } : {}),
        })
        // 不支持 Range 的 CDN 可能已经开始返回整份 CHD；取消正文，绝不能让悬停变成全盘下载。
        if (!response.ok || response.status !== 206) {
          await response.body?.cancel().catch(() => {})
          return
        }
        const range = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') ?? '')
        if (!range || Number(range[1]) !== start || Number(range[2]) !== end || Number(range[3]) !== opts.expectedBytes) {
          await response.body?.cancel().catch(() => {})
          return
        }
        const declared = response.headers.get('content-length')
        if (declared !== null && Number(declared) !== end - start + 1) {
          await response.body?.cancel().catch(() => {})
          return
        }
        if (!response.body) return
        const reader = response.body.getReader()
        const pieces: Uint8Array[] = []
        let received = 0
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (!value || received + value.byteLength > end - start + 1) throw new Error('热区分片长度异常')
            guard.touch()
            pieces.push(value)
            received += value.byteLength
          }
        } catch {
          await reader.cancel().catch(() => {})
          return
        } finally {
          reader.releaseLock()
        }
        // 存盘与格式校验不是网络等待，停止网络看门狗，避免慢存储被错报成线路故障。
        guard.stop()
        if (warmController.signal.aborted || received !== end - start + 1) return
        const part = new Blob(pieces as BlobPart[])
        try {
          await opts.checkPart?.(part, index)
          const saved = await withResumeTimeout(
            store.put(key, opts.expectedBytes, chunkBytes, index, part),
            RESUME_PUT_TIMEOUT_MS,
          )
          if (saved === false || saved === RESUME_TIMED_OUT) return
        } catch {
          // 第一片格式不符时不能留给正式下载拼接；其余失败只是本轮预热无收益。
          await withResumeTimeout(store.clear(key), RESUME_CLEAR_TIMEOUT_MS).catch(() => {})
          return
        }
      } catch {
        // 预热只是加速。停滞、坏响应或读取失败都交给点击后的完整下载处理。
        return
      } finally {
        guard.stop()
      }
    }
  })().finally(() => {
    if (blobChunkWarmTasks.get(key) === task) blobChunkWarmTasks.delete(key)
    if (blobChunkWarmControllers.get(key) === warmController) blobChunkWarmControllers.delete(key)
  })
  blobChunkWarmTasks.set(key, task)
  blobChunkWarmControllers.set(key, warmController)
  return task
}

/**
 * ⚠️ 小文件不需要特判：第一个 Range 请求要的就是 `bytes=0-<片长-1>`，
 * 比这短的文件一次就回全了，循环一次都不进。所以这里没有「多大以上才分片」的阈值。
 *
 * 这条路用于光盘、NDS、街机及带版本的大文件（见 adapters/emulatorjs.ts 的 prepareRemoteDiscRom）；
 * 其它小卡带 ROM 仍走 loadGameBytes 的 ArrayBuffer 路径，一个字节都不受影响。
 */

/** 单片重试次数。三次退避（0.5s / 1s / 2s）足够熬过一次 Wi-Fi 切换 */
export const CHUNK_RETRIES = 3
/**
 * 网络层失败（fetch 抛 TypeError：「Failed to fetch」、连接被重置、断网）另给更长的窗口：
 * 0.5 / 1 / 2 / 4 / 8 秒，合计约 15 秒。2026-11-10 墨西哥玩家《合金弹头 3》第二次开局 8.4 秒就失败，
 * 三次 3.5 秒的退避连一次线路抖动都熬不过。只在调用方没指定 retries 时生效。
 */
export const NETWORK_RETRIES = 5
const isNetworkFetchError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false
  if ((error as { name?: unknown }).name === 'TypeError') return true
  // 服务端暂时不可用与传输中断一样，不该被当成坏 ROM 去切其它语言；让同对象的线路重试耗尽后停止。
  return NETWORK_FAILURE_TEXT.test(String((error as { message?: unknown }).message ?? ''))
}

const MAX_CHUNK_CONCURRENCY = 4
/**
 * 网络与 IndexedDB 写盘重叠，但最多只允许两笔写入排队。
 * 不设上限会在高速网络 + 慢闪存上堆出几十个 8MB 事务，最后反过来挤掉模拟器启动所需内存。
 */
const RESUME_WRITE_BACKLOG = 2
/*
 * 断点续传仓库（IndexedDB / OPFS）的每次等待都要有上限。2026-11-11 大陆 Windows Chrome 132《植物大战僵尸》NDS：
 * ROM 152 秒下完、进度报 100%，之后 120 秒没有任何动静，被看门狗判超时；同一浏览器的 IndexedDB 早被引擎缓存判过挂死。
 * 收尾的 flushPartSaves 要等最后两笔写盘，而 put 的事务在坏掉的库上永不 complete，整局就停在这里。
 * 续传只是优化：等不到就本局放弃续传、改走内存，绝不能挡住开局。
 */
const RESUME_LOAD_TIMEOUT_MS = 8_000
const RESUME_PUT_TIMEOUT_MS = 15_000
const RESUME_CLEAR_TIMEOUT_MS = 5_000
export const RESUME_TIMED_OUT = Symbol('resume-timeout')

/** 探一个 Blob 的首尾字节能不能读出来；IDB 背后的文件丢了或损坏时会抛 NotReadableError。 */
export async function blobReadable(blob: Blob): Promise<boolean> {
  if (!blob.size) return true
  try {
    await blob.slice(0, 1).arrayBuffer()
    if (blob.size > 1) await blob.slice(blob.size - 1).arrayBuffer()
    return true
  } catch {
    return false
  }
}

/** 带上限地等一个续传仓库操作；超时返回 RESUME_TIMED_OUT。定时器必须清掉，否则快的那次也会在稍后被当成超时。 */
export async function withResumeTimeout<T>(task: Promise<T>, ms: number): Promise<T | typeof RESUME_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<typeof RESUME_TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(RESUME_TIMED_OUT), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 第一片本来就必须下载；用前 256 KiB（明确弱网提示下 128 KiB）的真实吞吐决定后续并发，不另发一份测速流量。
 *
 * 并发的目标是藏住高 RTT、丢包和单连接拥塞窗口，不是假设带宽可以凭空变多。因此弱网、省流量
 * 和低内存设备主动收缩；快网也最多四路，把瞬时 Blob 内存限制在 4 × 8 MiB 左右。
 */
export function adaptiveChunkConcurrency(
  sampleBytes: number,
  elapsedMs: number,
  hints: ChunkNetworkHints = {},
): number {
  const effectiveType = String(hints.effectiveType ?? '').toLowerCase()
  if (hints.saveData || effectiveType === 'slow-2g' || effectiveType === '2g') return 1

  const sampledMbps = sampleBytes > 0 && elapsedMs > 0
    ? (sampleBytes * 8) / (elapsedMs * 1000)
    : 0
  const hintedMbps = Number.isFinite(hints.downlinkMbps) ? Math.max(0, hints.downlinkMbps ?? 0) : 0
  const mbps = sampledMbps || hintedMbps
  const rtt = Number.isFinite(hints.rttMs) ? Math.max(0, hints.rttMs ?? 0) : 0

  let concurrency = 2
  /*
    有真实样本时以样本为准，浏览器的 effectiveType 只在没测到时兜底（2026-11-18《西游释厄传》实测）：
    Chrome 报 effectiveType=3g、downlink=1.25，同一时刻单连接正文实测约 9.5 Mbps —— 它是按历史请求粗估的，
    一个慢请求就能拖低。以前只要报 3g 就压成单路，21.9MB 的 ROM 三个分片串行下了约 20 秒。
    省流量 / 2G 仍在上面直接单路，不受样本影响。
  */
  const slowHint = sampledMbps > 0 ? false : effectiveType === '3g'
  if (slowHint || (mbps > 0 && mbps < 3)) concurrency = 1
  // Firefox / Safari 没有 Network Information API，rtt=0 代表“未知”而不是“很差”。
  // 已经拿到首个真实分片的高速样本时，不能因为缺这一条提示永远卡在三路。
  else if (mbps >= 24 && (rtt === 0 || rtt < 180)) concurrency = 4
  else if (mbps >= 8 || rtt >= 180) concurrency = 3

  // 并行 Range 会让每一路同时持有一个子 Blob；小内存 / 双核设备宁可少占内存，也不赌标签页被杀。
  if ((hints.deviceMemoryGb ?? Infinity) <= 2 || (hints.hardwareConcurrency ?? Infinity) <= 2) {
    concurrency = Math.min(concurrency, 2)
  }
  return Math.max(1, Math.min(MAX_CHUNK_CONCURRENCY, concurrency))
}

function browserChunkNetworkHints(): ChunkNetworkHints {
  if (typeof navigator === 'undefined') return {}
  const nav = navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string; downlink?: number; rtt?: number }
    deviceMemory?: number
  }
  return {
    saveData: nav.connection?.saveData,
    effectiveType: nav.connection?.effectiveType,
    downlinkMbps: nav.connection?.downlink,
    rttMs: nav.connection?.rtt,
    deviceMemoryGb: nav.deviceMemory,
    hardwareConcurrency: nav.hardwareConcurrency,
  }
}

/** 弱网先用较短样本判断线路；高 RTT 且带宽未知时也缩短，但不把已知高速网络误判成低吞吐。 */
function firstRangeSampleBytes(hints: ChunkNetworkHints): number {
  const effectiveType = String(hints.effectiveType ?? '').toLowerCase()
  const downlink = Number.isFinite(hints.downlinkMbps) ? Math.max(0, hints.downlinkMbps ?? 0) : 0
  const rtt = Number.isFinite(hints.rttMs) ? Math.max(0, hints.rttMs ?? 0) : 0
  const weakNetwork = effectiveType === 'slow-2g' || effectiveType === '2g' || effectiveType === '3g' ||
    (downlink > 0 && downlink < 1.5) || (rtt >= 800 && downlink < 3)
  return weakNetwork ? WEAK_NETWORK_FIRST_RANGE_SAMPLE_BYTES : FIRST_RANGE_SAMPLE_BYTES
}

const monotonicNow = () => typeof performance !== 'undefined' ? performance.now() : Date.now()

export const abortableDelay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('已取消', 'AbortError'))
      return
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: DOMException) => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const onAbort = () => finish(new DOMException('已取消', 'AbortError'))
    timer = setTimeout(() => finish(), ms)
    signal?.addEventListener('abort', onAbort, { once: true })
    // 防止调用方在上面的初检与监听注册之间取消。
    if (signal?.aborted) onAbort()
  })

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

/**
 * 带进度的下载，结果是 **Blob**，大文件自动分片 + 断点重传。
 *
 * ── 为什么不是 ArrayBuffer ──────────────────────────────────
 * 光盘镜像（PS1 一张几百 MB）不能走 ArrayBuffer 那条路：`new Uint8Array(loaded)` 要的是
 * 一整块**连续**内存，几百 MB 的连续分配在手机上本来就容易失败；更要命的是它之后还要
 * 再拷一份进 Blob、引擎再 XHR 回来一份，峰值是文件的两三倍。
 *
 * ── 为什么要分片 ────────────────────────────────────────────
 * 分片首先买到断点续传与内存封顶；首片 256 KiB 的真实吞吐决定后续开 1～4 路。测速通过后，
 * 大文件会提前并行取下一块完整 8 MiB Range，避免首片下完前网络空等。HTTP/2 复用时并发未必增加总带宽，
 * 所以绝不固定四路硬冲：
 *
 *   1. **断了不用从头来**。600MB 下到 95% 遇上一次 TCP reset / Wi-Fi 切 4G /
 *      代理超时，原来整个从 0 重来。现在只白下那 8MB。
 *      上传那边（services/romMultipart.ts）早就是这么干的，下载这边一直没有对等的东西。
 *   2. **内存封顶**。每片下完先合成一个子 Blob（浏览器会把大 Blob 落到磁盘），
 *      分片数组随即丢掉。峰值从「整个文件」降到「当前一至四片」。
 *
 * ⚠️ 第一个请求就带 `Range: bytes=0-<片长>`，**它既是探测也是第一片**：
 * 回 206 说明支持分片，`Content-Range` 顺带给出整份大小；回 200 说明服务器不认 Range，
 * 那就把这一条响应当整份读完（退回老路，一样能用）。用 HEAD 探不可靠 ——
 * 有些 CDN 对 HEAD 回 200 且带 Accept-Ranges，真发 Range 时却整份吐出来。
 */
export async function fetchBlobWithProgress(url: string, opts: BlobFetchOptions = {}): Promise<Blob> {
  // 玩家已点击开局：停止同一内容键上仍未完成的悬停预读，避免和正式 Range 请求重复占网。
  if (opts.resumeKey) blobChunkWarmControllers.get(opts.resumeKey)?.abort()
  const stallMs = opts.stallMs ?? STALL_MS
  const retries = opts.retries ?? CHUNK_RETRIES
  let highWater = 0
  const guardedOpts: BlobFetchOptions = opts.onProgress
    ? {
        ...opts,
        // 超时重试会重新进入下载器；进度不能因此从已完成的 80MB 倒退到 0。
        onProgress: (progress) => {
          highWater = Math.max(highWater, progress.loaded ?? 0)
          opts.onProgress?.({
            ...progress,
            loaded: highWater,
            ratio: progress.total ? Math.min(highWater / progress.total, 1) : progress.ratio,
          })
        },
      }
    : opts
  /*
    一只看门狗管一次下载尝试；普通网络错误由分片循环重试，卡死则必须换一只新的
    AbortController 才能重试（已经 abort 的 signal 永远不会复活）。

    这里的外层重试很重要：卡死可能发生在第一片，也可能发生在已下了几百 MB 之后。
    带 resumeKey 时，已完成分片已经落进 IndexedDB，新尝试只补缺片；不带持久化键时
    至少仍会自动再试，而不是让 fetch 永久挂住。退避与普通分片一致。
  */
  let currentUrl = url
  let alternates = [...new Set([...(opts.alternateUrls ?? []), opts.alternateUrl ?? ''].filter((candidate) => candidate && candidate !== url))]
  const trackHealth = opts.routeHealth ?? !opts.fetchImpl
  /*
    记分板认定原地址那条线路正在熔断、或真实吞吐明显更慢时，开局就换到排第一的那条（整局换，不混片，
    所以不带 romv 的地址也可以）。以前要等这一局首段测速或重试用光才换，每一局都先撞一次坏线路。
  */
  if (trackHealth && alternates.length) {
    const ranked = rankRomRoutes([url, ...alternates])
    if (ranked[0] !== url) {
      diagLog('download', 'info', `ROM 线路按记分板改走 ${romRouteOrigin(ranked[0])}（${romRouteHealthSummary() || '无记录'}）`)
      currentUrl = ranked[0]
      alternates = ranked.slice(1)
    }
  }
  const useNextRoute = (preferred = '') => {
    const at = preferred ? alternates.indexOf(preferred) : -1
    currentUrl = at >= 0 ? alternates.splice(at, 1)[0] : alternates.shift()!
  }
  for (let attempt = 0; ; attempt++) {
    const guard = createStallGuard(opts.signal, stallMs)
    guard.touch()
    let failure: unknown = null
    let switchForSpeed = false
    try {
      const blob = await blobWithProgressGuarded(
        currentUrl,
        { ...guardedOpts, alternateUrl: alternates[0] ?? '', routePool: [currentUrl, ...alternates] },
        guard,
      )
      if (currentUrl !== url) rememberRomHostForUrl(currentUrl)
      return blob
    } catch (error) {
      // 这一轮失败了：先掐掉看门狗名下还在跑的请求（首片失败后仍在下的提前分片），
      // 再决定重试 / 换线路 / 抛出。成功路径不走这里，不会误伤。
      guard.abort()
      if (trackHealth && guard.stalled()) recordRomRouteFailure(currentUrl, 'stall')
      if (opts.signal?.aborted || isAbort(error) && !guard.stalled()) throw error
      // 超过上限是这个对象本身的问题，换线路也一样
      if (error instanceof RangeError) throw error
      if (error instanceof SlowRomRouteError && alternates.length) {
        failure = error
        switchForSpeed = true
      } else if (!guard.stalled() || attempt >= retries) {
        failure = guard.stalled() ? markRomNetworkFailure(new Error(stallMessage(stallMs))) : error
        if (isNetworkFetchError(failure) && NETWORK_FAILURE_TEXT.test(String((failure as Error).message))) markRomNetworkFailure(failure)
      }
    } finally {
      guard.stop()
    }
    if (switchForSpeed && alternates.length) {
      const slowRoute = failure as SlowRomRouteError
      const target = slowRoute.route && alternates.includes(slowRoute.route) ? slowRoute.route : alternates[0]
      diagLog('download', 'warn', `ROM 首段 ${slowRoute.sampledMbps.toFixed(1)} Mbps，备用线路 ${slowRoute.alternateMbps.toFixed(1)} Mbps，切换：`, currentUrl, '→', target)
      useNextRoute(target)
      attempt = -1
      continue
    }
    if (failure) {
      if (!alternates.length) throw failure
      /*
        这条线路用光了重试：同一个对象依次换其余 CDN。相同 R2 对象有同一个 romv，
        断点分片按 resumeKey 续，已下的片不重下。
      */
      console.warn(`[download] ${new URL(currentUrl).host} 下载失败，改走 ${new URL(alternates[0]).host}：`,
        failure instanceof Error ? failure.message : failure)
      useNextRoute()
      attempt = -1
      continue
    }
    diagLog('download', 'warn', `整包第 ${attempt + 1} 次${guard.stalled() ? '卡住' : '失败'}，重试`, currentUrl)
    await abortableDelay(500 * 2 ** attempt, opts.signal)
  }
}

/** 真正的实现。看门狗由上面的 fetchBlobWithProgress 持有，这里只负责「收到字节就 touch」 */
async function blobWithProgressGuarded(url: string, opts: GuardedFetchOptions, guard: StallGuard): Promise<Blob> {
  const phase = opts.phase ?? 'rom'
  const type = opts.type ?? 'application/octet-stream'
  const chunkBytes = opts.chunkBytes ?? CHUNK_BYTES
  const maxBytes = opts.maxBytes ?? Infinity
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 ||
      !(maxBytes === Infinity || Number.isSafeInteger(maxBytes) && maxBytes > 0)) {
    throw new RangeError('无效的分片下载上限')
  }
  const retries = opts.retries ?? CHUNK_RETRIES
  const networkRetries = opts.retries ?? NETWORK_RETRIES
  const doFetch = opts.fetchImpl ?? fetch
  const emit = throttleProgress(opts.onProgress)
  const memoryLimit = Math.max(0, opts.inMemoryUpTo ?? 0)
  const resumeKey = memoryLimit ? '' : opts.resumeKey ?? ''
  let resumeStore: DownloadResumeStore | null = resumeKey ? (opts.resumeStore ?? downloadResumeStore) : null
  let reportedLoaded = 0
  /** 这一份（按整份大小）要不要留在内存里。分片模式下 total 在建第一个分片之前就已确定。 */
  const keepInMemory = (size: number) => memoryLimit > 0 && size > 0 && size <= memoryLimit
  const memoryParts = (chunks: Uint8Array[]) => chunks as Uint8Array<ArrayBuffer>[]
  /** 网络分片收齐后的那一块：内存模式下不建 Blob（建出来就可能读不出）。 */
  const makePart = (chunks: Uint8Array[], wholeSize: number): Blob =>
    keepInMemory(wholeSize) ? memoryRomBlob(memoryParts(chunks)) : new Blob(chunks as BlobPart[])
  /** 没有 body 的回应（测试 / 个别实现）：内存模式读成字节，不经 res.blob()。 */
  const bodylessPart = async (res: Response, wholeSize: number): Promise<Blob> =>
    memoryLimit > 0 && (wholeSize === 0 || keepInMemory(wholeSize))
      ? memoryRomBlob([new Uint8Array(await res.arrayBuffer())])
      : res.blob()

  emit({ phase, loaded: 0 }, true)

  /** 重试中的残片会让“本次已收到”回退；UI 只能停住，不能从 70% 倒退到 65%。 */
  const emitTotal = (loaded: number, total: number | undefined, flush = false) => {
    reportedLoaded = Math.max(reportedLoaded, loaded)
    emit({
      phase,
      loaded: reportedLoaded,
      total,
      ratio: total ? Math.min(reportedLoaded / total, 1) : undefined,
    }, flush)
  }

  const clearResume = async () => {
    if (!resumeStore) return
    try {
      await withResumeTimeout(resumeStore.clear(resumeKey), RESUME_CLEAR_TIMEOUT_MS)
    } catch {
      /* 临时缓存清不掉不能把一份已经完整的 ROM 判成下载失败。 */
    }
  }

  const loadResume = async (): Promise<DownloadResumeSnapshot | null> => {
    if (!resumeStore) return null
    try {
      const snapshot = await withResumeTimeout(resumeStore.load(resumeKey, chunkBytes), RESUME_LOAD_TIMEOUT_MS)
      if (snapshot === RESUME_TIMED_OUT) {
        resumeStore = null
        return null
      }
      return snapshot
    } catch {
      // Safari 隐私模式和配额故障都可能让 IDB 抛错；本局直接退回内存下载。
      resumeStore = null
      return null
    }
  }

  const savePart = async (total: number, index: number, blob: Blob) => {
    if (!resumeStore) return
    try {
      // 这层必须等事务提交；上面的有界队列可以让网络继续跑，但最终清理前仍要知道写盘真的结束。
      const stored = await withResumeTimeout(resumeStore.put(resumeKey, total, chunkBytes, index, blob), RESUME_PUT_TIMEOUT_MS)
      // 超时那笔事务也许稍后才提交，留下一片孤儿；本局不再写也不再清，交给仓库的过期清理
      if (stored === false || stored === RESUME_TIMED_OUT) resumeStore = null
    } catch {
      resumeStore = null
    }
  }

  /*
   * 下载与写盘做成有界流水线。旧实现每片都 await IndexedDB：网络已经空闲，下一片却要等闪存事务完成，
   * 手机和低端 SSD 上会在每个 8MB 边界停一下。现在先把完整 Blob 放进本局 parts，再让最多两笔写盘
   * 在后台追赶；若磁盘真的比网络慢，第三笔会自然背压，仍不会形成无界事务队列。
   */
  const pendingPartWrites = new Set<Promise<void>>()
  const queuePartSave = async (total: number, index: number, blob: Blob) => {
    if (!resumeStore) return
    while (pendingPartWrites.size >= RESUME_WRITE_BACKLOG) await Promise.race(pendingPartWrites)
    let task: Promise<void>
    task = savePart(total, index, blob).finally(() => pendingPartWrites.delete(task))
    pendingPartWrites.add(task)
  }
  const flushPartSaves = async () => {
    if (pendingPartWrites.size) await Promise.all(pendingPartWrites)
  }

  /** Range 回包必须精确对应请求；只验长度挡不住 CDN 把“别的一片等长数据”发回来。 */
  const assertContentRange = (res: Response, start: number, end: number, total: number) => {
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(res.headers.get('content-range') ?? '')
    if (
      !match
      || Number(match[1]) !== start
      || Number(match[2]) !== end
      || Number(match[3]) !== total
    ) {
      throw new Error(`分片范围不匹配：期望 bytes ${start}-${end}/${total}`)
    }
  }

  /** 慢线路才请求另一域的同一 ROM 对齐首片；若对方没有快 15%，继续当前流避免盲切更差线路。 */
  const measureAlternateRomRange = async (
    candidateUrl: string,
    expectedTotal: number,
    cancelSignal?: AbortSignal,
  ): Promise<number | null> => {
    const sampleBytes = Math.min(ALTERNATE_ROUTE_SAMPLE_BYTES, chunkBytes, expectedTotal)
    if (!candidateUrl || sampleBytes <= 0) return null
    const candidateEnd = Math.min(chunkBytes, expectedTotal) - 1
    const controller = new AbortController()
    const abortFromParent = () => controller.abort()
    if (guard.signal.aborted || cancelSignal?.aborted) controller.abort()
    else {
      guard.signal.addEventListener('abort', abortFromParent, { once: true })
      cancelSignal?.addEventListener('abort', abortFromParent, { once: true })
    }
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, ALTERNATE_ROUTE_SAMPLE_TIMEOUT_MS)
    // 与当前线路的首段采样同一口径：从响应头到达算起，握手和首字节不算
    let startedAt = monotonicNow()
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let loaded = 0
    try {
      const res = await doFetch(candidateUrl, {
        headers: { Range: `bytes=0-${candidateEnd}` }, signal: controller.signal,
        cache: opts.cache ?? 'default',
      })
      startedAt = monotonicNow()
      validateResponse(res, opts.check)
      if (res.status !== 206 || !res.body) {
        void res.body?.cancel().catch(() => {})
        return null
      }
      assertContentRange(res, 0, candidateEnd, expectedTotal)
      reader = res.body.getReader()
      while (loaded < sampleBytes) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) loaded += value.byteLength
      }
      if (loaded < sampleBytes || controller.signal.aborted) return null
      const elapsedMs = Math.max(1, monotonicNow() - startedAt)
      // 备用测速同样是这条线路的真实正文吞吐；免得只记录“赢了”的线路，旧分数长期不更新。
      if (trackHealth) recordRomRouteTransfer(candidateUrl, loaded, elapsedMs)
      return (loaded * 8) / (elapsedMs * 1000)
    } catch {
      if (timedOut && loaded >= ALTERNATE_ROUTE_MIN_SAMPLE_BYTES) {
        const elapsedMs = Math.max(1, monotonicNow() - startedAt)
        if (trackHealth) recordRomRouteTransfer(candidateUrl, loaded, elapsedMs)
        return (loaded * 8) / (elapsedMs * 1000)
      }
      return null
    } finally {
      clearTimeout(timer)
      guard.signal.removeEventListener('abort', abortFromParent)
      cancelSignal?.removeEventListener('abort', abortFromParent)
      await reader?.cancel().catch(() => {})
      try { reader?.releaseLock() } catch { /* 已由浏览器释放 */ }
    }
  }

  /** 服务器忽略 Range 时把 200 当整份读；已缓存的残片全部作废，不能混着拼。 */
  const takeWhole = async (res: Response): Promise<Blob> => {
    const encoded = Boolean(res.headers.get('content-encoding'))
    const len = Number(res.headers.get('content-length'))
    const total = !encoded && Number.isFinite(len) && len > 0 ? len : undefined
    if (total !== undefined && total > maxBytes) throw new RangeError('ROM 文件超过浏览器下载上限')
    if (!res.body) {
      const blob = await bodylessPart(res, total ?? 0)
      if (blob.size > maxBytes) throw new RangeError('ROM 文件超过浏览器下载上限')
      if (total !== undefined && blob.size !== total) {
        throw new Error(`下载不完整：应为 ${total} 字节，实际收到 ${blob.size} 字节`)
      }
      emitTotal(blob.size, blob.size, true)
      await flushPartSaves()
      await clearResume()
      if (memoryRomOf(blob)) return keepInMemory(blob.size) ? blob : new Blob([await blob.arrayBuffer()], { type })
      return blob.type === type ? blob : new Blob([blob], { type })
    }
    const { chunks, loaded } = await drain(
      res.body,
      phase,
      total,
      (p) => emitTotal(p.loaded ?? 0, p.total),
      maxBytes,
      guard.touch,
    )
    emitTotal(loaded, loaded, true)
    await flushPartSaves()
    await clearResume()
    return keepInMemory(loaded) ? memoryRomBlob(memoryParts(chunks), type) : new Blob(chunks as BlobPart[], { type })
  }

  let total = 0
  let parts: Array<Blob | undefined> = []
  let completed = 0
  let sampleBytes = 0
  let sampleElapsedMs = 0
  /** 首片完整校准后的并发；用它收回早期测速过于乐观时已经放出的多余预取。 */
  let calibratedConcurrency = 0
  const networkHints = opts.networkHints ?? browserChunkNetworkHints()
  const requestedMax = Math.trunc(opts.maxConcurrency ?? (opts.fetchImpl ? 1 : MAX_CHUNK_CONCURRENCY))
  const hardMax = Number.isFinite(requestedMax) ? Math.max(1, Math.min(
    MAX_CHUNK_CONCURRENCY,
    requestedMax,
  )) : 1
  const resumed = await loadResume()

  /* ── 线路池：同一版本对象的几条线路（见 sameObjectRoutes），按记分板给每个请求选线路 ── */
  const trackHealth = opts.routeHealth ?? !opts.fetchImpl
  const routePool = trackHealth ? sameObjectRoutes(url, opts.routePool ?? []) : [url]
  const hintedType = String(networkHints.effectiveType ?? '').toLowerCase()
  const conserveTraffic = Boolean(networkHints.saveData) || hintedType === 'slow-2g' || hintedType === '2g'
  /** 能不能为同一段字节同时问两条线路：要有第二条线路，且不在省流量 / 2G 下多花流量 */
  const canHedgeRoutes = routePool.length > 1 && !conserveTraffic
  /** 每条线路上本局的在途请求数，选线路时用来分摊 */
  const routeLoad = new Map<string, number>()
  const loadRoute = (route: string, delta: number) =>
    routeLoad.set(route, Math.max(0, (routeLoad.get(route) ?? 0) + delta))
  /** 响应头对冲改了实际来源后，分片占用量也要转到获胜线路。 */
  const moveRouteLoad = (from: string, to: string): string => {
    if (from === to) return from
    loadRoute(from, -1)
    loadRoute(to, 1)
    return to
  }
  /** 本局最近几次「发出请求 → 响应头到达」的耗时 */
  const headerSamples: number[] = []
  const medianHeaderMs = () => {
    if (!headerSamples.length) return 0
    const sorted = [...headerSamples].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  }
  /** 本局最快的一片的吞吐（字节 / 毫秒），不设样本下限；记分板还一片都没记下时，尾部对冲拿它估算 */
  let fastestLocalRate = 0
  const noteTransfer = (route: string, bytes: number, elapsedMs: number) => {
    if (bytes > 0) fastestLocalRate = Math.max(fastestLocalRate, bytes / Math.max(1, elapsedMs))
    if (trackHealth) recordRomRouteTransfer(route, bytes, elapsedMs)
  }
  /** 只记线路自己的错：网络层失败、5xx、429。404 是对象不在，换线路也一样，不算线路的账 */
  const noteRouteFailure = (route: string, error: unknown) => {
    if (!trackHealth || isAbort(error)) return
    const status = /^HTTP (\d{3})$/.exec(String((error as Error | undefined)?.message ?? ''))
    if (status) {
      const code = Number(status[1])
      if (code >= 500 || code === 429) recordRomRouteFailure(route, 'server')
    } else if (isNetworkFetchError(error)) {
      recordRomRouteFailure(route, 'network')
    }
  }
  /** 一条线路输给了另一条：读到的字节够一个样本就记吞吐，否则（连响应头 / 几十 KB 都没等到）记一次失速 */
  const noteLoser = (route: string, loaded: number, headersAt: number) => {
    if (!trackHealth) return
    if (headersAt && loaded >= ROUTE_MIN_SAMPLE_BYTES) recordRomRouteTransfer(route, loaded, monotonicNow() - headersAt)
    else recordRomRouteFailure(route, 'stall')
  }
  const bestKnownRate = () => {
    const rates = routePool.map((route) => romRouteRate(route) ?? 0)
    return Math.max(0, ...rates)
  }
  /**
   * 给下一个请求挑线路：先按记分板排序，跳过熔断中的和 avoid（刚失败 / 正慢的那条）；再按
   * 「吞吐 ÷ (本局在途请求 + 1)」分摊 —— 一样快的线路各分一路连接，明显慢的（不到最快的 40%）不再分新片。
   * 没测过的线路按「和已知最快的一样快」算，让它这一局就被测到；排序结果只取决于记分板，确定可复现。
   */
  const pickRoute = (avoid = ''): string => {
    if (routePool.length < 2) return url
    const usable = rankRomRoutes(routePool).filter((route) => route !== avoid)
    const healthy = usable.filter((route) => !isRomRouteOpen(route))
    const choices = healthy.length ? healthy : usable
    if (!choices.length) return avoid || url
    const observed = choices.map((route) => romRouteRate(route))
    const known = observed.filter((rate): rate is number => Boolean(rate))
    const top = known.length ? Math.max(...known) : 1
    // rankRomRoutes 已按近期失败折扣排序；负载分摊也必须用同一有效吞吐，否则稍快但常失败的线路会反超。
    const rates = choices.map((route) => romRouteEffectiveRate(route, top))
    let chosen = choices[0]
    let chosenScore = -1
    choices.forEach((route, order) => {
      const rate = rates[order] ?? top
      if (order > 0 && rate < top * SLOW_ROUTE_SHARE) return
      const score = rate / (1 + (routeLoad.get(route) ?? 0))
      if (score > chosenScore) {
        chosen = route
        chosenScore = score
      }
    })
    return chosen
  }
  const headersHedgeDelay = () => {
    const rtt = Number.isFinite(networkHints.rttMs) ? Math.max(0, networkHints.rttMs ?? 0) : 0
    return Math.max(opts.routeHedgeMs ?? ROUTE_HEADERS_HEDGE_MS, rtt * 6, medianHeaderMs() * 3)
  }
  type RangeAnswer = { res: Response; route: string; headersAt: number }
  /**
   * 发一个 Range 请求。可对冲时：headersHedgeDelay() 内响应头还没到、或这条直接网络失败，就在另一条线路上
   * 同时请求同一个 Range，谁的响应头先到用谁，另一条立刻中止（正文还没开始流，几乎不费流量）。
   * headersAt 是响应头到达的时刻：吞吐一律从这里算起，握手和首字节不算。
   */
  const fetchRange = (
    route: string,
    start: number,
    end: number,
    cache: RequestCache,
    signal: AbortSignal,
    hedge = true,
  ): Promise<RangeAnswer> => {
    const sentAt = monotonicNow()
    const request = (target: string, laneSignal: AbortSignal) =>
      Promise.resolve().then(() => doFetch(target, { headers: { Range: `bytes=${start}-${end}` }, signal: laneSignal, cache }))
    const answered = (res: Response, target: string): RangeAnswer => {
      const headersAt = monotonicNow()
      headerSamples.push(headersAt - sentAt)
      if (headerSamples.length > 8) headerSamples.shift()
      return { res, route: target, headersAt }
    }
    const backup = hedge && canHedgeRoutes ? pickRoute(route) : ''
    if (!backup || backup === route) {
      return request(route, signal).then((res) => {
        try {
          validateResponse(res, opts.check)
        } catch (error) {
          if (!signal.aborted) noteRouteFailure(route, error)
          throw error
        }
        return answered(res, route)
      }, (error) => {
        if (!signal.aborted) noteRouteFailure(route, error)
        throw error
      })
    }
    return new Promise<RangeAnswer>((resolve, reject) => {
      const lanes: Array<{ route: string; controller: AbortController; failed: boolean; error?: unknown }> = []
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let backupLoadReserved = false
      const releaseBackupLoad = () => {
        if (!backupLoadReserved) return
        backupLoadReserved = false
        loadRoute(backup, -1)
      }
      // 不在 resolve 时摘掉：调用方之后中止（对冲赢了 / 整局失败）时，正在读正文的那一路也要跟着停
      const onAbort = () => {
        clearTimeout(timer)
        for (const lane of lanes) lane.controller.abort()
        releaseBackupLoad()
        if (!settled) {
          settled = true
          reject(signal.reason ?? new DOMException('已取消', 'AbortError'))
        }
      }
      const launch = (target: string) => {
        // 对冲线路在等待响应头时也占用一条真实连接，不能让其它分片误把它当空闲线路。
        if (target === backup && !backupLoadReserved) {
          backupLoadReserved = true
          loadRoute(target, 1)
        }
        const lane: (typeof lanes)[number] = { route: target, controller: new AbortController(), failed: false }
        lanes.push(lane)
        request(target, lane.controller.signal).then((res) => {
          if (settled) {
            void res.body?.cancel().catch(() => {})
            if (target === backup) releaseBackupLoad()
            return
          }
          // 快速 404、5xx 或 HTML 错误页不能抢赢仍在等待的线路；先验证响应再决定是否中止对端。
          try {
            validateResponse(res, opts.check)
          } catch (error) {
            lane.failed = true
            lane.error = error
            if (target === backup) releaseBackupLoad()
            if (!lane.controller.signal.aborted) noteRouteFailure(target, error)
            if (lanes.length < 2) {
              clearTimeout(timer)
              launch(backup)
            } else if (lanes.every((item) => item.failed)) {
              settled = true
              clearTimeout(timer)
              releaseBackupLoad()
              reject(lanes.find((item) => item.error !== undefined)?.error ?? error)
            }
            return
          }
          settled = true
          clearTimeout(timer)
          for (const other of lanes) if (other !== lane) other.controller.abort()
          // 调用方会把原线路占位马上迁到获胜线路，这里先去掉对冲请求的临时占位。
          releaseBackupLoad()
          const answer = answered(res, target)
          if (target !== route) {
            // 原线路过了对冲延时还没回响应头，另一条先回：记一次失速，后面的片少分给它（连续两次就熔断）
            if (trackHealth && !lanes[0].failed) recordRomRouteFailure(route, 'stall')
            diagLog('download', 'info', `Range ${start}-${end}：${romRouteOrigin(route)} ${Math.round(answer.headersAt - sentAt)}ms 未回响应头，改用 ${romRouteOrigin(target)}`)
          }
          resolve(answer)
        }, (error) => {
          lane.failed = true
          lane.error = error
          if (target === backup) releaseBackupLoad()
          if (settled) return
          if (!lane.controller.signal.aborted) noteRouteFailure(target, error)
          if (lanes.length < 2) {
            // 第一条直接失败：不必等对冲延时
            clearTimeout(timer)
            launch(backup)
          } else if (lanes.every((item) => item.failed)) {
            settled = true
            reject(lanes[0].error)
          }
        })
      }
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
      launch(route)
      timer = setTimeout(() => {
        if (!settled && lanes.length < 2) launch(backup)
      }, headersHedgeDelay())
    })
  }

  if (resumed) {
    total = resumed.total
    const count = Math.ceil(total / chunkBytes)
    let valid = resumed.chunkBytes === chunkBytes && Number.isSafeInteger(total) && total > 0 &&
      total <= maxBytes && count <= MAX_BLOB_PARTS
    // 旧版 IDB 或损坏的 metadata 可能写着极大 total；先验上限，再分配 parts。
    if (valid) {
      parts = Array.from({ length: count }, () => undefined as Blob | undefined)
      for (const [index, blob] of resumed.parts) {
        const expected = Math.min(chunkBytes, total - index * chunkBytes)
        if (!Number.isInteger(index) || index < 0 || index >= count || !(blob instanceof Blob) || blob.size !== expected) {
          valid = false
          break
        }
        parts[index] = blob
        completed += blob.size
      }
    }
    /*
      续传片是 IndexedDB 里的 Blob 引用，字节在浏览器自己的存储里。2026-11-12 大陆 Windows Chrome 132（2GB）
      《口袋妖怪：白 2》：同一页里重开 7 次，靠续传片拼出来的 114MB ROM 有一次读包时永远不返回（120 秒后超时），
      一次抛 NotReadableError —— 这台浏览器的 IDB Blob 存储已经坏了。拼进整包前先探一下每片首尾各一个字节；
      读不出或卡住就整组作废、本局不再写续传，宁可重下，也不把一份读不出来的 ROM 交给解包。
    */
    if (valid && completed > 0) {
      const readable = await withResumeTimeout(
        Promise.all(parts.map((part) => (part ? blobReadable(part) : true))).then((all) => all.every(Boolean)),
        RESUME_LOAD_TIMEOUT_MS,
      )
      if (readable !== true) {
        console.warn('[download] 续传分片读不出来，作废并重新下载')
        valid = false
        await clearResume()
        resumeStore = null
      }
    }
    if (!valid || completed === 0) {
      await clearResume()
      parts = []
      total = 0
      completed = 0
    } else {
      emitTotal(completed, total, true)
    }
  }

  /*
    每片的在途字节分两路记：主请求，和尾部对冲时在另一条线路上重下的那一路。
    进度取两路的较大值 —— 下的是同一段字节，相加就算重了。
  */
  const mainLoaded = new Map<number, number>()
  const hedgeLoaded = new Map<number, number>()
  const inFlightLoaded = new Map<number, number>()
  let inFlightBytes = 0
  const activeControllers = new Map<number, AbortController>()
  const hedgeControllers = new Map<number, AbortController>()
  /** 主请求的现场：尾部对冲按它估算这一片还要多久 */
  const runningParts = new Map<number, { route: string; startedAt: number; headersAt: number }>()
  const hedges = new Map<number, Promise<void>>()
  let wholeResponse: Response | null = null
  let fatalError: unknown

  const abortActive = (except = -1) => {
    for (const [index, controller] of activeControllers) {
      if (index !== except) controller.abort()
    }
    for (const controller of hedgeControllers.values()) controller.abort()
  }

  /** 只维护字节差值；每个 64KB 网络块都展开 Map 再 reduce 会把四路下载的统计成本压回主线程。 */
  const refreshInFlight = (index: number) => {
    const loaded = Math.max(mainLoaded.get(index) ?? 0, hedgeLoaded.get(index) ?? 0)
    const previous = inFlightLoaded.get(index) ?? 0
    if (loaded) inFlightLoaded.set(index, loaded)
    else inFlightLoaded.delete(index)
    inFlightBytes += loaded - previous
  }
  const setInFlight = (index: number, loaded: number, lane: 'main' | 'hedge') => {
    ;(lane === 'main' ? mainLoaded : hedgeLoaded).set(index, loaded)
    refreshInFlight(index)
  }
  const clearInFlight = (index: number, lane: 'main' | 'hedge') => {
    ;(lane === 'main' ? mainLoaded : hedgeLoaded).delete(index)
    refreshInFlight(index)
  }

  /**
   * 一片下完：先到的那一路落进 parts，另一路（主请求或对冲）立刻停掉。返回 false = 另一路已经先到。
   * 对冲赢了时，把主请求那条线路此刻有多慢记进记分板，后面的片少分给它。
   */
  const commitPart = (index: number, part: Blob, lane: 'main' | 'hedge'): boolean => {
    if (parts[index] || wholeResponse) return false
    if (lane === 'hedge') {
      const running = runningParts.get(index)
      if (running) noteLoser(running.route, mainLoaded.get(index) ?? 0, running.headersAt)
    }
    parts[index] = part
    mainLoaded.delete(index)
    hedgeLoaded.delete(index)
    refreshInFlight(index)
    completed += part.size
    emitTotal(completed + firstRangeInFlight + inFlightBytes, total, true)
    activeControllers.get(index)?.abort()
    hedgeControllers.get(index)?.abort()
    return true
  }

  /**
   * 下一片。early = 首片还在读时提前开下的那几片（首片测速通过后）：只试一次，失败不抛 ——
   * 池子轮到这一片时再按常规重试重下。它和普通分片一样登记在 runningParts 里，慢了也能被尾部对冲。
   */
  const downloadPart = async (index: number, early = false) => {
    const start = index * chunkBytes
    const end = Math.min(start + chunkBytes, total) - 1
    const expect = end - start + 1
    /** 上一次失败在哪条线路上：重试换一条（同一版本对象有第二条线路时） */
    let avoidRoute = ''
    for (let attempt = 0; ; attempt++) {
      if (parts[index]) return
      const route = pickRoute(avoidRoute)
      let reservedRoute = route
      const controller = new AbortController()
      const abortFromGuard = () => controller.abort()
      if (guard.signal.aborted) controller.abort()
      else guard.signal.addEventListener('abort', abortFromGuard, { once: true })
      activeControllers.set(index, controller)
      const running = { route, startedAt: monotonicNow(), headersAt: 0 }
      runningParts.set(index, running)
      loadRoute(reservedRoute, 1)
      try {
        guard.touch()
        const answer = await fetchRange(
          route, start, end,
          // 浏览器磁盘缓存里的 206 若底层文件失效，重试必须绕过同一条坏缓存记录。
          attempt > 0 ? 'reload' : (opts.cache ?? 'default'),
          controller.signal,
        )
        const res = answer.res
        reservedRoute = moveRouteLoad(reservedRoute, answer.route)
        running.route = answer.route
        running.headersAt = answer.headersAt
        if (early && res.status !== 206) {
          // 提前分片不替首片做「服务器不认 Range」的决定：丢掉这条回应，交给池子按常规重下
          void res.body?.cancel().catch(() => {})
          return
        }
        if (res.status !== 206) {
          /*
            CDN 若在下载途中突然不认 Range，只能采用一份完整 200，绝不能让其它并发请求的局部字节
            同时继续落盘。先停兄弟请求，等它们真正退出后再读完整响应，清理续传现场的顺序才可靠。
          */
          if (!wholeResponse) {
            wholeResponse = res
            abortActive(index)
          } else {
            void res.body?.cancel().catch(() => {})
          }
          return
        }
        assertContentRange(res, start, end, total)
        const part = await takePartWithConcurrentProgress(res, expect, index, 'main')
        if (wholeResponse) return
        noteTransfer(running.route, part.size, monotonicNow() - running.headersAt)
        if (!commitPart(index, part, 'main')) return
        await queuePartSave(total, index, part)
        return
      } catch (error) {
        clearInFlight(index, 'main')
        // 尾部对冲那一路已经先下完，本路是被它停掉的
        if (parts[index]) return
        if (wholeResponse && isAbort(error)) return
        if (early) {
          if (!guard.stalled() && !opts.signal?.aborted && !isAbort(error)) {
            if (running.headersAt) noteRouteFailure(running.route, error)
            diagLog('download', 'warn', '首片期间的提前分片失败，后续会按常规重试：', error, running.route)
          }
          return
        }
        // 卡死不是「这一次没成」：重试只会再等一整个看门狗周期，直接抛
        if (guard.stalled()) throw error
        // 取消是用户意图，不是失败，别在这儿空转重试
        if (error instanceof RangeError) throw error
        if (isAbort(error) || opts.signal?.aborted) throw error
        // 响应头之前的失败 fetchRange 已经记过；之后的（读正文断流、5xx）在这里记
        if (running.headersAt) noteRouteFailure(running.route, error)
        avoidRoute = running.route
        // 对冲那一路还在下同一片：等它的结果，不另起一路
        const hedge = hedges.get(index)
        if (hedge) {
          await hedge
          if (parts[index]) return
        }
        if (attempt >= (isNetworkFetchError(error) ? networkRetries : retries)) throw error
        diagLog('download', 'warn', `分片 ${index} 第 ${attempt + 1} 次失败（${romRouteOrigin(running.route)}），重试：`, error, url)
        // 退避：0.5s / 1s / 2s（网络层失败最多到 8s）。切网络那一下往往要一两秒才恢复；
        // 有另一条线路可换时只稍等一下 —— 坏的多半是那条线路，不是这台设备的网络
        const switching = routePool.length > 1 && pickRoute(avoidRoute) !== avoidRoute
        await abortableDelay(switching ? 200 : 500 * 2 ** attempt, opts.signal)
      } finally {
        loadRoute(reservedRoute, -1)
        guard.signal.removeEventListener('abort', abortFromGuard)
        if (activeControllers.get(index) === controller) activeControllers.delete(index)
        if (runningParts.get(index) === running) runningParts.delete(index)
      }
    }
  }

  /** 并发片的局部进度要相加；继续沿用 completed 会让多路互相覆盖，看起来像进度停住。 */
  async function takePartWithConcurrentProgress(res: Response, expect: number, index: number, lane: 'main' | 'hedge'): Promise<Blob> {
    const relay = (p: LoadProgress) => {
      setInFlight(index, p.loaded ?? 0, lane)
      emitTotal(completed + firstRangeInFlight + inFlightBytes, total)
    }
    if (!res.body) {
      const blob = await bodylessPart(res, total)
      if (blob.size !== expect) throw new Error(`分片不完整：应为 ${expect} 字节，实际 ${blob.size}`)
      setInFlight(index, blob.size, lane)
      return blob
    }
    // 并发片同样要按实际读入字节止损，不能信 CDN 宣称的 Content-Range。
    const { chunks } = await drain(res.body, phase, expect, relay, expect, guard.touch)
    return makePart(chunks, total)
  }

  /*
    第一片的 Content-Range 已经说出了整份大小，必须在读完前就赋给 total：
    旧代码等首片下载完才赋值，8MB 期间只能走渐近映射，《主题医院》150MB 开局 6 秒进度就到 67%，
    后面真实比例 5%→85% 都输给它。现在首片开始就用总量算进度，也能在测速后提前启动下一片。
  */
  let probedTotal = 0
  /** 首片正在读的字节（首片读完归零）。首片期间提前开下的分片走池子，计在 inFlightBytes 里 */
  let firstRangeInFlight = 0
  let earlyPrefetchStarted = false
  /** 首片期间提前开下的分片（index → 任务）；池子里轮到它们时等这里的结果，失败的再按常规重下 */
  const earlyTasks = new Map<number, Promise<void>>()
  const emitInitialRangeProgress = (flush = false) =>
    emitTotal(completed + firstRangeInFlight + inFlightBytes, total || probedTotal || undefined, flush)
  /** 把分片内的字节换算成“已经完整落盘的分片 + 当前片”的整份进度。 */
  const takePart = async (res: Response, expect: number, onLoaded?: (loaded: number) => void) => {
    const relay = (p: LoadProgress) => {
      const loaded = p.loaded ?? 0
      onLoaded?.(loaded)
      if (onLoaded) emitInitialRangeProgress()
      else emitTotal(completed + loaded, total || probedTotal || undefined)
    }
    if (!res.body) {
      const blob = await bodylessPart(res, total)
      if (blob.size !== expect) throw new Error(`分片不完整：应为 ${expect} 字节，实际 ${blob.size}`)
      if (onLoaded) relay({ phase, loaded: blob.size })
      return blob
    }
    // Content-Range 只是服务器自报；若实际流远大于这一片，不能先无限攒进 chunks 再验长度。
    const { chunks } = await drain(res.body, phase, expect, relay, expect, guard.touch)
    return makePart(chunks, total)
  }

  /* 没有续传现场时，第一个请求同时探测 Range 支持并取得整份大小。 */
  if (total === 0) {
    /*
      第一片既是探测又是真数据，过去却在下面的逐片重试循环之外：Wi‑Fi 切换恰好发生在
      第一个请求时会直接失败，而第二片以后才有三次重试。弱网最常断在建连阶段，等于把
      重试留给了更不容易失败的部分。把“请求 + 响应头校验 + 读完整片”整体放进同一规则，
      截断的首片也不会被误当成一次不可恢复的整局失败。
    */
    /** 首片上一次失败在哪条线路上：重试换一条（有的话） */
    let failedFirstRoute = ''
    for (let attempt = 0; ; attempt++) {
      let firstRoute = failedFirstRoute ? pickRoute(failedFirstRoute) : url
      let firstHeadersAt = 0
      const firstRangeController = new AbortController()
      const abortFirstRangeFromGuard = () => firstRangeController.abort()
      if (guard.signal.aborted) firstRangeController.abort()
      else guard.signal.addEventListener('abort', abortFirstRangeFromGuard, { once: true })
      let firstPartRead = false
      let firstAttemptLoaded = 0
      let fasterAlternateError: SlowRomRouteError | null = null
      const alternateProbeController = new AbortController()
      let earlyRouteProbeTimer: ReturnType<typeof setTimeout> | undefined
      // 首片也占线路：提前分片按负载分摊时才会落到别的线路上
      let reservedRoute = firstRoute
      loadRoute(reservedRoute, 1)
      try {
        guard.touch()
        const answer = await fetchRange(
          firstRoute, 0, chunkBytes - 1, attempt > 0 ? 'reload' : (opts.cache ?? 'default'), firstRangeController.signal,
        )
        const first = answer.res
        reservedRoute = moveRouteLoad(reservedRoute, answer.route)
        firstRoute = answer.route
        firstHeadersAt = answer.headersAt
        /*
          吞吐从响应头到达算起（2026-11-18《西游释厄传》浏览器实测）：以前从发请求算，样本里含 TLS 握手和约 1 秒的
          首字节，256KB 的样本怎么算都不到 3Mbps，自适应并发被压成 1 路，3 个 8MB 分片串行下了 20 秒。
          并发要藏的是单连接的拥塞窗口和 RTT，衡量它该看正文流速；握手慢由 fetchRange 的响应头对冲去管。
        */
        const sampleStartedAt = answer.headersAt
        if (first.status !== 206) return takeWhole(first)

        const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(first.headers.get('content-range') ?? '')
        const firstTotal = Number(match?.[3])
        if (!match || Number(match[1]) !== 0 || !Number.isSafeInteger(firstTotal) || firstTotal <= 0) {
          throw new Error('分片响应缺少有效的 Content-Range')
        }
        if (firstTotal > maxBytes || Math.ceil(firstTotal / chunkBytes) > MAX_BLOB_PARTS) {
          void first.body?.cancel().catch(() => {})
          throw new RangeError('ROM 文件超过浏览器下载上限')
        }
        const firstEnd = Math.min(chunkBytes, firstTotal) - 1
        if (Number(match[2]) !== firstEnd) throw new Error(`分片范围不匹配：期望 bytes 0-${firstEnd}/${firstTotal}`)

        probedTotal = firstTotal
        total = firstTotal
        parts = Array.from({ length: Math.ceil(total / chunkBytes) }, () => undefined as Blob | undefined)
        const firstSampleSize = Math.min(firstRangeSampleBytes(networkHints), firstEnd + 1)
        // 线路比较单独使用较小样本；并发判断仍等原来的 128/256 KiB，避免慢启动样本压低整局并发。
        const alternateRoute = routePool.length > 1 ? pickRoute(firstRoute) : (opts.alternateUrl ?? '')
        const alternateExists = Boolean(alternateRoute && alternateRoute !== firstRoute)
        const effectiveType = String(networkHints.effectiveType ?? '').toLowerCase()
        const conserveTraffic = networkHints.saveData || effectiveType === 'slow-2g' || effectiveType === '2g'
        let alternateProbeInFlight = false
        let alternateProbeAttempts = 0
        let alternateProbeBytes = 0
        const startAlternateProbe = (routeSampleBytes: number, routeSampleElapsedMs: number) => {
          if (alternateProbeInFlight || !alternateExists || firstTotal < SLOW_ROUTE_MIN_FILE_BYTES || conserveTraffic) return
          if (alternateProbeAttempts >= ALTERNATE_ROUTE_MAX_PROBES) return
          if (alternateProbeAttempts > 0 && routeSampleBytes - alternateProbeBytes < ALTERNATE_ROUTE_REPROBE_BYTES) return
          const routeSampleMbps = (routeSampleBytes * 8) / (Math.max(1, routeSampleElapsedMs) * 1000)
          if (routeSampleMbps >= SLOW_ROUTE_MIN_MBPS) return
          alternateProbeInFlight = true
          alternateProbeAttempts++
          alternateProbeBytes = routeSampleBytes
          diagLog('download', 'info', `ROM 首段第 ${alternateProbeAttempts} 次测速 ${routeSampleBytes} 字节 / ${routeSampleElapsedMs.toFixed(0)}ms（${routeSampleMbps.toFixed(1)} Mbps，不含握手与首字节）：`, firstRoute)
          // 备用测速与当前首片并行；不能在 drain 的进度回调里等待，否则主流也会停读。
          void measureAlternateRomRange(alternateRoute, firstTotal, alternateProbeController.signal).then((alternateMbps) => {
            if (alternateMbps !== null && alternateMbps > routeSampleMbps * 1.15) {
              if (!firstPartRead) {
                fasterAlternateError = new SlowRomRouteError(routeSampleMbps, routeSampleElapsedMs, alternateMbps, alternateRoute)
                firstRangeController.abort()
              }
              return
            }
            diagLog('download', 'info', `备用 ROM 线路没有明显更快（${alternateMbps?.toFixed(1) ?? '未测出'} Mbps），继续当前线路：`, firstRoute)
          }).catch(() => {}).finally(() => { alternateProbeInFlight = false })
        }
        earlyRouteProbeTimer = alternateExists && firstTotal >= SLOW_ROUTE_MIN_FILE_BYTES && !conserveTraffic
          ? setTimeout(() => {
              // 有响应头但正文 1.5 秒仍未形成有效样本时，把它视为零吞吐并验证备用线路。
              if (firstPartRead || firstAttemptLoaded >= EARLY_ROUTE_SAMPLE_BYTES) return
              const elapsed = Math.max(1, monotonicNow() - sampleStartedAt)
              startAlternateProbe(firstAttemptLoaded, elapsed)
            }, EARLY_ROUTE_STALL_MS)
          : undefined
        let sampled = false
        const onFirstLoaded = (loaded: number) => {
          firstAttemptLoaded = loaded
          firstRangeInFlight = loaded
          if (loaded >= EARLY_ROUTE_SAMPLE_BYTES) {
            startAlternateProbe(Math.min(loaded, firstEnd + 1), Math.max(1, monotonicNow() - sampleStartedAt))
          }
          if (!sampled && loaded >= firstSampleSize) {
            sampled = true
            sampleBytes = Math.min(loaded, firstEnd + 1)
            sampleElapsedMs = Math.max(1, monotonicNow() - sampleStartedAt)
            const sampledMbps = (sampleBytes * 8) / (sampleElapsedMs * 1000)
            // 低速首段已经是真实正文样本。立即更新记分板，避免整片下完前仍沿用旧的高速记录。
            if (trackHealth && sampledMbps < SLOW_ROUTE_MIN_MBPS) {
              recordRomRouteTransfer(firstRoute, sampleBytes, sampleElapsedMs)
            }
            // 较大的并发样本若才首次确认线路慢，也在这里启动备用测速。
            startAlternateProbe(sampleBytes, sampleElapsedMs)
            const earlyConcurrency = Math.min(
              hardMax,
              adaptiveChunkConcurrency(sampleBytes, sampleElapsedMs, networkHints),
              Math.ceil(firstTotal / chunkBytes),
            )
            // 首片测速通过后抢先取后续块；仍用完整 8 MiB Range，不破坏边缘缓存的对齐规则
            if (!earlyPrefetchStarted && earlyConcurrency > 1) {
              earlyPrefetchStarted = true
              for (let index = 1; index < earlyConcurrency; index++) earlyTasks.set(index, downloadPart(index, true))
            }
          }
        }
        const firstPart = await takePart(first, firstEnd + 1, onFirstLoaded)
        firstPartRead = true
        clearTimeout(earlyRouteProbeTimer)
        if (fasterAlternateError) throw fasterAlternateError
        // 首片已完整到手时不再等待未完成的备用测速，让后续下载继续。
        alternateProbeController.abort()
        // 早期样本只用来提前预取；正式并发与线路记分一律按首个完整分片校准。
        // 否则慢启动后迅速提速时，旧的 256KB 低速样本会让整局始终串行下载。
        sampleBytes = firstPart.size
        sampleElapsedMs = Math.max(1, monotonicNow() - sampleStartedAt)
        noteTransfer(firstRoute, sampleBytes, sampleElapsedMs)
        calibratedConcurrency = Math.min(
          hardMax,
          adaptiveChunkConcurrency(sampleBytes, sampleElapsedMs, networkHints),
          Math.ceil(firstTotal / chunkBytes),
        )
        // 早期样本只负责抢跑；完整分片证明链路较慢时，立刻停掉超出正式并发的预取。
        // 被取消的早期任务会由正式 worker 按新并发重新请求，不把半片写进续传库。
        for (const [index] of earlyTasks) {
          if (index >= calibratedConcurrency && !parts[index]) activeControllers.get(index)?.abort()
        }
        firstRangeInFlight = 0
        parts[0] = firstPart
        // 提前分片可能先于首片下完，completed 里已经有它们
        completed += firstPart.size
        emitInitialRangeProgress(true)
        // 整份不足一片时已经完整，落临时库再立刻删只会拖慢几百 KB 的小游戏开局。
        if (firstTotal > chunkBytes) await queuePartSave(total, 0, firstPart)
        break
      } catch (error) {
        if (fasterAlternateError) {
          // 首片测速证实切线更快时，中止首片旁路并等它们退出，避免旧线路的写盘晚于新一轮续传读取。
          abortActive()
          await Promise.all(earlyTasks.values())
          await flushPartSaves()
          throw fasterAlternateError
        }
        // 卡死会在外层换一只新的 AbortController；这里不能拿已 abort 的 signal 空转。
        if (error instanceof SlowRomRouteError) throw error
        if (guard.stalled()) throw error
        if (error instanceof RangeError) throw error
        if (isAbort(error) || opts.signal?.aborted) throw error
        // 响应头之前的失败 fetchRange 已经记过；之后的（读正文断流、5xx）在这里记
        if (firstHeadersAt) noteRouteFailure(firstRoute, error)
        if (routePool.length > 1) failedFirstRoute = firstRoute
        if (attempt >= (isNetworkFetchError(error) ? networkRetries : retries)) throw error
        diagLog('download', 'warn', `首片第 ${attempt + 1} 次失败，重试：`, error, firstRoute)
        await abortableDelay(500 * 2 ** attempt, opts.signal)
      } finally {
        clearTimeout(earlyRouteProbeTimer)
        alternateProbeController.abort()
        firstRangeController.abort()
        guard.signal.removeEventListener('abort', abortFirstRangeFromGuard)
        loadRoute(reservedRoute, -1)
      }
    }
  }

  const concurrency = calibratedConcurrency || Math.min(
    hardMax,
    adaptiveChunkConcurrency(sampleBytes, sampleElapsedMs, networkHints),
  )
  const pending = parts.map((part, index) => part ? -1 : index).filter((index) => index >= 0)
  /*
    尾部对冲：整份文件什么时候下完由最慢的那一片决定（2026-11-18 实测 21.9MB ROM：三片分三条线路并发
    7.3～7.6 秒，同一线路并发 5～10 秒，波动全在最后一片）。没有新片可取时空出来的那一路去帮最慢的一片：
    在另一条线路上重下同一个 Range，先下完的落盘、另一路立刻停。只用空出来的那几路，总并发不超过
    concurrency；每片最多对冲一次；省流量 / 2G、只有一路、或没有第二条同版本线路时不做。
  */
  const hedgeEnabled = canHedgeRoutes && concurrency > 1
  const tailMinRemainingMs = opts.routeHedgeMs ?? TAIL_HEDGE_MIN_REMAINING_MS
  const tailPollMs = Math.min(TAIL_HEDGE_POLL_MS, Math.max(5, tailMinRemainingMs / 4))
  /** 挑预计最晚下完、而且换一条线路从头下也能明显更早下完的那一片 */
  const pickStraggler = (): { index: number; route: string } | null => {
    const now = monotonicNow()
    const best = bestKnownRate() || fastestLocalRate
    const headerMs = medianHeaderMs() || 1000
    let target: { index: number; route: string } | null = null
    let worst = tailMinRemainingMs
    for (const [index, running] of runningParts) {
      if (parts[index] || hedges.has(index)) continue
      const expect = Math.min(chunkBytes, total - index * chunkBytes)
      const loaded = mainLoaded.get(index) ?? 0
      let remainingMs: number
      if (!running.headersAt) {
        // 响应头迟迟不来（fetchRange 自己的对冲也没救回来）：当它卡住了
        remainingMs = now - running.startedAt > headersHedgeDelay() ? Infinity : 0
      } else {
        const elapsed = Math.max(1, now - running.headersAt)
        remainingMs = loaded > 0
          ? ((expect - loaded) * elapsed) / loaded
          : elapsed > tailMinRemainingMs ? Infinity : 0
      }
      if (remainingMs <= worst) continue
      const route = pickRoute(running.route)
      if (route === running.route) continue
      const rate = romRouteRate(route) ?? best
      const freshMs = headerMs + (rate > 0 ? expect / rate : Infinity)
      if (remainingMs !== Infinity && remainingMs < freshMs * 1.3) continue
      worst = remainingMs
      target = { index, route }
    }
    return target
  }

  /** 在另一条线路上重下同一片。失败不算整局失败：主请求还在，交给它的重试 */
  const runHedge = async (index: number, route: string) => {
    const start = index * chunkBytes
    const end = Math.min(start + chunkBytes, total) - 1
    const expect = end - start + 1
    const controller = new AbortController()
    const abortFromGuard = () => controller.abort()
    if (guard.signal.aborted) controller.abort()
    else guard.signal.addEventListener('abort', abortFromGuard, { once: true })
    hedgeControllers.set(index, controller)
    loadRoute(route, 1)
    const slowRoute = runningParts.get(index)?.route ?? ''
    diagLog('download', 'info', `分片 ${index} 在 ${romRouteOrigin(slowRoute)} 上偏慢，同时从 ${romRouteOrigin(route)} 重下`)
    let served = route
    let headersAt = 0
    try {
      const answer = await fetchRange(route, start, end, opts.cache ?? 'default', controller.signal, false)
      served = answer.route
      headersAt = answer.headersAt
      if (answer.res.status !== 206) {
        void answer.res.body?.cancel().catch(() => {})
        return
      }
      assertContentRange(answer.res, start, end, total)
      const part = await takePartWithConcurrentProgress(answer.res, expect, index, 'hedge')
      if (wholeResponse) return
      noteTransfer(served, part.size, monotonicNow() - headersAt)
      if (!commitPart(index, part, 'hedge')) return
      diagLog('download', 'info', `分片 ${index} 由 ${romRouteOrigin(served)} 先下完`)
      await queuePartSave(total, index, part)
    } catch (error) {
      if (headersAt) noteRouteFailure(served, error)
    } finally {
      clearInFlight(index, 'hedge')
      loadRoute(route, -1)
      guard.signal.removeEventListener('abort', abortFromGuard)
      if (hedgeControllers.get(index) === controller) hedgeControllers.delete(index)
    }
  }

  let cursor = 0
  const worker = async () => {
    while (!wholeResponse && fatalError === undefined) {
      const at = cursor++
      if (at >= pending.length) break
      const index = pending[at]
      try {
        // 首片期间已经开下的那几片：等它的结果（它慢了，空着的一路会去对冲）；失败了才按常规重下
        const early = earlyTasks.get(index)
        if (early) await early
        const hedge = hedges.get(index)
        if (hedge && !parts[index]) await hedge
        if (!parts[index]) await downloadPart(index)
      } catch (error) {
        if (fatalError === undefined && !wholeResponse) fatalError = error
        abortActive()
        return
      }
    }
    while (hedgeEnabled && !wholeResponse && fatalError === undefined && runningParts.size) {
      const straggler = pickStraggler()
      if (!straggler) {
        try {
          await abortableDelay(tailPollMs, guard.signal)
        } catch {
          return
        }
        continue
      }
      const task = runHedge(straggler.index, straggler.route)
      hedges.set(straggler.index, task)
      await task
    }
  }

  // 可以对冲时至少开两路：只剩一片也有一路空着，它慢了就能去另一条线路帮它
  const workerCount = pending.length
    ? Math.min(concurrency, hedgeEnabled ? Math.max(pending.length, 2) : pending.length)
    : 0
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  // 整局失败时提前分片已被中止；等它们真正退出，免得之后还往 parts / 续传库里写
  if (earlyTasks.size) await Promise.all(earlyTasks.values())
  if (fatalError !== undefined) throw fatalError
  if (wholeResponse) return takeWhole(wholeResponse)

  const complete = parts as Blob[]
  // 网络与大部分写盘已经重叠；这里只等最多两笔尾写，避免 clear 与尚未提交的 put 互相复活。
  await flushPartSaves()
  // 100% 必须代表这份 ROM 已经能返回给引擎，不能先满格再等待尾部写盘。
  emitTotal(total, total, true)
  // 删除几十到几百个临时片可能明显拖住开局。完整 Blob 已在手里，清理留在后台即可；
  // 同一个内容键此刻再次进入，最多只是短暂复用这份完整现场，不会混入另一代 ROM。
  void clearResume()
  if (keepInMemory(total)) {
    // 各片本来就是独立的字节块，拼成一个替身只是换个索引，不复制
    return memoryRomBlob(complete.flatMap((part) => (memoryRomOf(part)?.parts ?? []) as Uint8Array<ArrayBuffer>[]), type)
  }
  return new Blob(complete, { type })
}

/* ---------------- 合成一条 0→100 的总进度 ---------------- */

export interface LoadProgressPlan {
  /** 只用于测试与诊断；界面不把内部策略名露给玩家。 */
  id: string
  /** 真正发生的先后顺序。PS2 / J2ME 等运行时并不是统一的 engine → rom。 */
  order: readonly LoadPhase[]
  /** 每一阶段在整条 0~1 进度里的区间；不参与本策略的阶段是 [0, 0]。 */
  ranges: Readonly<Record<LoadPhase, readonly [number, number]>>
  /** 没有真实比例时的视觉预算；只负责让条子有反馈，不负责判定超时。 */
  durations: Readonly<Record<LoadPhase, number>>
}

export interface LoadProgressPlanContext {
  runtime: RuntimeId
  platform: PlatformId
  /** js-dos 是否带 Windows 3.x / 9x 系统盘。 */
  windowsGuest?: boolean
  /** 游戏盘是否是按扇区读取的静态 Sockdrive。 */
  streaming?: boolean
  /** MAME 需要完整挂载一份游戏专属 CHD；ROM 阶段会明显长于普通街机 ZIP。 */
  mameMedia?: boolean
  /** 本局计划用的核心（街机：mame-current 的核心下载 + 242MB wasm 编译远比 FBNeo 重） */
  core?: string
  /** 本地文件（「玩本地 ROM」）：ROM 已经在手，不会先于引擎下载 */
  localFile?: boolean
}

type PhaseShare = readonly [LoadPhase, number]

const DEFAULT_PHASE_DURATION_MS: Readonly<Record<LoadPhase, number>> = {
  engine: 20_000,
  assets: 45_000,
  rom: 45_000,
  starting: 45_000,
}

/**
 * 从“有意义的阶段 + 相对权重”生成连续区间。
 *
 * 集中生成而不是手写四组边界，避免后续调一个比例时留下空洞、重叠或总和不是 100%。
 * 权重会自动归一化，所以策略表里更适合写 20 / 55 / 25 这种一眼能审的整数。
 */
function makeLoadProgressPlan(
  id: string,
  shares: readonly PhaseShare[],
  durations: Partial<Record<LoadPhase, number>> = {},
): LoadProgressPlan {
  const order = shares.filter(([, weight]) => weight > 0).map(([phase]) => phase)
  const total = shares.reduce((sum, [, weight]) => sum + Math.max(0, weight), 0)
  if (total <= 0 || new Set(order).size !== order.length) throw new Error(`无效的加载进度策略：${id}`)

  const ranges: Record<LoadPhase, readonly [number, number]> = {
    engine: [0, 0],
    assets: [0, 0],
    rom: [0, 0],
    starting: [0, 0],
  }
  let cursor = 0
  for (let i = 0; i < shares.length; i += 1) {
    const [phase, rawWeight] = shares[i]
    const weight = Math.max(0, rawWeight)
    if (weight === 0) continue
    const end = i === shares.length - 1 ? 1 : cursor + weight / total
    ranges[phase] = [cursor, Math.min(1, end)]
    cursor = end
  }
  // 最后一段必须精确收在 1，避免浮点累计让“阶段已完成”的判断差一个极小量。
  const last = order[order.length - 1]
  if (last) ranges[last] = [ranges[last][0], 1]

  return {
    id,
    order,
    ranges,
    durations: { ...DEFAULT_PHASE_DURATION_MS, ...durations },
  }
}

/** 旧的四段比例保留为默认策略，给未知/以后新增的运行时一个安全兜底。 */
export const DEFAULT_LOAD_PROGRESS_PLAN = makeLoadProgressPlan('default', [
  ['engine', 20],
  ['assets', 20],
  ['rom', 40],
  ['starting', 20],
])

const LARGE_EMULATORJS_MEDIA = new Set<PlatformId>(['psx', 'nds', 'segaCD', 'amiga'])

/**
 * 按运行时的真实启动链分配进度区域。
 *
 * 这里分的是“玩家实际等待时间”，不是文件个数：
 *   · HTML5 的全部资源都在子页面里，外层只能观察启动，因此 starting 独占整条；
 *   · PS2 先探盘再装大 WASM，顺序就是 rom → engine → starting；
 *   · PSP / Dolphin 先起隔离运行时，再探 Range、挂盘，所以 engine 占最大段；
 *   · Windows 客体的系统镜像与开机远重于游戏层，不能再和红白机共用比例。
 */
export function loadProgressPlan(ctx: LoadProgressPlanContext): LoadProgressPlan {
  if (ctx.runtime === 'html5' || ctx.runtime === 'cloudgame' || ctx.runtime === 'liveview') {
    return makeLoadProgressPlan(`${ctx.runtime}-surface`, [['starting', 100]], { starting: 60_000 })
  }
  if (ctx.runtime === 'ruffle' || ctx.runtime === 'awayfl') {
    return makeLoadProgressPlan('flash', [['rom', 60], ['starting', 40]], { rom: 60_000, starting: 35_000 })
  }
  if (ctx.runtime === 'jsnes') {
    return makeLoadProgressPlan('jsnes', [['engine', 25], ['rom', 50], ['starting', 25]], {
      engine: 20_000,
      rom: 45_000,
      starting: 25_000,
    })
  }
  if (ctx.runtime === 'j2me') {
    // 本地 JAR 要先读/上传，正式 JAR 这一段会很快越过；最慢的是后面的 JVM 冷启动。
    return makeLoadProgressPlan('j2me', [['rom', 20], ['engine', 60], ['starting', 20]], {
      rom: 45_000,
      engine: 120_000,
      starting: 30_000,
    })
  }
  if (ctx.runtime === 'webretro') {
    return makeLoadProgressPlan('webretro', [['rom', 50], ['engine', 20], ['assets', 15], ['starting', 15]], {
      rom: 120_000,
      engine: 45_000,
      assets: 45_000,
      starting: 30_000,
    })
  }
  if (ctx.runtime === 'play') {
    // Play! 先做轻量 Range 探测，再加载远大于探测结果的 WASM / pthread 运行时。
    return makeLoadProgressPlan('ps2-stream', [['rom', 10], ['engine', 55], ['starting', 35]], {
      rom: 20_000,
      engine: 120_000,
      starting: 90_000,
    })
  }
  if (ctx.runtime === 'ppsspp' || ctx.runtime === 'dolphin') {
    return makeLoadProgressPlan(`${ctx.runtime}-stream`, [['engine', 50], ['rom', 10], ['starting', 40]], {
      engine: 120_000,
      rom: 30_000,
      starting: 90_000,
    })
  }
  if (ctx.runtime === 'jsdos') {
    if (ctx.windowsGuest) {
      return ctx.streaming
        ? makeLoadProgressPlan('windows-sockdrive', [['engine', 10], ['assets', 35], ['rom', 10], ['starting', 45]], {
            engine: 45_000,
            assets: 180_000,
            rom: 30_000,
          })
        : makeLoadProgressPlan('windows-bundle', [['engine', 10], ['assets', 40], ['rom', 15], ['starting', 35]], {
            engine: 45_000,
            assets: 180_000,
            rom: 180_000,
          })
    }
    return ctx.streaming
      ? makeLoadProgressPlan('dos-sockdrive', [['engine', 25], ['rom', 15], ['starting', 60]], {
          engine: 45_000,
          rom: 30_000,
          starting: 60_000,
        })
      : makeLoadProgressPlan('dos-bundle', [['engine', 20], ['rom', 55], ['starting', 25]], {
          engine: 45_000,
          rom: 180_000,
          starting: 45_000,
        })
  }
  if (ctx.runtime === 'emulatorjs') {
    if (ctx.platform === 'arcade') {
      /*
        远端街机 ROM 由站点先完整下载 + 解密 + 校验，**之后**才注入 loader.js（emulatorjs.ts 的
        prepareRemoteArcadeRom）。以前计划写的是 engine → assets → rom，于是 rom 事件先到、条子从 1%
        跳到 50%；之后核心下载（engine）和 BIOS（assets）的事件因为「阶段不倒退」全部被丢掉，
        mame-current 下 37MB 核心、解压编译 242MB 时条子停在 80% 写着「启动中」，45 秒预算一过卡在 99%。
        现在按真实顺序：rom → engine → assets → starting；本地文件仍是引擎在前。
      */
      const heavy = ctx.core === 'mame-current'
      if (ctx.localFile) {
        return makeLoadProgressPlan('emulatorjs-arcade-local', [['engine', heavy ? 45 : 35], ['assets', 10], ['rom', 20], ['starting', heavy ? 25 : 35]], {
          engine: heavy ? 180_000 : 90_000,
          assets: 45_000,
          rom: 60_000,
          starting: heavy ? 90_000 : 45_000,
        })
      }
      if (ctx.mameMedia) {
        // CHD 与 ROM 合成同一条 rom 进度（combinedRomProgress），真正开局必须等它完整写进虚拟文件系统。
        return makeLoadProgressPlan('emulatorjs-arcade-mame-media', [['rom', 50], ['engine', 25], ['assets', 5], ['starting', 20]], {
          rom: 240_000,
          engine: 180_000,
          assets: 45_000,
          starting: 90_000,
        })
      }
      return makeLoadProgressPlan(heavy ? 'emulatorjs-arcade-mame' : 'emulatorjs-arcade', heavy
        ? [['rom', 25], ['engine', 45], ['assets', 5], ['starting', 25]]
        : [['rom', 35], ['engine', 35], ['assets', 10], ['starting', 20]], {
        rom: 90_000,
        engine: heavy ? 180_000 : 90_000,
        assets: 45_000,
        starting: heavy ? 90_000 : 45_000,
      })
    }
    if (LARGE_EMULATORJS_MEDIA.has(ctx.platform)) {
      return makeLoadProgressPlan('emulatorjs-large-media', [['engine', 20], ['assets', 10], ['rom', 55], ['starting', 15]], {
        engine: 90_000,
        assets: 45_000,
        rom: 180_000,
        starting: 45_000,
      })
    }
    return makeLoadProgressPlan('emulatorjs-cartridge', [['engine', 30], ['assets', 10], ['rom', 40], ['starting', 20]], {
      engine: 60_000,
      assets: 30_000,
      rom: 60_000,
      starting: 45_000,
    })
  }
  return DEFAULT_LOAD_PROGRESS_PLAN
}

export const loadProgressRange = (plan: LoadProgressPlan, phase: LoadPhase): readonly [number, number] =>
  plan.ranges[phase]

export const firstLoadProgressPhase = (plan: LoadProgressPlan): LoadPhase =>
  plan.order[0] ?? 'starting'

export const nextLoadProgressPhase = (plan: LoadProgressPlan, phase: LoadPhase): LoadPhase | undefined => {
  const index = plan.order.indexOf(phase)
  return index >= 0 ? plan.order[index + 1] : undefined
}

export const loadProgressDurationMs = (plan: LoadProgressPlan, phase: LoadPhase): number =>
  plan.durations[phase]

/**
 * 默认/兼容策略的固定区间。
 *
 * 新播放器按 loadProgressPlan() 选择运行时专用比例；这个导出仍保留给旧测试、未知运行时和
 * 独立调用方。固定区间比“按本次见到的阶段重新归一化”可靠，因为后者会在阶段出现时重排，
 * 让玩家看到进度倒退。默认约定是：
 *
 *   0–20%   模拟器核心
 *   20–40%  系统镜像 / 引擎素材
 *   40–80%  游戏 ROM
 *   80–100% 模拟器启动与超时等待
 *
 * 已知运行时不会再为空阶段预留假区域，具体比例见 loadProgressPlan()。
 */
export const LOAD_PHASE_RANGE: Record<LoadPhase, readonly [number, number]> = DEFAULT_LOAD_PROGRESS_PLAN.ranges

/**
 * Windows 客体的 CI 创建会把近百 MB 的 qcow2 镜像交给 WASM 解包、建盘；这段耗时取决于
 * 设备 CPU 和内存，不是网络下载结束就会立刻完成。原来只留 45 秒，快设备能进、慢设备
 * 却会在稍后同样成功之前被误判为失败。额外留 4 分钟，真实引擎错误仍会由 js-dos 立即上报。
 */
export const WINDOWS_GUEST_INIT_GRACE_MS = 4 * 60_000

/**
 * 敲键那条链自己要花的时间（图形信号兜底 + 按键序列 + 敲完之后的画面确认）。
 *
 * ⚠️ 这几段以前**没有算进预算**，只减了 `windowsLaunchDelayMs` 一项。
 * 实际的时间线是：CI 创建（建盘，最慢的一段）→ 等图形信号（拿不到就死等 90 秒）
 * → `windowsLaunchDelayMs`（默认 24 秒）→ 按键链（3.x 约 14 秒：Run 框 0.8 + 打字
 * + 文件管理器 4 秒 + 选盘 0.35/0.8/1.5 + 第二次 Run 0.8）→ 敲完之后最多 20 秒画面确认。
 * 漏掉的这 124 秒全被算成了「建盘时间」——留给 qcow2 的其实只剩 160 秒，
 * 而 4 分钟那个数本来就是为建盘准备的。慢设备 + 不报画面尺寸的自定义镜像会在
 * 即将成功前被判超时，然后自动重试再等一遍，玩家合计对着遮罩近九分钟。
 */
const WINDOWS_LAUNCH_CHAIN_MS = WINDOWS_GRAPHICS_SIGNAL_FALLBACK_MS + 15_000 + WINDOWS_LAUNCH_VERIFY_MS

/**
 * 客体初始化 + 后台配置的开机等待，原本共同构成 80–99% 这段的**总超时预算**。
 * 现在适配器在 ci-ready 前仍沿用这个上限，避免慢设备因拆段而更早失败；收到 ci-ready
 * 后另外按 windowsGuestLaunchBudgetMs 计时，真实进展不会被之前建盘耗时挤掉。
 *
 * ⚠️⚠️ 这个数**只能用来判失败，绝不能用来画进度条**。这一条是 2026-09-11 那次
 * 「加载卡在 80%」的病根：EmulatorPlayer 的视觉计时器原来直接拿它当 duration，
 * 而它是 24000 + (90000+15000+20000) + 240000 = **389 秒**，用来铺 0.80→0.99
 * 这 19 个百分点 ——
 *
 *     1% 要走 20.5 秒。
 *
 * 实测（zeek-the-geek / Win3.11）：80%@5.2s → 81%@16.2s → 82%@37.2s；游戏在
 * 39 秒就跑起来了，条子才走到 82%。玩家看到的就是「80% 之后一动不动」。
 *
 * 「最坏情况下才判失败的上限」和「预计还要多久」是两个数，必须分开 ——
 * 前者在这里，后者见 startingSegmentMs。
 */
export function windowsGuestStartupBudgetMs(launchDelaySeconds = 24): number {
  return WINDOWS_GUEST_INIT_GRACE_MS + windowsGuestLaunchBudgetMs(launchDelaySeconds)
}

/** CI 已经建好之后，只给图形模式、自动输入与画面确认计时；不再混入之前的建盘时间。 */
export function windowsGuestLaunchBudgetMs(launchDelaySeconds = 24): number {
  return windowsLaunchDelayMs(launchDelaySeconds) + WINDOWS_LAUNCH_CHAIN_MS
}

/* ---------------- Windows 客体启动阶段的里程碑 ---------------- */

/**
 * 进入 starting 区域之后，客体到底走到哪一步了。
 *
 * 这一段以前是整条进度里**唯一没有任何真实信号**的部分：适配器进了 starting 就再也
 * 不吭声，条子全靠一个计时器瞎爬。而它恰恰是 Windows 客体耗时最长的一段
 * （实测占总时长的 87%）。所以给它补三个**确证发生过**的里程碑：
 *
 *   ci      DOSBox-X 的命令接口建好了（qcow2 挂载 / 建盘完成，冷启动最慢的一段）
 *   desktop 客体画面稳下来了 = Windows 桌面画完了（见 windowsLaunch 的 desktopSettled）
 *   launched 启动命令已经敲完回车
 *
 * 值是「在当前策略 starting 区域里的相对位置」。Windows 完整包与 Sockdrive 的启动区间
 * 不同，绝不能再把这里写死成某个整条百分比。
 */
export const STARTING_MILESTONE = Object.freeze({
  /** DOSBox-X 的命令接口已经建立。 */
  ci: 0.3,
  /** Windows 桌面已经稳定画出。 */
  desktop: 0.55,
  /** 游戏启动命令已经输入并回车。 */
  launched: 0.85,
})

/**
 * 里程碑能把条子推到 starting 区域的最高相对位置。
 *
 * 最后那一格永远留给 onReady：适配器说「命令敲完了」不等于玩家能动手，
 * 画到 100% 再倒回去是这套进度里最不能犯的错。
 */
export const STARTING_MILESTONE_CAP = 0.9

const MILESTONE_STOPS: readonly number[] = [
  STARTING_MILESTONE.ci,
  STARTING_MILESTONE.desktop,
  STARTING_MILESTONE.launched,
  1,
]

/** 下一个里程碑在哪儿。视觉进度只准爬到它跟前，越过去就等于替客体作证 */
export function nextStartupMilestone(startup: number): number {
  return MILESTONE_STOPS.find((stop) => stop > startup + 1e-6) ?? 1
}

/**
 * **视觉**进度从当前里程碑爬到下一个里程碑的预算（毫秒）。
 *
 * 和 windowsGuestStartupBudgetMs 的区别是这里要的是「预计」而不是「上限」。
 * 数字来自 2026-09-11 的实测：
 *   · Dos() → ci-ready：热缓存 0.5 秒，冷启动 ~72 秒（2.6MB wasm 冷编译 +
 *     21.5MB qcow2 在 WASM 里挂载建盘）。取 90 秒，冷启动那次才不会提前顶到头。
 *   · ci-ready → 桌面：Win3.11 在 5 倍速下 2 秒，慢机器留到 30 秒。
 *   · 桌面 → 敲完命令：盯画面 + 按键链，上限就是 dosLaunchDelay，再留 15 秒给按键链本身。
 *   · 敲完 → 第一帧：就是那段画面确认。
 */
export function startingSegmentMs(startup: number, windowsGuest: boolean, launchDelaySeconds = 24): number {
  if (!windowsGuest) return 45_000
  if (startup < STARTING_MILESTONE.ci) return 90_000
  if (startup < STARTING_MILESTONE.desktop) return 30_000
  if (startup < STARTING_MILESTONE.launched) return windowsLaunchDelayMs(launchDelaySeconds) + 15_000
  return WINDOWS_LAUNCH_VERIFY_MS
}

/**
 * total 未知时的渐近尺度（字节）。
 *
 * 拿不到 Content-Length 时，旧做法是切成「来回滑动的不确定态」——那是第二种状态，
 * 正是要去掉的东西。改成用**真实已下载字节**做渐近映射：条子跟着真实下载量走，
 * 但永远到不了本阶段的顶，等阶段真的结束了才跨过去。动得起来，也没有编数字。
 */
const SOFT_SCALE: Record<LoadPhase, number> = {
  engine: 8 * 1024 * 1024,
  assets: 8 * 1024 * 1024,
  rom: 4 * 1024 * 1024,
  starting: 1,
}

/**
 * 把 0~1 的整条进度抬到 [floor, 1] 区间里。
 *
 * ⚠️ 这是「自动重试 / 换引擎之后条子冻住」的正解，值得说清楚：
 *
 * 自动重试属于**同一次开始游戏**，所以播放器刻意保留玩家已经看到的百分比
 * （不保留的话，慢网上下到 60% 断一次，条子会当着他的面跳回 0%，像是白下了）。
 * 但保留之后，第二轮的进度是从 0 重新算的，而显示取的是 `Math.max(已显示, 新算的)`——
 * 于是 engine 段最高 0.19、assets 0.39、rom 0.79 全都输给那个 0.60，
 * **条子在整个第二次下载期间一动不动**。用户看到的和「卡在 80%」是同一种病。
 *
 * 所以第二轮不能从 0 起算，要把它整体压进 [已显示, 1]：从 60% 继续往前爬。
 * 视觉计时器那一路必须用同一个映射（见 EmulatorPlayer 的 progressFloor），
 * 只改一边等于没改。
 */
export const liftRatio = (floor: number, v: number): number => floor + (1 - floor) * v

/**
 * 造一个「把阶段进度折算成整条进度」的函数，每次加载新建一个。
 *
 * 三条保证：
 *   1. **只进不退**：记住已经显示过的最大值，任何回退都被吃掉
 *      （引擎乱序报数、或者某个阶段迟到，都不会让条子往回缩）
 *   2. **启动阶段不吃 ratio**：适配器报 starting=1 通常只表示“资源准备完了”，
 *      不表示模拟器已经可玩。starting 区域交给播放器的视觉计时缓慢推进，onReady 才算成功。
 *   3. **从 floor 起算**：重试/换引擎时接着上一轮的百分比往前爬（见 liftRatio）
 *
 * @param floor 这一轮的起点。0 = 全新的一局；>0 = 接着上一轮已经显示的百分比
 */
export function createOverallRatio(floor = 0, plan: LoadProgressPlan = DEFAULT_LOAD_PROGRESS_PLAN): (p: LoadProgress) => number {
  const base = Math.min(0.99, Math.max(0, floor))
  let shown = base
  /*
    同一阶段先报过「没有总量」的渐近估计（或视觉计时）、后来才拿到真实比例时，估计值可能已经跑在
    真实进度前面。只取 max 的话条子会停住，直到真实比例追上来——大包下载要停好几分钟。
    第一次拿到真实比例且落后于已显示值时，记下这一刻，把**剩下的**真实进度线性铺到
    [已显示, 阶段上界] 里：条子继续走，也照样在下载完成时正好到上界。
  */
  let anchor: { phase: LoadProgress['phase']; shown: number; inner: number } | null = null
  return (p) => {
    const [start, end] = loadProgressRange(plan, p.phase)
    const span = end - start
    if (p.phase !== 'starting' && p.ratio !== undefined && Number.isFinite(p.ratio)) {
      const inner = Math.min(1, Math.max(0, p.ratio))
      const top = liftRatio(base, end)
      if (anchor?.phase !== p.phase) {
        const value = liftRatio(base, start + span * inner)
        anchor = value < shown && shown < top && inner < 1 ? { phase: p.phase, shown, inner } : null
      }
      if (anchor) {
        const progressed = (inner - anchor.inner) / (1 - anchor.inner)
        const value = anchor.shown + (top - anchor.shown) * Math.min(1, Math.max(0, progressed))
        shown = Math.min(1, Math.max(shown, value))
        return shown
      }
    }

    /*
      starting 阶段刻意**不吃 ratio**：ruffle / jsnes / webretro 都是资源一读完就报
      `starting: 1`，那只表示「资源准备完了」，不表示模拟器已经可玩 —— 认了它条子会
      当场冲到 98% 再原地不动，和「卡在 80%」是同一种病，只换了个数字。
      真正能推进这一段的只有 startup：那是适配器**确证发生过**的里程碑
      （见 STARTING_MILESTONE），而且封顶在 STARTING_MILESTONE_CAP，
      最后一格永远留给 onReady。
    */
    let inner =
      p.phase === 'starting'
        ? Math.min(STARTING_MILESTONE_CAP, Math.max(0, p.startup ?? 0))
        : p.ratio
    if (inner === undefined && p.loaded !== undefined && p.loaded > 0) {
      inner = 1 - Math.exp(-p.loaded / SOFT_SCALE[p.phase])
    }
    const value = liftRatio(base, start + span * Math.min(1, Math.max(0, inner ?? 0)))
    shown = Math.min(1, Math.max(shown, value))
    return shown
  }
}

/* ---------------- 下载速度 ---------------- */

/** 算平均速度用的滑动窗口。太短会疯狂跳数，太长则网络变化半天反应不过来 */
const SPEED_WINDOW_MS = 3_000

export interface SpeedMeter {
  /** 报一次「当前这个文件已下载多少字节」。loaded 为空（只有阶段、没有字节数）时只推进时间 */
  push(loaded: number | undefined, now?: number): void
  /** 最近窗口内的平均速度（字节/秒）。窗口里没有新字节就是 0 */
  read(now?: number): number
}

/**
 * 下载速度表。
 *
 * 为什么放在这一层集中算，而不是让每个适配器自己报速度：各适配器报的都是
 * 「当前这个文件下了多少」，而一次加载要下好几个文件（核心、素材、ROM），
 * 每换一个文件 `loaded` 就**从头开始**。让每个适配器各算一遍，等于把同一个
 * 边界条件抄五遍；而且 EmulatorJS 那一路是 XHR 拦截来的，压根没有适配器代码可写。
 *
 * 所以这里自己维护一个只增不减的累计字节数：
 *   - `loaded` 比上次大 → 正常增量
 *   - `loaded` 比上次小 → 换文件了，这一整段都算新增（而不是算成负数）
 *
 * 速度取窗口两端的累计量之差。**没有新字节时会自然衰减到 0** —— 因为窗口左端
 * 会不断前移，两端的累计量最终相等。这一条很重要：WASM 编译那几十秒里一个字节都不走，
 * 界面必须停止显示「还在以 2MB/s 下载」，否则就是在骗人。
 */
export function createSpeedMeter(windowMs = SPEED_WINDOW_MS): SpeedMeter {
  let lastLoaded = 0
  let cumulative = 0
  /** (时刻, 到那一刻为止的累计字节)。只保留窗口内的，外加窗口左边最近的一条当基线 */
  const samples: Array<{ t: number; bytes: number }> = []

  const prune = (now: number) => {
    const cutoff = now - windowMs
    // 留一条窗口外最近的当基线：全删光的话窗口刚开头时算不出速度
    while (samples.length > 1 && samples[1].t <= cutoff) samples.shift()
  }

  return {
    push(loaded, now = Date.now()) {
      if (loaded !== undefined && Number.isFinite(loaded) && loaded >= 0) {
        // 变小 = 换了个文件重新从 0 开始数，这一段整个算新增
        cumulative += loaded >= lastLoaded ? loaded - lastLoaded : loaded
        lastLoaded = loaded
      }
      samples.push({ t: now, bytes: cumulative })
      prune(now)
    },
    read(now = Date.now()) {
      // 先按「现在」修剪一次：调用方可能只是在定时器里问一句，并没有新的进度事件。
      // 不修剪的话，下载停了之后速度会永远停在最后一个读数上
      if (samples.length) {
        samples.push({ t: now, bytes: cumulative })
        prune(now)
        samples.pop()
      }
      if (samples.length < 2) return 0
      const first = samples[0]
      const elapsed = now - first.t
      if (elapsed <= 0) return 0
      const bytes = cumulative - first.bytes
      return bytes > 0 ? (bytes / elapsed) * 1000 : 0
    },
  }
}
