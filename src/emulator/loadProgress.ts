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

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
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

  // 浏览器通常会把 Content-Length 不足变成网络异常，但代理 / Service Worker 的自造
  // Response 不一定如此。这里自己收最后一道口，不能把“流正常结束”误当成“文件完整”。
  if (total !== undefined && loaded !== total) {
    throw new Error(`下载不完整：应为 ${total} 字节，实际收到 ${loaded} 字节`)
  }

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

/* ---------------- 合成一条 0→100 的总进度 ---------------- */

/**
 * 各阶段在整条进度里占的权重，数组顺序就是实际发生的顺序。
 *
 * 为什么要合成：适配器报的是**每个阶段自己的** 0~1，直接拿去画条子，
 * 玩家看到的就是「涨到满 → 归零 → 再涨」——一局加载里来回好几次，
 * 像坏了。进度条只该有一种状态：从 0 走到 100，而且只进不退。
 *
 * 权重按实际耗时估：引擎的 wasm 最大（Ruffle 那个核心十几 MB），
 * 素材包次之，ROM 通常最小，starting 只是收个尾。
 */
const PHASE_WEIGHT: Array<[LoadPhase, number]> = [
  ['engine', 45],
  ['assets', 30],
  ['rom', 22],
  ['starting', 3],
]

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
 * 造一个「把阶段进度折算成整条进度」的函数，每次加载新建一个。
 *
 * 两条保证：
 *   1. **只进不退**：记住已经显示过的最大值，任何回退都被吃掉
 *      （引擎乱序报数、或者某个阶段迟到，都不会让条子往回缩）
 *   2. **第一个出现的阶段从 0 开始**：jsnes 这种只有 rom 阶段的引擎，
 *      不会一上来就停在 75%——权重会在「见到的第一个阶段往后」重新归一化
 */
export function createOverallRatio(): (p: LoadProgress) => number {
  let base: number | null = null
  let shown = 0
  return (p) => {
    const idx = PHASE_WEIGHT.findIndex(([ph]) => ph === p.phase)
    if (idx < 0) return shown
    if (base === null) base = idx
    // 比第一个见到的还早的阶段：迟到的回调，忽略（有 shown 兜着，条子不动）
    if (idx < base) return shown

    const scope = PHASE_WEIGHT.slice(base)
    const weightSum = scope.reduce((s, [, w]) => s + w, 0)
    let start = 0
    for (const [ph, w] of scope) {
      if (ph === p.phase) break
      start += w / weightSum
    }
    const span = PHASE_WEIGHT[idx][1] / weightSum

    let inner = p.ratio
    if (inner === undefined && p.loaded !== undefined && p.loaded > 0) {
      inner = 1 - Math.exp(-p.loaded / SOFT_SCALE[p.phase])
    }
    const value = start + span * Math.min(1, Math.max(0, inner ?? 0))
    shown = Math.min(1, Math.max(shown, value))
    return shown
  }
}
