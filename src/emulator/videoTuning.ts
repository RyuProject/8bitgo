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
 * ⚠️ **双屏机型要按单块屏算**，见 TuningInput.dualScreen。NDS 的画布是两块
 * 256×192 拼出来的（上下叠 256×384、并排 512×192），总像素 98304 一脚踩过
 * 320×240 那条线 —— 于是这个站上**单块屏最小**的机型（每屏 49152，比 Game Boy
 * 之外的任何一台都小）一直被当成大源，带宽一紧就把两块屏各缩成 128×96。
 * 这正是上面那段话要避免的事，只是判据取错了粒度。
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

/**
 * 「像素画」那一档的**每屏**像素上限。
 *
 * ⚠️ 这条线量的是**游戏的原生尺寸**（tuningFor 的 native），不是采集到的画布、
 * 也不是编码尺寸。三者不是一回事：
 *   画布 = 主播把播放器拉多宽（2079×1098）—— 跟内容毫无关系
 *   编码 = 画布缩回原生之后（424×224）—— 含两侧黑边，黑边多少取决于播放器的比例
 *   原生 = 核心真正在画的分辨率（384×224）—— 只有这个是游戏的属性
 * 所以判档只能用原生。拿编码尺寸判的话，同一款街机游戏在 16:9 的播放器上是
 * 424×224、在 4:3 的播放器上是 384×288，两次判出来可以不一样 —— 那显然是错的。
 *
 * 384×224 怎么来的：原来写的是 320×240（76800），而 CPS1/CPS2 街机板是 384×224
 * （86016）—— 一脚踩过线，于是这个站上**整个街机分类**一直被当成大源，
 * 拿到的是 maintain-framerate + contentHint:'motion'，也就是「糊了没关系，保帧率」。
 * 抬到 86016 之后线两边分别是：
 *   线内  GB 160×144 / GBA 240×160 / NES 256×240 / MD·NeoGeo 320×224 /
 *         PS1 320×240 / NDS 单屏 256×192 / 街机 384×224
 *   线外  NDS 双屏拼出来的 256×384（98304，所以 dualScreen 那一位仍然是必需的，
 *         见下面 TuningInput.dualScreen）、DOS·PS1 高分辨率 640×480、分享标签页的 720p/1080p
 *
 * ⚠️ 别再往上抬：98304（NDS 两块屏）是硬顶。越过它，dualScreen 那一位就变成死代码 ——
 * 不带这一位也会被判成像素画，于是「按单块屏算」这条逻辑再也不会被测到，
 * 而它正是 2026-09 修过的一个真 bug。
 */
export const RETRO_MAX_PIXELS = 384 * 224

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

/**
 * 编码前最多把分辨率缩这么多倍。
 *
 * 只是个防呆上限：正常路径上倍数来自「画布 ÷ 原生」，最大的实测值也就 5 倍出头。
 * 真出现离谱的倍数（画布被某个布局 bug 拉到 8K）时，与其信它，不如夹住 ——
 * 缩过头的代价是观众看一块马赛克，比多编几个像素严重。
 */
export const MAX_ENCODE_SCALE_DOWN = 16

/**
 * 这条源该在编码前缩几倍（WebRTC 的 `scaleResolutionDownBy`）。1 = 不缩。
 *
 * ── 为什么需要它 ──────────────────────────────────────────
 * 采集到的画布**不是游戏的原生分辨率**：EmulatorJS 的 <canvas> 是按屏幕上容器的
 * 大小 × dpr 建的，所以**主播把播放器拉多大，推出去的画面就有多大**。
 * 2026-09-11 线上实测（恐龙快打，CPS1 384×224）：推的是 **2079×1098**，
 * 像素数是原生的 26 倍，而多出来的 26 倍里**没有一点新信息** ——
 * 它就是 384×224 被双线性拉上去的结果。
 *
 * 代价全落在主播身上，而且是双份：
 *   · CPU —— 每个观众一条 PeerConnection = 一路独立编码，和游戏主循环抢同一颗核。
 *     实测推流时编码帧率掉到 4~17fps（见 broadcast.ts 的 onQuality）。
 *   · 上行 —— 码率按像素数算，2.28Mpx 直接把 MAX_BITRATE 顶满 6Mbps，
 *     ×12 个观众 = 72Mbps，家宽上行根本给不出。
 *
 * ── 为什么取两个比值里**小**的那个 ─────────────────────────
 * 画布通常比游戏**宽**（引擎把画面居中、两侧留黑边）：2079/1098 是 1.89，
 * 而 384/224 是 1.71。按宽算是 5.41 倍，缩完高度只剩 203 —— **低于原生**，
 * 那就真的在丢信息了。取 min（这里是 1098/224 = 4.90）保证两个方向都不低于原生，
 * 缩完是 424×224：游戏内容正好落在 384×224，多出来的 40 是那两条黑边。
 *
 * ⚠️ 拿不到原生尺寸就返回 1（照旧不缩）。猜错的代价不对称：不缩只是浪费带宽，
 * 而按错的原生去缩是把画面缩成马赛克，且主播无从发现。
 */
export function encodeScaleFor(
  width?: number,
  height?: number,
  native?: { width?: number; height?: number } | null,
): number {
  const w = Number(width) || 0
  const h = Number(height) || 0
  const nw = Number(native?.width) || 0
  const nh = Number(native?.height) || 0
  if (w <= 0 || h <= 0 || nw <= 0 || nh <= 0) return 1
  const scale = Math.min(w / nw, h / nh)
  if (!Number.isFinite(scale) || scale <= 1) return 1
  return Math.min(scale, MAX_ENCODE_SCALE_DOWN)
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
  /**
   * 编码前把分辨率缩几倍（见 encodeScaleFor）。1 = 原样编码。
   * ⚠️ 上面的 maxBitrate / retro / degradationPreference 已经是按**缩完之后**的尺寸算的，
   * 调用方不要再拿源尺寸去二次判断。
   */
  scaleResolutionDownBy: number
}

export interface TuningInput {
  width?: number
  height?: number
  fps: number
  /** 调用方自己定死的码率（分享标签页那条路会传）。传了就不按分辨率算 */
  maxBitrate?: number
  /** 码率下限覆盖。联机对响应要求更高，给得比直播宽一点 */
  minBitrate?: number
  /**
   * 这条源是**两块屏拼出来的**（双屏机型，见 dualScreen.ts 的 DUAL_SCREEN_PLATFORMS）。
   *
   * 只影响「是不是像素画」这一档的判定，**不影响码率** —— 码率按真实要编的像素数算，
   * 两块屏就是两块屏的量，那部分没有折扣。
   *
   * 为什么要调用方传而不是在这里从宽高猜：256×384 和 512×192 都是 NDS，
   * 而 512×192 也可能是别的什么源；猜错的两个方向代价都不小，
   * 而调用方手里本来就有平台 id，没有理由让这里去赌。
   */
  dualScreen?: boolean
  /**
   * 这款游戏的**原生**画面尺寸（模拟器核心的 av_info 几何，见 adapters/emulatorjs.ts
   * 的 reportGeometry）—— 不是画布尺寸，两者差多少取决于主播把播放器拉多宽。
   *
   * 传了就按它把编码分辨率缩回原生（见 encodeScaleFor）；不传 = 照旧原样编码。
   * 分享标签页那条路推的是整个标签页，没有「原生尺寸」可言，不传。
   */
  native?: { width?: number; height?: number } | null
}

/**
 * 算出这条视频轨该用什么编码参数。
 *
 * ⚠️ 拿不到宽高时（轨道刚建、getSettings 还没填）一律按**大源**处理：
 * 猜错的代价不对称 —— 把大源当小源，等于让 640×480 保着分辨率掉到个位数帧率，
 * 那是没法玩的；反过来只是像素画糊一点。
 */
export function tuningFor({ width, height, fps, maxBitrate, minBitrate = MIN_BITRATE, dualScreen, native }: TuningInput): VideoTuning {
  const w = Number(width) || 0
  const h = Number(height) || 0
  /*
    ⚠️ 下面**所有**判断都用缩完之后的尺寸，不用源尺寸。
    源尺寸是「主播的播放器有多宽」，跟内容无关（见 encodeScaleFor 文件内那段）：
    拿它去判像素画，384×224 的街机会因为画布是 2079×1098 而被当成大源；
    拿它去算码率，会为一堆插值出来的像素买单。
  */
  const scaleResolutionDownBy = encodeScaleFor(w, h, native)
  /** 真正要编码的像素数（缩完之后）。码率按它算 —— 那才是实打实要花的带宽 */
  const encoded = (w * h) / (scaleResolutionDownBy * scaleResolutionDownBy)
  /*
    判「是不是像素画」用**原生**尺寸，不用 encoded：encoded 里含黑边，
    含多少取决于主播播放器的比例（16:9 的播放器上 384×224 会编成 424×224）——
    那不是游戏的属性，拿它判档会让同一款游戏在不同主播那里落到不同档。
    拿不到原生就退回 encoded：没得选，而且那时 scale 也是 1，encoded 就是画布本身。
  */
  const nw = Number(native?.width) || 0
  const nh = Number(native?.height) || 0
  const judged = nw > 0 && nh > 0 ? nw * nh : encoded
  // 判「是不是像素画」看**单块屏**：双屏机型的画布是两块屏拼的，见文件头那段
  const perScreen = dualScreen ? judged / 2 : judged
  const retro = perScreen > 0 && perScreen <= RETRO_MAX_PIXELS

  const computed = encoded > 0
    ? Math.round(Math.max(minBitrate, Math.min(MAX_BITRATE, encoded * fps * BITS_PER_PIXEL_FRAME)))
    : minBitrate
  return {
    maxBitrate: maxBitrate ?? computed,
    maxFramerate: fps,
    // 小源：分辨率一格都不能少，宁可掉帧；大源：保流畅，缩一点没人在意
    degradationPreference: retro ? 'maintain-resolution' : 'maintain-framerate',
    contentHint: retro ? 'detail' : 'motion',
    retro,
    scaleResolutionDownBy,
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
      /*
        编码前先缩回原生（见 encodeScaleFor）。这一条是**主播端性能和上行流量**的大头：
        恐龙快打实测 2079×1098 → 424×224，像素数降 26 倍，码率从顶满的 6Mbps 降到 1Mbps。
        观众看到的清晰度不降反升 —— 缩掉的那些像素本来就是插值出来的。
      */
      e.scaleResolutionDownBy = tuning.scaleResolutionDownBy
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
