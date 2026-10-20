/**
 * 音频探针：把一个 iframe 里跑的引擎的声音**旁路**出来一份，供录像和直播取用。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────
 * 录像和直播要的是 `MediaStreamAudioDestinationNode`，而那个节点只能接在**产生声音的
 * 那个 AudioContext** 上。EmulatorJS、Ruffle 这些引擎都是自己 `new AudioContext()`，
 * 没有任何公开接口把它或者输出节点交出来 —— 于是录出来的视频和推出去的直播都是**静音**的。
 *
 * ── 怎么做 ───────────────────────────────────────────────────
 * 在引擎脚本加载**之前**，把它那个 realm 里的两样东西换掉：
 *   1. `AudioContext` 构造函数 —— 记下引擎建的第一个上下文，并在它上面建一个 GainNode
 *   2. `AudioNode.prototype.connect` —— 凡是**直接连到 destination**（扬声器）的节点，
 *      顺手再接一份到那个 GainNode 上
 * 然后把这个 Gain 当 `audioNode` 交给 `captureSources()`。
 *
 * ⚠️ 只旁路「直接连到扬声器」的那一路。中间节点也一起采的话同一条声音会被收好几遍。
 * ⚠️ NDS 的 RWebAudio 每批 PCM 都新建 AudioBufferSourceNode。默认旁路会让每批短音块
 * connect 两次，持续增加主线程和音频图开销；NDS 改走 shared-output：把短音块只接到一条
 * 固定总线，总线常驻连扬声器，录像/直播需要时再从同一总线分一条支路。
 * 两种模式都只有一条声音到扬声器，不会叠音。
 *
 * ── 为什么这么干是安全的 ─────────────────────────────────────
 * patch 落在**那个 iframe 自己的 realm** 里，不碰父页面，也不影响别的运行时；
 * 每开一局都是一个全新的 iframe，销毁时整个 realm 跟着没，不需要还原。
 * 而且每一步都兜住了：拿不到构造函数就原样返回一个空探针，旁路失败只影响录音里的声音、
 * 不影响游戏本身。**最坏的结果就是今天的行为 —— 没声音。**
 *
 * ⚠️ 时机是唯一的硬要求：必须赶在引擎建 AudioContext 之前装上。
 * 两个调用方都满足：EmulatorJS 在注入 loader.js 之前装，Ruffle 在注入 ruffle.js 之前装。
 */

export interface AudioTap {
  /** 引擎建的第一个 AudioContext */
  ctx: AudioContext | null
  /** 录屏取声点：direct-tap 是旁路；shared-output 是游戏声音唯一经过的固定输出总线。 */
  node: GainNode | null
}

/**
 * 同一个 realm 上已经装过的那个探针。
 *
 * ⚠️ 必须幂等。装第二次会把**已经包过的** connect 再包一层：一次
 * `connect(destination)` 于是旁路出两份，同一条声音被采两遍（录像里就是叠音、忽大忽小）。
 * 调用方现在都是「一个 iframe 装一次」，但 iframe 的 load 事件本来就可能来第二次
 * （销毁时把 src 换成 about:blank 也会触发），这种事不该靠调用方记得。
 */
const TAP_KEY = '__8bitgoAudioTap'
export type AudioTapMode = 'direct-tap' | 'shared-output'

/** 在 win 这个 realm 上装音频探针。必须在引擎脚本加载之前调；同一个 realm 装几次都一样 */
export function installAudioTap(win: Window & Record<string, unknown>, mode: AudioTapMode = 'direct-tap'): AudioTap {
  const existing = win[TAP_KEY] as AudioTap | undefined
  if (existing) return existing

  const tap: AudioTap = { ctx: null, node: null }
  const Native = (win.AudioContext || win.webkitAudioContext) as typeof AudioContext | undefined
  const NodeProto = (win as unknown as { AudioNode?: { prototype: AudioNode } }).AudioNode?.prototype
  // 装不成就别动人家的构造函数，也别记标记 —— 下次（换个时机）还能再试
  if (typeof Native !== 'function' || !NodeProto) return tap
  win[TAP_KEY] = tap
  const origConnect = NodeProto.connect

  class TappedAudioContext extends Native {
    constructor(...args: unknown[]) {
      super(...(args as [AudioContextOptions?]))
      if (!tap.ctx) {
        tap.ctx = this
        try {
          const node = this.createGain()
          if (mode === 'shared-output') {
            // 只在建总线时连接一次；不能调用已包装的 connect，否则又进入逐音块旁路逻辑。
            ;(origConnect as (...a: unknown[]) => unknown).call(node, this.destination)
          }
          tap.node = node
        } catch {
          tap.node = null
        }
      }
    }
  }
  win.AudioContext = TappedAudioContext
  if (win.webkitAudioContext) win.webkitAudioContext = TappedAudioContext

  NodeProto.connect = function (this: AudioNode, dest: AudioNode | AudioParam, ...rest: unknown[]) {
    if (mode === 'shared-output' && tap.ctx && tap.node && dest === tap.ctx.destination) {
      try {
        // 这条固定总线只接一次扬声器；每个临时 AudioBufferSourceNode 只需接总线一次。
        ;(origConnect as (...a: unknown[]) => unknown).call(this, tap.node, ...rest)
        return dest as AudioNode
      } catch {
        // 总线失效也不能让游戏静音：下面原样接回扬声器，最多只损失录屏声音。
      }
    }
    const ret = (origConnect as (...a: unknown[]) => unknown).call(this, dest, ...rest)
    try {
      // 只旁路「直接连到扬声器」的那一路，避免中间节点被重复采集
      if (mode === 'direct-tap' && tap.ctx && tap.node && dest === tap.ctx.destination) {
        ;(origConnect as (...a: unknown[]) => unknown).call(this, tap.node)
      }
    } catch {
      /* 旁路失败只影响录音里的声音，不影响游戏 */
    }
    return ret as AudioNode
  } as AudioNode['connect']

  return tap
}
