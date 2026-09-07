/**
 * 推流画面的编码参数：直播和联机**共用这一份**。
 *
 * ── 为什么要按源分辨率分两档 ─────────────────────────────────
 * 两条路原来都写死 `degradationPreference: 'maintain-framerate'`，注释是
 * 「游戏画面宁可糊一点也不要卡」。这句话对 640×480 的 DOS 成立，
 * 对 240×160 的 GBA 是**反的** —— 那个源本来就没有分辨率可降：
 *
 *   maintain-framerate 的含义是「扛不住就把分辨率缩下去」。
 *   240×160 缩一半是 120×80，而观众的屏幕还要把它放大回去 ——
 *   得到的不是「糊一点」，是一团认不出字的马赛克。像素画的每一个像素都是内容，
 *   缩放对它的破坏远大于对摄像头画面的破坏。
 *
 * 所以按源的大小分档：**小源保分辨率、掉帧率；大源保帧率、降分辨率**。
 * 分界线取 320×240（PS1 / 街机多数板子的分辨率）—— 这条线以下的机型
 * （NES 256×224、GBA 240×160、GB 160×144）缩一次就没法看了。
 *
 * `contentHint` 要和它一致，否则等于给编码器两个相反的指示：
 * `'detail'` = 「保清晰，可以掉帧」，`'motion'` = 「保流畅，可以糊」。
 *
 * ── 为什么码率也要按分辨率算 ────────────────────────────────
 * 原来直播固定 1.5Mbps、联机固定 2.5Mbps，全平台一个数。可 Game Boy 是 160×144、
 * DOS / N64 是 640×480 —— 像素数差 15 倍。结果是小机型白占上行
 * （直播 12 个观众 = 12 路，省下来的是实打实的），大机型一动就马赛克。
 *
 * ⚠️ 系数取 0.25 bit/像素/帧，比分享标签页那条路（tabBitrate 用 0.1）高一倍多。
 * 不是拍脑袋：像素画对视频编码器是**难**内容 —— 满屏高对比硬边缘、抖动色带，
 * 没有摄像头画面那种可以省掉的高频噪声。按 0.1 给的话 NES 只有 460kbps，一动就块。
 */

/** 源画面到这个大小以内，就按「像素画」对待 */
export const RETRO_MAX_PIXELS = 320 * 240

/**
 * 一条视频源的短边小于这个数，就当它**根本没有画面**。
 *
 * 2026-09-06 线上出过一次：观众收到的是一条 **2×2 的纯黑**流 —— 连接是好的、帧在正常解码，
 * 废的是画面本身。主播那边的 `<ruffle-player>` 当时只有 1 个 CSS 像素（× dpr 2），
 * `captureStream` 忠实地把这一格推了出去。
 *
 * 当时全链路没有一处拦得住它：抓屏照抓、编码器按 1Mbps 去编一格像素、
 * 观众端 `videoWidth > 0` 就算「有画面了」，于是进度条撤掉、看门狗清掉，
 * 剩下一块**永远黑、永远不报错**的屏。
 *
 * 16 这个数怎么来的：真实运行时里最小的源是 Game Boy 的 160×144。
 * 比它再小一个数量级的只可能是「播放器还没被布局出来」或者「画布已经废了」，
 * 没有中间地带 —— 所以这条线不会误伤任何一款真游戏。
 */
export const MIN_VIDEO_EDGE = 16

/**
 * 这个尺寸算不算「有画面」。
 *
 * ⚠️ 尺寸未知（0 / undefined）在这里算**不可用**。
 * 「还没有画面」和「画面是废的」对调用方是两件事，要分清的自己先判有没有值再问这里，
 * 别指望这个函数替你区分 —— 它只回答「这个尺寸能不能看」。
 */
export function usableVideoSize(width?: number, height?: number): boolean {
  const w = Number(width) || 0
  const h = Number(height) || 0
  return w >= MIN_VIDEO_EDGE && h >= MIN_VIDEO_EDGE
}

/** 码率系数：每像素每帧多少 bit */
const BITS_PER_PIXEL_FRAME = 0.25

/** 码率下限。再小的画面也给这么多，像素画的硬边缘吃码率 */
const MIN_BITRATE = 1_000_000
/** 码率上限。家宽上行还要乘以观众数，不能再高了 */
const MAX_BITRATE = 6_000_000

export type DegradationPreference = 'maintain-framerate' | 'maintain-resolution' | 'balanced'

export interface VideoTuning {
  maxBitrate: number
  maxFramerate: number
  degradationPreference: DegradationPreference
  contentHint: 'detail' | 'motion'
  /** true = 走的像素画那一档。调试和文案用 */
  retro: boolean
}

export interface TuningInput {
  width?: number
  height?: number
  fps: number
  /** 调用方自己定死的码率（分享标签页那条路会传）。传了就不按分辨率算 */
  maxBitrate?: number
  /** 码率下限覆盖。联机对响应要求更高，给得比直播宽一点 */
  minBitrate?: number
}

/**
 * 算出这条视频轨该用什么编码参数。
 *
 * ⚠️ 拿不到宽高时（轨道刚建、getSettings 还没填）一律按**大源**处理：
 * 猜错的代价不对称 —— 把大源当小源，等于让 640×480 保着分辨率掉到个位数帧率，
 * 那是没法玩的；反过来只是像素画糊一点。
 */
export function tuningFor({ width, height, fps, maxBitrate, minBitrate = MIN_BITRATE }: TuningInput): VideoTuning {
  const w = Number(width) || 0
  const h = Number(height) || 0
  const pixels = w * h
  const retro = pixels > 0 && pixels <= RETRO_MAX_PIXELS

  const computed = pixels > 0
    ? Math.round(Math.max(minBitrate, Math.min(MAX_BITRATE, pixels * fps * BITS_PER_PIXEL_FRAME)))
    : minBitrate
  return {
    maxBitrate: maxBitrate ?? computed,
    maxFramerate: fps,
    // 小源：分辨率一格都不能少，宁可掉帧；大源：保流畅，缩一点没人在意
    degradationPreference: retro ? 'maintain-resolution' : 'maintain-framerate',
    contentHint: retro ? 'detail' : 'motion',
    retro,
  }
}

/** 从一条视频轨上读出宽高。拿不到就返回空对象，交给 tuningFor 按大源兜底 */
export function sizeOfTrack(track: MediaStreamTrack | null | undefined): { width?: number; height?: number } {
  try {
    const { width, height } = track?.getSettings?.() ?? {}
    return { width, height }
  } catch {
    return {}
  }
}

/**
 * 把参数写到发送端上。
 *
 * ⚠️ `contentHint` 设在**轨**上而不是 sender 上，而且要在协商前就设 ——
 * 它影响的是编码器怎么建，设晚了这一路已经按默认建好了。
 * `setParameters` 则相反，要等 sender 协商完才生效（见调用方那里的 setTimeout）。
 */
export function applyTuning(sender: RTCRtpSender, tuning: VideoTuning): void {
  try {
    if (sender.track && sender.track.kind === 'video') {
      ;(sender.track as MediaStreamTrack & { contentHint: string }).contentHint = tuning.contentHint
    }
  } catch {
    /* 老浏览器没有 contentHint */
  }
  try {
    const params = sender.getParameters()
    if (!params.encodings?.length) params.encodings = [{}]
    for (const e of params.encodings) {
      e.maxBitrate = tuning.maxBitrate
      e.maxFramerate = tuning.maxFramerate
    }
    ;(params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference =
      tuning.degradationPreference
    void sender.setParameters(params)
  } catch {
    /* 浏览器不支持就按默认来，只是少一层优化 */
  }
}

/* ---------------- 观众数 → 帧率 ---------------- */

/**
 * 观众多了主动降帧。
 *
 * 为什么不能只靠 getStats 自适应：那是**事后**的 —— 等采样发现 CPU 被限住时，
 * 主播自己的游戏已经卡了好几秒。而「编码路数 × 帧率」是这台机器的负担，
 * 观众数一变就能算出来，没有理由等。
 *
 * ⚠️ 每个观众一条 PeerConnection = 一路**独立编码**，浏览器不会替我们复用。
 * 所以这里降的是所有路的帧率，N 路 × 30 帧降成 N 路 × 20 帧，省下的是三分之一。
 * 这只是止损，根治要上 SFU（主播推一路给服务器、观众从服务器拉）。
 *
 * 档位有意给得粗（30 / 24 / 20），细分只会让画面在观众进出时频繁变速。
 */
export function fpsForViewers(viewers: number, baseFps: number): number {
  if (viewers <= 3) return baseFps
  if (viewers <= 6) return Math.min(baseFps, 24)
  return Math.min(baseFps, 20)
}
