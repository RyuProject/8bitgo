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
  private readonly prefetch: boolean

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
    this.prefetch = opts.prefetch ?? true
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

    // 顺序预取：不 await，也不管它成不成 —— 失败了下次真要用时会照常再取一次
    if (this.prefetch) {
      const next = last + 1
      if (next * this.chunkBytes < this.size && !this.cache.has(next) && !this.inflight.has(next)) {
        void this.chunk(next).catch(() => {})
      }
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
export async function probeRange(url: string, signal?: AbortSignal): Promise<ProbeResult> {
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-1' }, signal })
    if (!res.ok) return { rangeSupported: false, size: 0 }
    // Content-Range: bytes 0-1/4700372992 —— 斜杠后面才是整盘大小，
    // 这一条比 Content-Length 可靠：206 的 Content-Length 说的是这一片的长度（2），不是整盘
    const cr = res.headers.get('content-range') ?? ''
    const total = Number(cr.split('/')[1])
    if (res.status === 206 && Number.isFinite(total) && total > 0) {
      return { rangeSupported: true, size: total }
    }
    const len = Number(res.headers.get('content-length'))
    return { rangeSupported: false, size: Number.isFinite(len) && len > 0 ? len : 0 }
  } catch {
    return { rangeSupported: false, size: 0 }
  }
}

/** 真实的 Range 取字节。206 之外一律当失败 —— 拿到整份 200 会把内存吃光 */
export function httpRangeFetcher(url: string, signal?: AbortSignal): RangeFetcher {
  return async (start, endInclusive) => {
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${endInclusive}` }, signal })
    if (res.status !== 206) throw new Error(`读盘失败：期望 206，实际 ${res.status}`)
    return res.arrayBuffer()
  }
}
