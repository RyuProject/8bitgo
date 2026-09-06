/**
 * 加载进度：把「正在下载多少 / 共多少」从各个运行时里统一收上来。
 *
 * 为什么需要它：以前播放器只有「加载中…」一句话，玩家分不清是在下 200KB 的 NES ROM
 * 还是在下 melonDS 那 3MB 的 wasm 加 6.7MB 的资源包 —— 后者在慢网络上要几十秒，
 * 期间画面全黑，看起来就像坏了。
 *
 * 能报真实字节数的只有「适配器自己去 fetch」的那几个（jsnes / jsdos / ruffle 的远程 SWF）。
 * iframe 型的引擎各有各的办法：webretro 同源，父窗口能读到它自己的 <progress>；
 * EmulatorJS 的下载全走 XHR，在 iframe 里把 XMLHttpRequest 包一层就能拿到字节数
 * （见 adapters/emulatorjs.ts 的 installProgressTap）—— 它自己那套文字进度 UI 我们
 * 一个字都不用碰，反正整个加载期间都被遮罩盖着。
 */
import type { LoadPhase, LoadProgress } from './types'
import { windowsLaunchDelayMs } from './windowsLaunch'

/** 进度回调节流：下载一个几十 MB 的 ROM 会触发上千次 chunk，全都 setState 会把主线程拖垮 */
const THROTTLE_MS = 120

export interface ProgressSink {
  (p: LoadProgress): void
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
export async function fetchWithProgress(
  url: string,
  opts: {
    phase?: LoadPhase
    onProgress?: ProgressSink
    signal?: AbortSignal
    /** 拿到响应头之后的校验钩子，比如挡掉返回 HTML 的错误页 */
    check?: (res: Response) => void
  } = {},
): Promise<ArrayBuffer> {
  const phase = opts.phase ?? 'rom'
  const emit = throttleProgress(opts.onProgress)

  emit({ phase, loaded: 0 }, true)

  const res = await fetch(url, { signal: opts.signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  opts.check?.(res)

  const encoded = Boolean(res.headers.get('content-encoding'))
  const len = Number(res.headers.get('content-length'))
  // 压缩过的响应，Content-Length 对不上解压后的字节数，直接当作未知总量
  let total = !encoded && Number.isFinite(len) && len > 0 ? len : undefined

  if (!res.body) {
    const buf = await res.arrayBuffer()
    if (total !== undefined && buf.byteLength !== total) {
      throw new Error(`下载不完整：应为 ${total} 字节，实际收到 ${buf.byteLength} 字节`)
    }
    emit({ phase, loaded: buf.byteLength, total: buf.byteLength, ratio: 1 }, true)
    return buf
  }

  const { chunks, loaded } = await drain(res.body, phase, total, emit)

  // 拼成一整块。最后一帧用真实总量，进度条一定走到 100%
  const out = new Uint8Array(loaded)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  emit({ phase, loaded, total: loaded, ratio: 1 }, true)
  return out.buffer
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
): Promise<{ chunks: Uint8Array[]; loaded: number }> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = totalHint
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    loaded += value.byteLength
    // 万一还是超了（服务器给的 Content-Length 本身就不对），转不确定态而不是显示 120%
    if (total !== undefined && loaded > total) total = undefined
    emit({ phase, loaded, total, ratio: total ? Math.min(loaded / total, 1) : undefined })
  }
  if (total !== undefined && loaded !== total) {
    throw new Error(`下载不完整：应为 ${total} 字节，实际收到 ${loaded} 字节`)
  }
  return { chunks, loaded }
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
}

/**
 * 一片多大。8MB 是在「重传代价」和「请求开销」之间取的：
 * 断一次只白下 8MB，而一张 600MB 的盘也才 75 个请求，HTTP/2 下开销可以忽略。
 */
export const CHUNK_BYTES = 8 * 1024 * 1024

/**
 * ⚠️ 小文件不需要特判：第一个 Range 请求要的就是 `bytes=0-<片长-1>`，
 * 比这短的文件一次就回全了，循环一次都不进。所以这里没有「多大以上才分片」的阈值。
 *
 * 而且这条路目前只有光盘平台在走（见 adapters/emulatorjs.ts 的 prepareRemoteDiscRom）——
 * 卡带机 ROM 走的是 loadGameBytes 那条 ArrayBuffer 路径，一个字节都不受影响。
 */

/** 单片重试次数。三次退避（0.5s / 1s / 2s）足够熬过一次 Wi-Fi 切换 */
export const CHUNK_RETRIES = 3

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(id)
        reject(new DOMException('已取消', 'AbortError'))
      },
      { once: true },
    )
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
 * 不是为了快。**HTTP/2 下并发 Range 不会提高吞吐**（多个请求复用同一条连接），
 * 这里也是顺序下的。分片买到的是另外两样：
 *
 *   1. **断了不用从头来**。600MB 下到 95% 遇上一次 TCP reset / Wi-Fi 切 4G /
 *      代理超时，原来整个从 0 重来。现在只白下那 8MB。
 *      上传那边（services/romMultipart.ts）早就是这么干的，下载这边一直没有对等的东西。
 *   2. **内存封顶**。每片下完先合成一个子 Blob（浏览器会把大 Blob 落到磁盘），
 *      分片数组随即丢掉。峰值从「整个文件」降到「一片」。
 *
 * ⚠️ 第一个请求就带 `Range: bytes=0-<片长>`，**它既是探测也是第一片**：
 * 回 206 说明支持分片，`Content-Range` 顺带给出整份大小；回 200 说明服务器不认 Range，
 * 那就把这一条响应当整份读完（退回老路，一样能用）。用 HEAD 探不可靠 ——
 * 有些 CDN 对 HEAD 回 200 且带 Accept-Ranges，真发 Range 时却整份吐出来。
 */
export async function fetchBlobWithProgress(url: string, opts: BlobFetchOptions = {}): Promise<Blob> {
  const phase = opts.phase ?? 'rom'
  const type = opts.type ?? 'application/octet-stream'
  const chunkBytes = opts.chunkBytes ?? CHUNK_BYTES
  const retries = opts.retries ?? CHUNK_RETRIES
  const doFetch = opts.fetchImpl ?? fetch
  const emit = throttleProgress(opts.onProgress)

  emit({ phase, loaded: 0 }, true)

  const first = await doFetch(url, { headers: { Range: `bytes=0-${chunkBytes - 1}` }, signal: opts.signal })
  if (!first.ok) throw new Error(`HTTP ${first.status}`)
  opts.check?.(first)

  /* ---- 服务器不认 Range：这一条就是整份，按老路读完 ---- */
  if (first.status !== 206) {
    const encoded = Boolean(first.headers.get('content-encoding'))
    const len = Number(first.headers.get('content-length'))
    const total = !encoded && Number.isFinite(len) && len > 0 ? len : undefined
    if (!first.body) {
      const blob = await first.blob()
      if (total !== undefined && blob.size !== total) {
        throw new Error(`下载不完整：应为 ${total} 字节，实际收到 ${blob.size} 字节`)
      }
      emit({ phase, loaded: blob.size, total: blob.size, ratio: 1 }, true)
      return blob.type === type ? blob : new Blob([blob], { type })
    }
    const { chunks, loaded } = await drain(first.body, phase, total, emit)
    emit({ phase, loaded, total: loaded, ratio: 1 }, true)
    return new Blob(chunks as BlobPart[], { type })
  }

  /* ---- 206：Content-Range 的斜杠后面才是整份大小 ---- */
  // 206 的 Content-Length 说的是这一片的长度，不是整份 —— 拿它当总量会让进度条一开始就满
  const total = Number((first.headers.get('content-range') ?? '').split('/')[1])
  if (!Number.isFinite(total) || total <= 0) {
    // 回了 206 却说不清整份多大，没法分片。把这一片读完当整份用
    const blob = await first.blob()
    emit({ phase, loaded: blob.size, total: blob.size, ratio: 1 }, true)
    return new Blob([blob], { type })
  }

  const parts: Blob[] = []
  let done = 0
  /** 把分片内的进度换算成整份的进度 */
  const relay = (p: LoadProgress) => {
    const loaded = done + (p.loaded ?? 0)
    emit({ phase, loaded, total, ratio: Math.min(loaded / total, 1) })
  }

  const take = async (res: Response, expect: number) => {
    if (!res.body) {
      const blob = await res.blob()
      if (blob.size !== expect) throw new Error(`分片不完整：应为 ${expect} 字节，实际 ${blob.size}`)
      return blob
    }
    // drain 自带「收到的字节数和 Content-Length 对不上就抛」这道校验，正好当分片完整性检查
    const { chunks } = await drain(res.body, phase, expect, relay)
    return new Blob(chunks as BlobPart[])
  }

  parts.push(await take(first, Math.min(chunkBytes, total)))
  done += parts[0].size

  while (done < total) {
    const end = Math.min(done + chunkBytes, total) - 1
    const expect = end - done + 1
    let part: Blob | null = null
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await doFetch(url, { headers: { Range: `bytes=${done}-${end}` }, signal: opts.signal })
        if (res.status !== 206) throw new Error(`分片请求失败：期望 206，实际 ${res.status}`)
        part = await take(res, expect)
        break
      } catch (e) {
        // 取消是用户意图，不是失败，别在这儿空转重试
        if (isAbort(e) || opts.signal?.aborted) throw e
        if (attempt >= retries) throw e
        // 退避：0.5s / 1s / 2s。切网络那一下往往要一两秒才恢复
        await sleep(500 * 2 ** attempt, opts.signal)
      }
    }
    parts.push(part)
    done += part.size
  }

  emit({ phase, loaded: total, total, ratio: 1 }, true)
  return new Blob(parts, { type })
}

/* ---------------- 合成一条 0→100 的总进度 ---------------- */

/**
 * 每个阶段在整条进度上的固定区间。
 *
 * 固定区间比“按本次见到的阶段重新归一化”更重要：Windows 客体会先下载核心与共享
 * 系统镜像，再下载游戏 ROM，最后等待客体开机。如果把 starting 只留 3%，玩家会长时间
 * 卡在 90% 左右，以为浏览器死了。现在明确约定：
 *
 *   0–20%   模拟器核心
 *   20–40%  系统镜像 / 引擎素材
 *   40–80%  游戏 ROM
 *   80–100% 模拟器启动与超时等待
 *
 * 某款游戏没有其中一个阶段时，进入下一阶段会直接跨过那一小段；总进度仍然只进不退。
 */
export const LOAD_PHASE_RANGE: Record<LoadPhase, readonly [number, number]> = {
  engine: [0, 0.2],
  assets: [0.2, 0.4],
  rom: [0.4, 0.8],
  starting: [0.8, 1],
}

/**
 * Windows 客体的 CI 创建会把近百 MB 的 qcow2 镜像交给 WASM 解包、建盘；这段耗时取决于
 * 设备 CPU 和内存，不是网络下载结束就会立刻完成。原来只留 45 秒，快设备能进、慢设备
 * 却会在稍后同样成功之前被误判为失败。额外留 4 分钟，真实引擎错误仍会由 js-dos 立即上报。
 */
export const WINDOWS_GUEST_INIT_GRACE_MS = 4 * 60_000

/** 客体初始化 + 后台配置的开机等待，共同构成 80–99% 这段的超时预算。 */
export function windowsGuestStartupBudgetMs(launchDelaySeconds = 24): number {
  return windowsLaunchDelayMs(launchDelaySeconds) + WINDOWS_GUEST_INIT_GRACE_MS
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
 *      不表示模拟器已经可玩。80% 之后交给播放器的超时计时缓慢推进，onReady 才算成功。
 *   3. **从 floor 起算**：重试/换引擎时接着上一轮的百分比往前爬（见 liftRatio）
 *
 * @param floor 这一轮的起点。0 = 全新的一局；>0 = 接着上一轮已经显示的百分比
 */
export function createOverallRatio(floor = 0): (p: LoadProgress) => number {
  const base = Math.min(0.99, Math.max(0, floor))
  let shown = base
  return (p) => {
    const [start, end] = LOAD_PHASE_RANGE[p.phase]
    const span = end - start

    // starting=1 只代表适配器已经开始启动；真就绪必须等 onReady，不能瞬间画到 100%。
    let inner = p.phase === 'starting' ? 0 : p.ratio
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
