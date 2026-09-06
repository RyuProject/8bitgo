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
 */
import type { CaptureSources } from './types'
import { connectLive, liveIceServers, type LiveSocket } from '@/services/live'
import { applyTuning, fpsForViewers, sizeOfTrack, tuningFor } from './videoTuning'

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
  sources: CaptureSources
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
  /** 房间号变了（重连后接不回原房间、只能重开时）。开播那一次也会调 */
  onRoom?: (roomId: string) => void
  onError?: (message: string) => void
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

type SignalData = { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit; gen?: number }

/** 能不能开播：有画面就行（声音可选） */
export function canBroadcast(sources: CaptureSources | null | undefined): boolean {
  if (!sources) return false
  if (sources.stream) return sources.stream.getTracks().length > 0
  return Boolean(sources.canvas && typeof sources.canvas.captureStream === 'function')
}

/**
 * 把 CaptureSources 拼成一条可推的流。
 * 返回的 release() 只停我们自己新建的轨 —— 云联机那条流还在播，停了画面就没了。
 */
function buildStream(sources: CaptureSources, fps: number): { stream: MediaStream; release: () => void } | null {
  const tracks: MediaStreamTrack[] = []
  let audioDest: MediaStreamAudioDestinationNode | null = null
  let ownTracks: MediaStreamTrack[] = []

  if (sources.stream) {
    tracks.push(...sources.stream.getTracks())
  } else if (sources.canvas && typeof sources.canvas.captureStream === 'function') {
    const captured = sources.canvas.captureStream(fps)
    const own = captured.getVideoTracks()
    tracks.push(...own)
    ownTracks = ownTracks.concat(own)
  }

  if (!sources.stream && sources.audioNode && sources.audioContext) {
    try {
      audioDest = sources.audioContext.createMediaStreamDestination()
      sources.audioNode.connect(audioDest)
      const own = audioDest.stream.getAudioTracks()
      tracks.push(...own)
      ownTracks = ownTracks.concat(own)
    } catch {
      audioDest = null
    }
  }

  if (!tracks.length) return null
  return {
    stream: new MediaStream(tracks),
    release: () => {
      if (audioDest && sources.audioNode) {
        try {
          sources.audioNode.disconnect(audioDest)
        } catch {
          /* 已经断了 */
        }
      }
      for (const t of ownTracks) t.stop()
    },
  }
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
function tuneSender(sender: RTCRtpSender, maxBitrate: number | undefined, maxFramerate: number) {
  const { width, height } = sizeOfTrack(sender.track)
  applyTuning(sender, tuningFor({ width, height, fps: maxFramerate, maxBitrate }))
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
  const built = buildStream(options.sources, captureFps)
  if (!built) throw new Error('no capture source')

  options.onState?.('connecting')

  let socket: LiveSocket
  try {
    socket = await connectLive()
  } catch (e) {
    built.release()
    throw e
  }

  /** 每个观众一条连接。gen 是这条连接的代号，随 SDP / ICE 一起发，观众据此认出「新一轮」 */
  const peers = new Map<string, { pc: RTCPeerConnection; gen: number }>()
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
  let cappedFps = captureFps
  let degradeStreak = 0
  let recoverStreak = 0
  let statsTimer = 0
  let visibilityBound = false
  let roomId = ''
  let token = ''

  const dropPeer = (viewerId: string) => {
    const p = peers.get(viewerId)
    if (!p) return
    peers.delete(viewerId)
    try {
      p.pc.close()
    } catch {
      /* ignore */
    }
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
    peers.set(viewerId, { pc, gen })

    for (const track of built.stream.getTracks()) {
      const sender = pc.addTrack(track, built.stream)
      if (track.kind === 'video') tuneSender(sender, options.maxBitrate ?? MAX_BITRATE_OVERRIDE, cappedFps)
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) socket.emit('signal', { target: viewerId, data: { candidate: ev.candidate.toJSON(), gen } satisfies SignalData })
    }
    pc.onconnectionstatechange = () => {
      // 观众那边断了就把连接收掉，别留着白占上行。它要是还在房间里，会自己重新 watch
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        if (peers.get(viewerId)?.pc === pc) dropPeer(viewerId)
      }
    }

    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      socket.emit('signal', { target: viewerId, data: { sdp: pc.localDescription ?? offer, gen } satisfies SignalData })
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
      if (peers.get(viewerId)?.pc !== pc) return
      dropPeer(viewerId)
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
        if (sender.track?.kind === 'video') tuneSender(sender, options.maxBitrate ?? MAX_BITRATE_OVERRIDE, cappedFps)
      }
    }
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
    try {
      if (socket.connected) socket.emit('host-visibility', { hidden: document.visibilityState === 'hidden' })
    } catch {
      /* 信令断了就算了，回来 resume 时状态会重新对齐 */
    }
  }

  const teardown = () => {
    if (statsTimer) {
      window.clearInterval(statsTimer)
      statsTimer = 0
    }
    if (visibilityBound) {
      document.removeEventListener('visibilitychange', onVisibility)
      visibilityBound = false
    }
    for (const id of Array.from(peers.keys())) dropPeer(id)
    built.release()
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
    } catch (e) {
      // 重开也失败（比如服务器满了）：这一局就到这儿，把资源放掉，别让 UI 挂着假标记
      if (stopped) return
      stopped = true
      teardown()
      options.onError?.(e instanceof Error ? e.message : String(e))
      options.onState?.('ended')
    }
  }

  socket.on('viewer-joined', ((payload: { viewerId?: string }) => {
    // 观众进来 / 观众重新 watch：都是「请给我一轮新的 offer」
    if (payload?.viewerId) void addViewer(payload.viewerId, true)
  }) as (...args: never[]) => void)

  socket.on('viewer-left', ((payload: { viewerId?: string }) => {
    if (payload?.viewerId) dropPeer(payload.viewerId)
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
    if (sdp) void p.pc.setRemoteDescription(new RTCSessionDescription(sdp)).catch(() => {})
    // 远端描述还没到就先丢掉这颗候选：对方会重发，比排队简单也不会卡住
    else if (candidate && p.pc.remoteDescription) void p.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {})
  }) as (...args: never[]) => void)

  socket.on('disconnect', (() => {
    // 信令断了，画面不一定断（WebRTC 是点对点的）。socket.io 会自己重连，连上再 resume
    if (!stopped) options.onState?.('reconnecting')
  }) as (...args: never[]) => void)

  // connectLive 已经消费掉首连的 connect，这里只会在**重连**时触发
  socket.on('connect', (() => {
    if (!stopped && roomId) void resume()
  }) as (...args: never[]) => void)

  try {
    await goLive()
  } catch (e) {
    stopped = true
    teardown()
    throw e
  }

  options.onState?.('live')

  statsTimer = window.setInterval(() => void statsTick(), STATS_INTERVAL_MS)
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
    stop() {
      if (stopped) return
      stopped = true
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
