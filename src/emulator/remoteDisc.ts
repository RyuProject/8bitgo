/**
 * 远程光盘：用 HTTP Range 按需读盘，不把整张盘下下来。
 *
 * ── 为什么非要有这个 ─────────────────────────────────────────
 * PS2 是 DVD，一张盘 1~4.7GB。「先整个下下来再开始玩」这条路在网页上根本不成立 ——
 * 就算玩家愿意等，浏览器也存不下：几 GB 的 Blob 会直接顶爆配额。
 *
 * 但光盘游戏本来就不需要整张盘：它按扇区读，一局下来真正碰到的往往只有几百 MB，
 * 而且顺序性很强（过场动画、关卡数据都是连续的）。所以正确的做法是把「盘」做成
 * 一个**按需从服务器取的窗口**，而不是一份本地副本。
 *
 * ── 为什么这件事在 Play! 上做得到 ────────────────────────────
 * Play!（js/play_browser/src/DiscImageDevice.ts）读盘只用到 File 的两样东西：
 *   `file.size` 和 `file.slice(start, end).arrayBuffer()`
 * 换句话说它要的不是 File，是**任何能按偏移给出字节的东西**。
 * 于是我们塞一个自己实现的对象进去就行，wasm 那边一个字都不用改。
 *
 * ⚠️ 这正是 PS2 能和 PS1 走不同路线的原因：EmulatorJS 那边的 ROM 下载在引擎内部的
 * XHR 里，没有这样一个可替换的读盘口子，只能整份下完再喂（见 adapters/emulatorjs.ts
 * 的 prepareRemoteDiscRom）。别指望把这套东西套到 EmulatorJS 上。
 *
 * ── 延迟才是设计的重点 ───────────────────────────────────────
 * 本地 File 切一片是微秒级，一次 Range 往返是几十到几百毫秒 —— 差了五个数量级。
 * 逐次请求的话游戏会卡到没法玩。所以：
 *   1. **按大块对齐取**（CHUNK_BYTES），一次往返换回几百次扇区读；
 *   2. **缓存已取回的块**（LRU，有字节上限），来回读同一片地图不重复走网络；
 *   3. **顺序预取**：给出第 n 块时顺手把第 n+1 块也拉了。光盘读取绝大多数是顺序的，
 *      这一条基本上把「过场动画卡顿」消掉。
 * 三条都是纯粹的访问模式优化，不改变任何语义。
 */

/** Play! 的读盘口子真正用到的东西，就这么两样 */
export interface DiscSource {
  readonly size: number
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> }
}

/** 一次 Range 取多大。2MB：一次往返换回约一千次 2048 字节的扇区读 */
export const CHUNK_BYTES = 2 * 1024 * 1024

/** 块缓存的字节上限。超了按最久未用淘汰 */
export const DEFAULT_CACHE_BYTES = 192 * 1024 * 1024

/** 取一段字节。抽成参数是为了能在 node 里测：真实实现走 fetch + Range 头 */
export type RangeFetcher = (start: number, endInclusive: number) => Promise<ArrayBuffer>

export interface RemoteDiscOptions {
  size: number
  fetchRange: RangeFetcher
  chunkBytes?: number
  cacheBytes?: number
  /** 顺序预取下一块。默认开；测试里关掉好断言请求次数 */
  prefetch?: boolean
  /** 向前保持多少个 2MB 块。默认 2；再大收益很小，却会和 WASM / 音频争网络。 */
  prefetchBlocks?: number
}

/**
 * 按块取、带 LRU 缓存的远程盘。
 *
 * ⚠️ `slice()` 必须**同步**返回一个带 `arrayBuffer()` 的对象 —— Play! 那边就是这么用的
 * （`this.file.slice(a, b).arrayBuffer().then(...)`）。所以这里返回的是一个惰性壳子，
 * 真正的网络请求发生在 `arrayBuffer()` 被调用时。写成 async slice 会让 wasm 拿到
 * 一个 Promise 然后去调它的 .arrayBuffer()，当场 TypeError。
 */
export class RemoteDisc implements DiscSource {
  readonly size: number
  private readonly chunkBytes: number
  private readonly cacheBytes: number
  private readonly fetchRange: RangeFetcher
  private readonly prefetchBlocks: number

  /** 块号 → 字节。Map 保持插入顺序，重新 set 一次就等于「最近用过」，LRU 靠这个 */
  private readonly cache = new Map<number, ArrayBuffer>()
  /** 块号 → 正在飞的请求。同一块被并发要两次时只发一次 */
  private readonly inflight = new Map<number, Promise<ArrayBuffer>>()
  private cached = 0

  /** 诊断用：真正走了多少次网络、命中了多少次。跑不动时先看这两个数 */
  stats = { requests: 0, hits: 0, bytesFetched: 0 }

  constructor(opts: RemoteDiscOptions) {
    this.size = opts.size
    this.chunkBytes = opts.chunkBytes ?? CHUNK_BYTES
    this.cacheBytes = opts.cacheBytes ?? DEFAULT_CACHE_BYTES
    this.fetchRange = opts.fetchRange
    const requestedPrefetch = opts.prefetch === false ? 0 : Math.max(0, Math.trunc(opts.prefetchBlocks ?? 2))
    // 缓存连“当前块 + 预取块”都装不下时主动缩窗，否则预取会把下一次马上要读的块自己淘汰掉。
    this.prefetchBlocks = Math.min(requestedPrefetch, Math.max(0, Math.floor(this.cacheBytes / this.chunkBytes) - 1))
  }

  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> } {
    // 夹回盘内。核心偶尔会读到盘末之后（探测盘尾、猜容量），越界不该变成一个网络错误
    const from = Math.max(0, Math.min(this.size, Math.trunc(start)))
    const to = Math.max(from, Math.min(this.size, Math.trunc(end)))
    return { arrayBuffer: () => this.read(from, to) }
  }

  private async read(from: number, to: number): Promise<ArrayBuffer> {
    const length = to - from
    const out = new Uint8Array(length)
    if (length === 0) return out.buffer

    const first = Math.floor(from / this.chunkBytes)
    const last = Math.floor((to - 1) / this.chunkBytes)
    for (let i = first; i <= last; i++) {
      const chunk = new Uint8Array(await this.chunk(i))
      const chunkStart = i * this.chunkBytes
      // 这一块里要用到的区间，换算成块内偏移
      const copyFrom = Math.max(from, chunkStart) - chunkStart
      const copyTo = Math.min(to, chunkStart + chunk.length) - chunkStart
      if (copyTo > copyFrom) out.set(chunk.subarray(copyFrom, copyTo), chunkStart + copyFrom - from)
    }

    // 保持两块滚动预读：2MB 单块在跨洲链路上可能要数秒，只提前一块仍会被连续音频/视频追上。
    // 不 await，也不管它成不成；正式读取会复用 inflight，失败则按真实请求重新获取。
    for (let ahead = 1; ahead <= this.prefetchBlocks; ahead++) {
      const next = last + ahead
      if (next * this.chunkBytes >= this.size) break
      if (!this.cache.has(next) && !this.inflight.has(next)) void this.chunk(next).catch(() => {})
    }
    return out.buffer
  }

  private chunk(index: number): Promise<ArrayBuffer> {
    const hit = this.cache.get(index)
    if (hit) {
      this.stats.hits++
      // 重新插一遍 = 移到 Map 末尾 = 标记为最近使用
      this.cache.delete(index)
      this.cache.set(index, hit)
      return Promise.resolve(hit)
    }
    const flying = this.inflight.get(index)
    if (flying) return flying

    const start = index * this.chunkBytes
    const endInclusive = Math.min(this.size, start + this.chunkBytes) - 1
    this.stats.requests++
    const p = this.fetchRange(start, endInclusive)
      .then((buf) => {
        // 不完整的块如果进缓存，后续扇区会被 Uint8Array 默认的零填充悄悄弄坏。
        if (buf.byteLength !== endInclusive - start + 1) {
          throw new Error(`读盘块不完整：期望 ${endInclusive - start + 1} 字节，实际 ${buf.byteLength}`)
        }
        this.stats.bytesFetched += buf.byteLength
        this.store(index, buf)
        return buf
      })
      .finally(() => {
        this.inflight.delete(index)
      })
    this.inflight.set(index, p)
    return p
  }

  private store(index: number, buf: ArrayBuffer): void {
    this.cache.set(index, buf)
    this.cached += buf.byteLength
    // 最久未用的先走。留着当前这块 —— 调用方马上就要读它
    for (const key of this.cache.keys()) {
      if (this.cached <= this.cacheBytes) break
      if (key === index) continue
      this.cached -= this.cache.get(key)?.byteLength ?? 0
      this.cache.delete(key)
    }
  }

  /** 换游戏 / 拆会话时把缓存放掉，几百 MB 不该跟着页面一直留着 */
  dispose(): void {
    this.cache.clear()
    this.inflight.clear()
    this.cached = 0
  }
}

/* ---------------- 探测 ---------------- */

export interface ProbeResult {
  /** 服务器支持 Range，可以流式读 */
  rangeSupported: boolean
  /** 盘的字节数；拿不到 Content-Length 时是 0 */
  size: number
}

/** 两字节 Range 探测不应让启动界面永远等响应头。 */
export const RANGE_PROBE_TIMEOUT_MS = 15_000
/** 读盘单块通常只有 2MB；连续 30 秒一个字节都没有就结束这一局的读取请求。 */
const RANGE_STALL_TIMEOUT_MS = 30_000

function cancelResponse(res: Response): void {
  if (res.body) void res.body.cancel().catch(() => {})
}

/**
 * 这个地址能不能流式读。
 *
 * 用一次「只要头两个字节」的 Range 请求探，而不是 HEAD：
 * 有些 CDN 对 HEAD 回 200 且带 Accept-Ranges，实际发 Range 时却整份吐出来。
 * 直接发一个真的 Range 请求，看回的是不是 **206**，是唯一靠得住的判断。
 *
 * ⚠️ 探不到就返回 rangeSupported: false，调用方要有整份下载那条退路 ——
 * 对 PS1 那种几百 MB 的盘退回去还能用，PS2 则只能报错（几 GB 下不下来）。
 */
export async function probeRange(
  url: string,
  signal?: AbortSignal,
  timeoutMs = RANGE_PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  if (signal?.aborted) return { rangeSupported: false, size: 0 }
  const controller = new AbortController()
  const abortFromParent = () => controller.abort()
  signal?.addEventListener('abort', abortFromParent, { once: true })
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
  let res: Response | null = null
  try {
    res = await fetch(url, { headers: { Range: 'bytes=0-1' }, signal: controller.signal })
    if (!res.ok) {
      cancelResponse(res)
      return { rangeSupported: false, size: 0 }
    }
    // Range 偏移必须对应磁盘原始字节；代理若 gzip/br 后再回 206，浏览器解码会让偏移失真。
    if (res.headers.get('content-encoding')) {
      cancelResponse(res)
      return { rangeSupported: false, size: 0 }
    }
    // Content-Range: bytes 0-1/4700372992 —— 斜杠后面才是整盘大小，
    // 这一条比 Content-Length 可靠：206 的 Content-Length 说的是这一片的长度（2），不是整盘
    // 探测只要两个字节；看完响应头就关掉流，尤其不能把忽略 Range 的 200 整盘下载下来。
    const cr = res.headers.get('content-range') ?? ''
    const match = /^bytes 0-1\/(\d+)$/i.exec(cr)
    const size = match ? Number(match[1]) : 0
    cancelResponse(res)
    if (res.status === 206 && Number.isSafeInteger(size) && size > 1) {
      return { rangeSupported: true, size }
    }
    const len = Number(res.headers.get('content-length'))
    return { rangeSupported: false, size: Number.isFinite(len) && len > 0 ? len : 0 }
  } catch {
    return { rangeSupported: false, size: 0 }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abortFromParent)
  }
}

/** 真实的 Range 取字节。206 之外一律当失败 —— 拿到整份 200 会把内存吃光 */
export function httpRangeFetcher(
  url: string,
  signal?: AbortSignal,
  stallMs = RANGE_STALL_TIMEOUT_MS,
): RangeFetcher {
  return async (start, endInclusive) => {
    const expected = endInclusive - start + 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endInclusive) || start < 0 || expected <= 0) {
      throw new RangeError('读盘失败：Range 偏移无效')
    }

    const controller = new AbortController()
    const abortFromParent = () => controller.abort()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener('abort', abortFromParent, { once: true })
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const touch = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, Math.max(1, stallMs))
    }

    try {
      touch()
      const res = await fetch(url, {
        headers: { Range: `bytes=${start}-${endInclusive}` },
        signal: controller.signal,
      })
      if (res.status !== 206) {
        cancelResponse(res)
        throw new Error(`读盘失败：期望 206，实际 ${res.status}`)
      }
      if (res.headers.get('content-encoding')) {
        cancelResponse(res)
        throw new Error('读盘失败：服务器对 Range 正文启用了压缩，磁盘偏移不可靠')
      }
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(res.headers.get('content-range') ?? '')
      if (
        !match
        || Number(match[1]) !== start
        || Number(match[2]) !== endInclusive
        || !Number.isSafeInteger(Number(match[3]))
        || Number(match[3]) <= endInclusive
      ) {
        cancelResponse(res)
        throw new Error('读盘失败：服务器返回的 Content-Range 与请求偏移不一致')
      }
      const contentLength = res.headers.get('content-length')
      if (contentLength !== null && Number(contentLength) !== expected) {
        cancelResponse(res)
        throw new Error(`读盘失败：分段长度应为 ${expected}，服务器声明 ${contentLength}`)
      }
      if (!res.body) {
        const bytes = await res.arrayBuffer()
        if (bytes.byteLength !== expected) {
          throw new Error(`读盘失败：分段长度应为 ${expected}，实际 ${bytes.byteLength}`)
        }
        return bytes
      }

      // 直接写进定长缓冲，不用无界 chunks；错回一整张盘的代理响应也不会把内存吃光。
      const reader = res.body.getReader()
      const bytes = new Uint8Array(expected)
      let loaded = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!value) continue
          touch()
          if (loaded + value.byteLength > expected) {
            await reader.cancel().catch(() => {})
            throw new Error(`读盘失败：Range 正文超过 ${expected} 字节`)
          }
          bytes.set(value, loaded)
          loaded += value.byteLength
        }
      } finally {
        reader.releaseLock()
      }
      if (loaded !== expected) {
        throw new Error(`读盘失败：分段长度应为 ${expected}，实际 ${loaded}`)
      }
      return bytes.buffer
    } catch (error) {
      if (timedOut) throw new Error(`读盘卡住：${Math.round(Math.max(1, stallMs) / 1000)} 秒没有收到数据`)
      throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', abortFromParent)
    }
  }
}
