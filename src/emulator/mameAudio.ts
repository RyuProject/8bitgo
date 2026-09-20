/**
 * MAME（mame-current）的音频窗口：把引擎写死的 `audio_latency = 64` 调大。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────
 * 核心的音频驱动（RetroArch 的 RWebAudio，编译在核心胶水层里）是这么播声音的：
 *
 *   function _RWebAudioQueueBuffer(num_frames, left, right) {
 *     if (RWA.nonblock && _RWebAudioWriteAvailFrames() < num_frames) return 0   // 空间不够 → 整块丢
 *     var buffer = createBuffer(2, num_frames, context.sampleRate)              // 1:1 拷，不重采样
 *     var startTime = RWA.endTime > currentTime ? RWA.endTime
 *                     : Math.ceil(currentTime*1000)/1000 + MIN_START_OFFSET_SEC // 排空后重新起算
 *     RWA.endTime = startTime + buffer.duration
 *     bufferSource.start(startTime + RWA.extraLatencySec)
 *   }
 *
 * 也就是：**每批音频都是一个新 AudioBufferSourceNode，首尾靠时间戳精确相接**，
 * 而能提前排多久由窗口大小决定 —— 窗口就是 `audio_latency` 毫秒
 * （`WriteAvailFrames = (latency/1000 - endTime + now) * sampleRate`）。
 *
 * 引擎把 `audio_latency = 64` 写死在 retroarch.cfg 里（见 getRetroArchCfg）。
 * 64ms 意味着：**主线程只要有超过 64ms 的长任务，音频队列就被抽干**，下一块要么
 * 被丢掉、要么带着 MIN_START_OFFSET_SEC 重新起算 —— 两者都是波形不连续，
 * 听感就是短促音效上的「毛刺」。
 *
 * 这不是理论：线上实测到过 `requestAnimationFrame handler took 91ms` 的主线程长任务
 * （DevTools 开着、聊天/直播面板在跑时更容易），而 91 > 64。
 *
 * ── 为什么只给 MAME 调 ────────────────────────────────────────
 * MAME 是本站最重的核心（37MB 压缩 / 242MB 解压、软件渲染整块街机板），最容易卡到
 * 抽干窗口；而 FBNeo 那一批轻得多，从来没人报过毛刺。调大窗口的代价是**实打实的
 * 音画延迟**（+64ms），所以不做成全站默认 —— 只给 mame-current 这一个核心。
 *
 * ── 怎么生效 ─────────────────────────────────────────────────
 * `retroarch.cfg` 在虚拟文件系统里（`/home/web_user/.config/retroarch/retroarch.cfg`），
 * 引擎在核心模块初始化时就写好了，而**核心是在 callMain 里才去读它的**（本地日志顺序可证：
 * `[Config] Looking for config in …` 出现在核心 banner 与 `[RWebAudio] Device rate` 之前、
 * 而这两行都在我们的 beforeStart 钩子之后）。所以开局前改写这份 cfg 完全来得及。
 *
 * 怎么验证真的生效：核心会打印窗口大小 ——
 * `[RWebAudio] Buffer size: 24576 bytes` = 64ms × 48000 × 2ch × 4B；
 * 改成 128ms 之后应该变成 49152 bytes。看不到这行变小/没变就是没写进去。
 *
 * 抽成纯函数是为了能测（和 biosPlan.ts 同一个理由：这段逻辑在 iframe 里没法单测）。
 * 回归：`npm run test:mame-audio`。
 */

/**
 * MAME 的音频窗口（毫秒）。引擎默认 64，这里给 128。
 *
 * 取 128 的理由：实测到的长任务最大 91ms，64 的窗口必然被抽干；128 留了余量，
 * 且 128ms × 48000 = 6144 帧（整数，日志里 Buffer size 会正好是 49152 bytes，便于核对）。
 * 觉得延迟偏大想调小的话，先看核心日志里的 Buffer size 是不是跟着变了。
 */
export const MAME_AUDIO_LATENCY_MS = 128

/** 引擎写这份配置的位置（Emscripten 虚拟文件系统内的绝对路径） */
export const RETROARCH_CFG_PATH = '/home/web_user/.config/retroarch/retroarch.cfg'

const LATENCY_LINE = /^\s*audio_latency\s*=/

/**
 * 把 cfg 里的 `audio_latency` 覆盖成 targetMs，其它行一个字都不动。
 *
 * 三条约定：
 *   1. **已有那一行就地改**，不是追加 —— cfg 是给人看的排查材料，
 *      留着两行（一行 64 一行 128）只会让下一个人怀疑到底哪行生效。
 *      就地改同时也满足「后写覆盖先写」的语义，不依赖解析顺序。
 *   2. **本来就是这个值就原样返回**（调用方按「返回值 === 入参」判断要不要写盘），
 *      这样钩子跑两次也不会把文件改脏。
 *   3. 有多行 `audio_latency` 时只保留第一条、其余清空，避免出现互相矛盾的配置。
 */
export function raiseAudioLatency(cfg: string, targetMs: number): string {
  const target = `audio_latency = ${targetMs}`
  // 空文件（引擎还没写 cfg / 读出来是空的）直接给一行，别留下一个开头的空行
  if (!cfg.trim()) return target
  const lines = cfg.split('\n')
  let done = false
  const out = lines.map((line) => {
    if (!LATENCY_LINE.test(line)) return line
    if (done) return ''
    done = true
    return target
  })
  if (!done) {
    // cfg 一般以换行结尾，split 会多出一个空串；占它那个位置，别再多出一行空行
    if (out.length > 0 && out[out.length - 1].trim() === '') out[out.length - 1] = target
    else out.push(target)
  }
  return out.join('\n')
}
