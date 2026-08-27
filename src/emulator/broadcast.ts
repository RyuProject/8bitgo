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
 */
import type { CaptureSources } from './types'
import { connectLive, liveIceServers, type LiveSocket } from '@/services/live'

/** 单路视频码率上限。GBA 才 240×160，给到 1.5Mbps 已经很宽裕 */
const MAX_BITRATE = Number(import.meta.env.VITE_LIVE_MAX_BITRATE) || 1_500_000
const MAX_FPS = 60

export type BroadcastState = 'connecting' | 'live' | 'ended' | 'error'

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
  onState?: (state: BroadcastState) => void
  onViewers?: (count: number) => void
  onError?: (message: string) => void
}

export interface Broadcast {
  readonly roomId: string
  viewers: () => number
  stop: () => void
}

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
function tuneSender(sender: RTCRtpSender) {
  try {
    const params = sender.getParameters()
    if (!params.encodings?.length) params.encodings = [{}]
    for (const e of params.encodings) {
      e.maxBitrate = MAX_BITRATE
      e.maxFramerate = MAX_FPS
    }
    ;(params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = 'maintain-framerate'
    void sender.setParameters(params)
  } catch {
    /* 浏览器不支持就按默认来 */
  }
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
  /** 每个观众一条连接 */
  const peers = new Map<string, RTCPeerConnection>()
  let viewers = 0
  let stopped = false

  const dropPeer = (viewerId: string) => {
    const pc = peers.get(viewerId)
    if (!pc) return
    peers.delete(viewerId)
    try {
      pc.close()
    } catch {
      /* ignore */
    }
  }

  const addViewer = async (viewerId: string) => {
    if (stopped || peers.has(viewerId)) return
    const pc = new RTCPeerConnection({ iceServers })
    peers.set(viewerId, pc)

    for (const track of built.stream.getTracks()) {
      const sender = pc.addTrack(track, built.stream)
      if (track.kind === 'video') tuneSender(sender)
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) socket.emit('signal', { target: viewerId, data: { candidate: ev.candidate.toJSON() } })
    }
    pc.onconnectionstatechange = () => {
      // 观众那边断了就把连接收掉，别留着白占上行
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') dropPeer(viewerId)
    }

    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      socket.emit('signal', { target: viewerId, data: { sdp: pc.localDescription } })
    } catch (e) {
      dropPeer(viewerId)
      options.onError?.(e instanceof Error ? e.message : String(e))
    }
  }

  socket.on('viewer-joined', ((payload: { viewerId?: string }) => {
    if (payload?.viewerId) void addViewer(payload.viewerId)
  }) as (...args: never[]) => void)

  socket.on('viewer-left', ((payload: { viewerId?: string }) => {
    if (payload?.viewerId) dropPeer(payload.viewerId)
  }) as (...args: never[]) => void)

  socket.on('viewers', ((payload: { count?: number }) => {
    viewers = payload?.count ?? 0
    options.onViewers?.(viewers)
  }) as (...args: never[]) => void)

  socket.on('signal', ((payload: { from?: string; data?: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } }) => {
    const pc = payload?.from ? peers.get(payload.from) : null
    if (!pc || !payload?.data) return
    const { sdp, candidate } = payload.data
    if (sdp) void pc.setRemoteDescription(new RTCSessionDescription(sdp)).catch(() => {})
    // 远端描述还没到就先丢掉这颗候选：对方会重发，比排队简单也不会卡住
    else if (candidate && pc.remoteDescription) void pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {})
  }) as (...args: never[]) => void)

  socket.on('disconnect', (() => {
    if (!stopped) options.onState?.('ended')
  }) as (...args: never[]) => void)

  const room = await new Promise<{ roomId: string }>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('go-live timeout')), 10_000)
    socket.emit(
      'go-live',
      {
        title: options.meta.title,
        gameSlug: options.meta.gameSlug,
        gameName: options.meta.gameName,
        platform: options.meta.platform,
        hostName: options.meta.hostName,
      },
      (err: string | null, data: { roomId: string }) => {
        window.clearTimeout(timer)
        if (err) reject(new Error(err))
        else resolve(data)
      },
    )
  }).catch((e) => {
    stopped = true
    built.release()
    socket.close()
    throw e
  })

  options.onState?.('live')

  return {
    roomId: room.roomId,
    viewers: () => viewers,
    stop() {
      if (stopped) return
      stopped = true
      try {
        socket.emit('stop-live')
      } catch {
        /* ignore */
      }
      for (const id of Array.from(peers.keys())) dropPeer(id)
      built.release()
      socket.close()
      options.onState?.('ended')
    },
  }
}
