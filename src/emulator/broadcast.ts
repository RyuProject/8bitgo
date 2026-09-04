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

/** 单路视频码率上限。GBA 才 240×160，给到 1.5Mbps 已经很宽裕 */
const MAX_BITRATE = Number(import.meta.env.VITE_LIVE_MAX_BITRATE) || 1_500_000
const MAX_FPS = 60

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

/** 限码率、保帧率：游戏画面宁可糊一点也不要卡 */
function tuneSender(sender: RTCRtpSender, maxBitrate = MAX_BITRATE) {
  try {
    const params = sender.getParameters()
    if (!params.encodings?.length) params.encodings = [{}]
    for (const e of params.encodings) {
      e.maxBitrate = maxBitrate
      e.maxFramerate = MAX_FPS
    }
    ;(params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = 'maintain-framerate'
    void sender.setParameters(params)
  } catch {
    /* 浏览器不支持就按默认来 */
  }
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
  const built = buildStream(options.sources, options.fps ?? 30)
  if (!built) throw new Error('no capture source')

  options.onState?.('connecting')

  let socket: LiveSocket
  try {
    socket = await connectLive()
  } catch (e) {
    built.release()
    throw e
  }

  const iceServers = await liveIceServers()
  /** 每个观众一条连接。gen 是这条连接的代号，随 SDP / ICE 一起发，观众据此认出「新一轮」 */
  const peers = new Map<string, { pc: RTCPeerConnection; gen: number }>()
  let genCounter = 0
  let viewers = 0
  let stopped = false
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
    const gen = ++genCounter
    const pc = new RTCPeerConnection({ iceServers })
    peers.set(viewerId, { pc, gen })

    for (const track of built.stream.getTracks()) {
      const sender = pc.addTrack(track, built.stream)
      if (track.kind === 'video') tuneSender(sender, options.maxBitrate)
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
      dropPeer(viewerId)
      options.onError?.(e instanceof Error ? e.message : String(e))
    }
  }

  const teardown = () => {
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
