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
