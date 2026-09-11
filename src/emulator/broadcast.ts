/**
 * 主播侧：把当前运行时的画面和声音推给 N 个观众。
 *
 * 输入就是 Runtime 句柄给出的 CaptureSources —— 也就是录像用的同一份东西。
 * 所以任何能录像的引擎都能开播，不需要引擎本身支持联机：
 * GBA（EmulatorJS）、DOS（js-dos）、Flash（Ruffle）、Java（FreeJ2ME）都一样。
 *
 * 没有 SFU，是「主播直连每个观众」的星型结构：
 *   上行 = 单路码率 × 观众数。家宽大概到十来路就满了，服务端也按这个数封顶。
 *   真要做大场子，得在中间加一层转发（主播只推一路，服务器扇出）。
 *
 * ── 断线 ──────────────────────────────────────────────────
 * 信令 socket 断了不等于直播断了：画面走的是点对点的 WebRTC，服务器只管握手。
 * 所以这里的原则是**能接回去就接回去，接不回去就重开，绝不因为信令抖一下就散场**：
 *
 *   socket 重连成功 → resume-live（凭开播时发的 token）
 *     ├─ 成功：房间号不变，观众不用换链接。服务器给回当前观众名单，
 *     │        哪条 PeerConnection 还活着自己看，死了的重新 offer
 *     └─ not found（服务器重启、宽限期过了）：go-live 重开一个新房间，
 *              还连着的观众画面照样在流，只是大厅里换了个房间号
 *
 * 以前是 socket 一断就报 ended，然后什么都不做 —— 抓屏的轨、音频节点、每条 PeerConnection
 * 全部泄漏，而且这一局再也不会开播。
 *
 * 观众那边的信令断了同理：它重连后 socket.id 会换，服务端凭它自带的 key 认出是同一个人，
 * 发 viewer-rebound 过来 —— 我们只把那条连接换个名字，画面一帧不掉、编码器一路不多
 * （见 peers 的注释）。
 */
import type { CaptureSources, PadButton } from './types'
import { type LiveChatMessage, connectLive, liveIceServers, type LiveSocket } from '@/services/live'
// 弹幕的清洗 / 限流 / ack 都在 chatSend.ts 里（两条发送路径共用一份，见那边的文件头）
import { sendChatWithAck, type ChatSendResult } from './chatSend'
import { applyTuning, fpsForViewers, sizeOfTrack, tuningFor, usableVideoSize } from './videoTuning'
import { COOP_CHANNEL, createSeatGate, encode as encodeCoop, type CoopMsg } from './coopSeat'
import { isDualScreen } from './dualScreen'
import { createCaptureFeed, probeCapture, type CaptureFeed, type SourceResolver } from './captureFeed'

/**
 * 码率上限的**手动覆盖**。设了就一律用它，不再按分辨率算。
 *
 * ⚠️ 默认是空的 —— 现在码率由 videoTuning.tuningFor 按源画面大小算（w×h×fps×系数），
 * 因为原来那个「全平台一个 1.5Mbps」对 160×144 的 Game Boy 是浪费上行
 * （直播是 N 个观众 N 路，省下来很实在），对 640×480 的 DOS 又不够用。
 * 只有在自动值明显不合适时才设这个环境变量把它压住。
 */
const MAX_BITRATE_OVERRIDE = Number(import.meta.env.VITE_LIVE_MAX_BITRATE) || undefined
/**
 * 采集帧率的默认值（options.fps 不传时用它）。
 *
 * ⚠️ 以前这里叫 MAX_FPS = 60，被 tuneSender 当成 maxFramerate 写进编码参数 ——
 * 而画面是 `captureStream(30)` 采的，源头就只有 30 帧。写 60 不会让画面更流畅，
 * 只会让读代码的人以为在推 60 帧。现在两处统一用同一个数。
 */
const DEFAULT_FPS = 30
/** 多久读一次 WebRTC 统计。太密没意义（编码器自己的自适应也是秒级的） */
const STATS_INTERVAL_MS = 5_000
/**
 * 多久查一次采集源还在不在（画布是否脱离文档 / 塌成废尺寸）。
 * Ruffle 读档 reload() 换画布前后大约 700ms，2 秒一查观众最多冻两秒多；再密也没意义。
 */
const SOURCE_CHECK_MS = 2_000
/**
 * 连续几次采样都被判定为受限，才真的降一档；连续几次干净才升回去。
 * 不设迟滞的话画质会在两档之间来回跳，比一直糊更难受。
 */
const DEGRADE_AFTER = 2
const RECOVER_AFTER = 4

export type BroadcastState = 'connecting' | 'live' | 'reconnecting' | 'ended' | 'error'

export interface BroadcastMeta {
  gameSlug?: string
  gameName: string
  platform: string
  title?: string
  hostName?: string
}

export interface BroadcastOptions {
  /**
   * 采集源。**推荐传函数**：源会被反复重新解析 —— 开播时一次、每次发现画布废了/换了再一次
   * （见 captureFeed.ts）。传死对象的话画布一换（Ruffle 读档）直播就冻住，没人能救。
   */
  sources: CaptureSources | SourceResolver
  meta: BroadcastMeta
  fps?: number
  /**
   * 视频码率上限（bps）。不传用 MAX_BITRATE —— 那是按 240×160 的 GBA 画布给的；
   * 分享整个标签页那种 720p / 1080p 的画面要给多几倍，否则一动就糊成马赛克。
   */
  maxBitrate?: number
  onState?: (state: BroadcastState) => void
  onViewers?: (count: number) => void
  /**
   * 推流质量。以前这条链路上**一个 getStats 都没有** —— 推出去之后画质好不好、
   * 是被 CPU 还是被带宽限住了，主播和我们都一无所知，只能等观众来报「好卡」。
   *
   * reason 直接来自 WebRTC 的 qualityLimitationReason：
   *   cpu       编码跟不上。**每个观众一条 PeerConnection = 一路独立编码**，
   *             而游戏主循环在同一个进程里 —— 观众一多，先卡的是主播自己的游戏。
   *   bandwidth 上行不够，编码器已经自己在降码率了
   *   none      一切正常
   */
  onQuality?: (info: QualityInfo) => void
  /** 收到一条弹幕（房主自己发的那条也会回来 —— 顺序由服务端定，本地不做乐观回显） */
  onChat?: (msg: LiveChatMessage) => void
  /** 房间号变了（重连后接不回原房间、只能重开时）。开播那一次也会调 */
  onRoom?: (roomId: string) => void
  onError?: (message: string) => void
  /* ---------------- 「上场当 2P」（见 coopSeat.ts） ---------------- */
  /**
   * 这一局 2P 真的读哪几颗键（Ruffle 的 `keys.p2`）。**传函数**：句柄可能比开播晚到，
   * 而且换游戏时会变。返回空数组 = 这一局没有 2P 位，那就一个按键都不放行。
   */
  coopButtons?: () => readonly PadButton[]
  /**
   * 有观众请求上场。UI 拿这个弹「让 TA 上场」；同意就调 Broadcast.grantSeat(viewerId)。
   * `name` 是服务端派生的显示名（拿不到就是 undefined，UI 退回「有人想上场」）——
   * **只用来显示**，身份判据永远是「消息从哪条通道来的」（见 coopSeat.ts）。
   */
  onSeatRequest?: (viewerId: string, name?: string) => void
  /**
   * 持座那位按了一颗键。接到运行时去：`handle.sendButton(button, down, 1)`。
   *
   * ⚠️ 松开的那一条同样会来 —— 而且**收座 / 断线 / 停播时我们会替他补发一轮松开**
   * （见 coopSeat.ts 文件头）。别在这里过滤 down === false。
   */
  onGuestInput?: (button: PadButton, down: boolean) => void
  /** 座位换人了（null = 空着）。UI 靠它显示「2P：某某」 */
  onSeatChange?: (viewerId: string | null) => void
}

export interface Broadcast {
  /** 当前房间号。重连后可能换（见文件头「断线」一节），UI 别缓存它，用 onRoom */
  readonly roomId: string
  viewers: () => number
  /**
   * 告诉服务器「这个直播间同时也是那个联机房」（传 null 解绑）。
   *
   * 主播点「联机」之后直播**不停**：观众正看着的那一路画面一帧都不该掉。
   * 报上去只是为了让**别人的大厅**知道这两个房间是一回事，好把两张卡合成一张、
   * 手柄位还空着就挂个 👋（见 services/allRooms.ts）。
   */
  linkNetplay: (roomId: string | null) => void
  /**
   * 发一条弹幕。服务端会广播给房间里所有人（包括房主自己）——
   * 所以这里**不**做本地回显：每个人看到的顺序都是服务端定的那一个，
   * 房主也不例外，不然自己那条会比别人早出现，看起来像两套时间线。
   */
  /** 发一条弹幕。兑现值 = 服务端的答复（null 表示发出去了），见 chatSend.ts */
  sendChat: (text: string) => Promise<ChatSendResult>
  /**
   * 把 2P 位给某个观众（传的是 onSeatRequest 给的那个 viewerId）。
   * 换人时上一位还按着的键会自动补一轮松开。
   */
  grantSeat: (viewerId: string) => void
  /** 收回 2P 位。按着的键一律松开 */
  revokeSeat: () => void
  /** 当前持座的观众 id */
  seated: () => string | null
  stop: () => void
}

export interface QualityInfo {
  /** 最需要关注的那个限制原因（有观众被 CPU 限住就报 cpu，它比带宽更难自愈） */
  reason: 'none' | 'cpu' | 'bandwidth' | 'other'
  /** 当前实际发送的帧率（所有观众里的最低值） */
  fps: number
  /** 当前实际发送的码率，kbps（所有观众合计） */
  kbps: number
  /** 我们主动把帧率压到了多少；等于采集帧率就是没压 */
  cappedFps: number
  viewers: number
}

/**
 * 主播 ↔ 观众之间经服务器转发的信令包。服务器不看内容原样转（见 live.js 的 signal）。
 * `error: 'no-source'`：主播这一刻抓不到画面（画布没了 / 废了），观众别干等 offer ——
 * 以前这种情况是悄悄 dropPeer，观众要等满 75 秒才拿到一句甩锅给网络的超时。
 */
type SignalData = { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit; gen?: number; error?: 'no-source' }

/**
 * 能不能开播：有画面就行（声音可选）。
 *
 * ⚠️ 「有画面」还包含**画面不能是废的**。画布小到 2×2 时 `captureStream` 一样给得出一条轨，
 * 推出去就是一块观众永远看不出所以然的黑屏（见 videoTuning 的 `MIN_VIDEO_EDGE`）。
 *
 * 这里返回 false **不等于放弃**：LiveControls 收到 false 会按 `RETRY_MS` 重试，
 * 播放器布局到位、画布长回正常尺寸就自然开播了（Ruffle 那边元素一变大就会重建画布）。
 * 一直好不了才落到「手动分享标签页」那条路 —— 那也比推一块黑屏出去强。
 */
export function canBroadcast(sources: CaptureSources | null | undefined): boolean {
  if (!sources) return false
  if (sources.stream) {
    if (!sources.stream.getTracks().length) return false
    const { width, height } = sizeOfTrack(sources.stream.getVideoTracks()[0])
    // 尺寸读不出来时不拦：分享标签页那条流的源是屏幕，不可能是 2×2
    return !width || !height || usableVideoSize(width, height)
  }
  if (!sources.canvas || typeof sources.canvas.captureStream !== 'function') return false
  return usableVideoSize(sources.canvas.width, sources.canvas.height)
}

/**
 * 按这条轨的**实际画面大小**定编码参数（见 videoTuning.ts）。
 *
 * ⚠️ 原来这里写死 `maintain-framerate` + 固定 1.5Mbps。对 640×480 的 DOS 是对的，
 * 对 240×160 的 GBA 是反的 —— 那个源本来就没有分辨率可降，缩一次就是马赛克。
 * 现在两件事都交给 tuningFor 按源大小决定，直播和联机共用同一份判断。
 *
 * `options.maxBitrate` 仍然优先（分享标签页那条路自己按屏幕分辨率算过）。
 */
function tuneSender(
  sender: RTCRtpSender,
  maxBitrate: number | undefined,
  maxFramerate: number,
  size: { width?: number; height?: number } = sizeOfTrack(sender.track),
  /** 双屏机型（NDS）：像素画那一档要按单块屏判，见 videoTuning 的 dualScreen */
  dualScreen = false,
) {
  // ⚠️ 尺寸要调用方从采集源上拿（feed.videoSize()）。走 Insertable Streams 时 sender.track 是
  // generator 轨，getSettings() 多半是空的 —— 空就会被当成大源去缩分辨率，Game Boy 直接成马赛克
  applyTuning(sender, tuningFor({ width: size.width, height: size.height, fps: maxFramerate, maxBitrate, dualScreen }))
}

/** 这条连接还值得留着吗（还在握手、或者已经通了） */
function alive(pc: RTCPeerConnection): boolean {
  const s = pc.connectionState
  return s === 'new' || s === 'connecting' || s === 'connected'
}

/** 带超时的 ack 调用；socket 没连上时 emit 会被 socket.io 缓存到重连，这里不等它 */
function call<T>(socket: LiveSocket, event: string, payload: unknown, ms = 10_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!socket.connected) return reject(new Error('disconnected'))
    const timer = window.setTimeout(() => reject(new Error(`${event} timeout`)), ms)
    socket.emit(event, payload, (err: string | null, data: T) => {
      window.clearTimeout(timer)
      if (err) reject(new Error(err))
      else resolve(data)
    })
  })
}

export async function startBroadcast(options: BroadcastOptions): Promise<Broadcast> {
  const captureFps = options.fps ?? DEFAULT_FPS
  /** 每次都重新向运行时要源（见 BroadcastOptions.sources 的注释） */
  const resolveSources: SourceResolver = typeof options.sources === 'function' ? options.sources : () => options.sources as CaptureSources

  /**
   * 抓屏是**按需**建的：没有观众时一帧都不抓。
   *
   * ⚠️ 这条很重要，因为这个站是「玩就是播」——**每一个玩家都在开播**。
   * 以前 buildStream() 是在这里无条件调的，于是每一局单机游戏都在白付：
   *   · `canvas.captureStream(30)` 让浏览器每秒从游戏画布上复制 30 帧
   *     （EmulatorJS 的画布是 WebGL 的，这是一次 GPU 读回/纹理拷贝，
   *     街机核心本来就跑在 59.94Hz 上，中低端手机和集显笔记本上这笔开销是实打实的）
   *   · 再往音频图上挂一个 MediaStreamAudioDestinationNode
   * 而这些帧和这些采样**一个字节都没发出去** —— 没有观众就没有 RTCRtpSender，
   * 编码器根本没启动。等于纯浪费。
   *
   * 现在改成：信令照连、房间照注册（大厅里照样看得到这一局），
   * 但真正的抓屏推迟到**第一个观众进来**，最后一个观众走了再放掉。
   */
  let built: CaptureFeed | null = null
  /**
   * 上一轮抓屏放掉时留下的最后一帧，喂给下一轮当种子（见 captureFeed.ts 的 release 注释）：
   * 游戏暂停着、观众走光又来人，没有它新观众一帧都拿不到。
   */
  let seedFrame: VideoFrame | null = null
  /** 观众走光之后延迟放手，免得断线重连那几秒里反复停/建抓屏 */
  let idleTimer = 0

  /*
    开播前先探一次「这个源到底抓不抓得出画面」。
    不探的话，抓不出来这件事要等到第一个观众进来才发现，而调用方
    （LiveControls）正是靠这个异常去切「手动分享标签页」那条路的。
    探完立刻放掉：建一条 track 再停掉是瞬时操作，不留任何持续开销。
  */
  if (!probeCapture(resolveSources(), captureFps)) throw new Error('no capture source')

  /** 真要推流了才开始抓。抓不出来（画布已经没了）返回 null，调用方跳过这条连接 */
  const ensureStream = () => {
    window.clearTimeout(idleTimer)
    idleTimer = 0
    if (!built) {
      // 种子帧的所有权交给新 feed（拿不到源时它自己会 close）
      const seed = seedFrame
      seedFrame = null
      built = createCaptureFeed(resolveSources, captureFps, seed)
      /**
       * ⚠️ 新建的 feed 一律按**基准**帧率开抓，得立刻把当前档位补给它。
       *
       * `cappedFps` 活整场，`built` 只活到观众走光 3 秒。而 `applyFpsCap` 有「值没变就早退」，
       * 于是这条路会悄悄回到 30 帧：
       *   CPU 吃紧 → statsCap 降到 15、cappedFps=15 → 观众走光（statsCap 故意不复位）→
       *   feed 销毁 → 新观众来 → createCaptureFeed 用基准 30 建流 → retuneFps 算出还是 15 →
       *   等于 cappedFps，早退 → setCaptureFps 一次都没调。
       * 结果：编码器封在 15，画布却回到 30 —— 「降档降了个寂寞」在已经证明扛不住的那台机器上原样复现。
       */
      built?.setCaptureFps(cappedFps)
      if (built && !built.keepAlive) {
        // 没有 Insertable Streams 的浏览器：换源换的是轨，得挨个 sender 换过去（不用重新协商）
        built.onVideoTrackReplaced = (track) => {
          for (const { pc } of peers.values()) {
            for (const sender of pc.getSenders()) {
              if (sender.track?.kind !== 'video') continue
              void sender.replaceTrack(track).then(() => tuneSender(sender, options.maxBitrate ?? MAX_BITRATE_OVERRIDE, cappedFps, built?.videoSize(), dualScreenSource))
            }
          }
        }
      }
    }
    return built
  }
  const releaseStream = () => {
    window.clearTimeout(idleTimer)
    idleTimer = 0
    const keep = built?.release() ?? null
    built = null
    // 只留最新的一帧
    if (keep) {
      seedFrame?.close()
      seedFrame = keep
    }
  }
  /** 没人看了：3 秒后放掉抓屏。给「观众只是抖了一下重连」留个窗口 */
  const releaseIfIdle = () => {
    if (built === null || idleTimer) return
    idleTimer = window.setTimeout(() => {
      idleTimer = 0
      if (!stopped && peers.size === 0) releaseStream()
    }, 3_000)
  }

  options.onState?.('connecting')

  let socket: LiveSocket
  try {
    socket = await connectLive()
  } catch (e) {
    releaseStream()
    throw e
  }

  /**
   * 每个观众一条连接。gen 是这条连接的代号，随 SDP / ICE 一起发，观众据此认出「新一轮」。
   *
   * `id` 是这条连接当前对应的观众 socket.id —— 会变：观众的信令重连后 socket.io 给它一个新 id，
   * 服务端凭观众自带的 key 认出还是同一个人，发 viewer-rebound 让我们把这条**还在流的**连接换个名字
   * （以前是当新观众重建整条 PeerConnection，观众画面黑一下、编码器多跑一路）。
   * 所以回调里一律用 `entry.id` 反查，别把创建时的 viewerId 闭包捕获死。
   *
   * `pending` / `remoteReady`：观众的 answer 和它的 ICE 候选是紧挨着发过来的，而 setRemoteDescription
   * 是异步的 —— 候选到的时候 remoteDescription 多半还是 null。以前这里直接把候选丢掉，注释说
   * 「对方会重发」：**WebRTC 不重发候选**，丢了就是丢了。host 类候选（局域网直连）几乎必丢，
   * 主播主线程忙（模拟器 + N 路编码）时 srflx 也会丢，剩下能配对的只有中继 —— 白走 TURN 流量，
   * 没配 TURN 的站点上则是同一路由器下的两个人都连不上。现在先攒着，远端描述落地后再一并加。
   */
  type Peer = { pc: RTCPeerConnection; gen: number; id: string; pending: RTCIceCandidateInit[]; remoteReady: boolean; dc?: RTCDataChannel }
  const peers = new Map<string, Peer>()
  let genCounter = 0
  let viewers = 0
  let stopped = false
  /**
   * 我们主动施加的帧率上限。两个来源取更小的那个：
   *   - `statsCap`：getStats 发现 CPU 被限住之后**事后**逐档降（见 statsTick）
   *   - `fpsForViewers(viewers)`：按观众数**前馈**降（见 videoTuning.ts）
   * 分开记是必要的：观众走光之后前馈那一档要自动松开，而 statsTick 那一档
   * 得靠连续几轮干净采样才升回去 —— 混在一个变量里，观众一走就会把 CPU 那档也一并松掉。
   */
  let statsCap = captureFps
  /*
    这一局的源是不是两块屏拼出来的（NDS）。像素画那一档要按**单块屏**判 ——
    NDS 的画布总像素（256×384 = 98304）一脚踩过 320×240 那条线，不带这一位的话
    这个站上单块屏最小的机型会被当成大源，带宽一紧就把两块屏各缩成 128×96。
    见 videoTuning.ts 的 dualScreen。房间快照里的 platform 就是个字符串，
    isDualScreen 收得下（见 dualScreen.ts 那条注释）。
  */
  const dualScreenSource = isDualScreen(options.meta.platform)
  let cappedFps = captureFps
  let degradeStreak = 0
  let recoverStreak = 0
  let statsTimer = 0
  let sourceTimer = 0
  let visibilityBound = false
  let roomId = ''
  let token = ''
  /**
   * 休眠：服务器把房收了（主播切后台太久、一个观众都没有 —— 见 live.js 的 host-idle），
   * 但主播这一局还在跑。不是错、也不用重连：人不在，房挂在大厅里只会骗人进来。
   * 信令留着、抓屏放掉；主播一回到前台就重新开一间（房间号换新的，走 onRoom）。
   */
  let dormant = false

  /**
   * 「上场当 2P」的闸。身份只认「消息从哪条通道来的」，规则和松键都在 coopSeat.ts 里，
   * 这里只负责接线：DataChannel ↔ 闸 ↔ options 的回调。
   */
  const gate = createSeatGate(options.coopButtons)

  /** 把闸交回来的「要松开的键」真的松掉。收座 / 断线 / 停播都靠这一句 */
  const release = (keys: PadButton[]) => {
    for (const b of keys) options.onGuestInput?.(b, false)
  }

  /** 告诉某个观众他现在有没有 2P 位。通道没开就算了 —— 他重连时会重新收到 hello */
  const tellSeat = (viewerId: string, on: boolean) => {
    const dc = peers.get(viewerId)?.dc
    if (!dc || dc.readyState !== 'open') return
    try {
      dc.send(encodeCoop({ t: 'seat', on, ...(on ? { buttons: [...(options.coopButtons?.() ?? [])] } : {}) }))
    } catch {
      /* 通道刚断，无所谓 —— 座位状态由房主这边说了算 */
    }
  }

  /**
   * 把「这一局有没有 2P 位、有没有人坐着」报给服务器，好让**别人的大厅**看得见
   * （见 live.js 的 publicRoom.coopOpen）。
   *
   * 服务器不参与授权 —— 座位给谁、按键放不放行全在这台机器上守（coopSeat.ts）。
   * 报上去纯粹是为了让这个功能被发现得到：不报的话，只有已经点开这个直播间的人
   * 才知道能上场，而没人会为了找一个 2P 位把每个直播间都点一遍。
   *
   * 只在**变化时**发。这函数会被 5 秒一轮的统计循环顺手调到（覆盖「句柄比开播晚到」
   * 和「中途换了游戏」两种情况），绝大多数轮次是没变化的。
   */
  /** viewerId → 显示名。只增不减也没关系，一场直播的观众数量级很小；dropPeer 时顺手删 */
  const viewerNames = new Map<string, string>()
  let coopReported = ''
  const reportCoop = () => {
    if (stopped || dormant) return
    const open = (options.coopButtons?.().length ?? 0) > 0
    const taken = gate.seated() !== null
    const key = `${open}/${taken}`
    if (key === coopReported) return
    coopReported = key
    try {
      if (socket.connected) socket.emit('coop-state', { open, taken })
    } catch {
      /* 信令断了就算了 —— 重连后这个函数还会被统计循环调到，那时再报 */
    }
  }

  /** 收回座位：松键、告诉那位、报给 UI。访客自己下场和房主收回走的是同一条 */
  const revokeInternal = () => {
    const who = gate.seated()
    release(gate.revoke())
    if (!who) return
    tellSeat(who, false)
    options.onSeatChange?.(null)
    reportCoop()
  }

  /**
   * 给一个观众建输入通道。**必须在 createOffer 之前调**：这样通道进得了 SDP，
   * 不需要再走一轮重新协商（观众那边只要 ondatachannel 接着）。
   *
   * 可靠 + 有序（默认值，不改）：按键消息极小极稀，而**丢一个 keyup 的代价是
   * 角色一直朝墙里跑**（见 coopSeat.ts 文件头）。这里不值得为几毫秒去换不可靠传输。
   */
  const openInput = (entry: Peer) => {
    let dc: RTCDataChannel
    try {
      dc = entry.pc.createDataChannel(COOP_CHANNEL)
    } catch {
      // 老浏览器 / 奇怪的实现：没有输入通道就只是不能上场，直播照旧
      return
    }
    entry.dc = dc
    dc.onopen = () => {
      // 能力发现：这一局有没有 2P 位，由房主说。老版本的观众收不到也无所谓（他不会有那个按钮）
      const buttons = [...(options.coopButtons?.() ?? [])]
      try {
        dc.send(encodeCoop({ t: 'hello', coop: buttons.length > 0, ...(buttons.length ? { buttons } : {}) }))
      } catch {
        /* ignore */
      }
      // 主播重连后观众可能还持着座（peers 换了但 gate 没换），补一句让他的界面对上
      if (gate.seated() === entry.id) tellSeat(entry.id, true)
    }
    dc.onmessage = (ev) => {
      // ⚠️ 身份用 entry.id 现取，不能闭包捕获创建时的 viewerId：观众信令重连后
      // 服务端发 viewer-rebound，这条**还在流的**连接会被改名（见 Peer 的注释）
      const msg: CoopMsg | null = gate.admit(entry.id, ev.data)
      if (!msg) return
      if (msg.t === 'want') options.onSeatRequest?.(entry.id, viewerNames.get(entry.id))
      else if (msg.t === 'leave') revokeInternal()
      else if (msg.t === 'k') options.onGuestInput?.(msg.b, msg.d)
    }
    dc.onclose = () => release(gate.forget(entry.id))
  }

  const dropPeer = (viewerId: string) => {
    const p = peers.get(viewerId)
    if (!p) return
    peers.delete(viewerId)
    /*
      ⚠️ 先松键再关连接。这个观众可能正持着 2P 位、手里按着方向键 ——
      不松的话游戏里那个角色会一直朝墙里跑，而且看起来像游戏卡住了，
      玩家不会想到是「刚才那个人断线了」。
    */
    const wasSeated = gate.seated() === viewerId
    viewerNames.delete(viewerId)
    release(gate.forget(viewerId))
    if (wasSeated) options.onSeatChange?.(null)
    try {
      p.pc.close()
    } catch {
      /* ignore */
    }
    // 最后一个观众走了 → 停掉抓屏（见 ensureStream 的注释）
    if (peers.size === 0) releaseIfIdle()
  }

  /**
   * 给一个观众建连接并发 offer。
   * force=false 时，已有的连接还活着就不动它（主播重连回来对照名单用）；
   * force=true 是观众明确要求重来（它重新 watch 了），旧连接不管死活都换掉。
   */
  const addViewer = async (viewerId: string, force: boolean) => {
    if (stopped) return
    const existing = peers.get(viewerId)
    if (existing) {
      if (!force && alive(existing.pc)) return
      dropPeer(viewerId)
    }
    /**
     * ICE 配置**每条连接现取一次**，不能拿开播那一刻的那份用一整场。
     *
     * TURN 是短期凭证（默认 1 小时过期）—— 以前这一份是在 startBroadcast 里取好、闭包捕获的，
     * 于是一场播过一小时之后，**新进来的观众全部连不上**，而老观众好好的（他们的连接早就建好了）。
     * 这种「播着播着新观众就进不来了」的 bug 上线后极难查。
     * fetchIceConfig 自带缓存（快过期才重新取），所以绝大多数调用只是读一下内存。
     */
    const iceServers = await liveIceServers()
    if (stopped) return
    // await 期间观众可能又重新 watch 了一轮：把那一条收掉，以这次为准（gen 更大，观众认新的）
    dropPeer(viewerId)
    const gen = ++genCounter
    const pc = new RTCPeerConnection({ iceServers })
    const entry: Peer = { pc, gen, id: viewerId, pending: [], remoteReady: false }
    peers.set(viewerId, entry)

    // 第一个观众进来才真的开始抓屏
    const media = ensureStream()
    if (!media) {
      // 画布已经没了 / 塌成废尺寸（换游戏、引擎拆了、播放器没布局好）：这条连接建不起来。
      // 告诉观众一声再收掉 —— 它会隔几秒再来要一次，画布回来了就接上；一直没有它才报错
      try {
        socket.emit('signal', { target: entry.id, data: { error: 'no-source', gen } satisfies SignalData })
      } catch {
        /* ignore */
      }
      dropPeer(entry.id)
      return
    }
    for (const track of media.stream.getTracks()) {
      const sender = pc.addTrack(track, media.stream)
      if (track.kind === 'video') tuneSender(sender, options.maxBitrate ?? MAX_BITRATE_OVERRIDE, cappedFps, media.videoSize(), dualScreenSource)
    }

    // ⚠️ 必须在 createOffer 之前：通道要进 SDP，否则得多走一轮重新协商
    openInput(entry)

    pc.onicecandidate = (ev) => {
      if (ev.candidate) socket.emit('signal', { target: entry.id, data: { candidate: ev.candidate.toJSON(), gen } satisfies SignalData })
    }
    pc.onconnectionstatechange = () => {
      // 观众那边断了就把连接收掉，别留着白占上行。它要是还在房间里，会自己重新 watch
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        if (peers.get(entry.id)?.pc === pc) dropPeer(entry.id)
      }
    }

    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      socket.emit('signal', { target: entry.id, data: { sdp: pc.localDescription ?? offer, gen } satisfies SignalData })
    } catch (e) {
      /**
       * ⚠️ 必须认身份，和 12 行上面的 onconnectionstatechange 一个道理。
       *
       * 同一个 viewerId 的两次 addViewer 会重叠（服务器重启后主播 resume 和观众重新 watch
       * 几乎同时发生）：后一次的 dropPeer 把前一次 close 掉，前一次的 createOffer 于是抛
       * InvalidStateError 进到这里 —— 不认身份的话，它删掉并 close 的是**刚建好的那条正确连接**。
       * 结果这个观众一条 offer 都收不到，pc 停在 new（永远不会变 failed），
       * 主播这边 peers 里也没有它了，只能等观众自己 20 秒后再要一轮。
       */
      if (peers.get(entry.id)?.pc !== pc) return
      dropPeer(entry.id)
      // 旧一轮被新一轮顶掉是正常现象，只有当前这条失败才值得往上报
      options.onError?.(e instanceof Error ? e.message : String(e))
    }
  }

  /** 把新的帧率上限应用到所有观众的视频发送端 */
  const applyFpsCap = (next: number) => {
    if (next === cappedFps) return
    cappedFps = next
    for (const { pc } of peers.values()) {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind === 'video') tuneSender(sender, options.maxBitrate ?? MAX_BITRATE_OVERRIDE, cappedFps, built?.videoSize(), dualScreenSource)
      }
    }
    /**
     * ⚠️ 抓屏帧率必须跟着一起降，不然这个降档等于白降。
     *
     * 上面那圈只改编码器的 maxFramerate。而画面是 `canvas.captureStream(fps)` 采的，
     * 采多少帧跟编码器编多少帧是**两件事** —— 7 个观众时编码降到 20 帧了，
     * 画布仍然每秒被拷 30 次。
     *
     * 而这两笔开销的性质完全不同：编码是 N 路（观众数越多越贵），抓屏只有一路，
     * 但**抓屏那一路是 GPU 读回，跟模拟器抢的是同一根线程** ——
     * 玩家感觉到的「一开播就卡」主要来自它，不是来自编码。少编几帧救不了它，
     * 少抓几帧才救得了。
     */
    built?.setCaptureFps(next)
  }

  /**
   * 重算该用多少帧：事后那档（statsCap）和前馈那档（按观众数）取更小的。
   *
   * 观众进出时都要调一次 —— 前馈那一档是**可逆**的：人走了就该自动放回去，
   * 不用等 getStats 攒够几轮干净采样。
   */
  const retuneFps = () => applyFpsCap(Math.min(statsCap, fpsForViewers(viewers, captureFps)))

  /**
   * 读一轮 WebRTC 统计，必要时降档。
   *
   * 只看 outbound-rtp 的视频条目：`qualityLimitationReason` 是浏览器自己的判断，
   * 比我们从帧率倒推可靠得多。取「最坏的那个观众」而不是平均 ——
   * 一个人卡不代表大家都卡，但 CPU 被限住是主播这台机器的问题，对谁都成立。
   *
   * 我们只动帧率，不动码率：码率浏览器自己就在按带宽估计调（BWE），
   * 再插一手只会互相打架。而**帧率是它不会替我们省的那一项** ——
   * 编码路数 × 帧率才是主播 CPU 的真实负担。
   */
  const statsTick = async () => {
    /*
      ⚠️ 顺手报一次 2P 位的状态，而且必须在下面那道早退**之前**：
      「一个观众都还没有」正是最需要让大厅显示 👋 的时候 —— 放到早退后面，
      房间永远不会被标成「还差一个人」，而那恰恰是这个功能被发现的唯一入口。
      这里也顺带覆盖「句柄比开播晚到」和「中途换了游戏」两种情况。
    */
    reportCoop()
    if (stopped || peers.size === 0) return
    /**
     * 收集每个观众上报的限制原因，循环结束后再取最坏的那个。
     * 不在回调里直接维护「当前最坏值」——TypeScript 的控制流分析不跟踪闭包里的赋值，
     * 循环后的比较会被判成恒假（TS2367）。分成收集 + 归约两步，类型和意图都更清楚。
     */
    const reasons: string[] = []
    let minFps = Number.POSITIVE_INFINITY
    let totalKbps = 0
    let sawVideo = false

    for (const { pc } of peers.values()) {
      let report: RTCStatsReport
      try {
        report = await pc.getStats()
      } catch {
        continue
      }
      report.forEach((stat) => {
        const s = stat as RTCStats & {
          kind?: string
          qualityLimitationReason?: string
          framesPerSecond?: number
          targetBitrate?: number
        }
        if (s.type !== 'outbound-rtp' || s.kind !== 'video') return
        sawVideo = true
        if (s.qualityLimitationReason) reasons.push(s.qualityLimitationReason)
        if (typeof s.framesPerSecond === 'number') minFps = Math.min(minFps, s.framesPerSecond)
        if (typeof s.targetBitrate === 'number') totalKbps += Math.round(s.targetBitrate / 1000)
      })
    }
    if (stopped || !sawVideo) return

    // 取最坏的那个观众，而不是平均：一个人卡不代表大家都卡，
    // 但 CPU 被限住是主播这台机器的问题，对谁都成立，所以它优先级最高（带宽会自愈，CPU 不会）
    const worst: QualityInfo['reason'] = reasons.includes('cpu')
      ? 'cpu'
      : reasons.includes('bandwidth')
        ? 'bandwidth'
        : reasons.some((r) => r !== 'none')
          ? 'other'
          : 'none'

    // 只有 CPU 受限才由我们出手降帧率；带宽受限交给浏览器自己调码率
    if (worst === 'cpu') {
      degradeStreak++
      recoverStreak = 0
      if (degradeStreak >= DEGRADE_AFTER) {
        degradeStreak = 0
        // 逐档减半，最低 10 帧 —— 再低就不像在动了，不如让人少几个观众
        const next = Math.max(10, Math.round(statsCap / 2))
        if (next < statsCap) {
          statsCap = next
          retuneFps()
        }
      }
    } else {
      degradeStreak = 0
      if (statsCap < captureFps) {
        recoverStreak++
        if (recoverStreak >= RECOVER_AFTER) {
          recoverStreak = 0
          statsCap = Math.min(captureFps, statsCap * 2)
          retuneFps()
        }
      }
    }

    options.onQuality?.({
      reason: worst,
      fps: Number.isFinite(minFps) ? Math.round(minFps) : 0,
      kbps: totalKbps,
      cappedFps,
      viewers,
    })
  }

  /**
   * 主播切到后台：浏览器不给后台标签页出帧，`captureStream` 直接停住，
   * 观众那边画面**冻结**。这是浏览器行为，改不了 —— 但可以告诉观众一声，
   * 否则他看到的是一张凝固的画面、没有任何解释，只会以为是自己网断了。
   */
  const onVisibility = () => {
    if (stopped) return
    if (document.visibilityState === 'visible' && dormant) {
      void wake()
      return
    }
    try {
      if (socket.connected && roomId) socket.emit('host-visibility', { hidden: document.visibilityState === 'hidden' })
    } catch {
      /* 信令断了就算了，回来 resume 时状态会重新对齐 */
    }
  }

  /** 从休眠里醒来：重新开一间。信令没连着就继续睡，connect 回来再醒 */
  const wake = async () => {
    if (stopped || !dormant || !socket.connected) return
    dormant = false
    try {
      await goLive()
      viewers = 0
      options.onViewers?.(0)
      options.onState?.('live')
    } catch (e) {
      if (stopped) return
      // 重开失败（服务器满了之类）：这一局就到这儿，别让 UI 挂着假标记
      stopped = true
      teardown()
      options.onError?.(e instanceof Error ? e.message : String(e))
      options.onState?.('ended')
    }
  }

  /**
   * 采集源还在不在。画布被运行时换掉（Ruffle 读档）或者塌成废尺寸时，
   * feed 自己去重新取源并接上 —— 有 Insertable Streams 的浏览器观众无感，没有的走 replaceTrack。
   * 只在有观众、真在抓屏的时候查：没人看时抓屏本来就是放掉的。
   */
  const sourceTick = () => {
    if (stopped || !built || peers.size === 0) return
    if (built.check()) console.info('[live] 采集源已更换（画布被重建或换掉），观众那头无缝接上')
  }

  const teardown = () => {
    if (statsTimer) {
      window.clearInterval(statsTimer)
      statsTimer = 0
    }
    if (sourceTimer) {
      window.clearInterval(sourceTimer)
      sourceTimer = 0
    }
    if (visibilityBound) {
      document.removeEventListener('visibilitychange', onVisibility)
      visibilityBound = false
    }
    for (const id of Array.from(peers.keys())) dropPeer(id)
    releaseStream()
    seedFrame?.close()
    seedFrame = null
    try {
      socket.close()
    } catch {
      /* ignore */
    }
  }

  /**
   * 已经报给服务器的联机房号。
   *
   * 要记着是因为**每次重开 / 续播都得再报一遍**：服务端在主播掉线时会把它清掉
   * （见 server/src/live.js 的 hostAway —— 那时候联机房要么散了要么在换房主，
   * 留着陈旧房号会让大厅挂一个点进去进不去的「联机中」），重开出来的新房间更是从零开始。
   */
  let linkedNetplayRoom: string | null = null

  /** 把配对房号补报给服务器。开房 / 续播成功之后各叫一次 */
  const relink = () => {
    if (!linkedNetplayRoom) return
    try {
      if (socket.connected) socket.emit('link-netplay', { roomId: linkedNetplayRoom })
    } catch {
      /* ignore */
    }
  }

  const goLive = async () => {
    const data = await call<{ roomId: string; token: string }>(socket, 'go-live', {
      title: options.meta.title,
      gameSlug: options.meta.gameSlug,
      gameName: options.meta.gameName,
      platform: options.meta.platform,
      hostName: options.meta.hostName,
    })
    roomId = data.roomId
    token = data.token
    options.onRoom?.(roomId)
    relink()
  }

  /** socket 重连上来之后：先试着接回原房间，接不回去就重开 */
  const resume = async () => {
    if (stopped) return
    try {
      const data = await call<{ roomId: string; viewers?: string[] }>(socket, 'resume-live', { roomId, token })
      const current = new Set(data.viewers ?? [])
      // 名单上没有的观众已经走了（宽限期里它们 disconnect 时主播不在，没收到 viewer-left）
      for (const id of Array.from(peers.keys())) if (!current.has(id)) dropPeer(id)
      // 名单上的：连接还活着的不动（信令断了画面没断），死了的重新 offer
      for (const id of current) void addViewer(id, false)
      viewers = current.size
      options.onViewers?.(viewers)
      retuneFps()
      options.onState?.('live')
      relink()
      // 服务端不记「切后台」这个状态跨断线：接回来要再报一次，否则主播明明在后台，
      // 中途进来的观众拿到的快照却是 hostFrozen=false，对着冻住的画面等 75 秒
      onVisibility()
      return
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (stopped) return
      // 房间已经没了（服务器重启 / 宽限期过了）：那就重开。老观众如果画面还连着，照样在看
      if (msg !== 'not found' && msg !== 'forbidden') {
        // 其它错误（超时、又断了）：等下一次 connect 再来，socket.io 会一直重试
        console.warn('[live] 续播失败，等下次重连', msg)
        return
      }
    }
    try {
      await goLive()
      viewers = 0
      options.onViewers?.(0)
      options.onState?.('live')
      onVisibility() // 新房间从零开始，同样要知道主播此刻在不在前台
    } catch (e) {
      // 重开也失败（比如服务器满了）：这一局就到这儿，把资源放掉，别让 UI 挂着假标记
      if (stopped) return
      stopped = true
      teardown()
      options.onError?.(e instanceof Error ? e.message : String(e))
      options.onState?.('ended')
    }
  }

  socket.on('viewer-joined', ((payload: { viewerId?: string; replaces?: string }) => {
    // 观众进来 / 观众重新 watch：都是「请给我一轮新的 offer」
    if (!payload?.viewerId) return
    // 它上一条连接用的是另一个 socket.id（信令重连过、画面也断了）：那条直接拆，不用等服务端的 viewer-left
    if (payload.replaces && payload.replaces !== payload.viewerId) dropPeer(payload.replaces)
    void addViewer(payload.viewerId, true)
  }) as (...args: never[]) => void)

  socket.on('viewer-rebound', ((payload: { from?: string; to?: string }) => {
    /**
     * 同一个观众换了 socket.id，画面没断（见 peers 的注释）：把连接换个名字，一帧都不重编。
     * 那条连接要是已经死了 / 我们这边压根没有，就按新观众处理，给它一轮 offer。
     */
    if (!payload?.from || !payload.to || payload.from === payload.to) return
    const p = peers.get(payload.from)
    if (p && alive(p.pc)) {
      peers.delete(payload.from)
      dropPeer(payload.to) // 新 id 下万一挂着别的连接（不该有），先收掉
      p.id = payload.to
      peers.set(payload.to, p)
      /*
        ⚠️ 座位也要跟着改名。不改的话：连接还在、画面一帧不掉，但闸里记着旧 id，
        持座那位从此一个键都送不进来，而两边界面都显示他还是 2P（见 coopSeat 的 rename）。
      */
      gate.rename(payload.from, payload.to)
      return
    }
    dropPeer(payload.from)
    void addViewer(payload.to, true)
  }) as (...args: never[]) => void)

  socket.on('viewer-left', ((payload: { viewerId?: string }) => {
    if (payload?.viewerId) dropPeer(payload.viewerId)
  }) as (...args: never[]) => void)

  socket.on('live-ended', ((payload: { roomId?: string; reason?: string }) => {
    // 只认自己这一间；stop() 自己发的 stop-live 回来的那条已经被 stopped 挡掉
    if (stopped || !roomId || payload?.roomId !== roomId) return
    for (const id of Array.from(peers.keys())) dropPeer(id)
    releaseStream()
    roomId = ''
    token = ''
    viewers = 0
    options.onViewers?.(0)
    dormant = true
    console.info(`[live] 服务器收了房间（${payload?.reason ?? '?'}），进入休眠，回到前台再重开`)
    // UI 上先按「重连中」显示：主播人不在看不到，回来那一刻 wake() 立刻换成 live
    options.onState?.('reconnecting')
    if (document.visibilityState === 'visible') void wake()
  }) as (...args: never[]) => void)

  socket.on('chat', ((msg: LiveChatMessage) => {
    if (msg?.text) options.onChat?.(msg)
  }) as (...args: never[]) => void)

  /**
   * 观众叫什么（服务端派生，见 live.js 的 viewer-name）。只用来在
   * 「XX 想上场当 2P」那句话里显示，别拿它当身份判据 —— 身份只认通道（coopSeat.ts）。
   */
  socket.on('viewer-name', ((payload: { viewerId?: string; name?: string; guest?: string }) => {
    const id = payload?.viewerId
    if (!id) return
    const label = payload.name || (payload.guest ? `#${payload.guest}` : '')
    if (label) viewerNames.set(id, label)
  }) as (...args: never[]) => void)

  socket.on('viewers', ((payload: { count?: number }) => {
    viewers = payload?.count ?? 0
    options.onViewers?.(viewers)
    // 观众数一变就重算帧率 —— 「编码路数 × 帧率」是主播 CPU 的真实负担，
    // 这个不用等 getStats 事后发现，人进来的那一刻就能算出来
    retuneFps()
  }) as (...args: never[]) => void)

  socket.on('signal', ((payload: { from?: string; data?: SignalData }) => {
    const p = payload?.from ? peers.get(payload.from) : null
    if (!p || !payload?.data) return
    const { sdp, candidate, gen } = payload.data
    // 观众回的是上一轮的包（它还没收到新 offer 就先回了旧的）：不能喂给新连接
    if (gen !== undefined && gen !== p.gen) return
    if (sdp) {
      if (sdp.type && sdp.type !== 'answer') return // 观众只回 answer
      const pc = p.pc
      void pc
        .setRemoteDescription(new RTCSessionDescription(sdp))
        .then(() => {
          // 这条连接可能在 await 期间被换掉了（观众又 watch 了一轮）：别往新连接里灌旧候选
          if (peers.get(p.id) !== p) return
          p.remoteReady = true
          for (const c of p.pending.splice(0)) void pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})
        })
        .catch(() => {})
    } else if (candidate) {
      // 远端描述还没落地就先攒着 —— WebRTC **不会**重发候选，丢一颗就少一条可能的通路（见 peers 的注释）
      if (p.remoteReady) void p.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {})
      else p.pending.push(candidate)
    }
  }) as (...args: never[]) => void)

  socket.on('disconnect', (() => {
    // 信令断了，画面不一定断（WebRTC 是点对点的）。socket.io 会自己重连，连上再 resume
    if (!stopped) options.onState?.('reconnecting')
  }) as (...args: never[]) => void)

  // connectLive 已经消费掉首连的 connect，这里只会在**重连**时触发
  socket.on('connect', (() => {
    if (stopped) return
    if (roomId) void resume()
    else if (dormant && document.visibilityState === 'visible') void wake()
  }) as (...args: never[]) => void)

  try {
    await goLive()
  } catch (e) {
    stopped = true
    teardown()
    throw e
  }

  options.onState?.('live')
  // 开播就报一次，别等第一轮统计（那要 5 秒，大厅这 5 秒里少一个 👋）
  reportCoop()

  statsTimer = window.setInterval(() => void statsTick(), STATS_INTERVAL_MS)
  sourceTimer = window.setInterval(sourceTick, SOURCE_CHECK_MS)
  document.addEventListener('visibilitychange', onVisibility)
  visibilityBound = true
  // 开播那一刻就可能已经在后台了（比如切到别的标签页才点的开播）
  if (document.visibilityState === 'hidden') onVisibility()

  return {
    get roomId() {
      return roomId
    },
    viewers: () => viewers,
    /** 见接口注释。socket 没连上就悄悄跳过 —— 重连之后 LiveControls 会再报一次 */
    linkNetplay(roomId: string | null) {
      if (stopped) return
      linkedNetplayRoom = roomId
      try {
        if (socket.connected) socket.emit('link-netplay', { roomId: roomId ?? '' })
      } catch {
        /* ignore */
      }
    },
    /**
     * 见接口注释。补发没有意义（那一刻早过去了），但**发没发出去要告诉调用方** ——
     * 弹幕不做本地回显，被丢掉的那条在界面上和「没人说话」长得一模一样。
     */
    sendChat(text: string) {
      if (stopped) return Promise.resolve('dropped' as ChatSendResult)
      return sendChatWithAck(socket, text)
    },
    grantSeat(viewerId: string) {
      if (stopped) return
      const previous = gate.seated()
      release(gate.grant(viewerId))
      if (previous && previous !== viewerId) tellSeat(previous, false)
      tellSeat(viewerId, true)
      options.onSeatChange?.(gate.seated())
      reportCoop()
    },
    revokeSeat() {
      revokeInternal()
    },
    seated: () => gate.seated(),
    stop() {
      if (stopped) return
      stopped = true
      // 停播也要松键：这一局还在跑，只是不播了 —— 别留一个卡住的方向键给房主
      revokeInternal()
      try {
        if (socket.connected) socket.emit('stop-live')
      } catch {
        /* ignore */
      }
      teardown()
      options.onState?.('ended')
    },
  }
}
