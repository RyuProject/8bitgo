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
 * Windows 9x 的 CI 创建会把近百 MB 的 qcow2 镜像交给 WASM 解包、建盘；这段耗时取决于
 * 设备 CPU 和内存，不是网络下载结束就会立刻完成。原来只留 45 秒，快设备能进、慢设备
 * 却会在稍后同样成功之前被误判为失败。额外留 4 分钟，真实引擎错误仍会由 js-dos 立即上报。
 */
export const WINDOWS_GUEST_INIT_GRACE_MS = 4 * 60_000

/** 客体初始化 + 后台配置的开机等待，共同构成 80–99% 这段的超时预算。 */
export function windowsGuestStartupBudgetMs(launchDelaySeconds = 24): number {
  const delay = Math.max(5, Math.min(120, launchDelaySeconds))
  return delay * 1000 + WINDOWS_GUEST_INIT_GRACE_MS
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
 * 造一个「把阶段进度折算成整条进度」的函数，每次加载新建一个。
 *
 * 两条保证：
 *   1. **只进不退**：记住已经显示过的最大值，任何回退都被吃掉
 *      （引擎乱序报数、或者某个阶段迟到，都不会让条子往回缩）
 *   2. **启动阶段不吃 ratio**：适配器报 starting=1 通常只表示“资源准备完了”，
 *      不表示模拟器已经可玩。80% 之后交给播放器的超时计时缓慢推进，onReady 才算成功。
 */
export function createOverallRatio(): (p: LoadProgress) => number {
  let shown = 0
  return (p) => {
    const [start, end] = LOAD_PHASE_RANGE[p.phase]
    const span = end - start

    // starting=1 只代表适配器已经开始启动；真就绪必须等 onReady，不能瞬间画到 100%。
    let inner = p.phase === 'starting' ? 0 : p.ratio
    if (inner === undefined && p.loaded !== undefined && p.loaded > 0) {
      inner = 1 - Math.exp(-p.loaded / SOFT_SCALE[p.phase])
    }
    const value = start + span * Math.min(1, Math.max(0, inner ?? 0))
    shown = Math.min(1, Math.max(shown, value))
    return shown
  }
}
