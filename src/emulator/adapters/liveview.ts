/**
 * 观众侧：只看不玩。
 *
 * 主播那边把画布和声音经 WebRTC 直推过来（见 emulator/broadcast.ts），
 * 这里就是收下来塞进一个 <video>。没有模拟器在跑，所以既不能暂停也没有存档 ——
 * 但音量、截图、录像都还在（都是对着这条流做的）。
 *
 * 和 cloudgame 的区别：cloudgame 的画面来自服务器上跑的游戏（要花钱），
 * 这里的画面来自另一个玩家的浏览器（零服务器成本，只借道信令）。
 *
 * ── 断线 ──────────────────────────────────────────────────
 * 三样东西各自会断，处理方式不同：
 *
 *   自己的信令 socket 断了   → socket.io 自动重连，连上后重新 watch **登记回房间**。重连后 socket.id
 *                             是新的，服务器凭我们自带的 key 认出还是同一个人：画面还连着就只是换个名字
 *                             （主播那条 PeerConnection 不重建，一帧不掉）；画面已经断了才要一轮新 offer。
 *                             以前每次重连都当新观众重建整条连接 —— 画面黑一下、人数多算一个、
 *                             满员的房间里还会被自己的幽灵挤出去（watch 回 full）。
 *   到主播的 PeerConnection  → 主播在的话重新 watch 要一轮新 offer；主播不在就等 host-back。
 *   failed
 *   主播的 socket 断了       → 服务器发 host-away、房间先留着（见 server/src/live.js）。
 *                             主播回来发 host-back 并对照名单重新 offer，这里什么都不用做。
 *
 * 只有 live-ended 才算真的结束。以前是 pc 一 failed 就报「连接断了」进错误遮罩，
 * 而主播可能几秒后就回来了；socket 断了则干脆什么都不做，画面冻着直到天荒地老。
 *
 * 一个特殊情形：服务器重启，内存里的房间全没了，重新 watch 会回 not found ——
 * 但如果画面还在流（P2P 不经过服务器），那就静默继续看，别拿遮罩盖掉一场好好的直播。
 */
import type { Capability, CaptureSources, MountOptions, RuntimeHandle } from '../types'
import { getT, fmt } from '@/services/i18n'
import { connectLive, liveEnabled, liveIceConfig, type LiveChatMessage, type LiveSocket } from '@/services/live'
import { sanitizeChatText } from '../../../shared/live-chat.js'
import { usableVideoSize } from '../videoTuning'

export type LiveViewState = 'connecting' | 'watching' | 'reconnecting' | 'host-away' | 'ended' | 'error'

export interface LiveSession {
  /** 要观看的直播间 */
  roomId: string
  onState?: (state: LiveViewState) => void
  onViewers?: (count: number) => void
  onInfo?: (info: { title: string; hostName: string; gameName: string }) => void
  /**
   * 主播把这个直播间同时开成了联机房（或者刚关掉，回传 null）。
   *
   * 观众靠它多出一个「加入联机」的入口 —— 「看着看着就能上场」全靠这一条：
   * 已经在看的人不会再去刷大厅，等轮询等不来。
   */
  onNetplay?: (roomId: string | null) => void
  /** 收到一条弹幕。自己发的那条也会从服务端回来，本地不做乐观回显 */
  onChat?: (msg: LiveChatMessage) => void
  /**
   * 主播切到后台了（true）/ 切回来了（false）。
   * 画面这时是**冻结**而不是断开 —— 浏览器不给后台标签页出帧，这是浏览器行为。
   */
  onFrozen?: (frozen: boolean) => void
  /**
   * 观众这一侧的链路质量。
   *
   * 为什么值得单独报：主播侧早就有 getStats，观众侧一个都没有 —— 于是观众卡的时候
   * **分不清是自己网差还是主播那边扛不住**，只能瞎刷新。而这两件事该做的动作完全相反：
   * 前者换个网络有用，后者换网络没用、少看一会儿才有用。
   */
  onLinkQuality?: (q: LinkQuality) => void
}

export interface LinkQuality {
  /**
   * - `ok`      一切正常
   * - `local`   丢包 / 抖动高 → **你这边**的网络问题（换网络、离路由器近点有用）
   * - `host`    收到的帧率明显偏低但几乎不丢包 → **主播那边**发得就少（他降档了或者机器扛不住）
   */
  verdict: 'ok' | 'local' | 'host'
  /** 实际收到的帧率 */
  fps: number
  /** 丢包率（0~1） */
  loss: number
  /** 往返时延（毫秒）；拿不到是 0 */
  rttMs: number
}

type SignalData = { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit; gen?: number; error?: 'no-source' }
type WatchAck = {
  hostId: string | null
  hostAway?: boolean
  /** 主播切后台了，画面冻着。中途进来的观众只能从这里知道 —— host-frozen 那条推送早发过了 */
  hostFrozen?: boolean
  title: string
  hostName: string
  gameName: string
  viewers: number
  /** 配对的联机房号。中途进来的观众靠它，不用等 netplay-linked 那一下 */
  netplayRoomId?: string | null
  /** 最近几条弹幕。同理：中途进来的人靠它，不然面对一片空白 */
  chat?: LiveChatMessage[]
}

/**
 * 首次等 offer 的时间。
 *
 * 主播收到 viewer-joined 就会发 offer，正常一两秒。等不到通常不是网络慢，而是**那条事件丢了**
 * ——主播正好在重连、或者 offer 发出前 addViewer 抛了。以前首次 watch 之后**根本没上闹钟**
 * （armRewatch 只在 rewatch 和 host-back 之后才上），offer 一丢，观众的 pc 就永远停在 new 状态：
 * 它不会变成 failed，所以那套「failed → rewatch」的恢复逻辑一次都不会触发，干等到总超时报错。
 */
const FIRST_OFFER_MS = 8_000
/** 重新 watch 之后等 offer 的时间；到点还没通就再要一次，要过几次都没用才算断 */
const REWATCH_TIMEOUT_MS = 20_000
const REWATCH_MAX = 3
/**
 * 从进房到画面通的**总**预算。
 *
 * 以前这里是 25 秒，而重试机制是 20 秒 × 3 次 —— 看门狗必然先到，`fail()` 一调直接进错误遮罩，
 * 等于那三次重试在首连场景里是死代码。现在放到「首次 8s + 3 × 20s」之上，留一点余量，
 * 让重试真的有机会跑完；正常连上的话 freshPc 那边一到 connected 就把它清了。
 */
const CONNECT_BUDGET_MS = 75_000

/* ---------------- 观众端链路统计 ---------------- */

/** 多久读一轮 inbound-rtp。和主播侧对齐，秒级足够 —— 编码器自己的自适应也是秒级的 */
const LINK_STATS_INTERVAL_MS = 5_000
/**
 * 丢包超过这个比例就判成「你这边网络有问题」。
 * 3% 是经验线：WebRTC 靠 NACK/FEC 能补掉零星丢包，到 3% 以上画面才会开始出块。
 */
const LOSS_BAD = 0.03
/**
 * 收到的帧率低于「主播标称帧率」的这个比例，且**几乎不丢包**，就判成主播那边发得少。
 *
 * ⚠️ 必须带上「不丢包」这个条件。丢包也会让收到的帧率掉下来，
 * 那种情况是本地网络问题，说成「主播扛不住」会让观众白白去等一个不会好的东西。
 */
const HOST_SLOW_RATIO = 0.6
/** 主播那边的基准帧率（broadcast.ts 的 DEFAULT_FPS）。观众拿不到真值，按这个比 */
const ASSUMED_HOST_FPS = 30

function deadHandle(): RuntimeHandle {
  return { destroy: () => {}, caps: new Set<Capability>() }
}

export function mount(container: HTMLElement, options: MountOptions): RuntimeHandle {
  const rt = getT().runtime
  const live = options.live

  if (!liveEnabled()) {
    options.onError?.(rt.liveNotConfigured)
    return deadHandle()
  }
  if (!live?.roomId) {
    options.onError?.(rt.liveNoRoom)
    return deadHandle()
  }

  let destroyed = false
  let socket: LiveSocket | null = null
  let pc: RTCPeerConnection | null = null
  /** 当前这条 pc 对应主播那边的代号；不匹配的 ICE 候选是上一轮的，扔掉 */
  let pcGen: number | undefined
  /** 这条 pc 已经吃过一个 offer 了 —— 再来一个就是新一轮，得换连接 */
  let pcOffered = false
  /** 远端描述到之前收到的候选先攒着，否则 addIceCandidate 会报错 */
  let pendingIce: RTCIceCandidateInit[] = []
  let hostId: string | null = null
  let hostAway = false
  /** 曾经成功进过房（之后的 watch 都是「重新 watch」，失败的意义不一样） */
  let joined = false
  /**
   * 这一次观看的身份钥匙，随每次 watch 发给服务端（见 server/src/live.js 的「观众换了 socket」）。
   * 信令重连后 socket.id 会换，服务端凭它认出还是同一个人：不多算人数、不把我们挤出满员的房间、
   * 画面还连着就不让主播重建连接。随机、只发给服务端，别人拿不到。
   */
  const viewerKey = (() => {
    try {
      return crypto.randomUUID().replace(/-/g, '')
    } catch {
      return Math.random().toString(36).slice(2) + Date.now().toString(36)
    }
  })()
  /**
   * 主播冻着（切后台）的时候来了一次「该重连了」（pc failed / 主播说抓不到画面）—— 当时不能动
   * （冻着期间要多少轮 offer 都等不到帧），记下来，等它一回前台就补上。
   * 不记的话：解冻那一刻只看 `!gotFrame`，而我们早就见过帧了 → 没人再去要 offer，
   * 观众对着一条死掉的连接、状态栏却写着「在看」，永远不会自愈。
   */
  let thawRewatch = false
  /** 服务器已经不认这个房间了，但画面还在流；画面一断就是真的结束 */
  let orphan = false
  let watching = false
  let rewatchTimer = 0
  let rewatchCount = 0
  /** 站点配了 TURN 中继没有。没有的话「连不上」十有八九是穿不过 NAT，提示要说得具体些 */
  let hasTurn = false
  /**
   * ⚠️ 可变，而且每次建新连接之前都要刷。
   *
   * TURN 凭证是后端现签的短期凭证（默认一小时）。一场直播看两小时，中途主播信令重连
   * 一次、或者我们自己 rewatch 一次，都会**新建 PeerConnection** —— 用挂载那一刻取的
   * 那份就是拿过期凭证去连中继：需要走中继的观众（对称 NAT、移动网络）ICE 全灭，
   * 三次 rewatch 用完直接报「直播中断」，而且看直播这条路播放器不会自动重试，
   * 观众只能手动刷新页面。老观众（连接没重建过）一切正常，所以线上极难查。
   * 主播那边（broadcast.ts 的 addViewer）早就是每条连接现取的，观众这边一直漏着。
   */
  let iceServers: RTCIceServer[] = []
  /** 刷一遍 ICE 配置。liveIceConfig 自带缓存，没过期时只读内存，不发请求 */
  const refreshIce = async () => {
    if (destroyed) return
    try {
      const next = await liveIceConfig()
      if (destroyed) return
      iceServers = next.iceServers
      hasTurn = next.hasTurn
    } catch {
      /* 取不到就沿用上一次的，总比不连强 */
    }
  }
  /**
   * **真的有画面了**，而不是「连接建立了」。
   *
   * 这两件事差着一段可见的时间：PeerConnection 报 connected 只说明 ICE + DTLS 通了，
   * 第一个关键帧还在路上（编码、发送、解码都要时间）。以前一 connected 就
   * `onStart()` + 切成 watching，进度条当场消失，于是观众对着一块**黑屏**干等 ——
   * 而且如果对方压根没加视频轨（主播那边 addTrack 抛了之类），这块黑屏会一直黑下去，
   * 没有任何超时、没有任何提示。改成等到第一帧真的画出来为止。
   */
  let gotFrame = false
  /**
   * 帧在解码，但小得没有内容（2×2 那种）。
   *
   * 这是**主播端的源废了**，不是网络问题 —— 报错时必须和「连不上」分开说，
   * 否则观众会去换网络、换热点，折腾一件跟他毫无关系的事。
   */
  let tinyFrame = false
  /** 主播明说了「这一刻抓不到画面」（见 broadcast.ts 的 SignalData.error）。报错时优先于一切网络诊断 */
  let noSource = false
  /** 主播说抓不到画面之后，隔多久再去要一次。画布回来（Ruffle 读档重建大约 700ms）就能接上 */
  const NO_SOURCE_RETRY_MS = 2_500
  /** 第一帧的等待器（换连接时要撤掉，否则旧连接的回调会误报） */
  let frameWaiter: (() => void) | null = null
  /** 主播切到后台了：画面冻着，不是断了 */
  let hostFrozen = false
  /**
   * 本地收集到的候选类型（host / srflx / relay）。
   *
   * 只有 host 意味着**连公网地址都没问出来** —— STUN 不可达（比如默认那几台在墙外的），
   * 这时除非两边在同一个局域网里，否则必然连不上，跟主播在不在没有半点关系。
   * 拿它来把「网络根本没有通路」和「主播下播了」分开，不然报错永远是那句放之四海而皆准的废话。
   */
  const localCandidateTypes = new Set<string>()
  const stream = new MediaStream()

  const host = document.createElement('div')
  host.style.cssText = 'position:relative;width:100%;height:100%;background:#000;display:flex;align-items:center;justify-content:center'
  const video = document.createElement('video')
  video.autoplay = true
  video.playsInline = true
  video.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;image-rendering:pixelated'
  video.srcObject = stream
  host.appendChild(video)

  /**
   * 带声音的自动播放多半会被浏览器拦下（没有用户手势）。以前的做法是拦下就拦下，
   * 观众对着黑屏不知道该干什么。现在：被拦就先静音播出画面，挂一个「点一下开声」的角标。
   */
  const unmuteHint = document.createElement('button')
  unmuteHint.type = 'button'
  unmuteHint.textContent = rt.liveUnmute
  unmuteHint.style.cssText =
    'position:absolute;left:50%;bottom:12px;transform:translateX(-50%);display:none;padding:6px 12px;border:0;border-radius:999px;' +
    'background:rgba(0,0,0,.7);color:#fff;font:600 12px/1 system-ui,sans-serif;cursor:pointer;backdrop-filter:blur(4px)'
  host.appendChild(unmuteHint)
  container.appendChild(host)

  const tryPlay = () => {
    void video.play().catch(() => {
      if (destroyed || video.muted) return
      video.muted = true
      unmuteHint.style.display = 'block'
      void video.play().catch(() => {})
    })
  }
  const unmute = () => {
    video.muted = false
    unmuteHint.style.display = 'none'
    void video.play().catch(() => {})
  }
  const onClick = () => (video.muted && unmuteHint.style.display !== 'none' ? unmute() : tryPlay())
  host.addEventListener('click', onClick)

  /**
   * 连不上时到底该说什么。
   *
   * 拿本地收集到的候选类型判断：一个公网候选都没有（只有 host），就是这条网络出不去，
   * 说「可能是对方下播了」纯属误导 —— 用户会一直重试一件永远不可能成功的事。
   */
  const diagnose = (): string => {
    // 主播自己说了抓不到画面：这是最确定的一条，什么网络诊断都不用做
    if (noSource) return rt.liveNoSource
    /**
     * 先看有没有收到过帧。收到了就说明 ICE 早就通了，
     * 再去谈 STUN / TURN 是把观众往错误的方向支 —— 问题在主播推的画面上。
     */
    if (tinyFrame) {
      console.warn(`[live] 主播推过来的画面只有 ${video.videoWidth}×${video.videoHeight}，源废了，与网络无关`)
      return rt.liveBadFrame
    }
    /**
     * 通道通了、轨也在，但一帧都没到（轨一直 muted）：是**主播那边不出帧**，不是网络。
     * 实测（真 Chromium 环回）：画布静止时后进的观众就是这个形状 —— 游戏暂停、Flash 停在静态菜单、
     * 或者主播的浏览器没有 Insertable Streams 补不了帧。说「连不上」会让人去换热点，白折腾。
     */
    const vt = stream.getVideoTracks()[0]
    // 走到 diagnose() 就说明一帧都没画出来（看门狗只在 !watching 时叫它），所以这里不用再看 gotFrame。
    // ⚠️ 别拿 track.muted 当判据：实测源曾经出过帧再静止时，后进观众的轨可能报 muted=false 却一帧没有。
    if (pc?.connectionState === 'connected' && vt) {
      console.warn(`[live] 已连上主播（轨 muted=${vt.muted}），但对方一帧都没发出来（游戏暂停 / 静止画面 / 主播浏览器不出帧）`)
      return rt.liveHostIdle
    }
    const outward = localCandidateTypes.has('srflx') || localCandidateTypes.has('relay')
    if (!outward) {
      console.warn('[live] 只收集到 host 候选，拿不到公网地址（STUN 不可达？）hasTurn=', hasTurn)
      return rt.liveNoRoute
    }
    if (!hasTurn) console.warn('[live] 有公网候选但配不上对，且站点没有 TURN 中继兜底')
    return rt.liveTimeout
  }

  const watchdog = window.setTimeout(() => {
    if (!destroyed && !watching) {
      live.onState?.('error')
      options.onError?.(diagnose())
    }
  }, CONNECT_BUDGET_MS)

  const caps = new Set<Capability>(['volume', 'screenshot', 'record'])

  const fail = (msg: string) => {
    if (destroyed) return
    window.clearTimeout(watchdog)
    window.clearTimeout(rewatchTimer)
    live.onState?.('error')
    options.onError?.(msg)
  }

  /**
   * 等这条 <video> 真的画出第一帧。
   *
   * 首选 `requestVideoFrameCallback` —— 它的语义正是「一帧已经可以拿去显示了」，
   * 比 loadeddata / playing 都准。不支持的浏览器退回事件 + 轮询 videoWidth：
   * 有尺寸就说明解码器已经吃到东西了。
   */
  const waitForFirstFrame = (onFrame: () => void) => {
    frameWaiter?.()
    let done = false
    const fire = () => {
      if (done || destroyed) return
      done = true
      cleanup()
      onFrame()
    }
    const vid = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number
      cancelVideoFrameCallback?: (handle: number) => void
    }
    let rvfc = 0
    let poll = 0
    const onEvent = () => {
      if (video.videoWidth <= 0) return
      /**
       * ⚠️ 有尺寸 ≠ 有画面。
       *
       * 以前这里是 `videoWidth > 0` 就 fire()，于是一条 2×2 的黑屏轨也算「第一帧到了」：
       * markWatching() 把看门狗清掉、进度条撤掉，剩下一块永远黑、永远不报错的屏
       * （2026-09-06 线上就是这么发生的）。「等第一帧」防住了「一帧都没有」，
       * 没防住「帧是废的」—— 这里补上。
       *
       * 不 fire 也不立刻报错：接着等。主播那边把播放器布局好之后画布会重建，
       * 轨会跟着变大（实测会），真的一直不好就由看门狗按 diagnose() 说清楚是谁的问题。
       */
      if (!usableVideoSize(video.videoWidth, video.videoHeight)) {
        tinyFrame = true
        return
      }
      tinyFrame = false
      fire()
    }
    const cleanup = () => {
      if (rvfc && vid.cancelVideoFrameCallback) vid.cancelVideoFrameCallback(rvfc)
      if (poll) window.clearInterval(poll)
      video.removeEventListener('loadeddata', onEvent)
      video.removeEventListener('playing', onEvent)
      frameWaiter = null
    }
    frameWaiter = () => {
      done = true
      cleanup()
    }
    if (typeof vid.requestVideoFrameCallback === 'function') {
      // 自续：rVFC 只回调一次，而第一帧可能是废的，得盯着后面的帧等它变好
      const onRvfc = () => {
        onEvent()
        if (!done && !destroyed && vid.requestVideoFrameCallback) rvfc = vid.requestVideoFrameCallback(onRvfc)
      }
      rvfc = vid.requestVideoFrameCallback(onRvfc)
    }
    video.addEventListener('loadeddata', onEvent)
    video.addEventListener('playing', onEvent)
    // 兜底：有些浏览器上面几条都不触发（自动播放被拦、轨到得早于监听），轮询最稳
    poll = window.setInterval(onEvent, 250)
    onEvent()
  }

  /* ---- 观众端链路质量采样 ---- */
  let linkTimer = 0
  /** 上一轮的累计值，用来算这一段区间的增量（getStats 给的是从头累计的） */
  let lastPkts = { received: 0, lost: 0 }

  /**
   * 读一轮 inbound-rtp，判断「卡是谁的问题」。
   *
   * 用**区间增量**而不是累计值：累计丢包率会被开局握手那几秒的丢包长期拖住，
   * 网络早就好了，读数还挂在高位 —— 观众看到的就是一句永远不消失的「你的网络不稳」。
   */
  const sampleLink = async () => {
    if (destroyed || !pc || !gotFrame) return
    let report: RTCStatsReport
    try {
      report = await pc.getStats()
    } catch {
      return
    }
    let fps = 0
    let received = 0
    let lost = 0
    let rttMs = 0
    report.forEach((stat) => {
      const t = stat as RTCStats & {
        kind?: string
        framesPerSecond?: number
        packetsReceived?: number
        packetsLost?: number
        state?: string
        currentRoundTripTime?: number
      }
      if (t.type === 'inbound-rtp' && t.kind === 'video') {
        if (typeof t.framesPerSecond === 'number') fps = t.framesPerSecond
        if (typeof t.packetsReceived === 'number') received += t.packetsReceived
        // packetsLost 可以是负数（重排序被算回来），夹到 0
        if (typeof t.packetsLost === 'number') lost += Math.max(0, t.packetsLost)
      } else if (t.type === 'candidate-pair' && t.state === 'succeeded' && typeof t.currentRoundTripTime === 'number') {
        rttMs = Math.round(t.currentRoundTripTime * 1000)
      }
    })

    const dRecv = Math.max(0, received - lastPkts.received)
    const dLost = Math.max(0, lost - lastPkts.lost)
    lastPkts = { received, lost }
    // 这一段区间里几乎没收到包就别下结论 —— 样本太小，判什么都是噪声
    if (dRecv + dLost < 50) return
    const loss = dLost / (dRecv + dLost)

    const verdict: LinkQuality['verdict'] =
      loss >= LOSS_BAD ? 'local' : fps > 0 && fps < ASSUMED_HOST_FPS * HOST_SLOW_RATIO ? 'host' : 'ok'
    live.onLinkQuality?.({ verdict, fps: Math.round(fps), loss, rttMs })
  }

  /** 第一帧到了：这才算真的「在看」 */
  const markWatching = () => {
    gotFrame = true
    window.clearTimeout(watchdog)
    window.clearTimeout(rewatchTimer)
    rewatchCount = 0
    if (!watching) {
      watching = true
      options.onStart?.()
    }
    // 有画面了才开始采样：没画面时读出来的全是握手期的噪声
    if (!linkTimer) {
      lastPkts = { received: 0, lost: 0 }
      linkTimer = window.setInterval(() => void sampleLink(), LINK_STATS_INTERVAL_MS)
    }
    live.onState?.(hostFrozen ? 'host-away' : 'watching')
  }

  const closePc = () => {
    if (!pc) return
    const old = pc
    pc = null
    old.onconnectionstatechange = null
    old.ontrack = null
    old.onicecandidate = null
    try {
      old.close()
    } catch {
      /* ignore */
    }
  }

  /** 换一条新连接。主播每轮 offer 都是新建的 PeerConnection，旧的那条接不了 */
  const freshPc = (gen: number | undefined) => {
    closePc()
    // 旧连接的等待器不能留着：它盯的是同一个 <video>，会把上一轮的残帧当成新连接通了
    frameWaiter?.()
    pcGen = gen
    pcOffered = false
    pendingIce = []
    /**
     * ⚠️ 换连接就要重新证明有画面。
     *
     * gotFrame 以前只置位不复位，于是第一帧之后所有「等不到画面」的恢复逻辑全成了死代码：
     * ontrack 不再装等待器、connectionState 一到 connected 就报「在看」、
     * armRewatch 的 `!gotFrame` 永远为假。表现是画面停在上一路连接的最后一帧，
     * 状态却写着「📡 在看」，没有超时、没有提示、永远不会自愈。
     */
    gotFrame = false
    tinyFrame = false
    const next = new RTCPeerConnection({ iceServers })
    pc = next
    next.ontrack = (ev) => {
      // 新一轮的轨替换旧一轮的同类轨：<video> 一直盯着同一个 MediaStream，不用重新赋 srcObject
      for (const track of ev.streams[0]?.getTracks() ?? [ev.track]) {
        if (stream.getTracks().includes(track)) continue
        for (const old of stream.getTracks()) if (old.kind === track.kind) stream.removeTrack(old)
        stream.addTrack(track)
      }
      tryPlay()
      // 轨到了就可以开始等第一帧 —— 比等 connectionState 变 connected 更早
      if (!gotFrame && ev.track.kind === 'video') waitForFirstFrame(markWatching)
    }
    next.onconnectionstatechange = () => {
      if (destroyed || pc !== next) return
      const s = next.connectionState
      if (s === 'connected') {
        /**
         * 通道通了 ≠ 有画面了。第一帧还在路上，这时候把进度条撤掉只会露出一块黑屏。
         * 看门狗**故意不在这里清** —— 连上了却一直没有画面（主播没加轨、编码器起不来）
         * 也必须能超时报错，而不是让人对着黑屏无限等。
         */
        if (gotFrame) live.onState?.('watching')
        else {
          live.onState?.('connecting')
          waitForFirstFrame(markWatching)
        }
      } else if (s === 'disconnected') {
        // ICE 的 disconnected 经常自己恢复；先只把标记变一下，failed 才动手
        live.onState?.(hostAway ? 'host-away' : 'reconnecting')
      } else if (s === 'failed') {
        if (orphan) return fail(rt.liveLost) // 服务器早不认这个房间了，画面也断了：真的结束
        if (hostAway) return live.onState?.('host-away') // 主播回来会重新 offer
        if (!socket?.connected) return live.onState?.('reconnecting') // socket 连上会重新 watch
        void rewatch()
      }
    }
    next.onicecandidate = (ev) => {
      if (ev.candidate?.type) localCandidateTypes.add(ev.candidate.type)
      // 用 pcGen 而不是参数 gen：首连时这条 pc 是空着等 offer 建的，代号要等 offer 到了才知道
      if (ev.candidate && socket?.connected && hostId && pc === next) {
        socket.emit('signal', { target: hostId, data: { candidate: ev.candidate.toJSON(), gen: pcGen } satisfies SignalData })
      }
    }
    return next
  }

  /**
   * 进房 / 重新进房。返回 false 表示这次没成功（错误已经处理）。
   *
   * `reoffer`：明确告诉服务端「我的画面断了，要一轮新 offer」。不带的话，服务端认出我们只是换了 socket
   * 时会让主播**保留**那条还在流的连接（viewer-rebound），而不是拆了重建。
   */
  const watch = async (reoffer = true): Promise<boolean> => {
    if (destroyed || !socket?.connected) return false
    const s = socket
    let info: WatchAck
    try {
      info = await new Promise<WatchAck>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('watch timeout')), 10_000)
        s.emit('watch', { roomId: live.roomId, key: viewerKey, reoffer }, (err: string | null, data: WatchAck) => {
          window.clearTimeout(timer)
          if (err) reject(new Error(err))
          else resolve(data)
        })
      })
    } catch (e) {
      if (destroyed) return false
      const msg = e instanceof Error ? e.message : String(e)
      if (joined && msg === 'not found' && pc && pc.connectionState === 'connected') {
        // 服务器重启把房间忘了，但画面还在点对点地流：静默继续，别打断一场好好的直播
        orphan = true
        live.onState?.('watching')
        return false
      }
      if (joined && msg !== 'not found' && msg !== 'full') {
        // 重新 watch 超时 / 别的临时错误：留给下一次 connect 或者 rewatch 再试
        live.onState?.('reconnecting')
        return false
      }
      fail(msg === 'not found' ? rt.liveGone : msg === 'full' ? rt.liveFull : fmt(rt.liveFailed, { msg }))
      return false
    }
    if (destroyed) return false

    hostId = info.hostId
    hostAway = !info.hostId || Boolean(info.hostAway)
    // 主播在我进来之前就切后台了：host-frozen 那条推送早发过，只能从 ack 里补
    if (Boolean(info.hostFrozen) !== hostFrozen) {
      hostFrozen = Boolean(info.hostFrozen)
      live.onFrozen?.(hostFrozen)
    }
    if (!joined) {
      joined = true
      live.onInfo?.({ title: info.title, hostName: info.hostName, gameName: info.gameName })
      /*
        ⚠️ **刻意不再补历史弹幕**（2026-09-07 起，见 LiveChat.tsx 的文件头）。
        ack 里那个 `info.chat` 服务端照旧会送（30 条环形缓冲），我们收下不用。

        为什么不能「顺手 push 一下反正不亏」：弹幕现在只有飘幕这一个出口，而飘幕
        **按设计不飞补历史那一批**（一次性糊满屏没人读得了，靠 LiveChatLane 的 seen 拦着）。
        画面下方的消息列表已经整块删掉。所以 push 进来的这些谁都看不见 ——
        白占内存、还会把 KEEP 那个飘幕缓冲挤掉真正该飞的新消息。

        代价是明确接受的：中途进来的观众看不到他进来之前说过的话。
      */
      // 中途进来的观众：主播可能早就点过「联机」了，ack 里就带着房号
      live.onNetplay?.(info.netplayRoomId ?? null)
      // 主播那边收到 viewer-joined 后会主动发 offer 过来，这里等着就行
      options.onReady?.()
    }
    live.onViewers?.(info.viewers)
    // 主播不在：首连的看门狗别叫 —— 等多久由服务器的宽限期决定，到点它会发 live-ended
    if (hostAway) window.clearTimeout(watchdog)
    live.onState?.(hostAway ? 'host-away' : pc?.connectionState === 'connected' ? 'watching' : 'connecting')
    return true
  }

  /** 等一轮 offer；到点画面还没通就重新 watch 要一次 */
  const armRewatch = (delay = REWATCH_TIMEOUT_MS) => {
    window.clearTimeout(rewatchTimer)
    rewatchTimer = window.setTimeout(() => {
      // 判据是「有没有画面」，不是「通道通没通」：连上了却一直不出画面
      // （主播那边没加轨、或者编码器起不来）同样要再要一轮 offer
      /*
        ⚠️ hostFrozen 也要放行，和 hostAway 一个待遇。
        主播切到后台时浏览器不给后台页出帧，captureStream 直接停住 —— 这时候等不到画面
        是**必然**的，不是连接有问题。以前守卫里没有它：闹钟照响 → 8/28/48 秒各重新 watch
        一次 → 每一次都让主播那边把整条 PeerConnection 连编码管线重建一遍（砸在一台
        本来就被降频的后台机器上）→ 68 秒后 rewatchCount 撞满，观众拿到一句
        「连接超时 / 你的网络出不去」。主播好好的，只是切了个标签页。
      */
      if (!destroyed && !hostAway && !hostFrozen && !gotFrame) void rewatch()
    }, delay)
  }

  /** 要一轮新 offer；等不到就再要，几次都没用才算断 */
  const rewatch = async () => {
    if (destroyed || !socket?.connected) return
    // 主播冻着的时候重来多少次都等不到帧，记一笔，等它 host-frozen:false 回来再补（见 thawRewatch）
    if (hostFrozen) {
      thawRewatch = true
      return
    }
    thawRewatch = false
    window.clearTimeout(rewatchTimer)
    if (rewatchCount >= REWATCH_MAX) return fail(joined && watching ? rt.liveLost : diagnose())
    rewatchCount += 1
    live.onState?.('reconnecting')
    // 重连这一轮多半要新建 PeerConnection，凭证先刷一遍再要 offer
    await refreshIce()
    if (destroyed) return
    const ok = await watch()
    if (!ok || destroyed || hostAway) return
    armRewatch()
  }

  /**
   * 自己的信令重连上来了：**重新登记进房间**，这一步和主播冻着没冻着无关。
   *
   * 服务端的 membership 是按 socket.id 记的，重连后 id 换了 —— 不重新 watch 就等于不在房间里：
   * 收不到 host-frozen:false / live-ended / 弹幕 / 联机房号，房间还可能因为「零观众」被收掉。
   * 以前这里走的是 rewatch()，而它一看到 hostFrozen 就早退 → 主播切着后台时观众的网抖一下，
   * 这个观众就永远掉出了房间，主播回前台它也不知道，只能一直黑着。
   *
   * 画面还连着就不要新 offer（服务端会让主播把连接换个名字）；断了才要。
   */
  const rejoin = async () => {
    if (destroyed || !socket?.connected) return
    window.clearTimeout(rewatchTimer)
    rewatchCount = 0
    await refreshIce()
    if (destroyed) return
    const connected = pc?.connectionState === 'connected'
    const ok = await watch(!connected)
    if (!ok || destroyed || hostAway || hostFrozen) return
    // 闹钟照上：到点有画面它什么都不做，没画面（要的 offer 没来 / 连着却不出帧）就再要一轮
    armRewatch()
  }

  void (async () => {
    try {
      live.onState?.('connecting')
      socket = await connectLive()
      if (destroyed) return socket.close()
      await refreshIce()
      if (destroyed) return socket.close()
      const s = socket

      // 一条空连接先立着，等主播的第一个 offer；ICE 候选在 offer 之前到的话有地方攒
      freshPc(undefined)

      s.on('signal', ((payload: { from?: string; data?: SignalData }) => {
        if (destroyed || !payload?.data) return
        // from 必须是当前主播；主播重连后 id 换了，host-back 会更新 hostId
        if (!hostId || payload.from !== hostId) return
        const { sdp, candidate, gen, error } = payload.data
        if (error === 'no-source') {
          /**
           * 主播这一刻抓不到画面。不当场报错 —— 画布可能只是在重建（Ruffle 读档那 700ms）——
           * 隔几秒再要一轮；几轮都这样，rewatch 撞满 REWATCH_MAX 之后 diagnose() 会把这句话原样报出来。
           */
          noSource = true
          console.warn('[live] 主播报告抓不到画面（画布没了或废了），稍后重试')
          live.onState?.('connecting')
          window.clearTimeout(rewatchTimer)
          rewatchTimer = window.setTimeout(() => {
            if (!destroyed && !gotFrame) void rewatch()
          }, NO_SOURCE_RETRY_MS)
          return
        }
        if (sdp) {
          noSource = false
          if (sdp.type && sdp.type !== 'offer') return // 主播只发 offer
          // 新一轮：代号变了，或者这条连接已经吃过 offer。主播每轮都是新建的 PeerConnection
          const stale = !pc || pcOffered || (gen !== undefined && pcGen !== undefined && gen !== pcGen)
          const cur: RTCPeerConnection = stale ? freshPc(gen) : (pc as RTCPeerConnection)
          pcGen = gen
          pcOffered = true
          void (async () => {
            await cur.setRemoteDescription(new RTCSessionDescription(sdp))
            for (const c of pendingIce.splice(0)) await cur.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})
            const answer = await cur.createAnswer()
            await cur.setLocalDescription(answer)
            if (pc === cur && s.connected && hostId) {
              s.emit('signal', { target: hostId, data: { sdp: cur.localDescription ?? answer, gen } satisfies SignalData })
            }
          })().catch((e) => {
            if (!destroyed && pc === cur) fail(fmt(rt.liveFailed, { msg: e instanceof Error ? e.message : String(e) }))
          })
        } else if (candidate) {
          if (!pc) return
          if (gen !== undefined && pcGen !== undefined && gen !== pcGen) return // 上一轮的候选
          if (pc.remoteDescription) void pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {})
          else pendingIce.push(candidate)
        }
      }) as (...args: never[]) => void)

      /**
       * 弹幕。服务端广播给房间里所有人，自己发的那条也会回来 ——
       * 所以这里收到什么就显示什么，本地不做乐观回显：
       * 每个观众看到的顺序都是服务端定的那一个。
       */
      s.on('chat', ((msg: LiveChatMessage) => {
        if (msg?.text) live.onChat?.(msg)
      }) as (...args: never[]) => void)


      s.on('viewers', ((p: { count?: number }) => live.onViewers?.(p?.count ?? 0)) as (...args: never[]) => void)
      /**
       * 主播刚把这一局开成了联机房（传 null 就是刚关掉）。
       * 已经在看的人就是靠这一下多出「加入联机」按钮的 —— 他们不会再去刷大厅。
       */
      s.on(
        'netplay-linked',
        ((p: { roomId?: string | null }) => live.onNetplay?.(p?.roomId || null)) as (...args: never[]) => void,
      )

      /**
       * 主播切到后台了：浏览器不给后台标签页出帧，画面就冻在那儿。
       * 不是断线、不用重连 —— 只要告诉观众一声，别让他以为是自己网的问题。
       */
      s.on('host-frozen', ((p: { frozen?: boolean }) => {
        if (destroyed) return
        const was = hostFrozen
        hostFrozen = Boolean(p?.frozen)
        live.onFrozen?.(hostFrozen)
        if (watching) live.onState?.(hostFrozen ? 'host-away' : 'watching')
        /*
          主播回来了，而我还没见过一帧（进来的时候他就冻着）—— 现在才是该等画面的时候。
          冻着期间闹钟是被 armRewatch 的守卫挡住的，不在这里重新起一次的话，
          就再也没有人来喊「怎么还没画面」，观众会一直黑着。
        */
        if (was && !hostFrozen) {
          if (thawRewatch) {
            // 冻着期间连接就已经断了（见 thawRewatch）：现在立刻去要，别再等 20 秒
            thawRewatch = false
            rewatchCount = 0
            void rewatch()
          } else if (!gotFrame) {
            armRewatch()
          }
        }
      }) as (...args: never[]) => void)

      s.on('host-away', (() => {
        if (destroyed) return
        hostAway = true
        // 画面还连着就不惊动人（只是主播的信令断了，WebRTC 不经过服务器）；断了才亮「主播不在」
        if (pc?.connectionState !== 'connected') live.onState?.('host-away')
      }) as (...args: never[]) => void)

      s.on('host-back', ((p: { hostId?: string }) => {
        if (destroyed) return
        hostAway = false
        if (p?.hostId) hostId = p.hostId
        // 主播回来会对照名单重新 offer。它那边要是还以为这条连接活着（两边判断有时差），
        // offer 就不会来 —— 所以上个闹钟，到点画面没通就主动去要
        if (pc?.connectionState === 'connected') live.onState?.('watching')
        else {
          live.onState?.('connecting')
          rewatchCount = 0
          armRewatch()
        }
      }) as (...args: never[]) => void)

      s.on('live-ended', (() => {
        if (destroyed) return
        window.clearTimeout(rewatchTimer)
        live.onState?.('ended')
        options.onError?.(rt.liveEnded)
      }) as (...args: never[]) => void)

      s.on('disconnect', (() => {
        if (destroyed) return
        // 服务器把我们从房间里踢了、也通知了主播拆连接。socket.io 会自动重连，连上再进一次
        live.onState?.(pc?.connectionState === 'connected' ? 'watching' : 'reconnecting')
      }) as (...args: never[]) => void)

      // connectLive 已经消费掉首连的 connect，这里只在**重连**时触发
      s.on('connect', (() => {
        if (destroyed || !joined) return
        void rejoin()
      }) as (...args: never[]) => void)

      const ok = await watch()
      /**
       * 首连也要上闹钟 —— 这一行以前没有。
       * 主播漏收 viewer-joined（它正在重连、或者 offer 发出前抛了）的话，offer 永远不来，
       * 而 pc 停在 new 状态**不会**变 failed，那条「failed → rewatch」的恢复路径压根不触发。
       * 结果就是观众干等到总超时，中间一次重试都没有。
       */
      if (ok && !hostAway) armRewatch(FIRST_OFFER_MS)
      options.onCaps?.(caps)
    } catch (e) {
      if (destroyed) return
      fail(e instanceof Error ? e.message : String(e))
    }
  })()

  options.onCaps?.(caps)

  return {
    caps,
    volume: 1,
    /**
     * 发一条弹幕。socket 没连上就丢掉 —— 弹幕补发没有意义，那一刻早过去了。
     * 房间号不用带：服务端从 membership 认，客户端指定房间号是个跨房间注入的口子。
     */
    liveChat(text: string) {
      const clean = sanitizeChatText(text)
      if (!clean || destroyed || !socket?.connected) return
      try {
        socket.emit('chat', { text: clean })
      } catch {
        /* ignore */
      }
    },
    setVolume(next: number) {
      const v = Math.max(0, Math.min(1, next))
      video.volume = v
      video.muted = v === 0
      if (v > 0) unmuteHint.style.display = 'none'
    },
    async screenshot() {
      if (!video.videoWidth) return null
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.drawImage(video, 0, 0)
      return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    },
    captureSources(): CaptureSources | null {
      // 收到的流本来就带音视频，录像直接录它
      return stream.getTracks().length ? { stream } : null
    },
    destroy() {
      destroyed = true
      frameWaiter?.()
      window.clearInterval(linkTimer)
      window.clearTimeout(watchdog)
      window.clearTimeout(rewatchTimer)
      host.removeEventListener('click', onClick)
      closePc()
      try {
        socket?.close()
      } catch {
        /* ignore */
      }
      socket = null
      for (const t of stream.getTracks()) {
        t.stop()
        stream.removeTrack(t)
      }
      video.srcObject = null
      host.remove()
    },
  }
}

