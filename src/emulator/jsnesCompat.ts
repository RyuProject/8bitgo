import type { NESOptions } from 'jsnes'

/**
 * jsnes 能 loadROM 不等于能把游戏真正跑起来：mapper 4 的个别 ROM 会在开局几帧后跳进
 * 无效操作码。多跑 12 帧足够覆盖这次《超级马力欧兄弟 3》在第 7 帧崩溃的情况，开销又
 * 只有约 0.2 秒的模拟时间，不会把每次启动都变成一次肉眼可见的长自检。
 */
export const JSNES_PREFLIGHT_FRAMES = 12

interface JsnesStartupCore {
  loadROM: (data: string) => void
  frame: () => void
}

export type JsnesCoreConstructor = new (options: NESOptions) => JsnesStartupCore

/**
 * 在 Browser 挂全局键盘监听、创建 AudioContext 之前先用纯核心试跑几帧。
 *
 * 这里故意返回错误而不是抛：调用方要把它归类为「这份 ROM 不适合 jsnes」，交给播放器
 * 换 EmulatorJS；若当成普通加载错误原样重试，只会确定性地再灰屏一次。
 */
export function probeJsnesStartup(Core: JsnesCoreConstructor, romData: string, frames = JSNES_PREFLIGHT_FRAMES): Error | null {
  try {
    const nes = new Core({
      onFrame: () => {},
      onAudioSample: () => {},
      onStatusUpdate: () => {},
      onBatteryRamWrite: () => {},
      // Browser 在 AudioContext 尚未创建时也是用 44100；自检要和真正开局走同一条核心路径。
      sampleRate: 44100,
    })
    nes.loadROM(romData)
    for (let i = 0; i < frames; i++) nes.frame()
    return null
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

interface DisconnectableAudioNode {
  disconnect: () => void
}

interface ClosableAudioContext {
  close: () => Promise<unknown>
}

export interface JsnesSpeakerStopTarget {
  stop?: () => void
  node?: DisconnectableAudioNode | null
  audioCtx?: ClosableAudioContext | null
  batchPos?: number
  _removeResumeListeners?: () => void
}

/**
 * jsnes 2.1.0 的 stop() 写死了 `node.disconnect(audioCtx.destination)`。本站为了调音量，把
 * 连接改成 node -> gain -> destination 后，那条特定目标连接已经不存在，Chrome 会抛
 * InvalidAccessError；更糟的是 Browser 的异常处理会先 stop 再上报，于是这条清理错误把真正的
 * 「invalid opcode」盖掉，还让 worklet 留着不断重试。
 *
 * 只有音频确实被本站改线时才接管 stop；未改线时继续走上游实现。下面几步刻意保持与
 * jsnes 2.1.0 一致，只把「断开特定 destination」换成「断开全部输出」。升级 jsnes 后测试会
 * 核对这组内部字段，避免上游改了生命周期而我们继续悄悄照抄旧实现。
 */
export function installJsnesSafeStop(
  speakers: JsnesSpeakerStopTarget,
  isRerouted: () => boolean,
  onStopped: () => void,
): void {
  if (typeof speakers.stop !== 'function') return
  const nativeStop = speakers.stop.bind(speakers)

  speakers.stop = () => {
    if (!isRerouted()) {
      try {
        nativeStop()
      } finally {
        onStopped()
      }
      return
    }

    try {
      speakers._removeResumeListeners?.()
    } catch {
      /* 清理监听不能阻断后面的音频释放 */
    }
    try {
      speakers.node?.disconnect()
    } catch {
      /* 节点可能已被浏览器或录像逻辑提前断开 */
    }
    speakers.node = null

    const ctx = speakers.audioCtx
    speakers.audioCtx = null
    if (ctx) {
      try {
        void ctx.close().catch(() => {})
      } catch {
        /* 已关闭的 context 在不同浏览器里行为不一致，停机必须保持幂等 */
      }
    }
    speakers.batchPos = 0
    onStopped()
  }
}
