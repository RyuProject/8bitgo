/**
 * 观众侧：只看不玩。
 *
 * 主播那边把画布和声音经 WebRTC 直推过来（见 emulator/broadcast.ts），
 * 这里就是收下来塞进一个 <video>。没有模拟器在跑，所以既不能暂停也没有存档 ——
 * 但音量、截图、录像都还在（都是对着这条流做的）。
 *
 * 和 cloudgame 的区别：cloudgame 的画面来自服务器上跑的游戏（要花钱），
 * 这里的画面来自另一个玩家的浏览器（零服务器成本，只借道信令）。
 */
import type { Capability, CaptureSources, MountOptions, Runtime, RuntimeHandle } from '../types'
import { getT, fmt } from '@/services/i18n'
import { connectLive, liveEnabled, liveIceServers, type LiveSocket } from '@/services/live'

export type LiveViewState = 'connecting' | 'watching' | 'ended' | 'error'

export interface LiveSession {
  /** 要观看的直播间 */
  roomId: string
  onState?: (state: LiveViewState) => void
  onViewers?: (count: number) => void
  onInfo?: (info: { title: string; hostName: string; gameName: string }) => void
}

/** 握手超时：连不上要给明确提示，而不是永远转圈 */
const HANDSHAKE_TIMEOUT_MS = 25_000

function deadHandle(): RuntimeHandle {
  return { destroy: () => {}, caps: new Set<Capability>() }
}

function mount(container: HTMLElement, options: MountOptions): RuntimeHandle {
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
  let watching = false
  /** 远端描述到之前收到的候选先攒着，否则 addIceCandidate 会报错 */
  const pendingIce: RTCIceCandidateInit[] = []
  const stream = new MediaStream()

  const host = document.createElement('div')
  host.style.cssText = 'position:relative;width:100%;height:100%;background:#000;display:flex;align-items:center;justify-content:center'
  const video = document.createElement('video')
  video.autoplay = true
  video.playsInline = true
  // 不静音，但浏览器可能拦下自动播放；下面点一下画面会重试
  video.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;image-rendering:pixelated'
  video.srcObject = stream
  host.appendChild(video)
  container.appendChild(host)

  const onClick = () => void video.play().catch(() => {})
  host.addEventListener('click', onClick)

  const watchdog = window.setTimeout(() => {
    if (!destroyed && !watching) {
      live.onState?.('error')
      options.onError?.(rt.liveTimeout)
    }
  }, HANDSHAKE_TIMEOUT_MS)

  const caps = new Set<Capability>(['volume', 'screenshot', 'record'])

  void (async () => {
    try {
      live.onState?.('connecting')
      socket = await connectLive()
      if (destroyed) return socket.close()
      const iceServers = await liveIceServers()
      if (destroyed) return socket.close()

      pc = new RTCPeerConnection({ iceServers })
      pc.ontrack = (ev) => {
        for (const track of ev.streams[0]?.getTracks() ?? [ev.track]) {
          if (!stream.getTracks().includes(track)) stream.addTrack(track)
        }
        void video.play().catch(() => {})
      }
      pc.onconnectionstatechange = () => {
        if (destroyed || !pc) return
        if (pc.connectionState === 'connected') {
          window.clearTimeout(watchdog)
          watching = true
          live.onState?.('watching')
          options.onStart?.()
        } else if (pc.connectionState === 'failed') {
          live.onState?.('error')
          options.onError?.(rt.liveLost)
        }
      }

      const info = await new Promise<{ hostId: string; title: string; hostName: string; gameName: string; viewers: number }>(
        (resolve, reject) => {
          const timer = window.setTimeout(() => reject(new Error('watch timeout')), 10_000)
          socket?.emit('watch', { roomId: live.roomId }, (err: string | null, data: never) => {
            window.clearTimeout(timer)
            if (err) reject(new Error(err))
            else resolve(data)
          })
        },
      )
      if (destroyed) return
      live.onInfo?.({ title: info.title, hostName: info.hostName, gameName: info.gameName })
      live.onViewers?.(info.viewers)
      // 主播那边收到 viewer-joined 后会主动发 offer 过来，这里等着就行
      options.onReady?.()

      const hostId = info.hostId
      socket.on('signal', ((payload: { from?: string; data?: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } }) => {
        if (destroyed || !pc || payload?.from !== hostId || !payload.data) return
        const { sdp, candidate } = payload.data
        if (sdp) {
          void (async () => {
            if (!pc) return
            await pc.setRemoteDescription(new RTCSessionDescription(sdp))
            for (const c of pendingIce.splice(0)) await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            socket?.emit('signal', { target: hostId, data: { sdp: pc.localDescription } })
          })().catch((e) => {
            if (!destroyed) options.onError?.(fmt(rt.liveFailed, { msg: e instanceof Error ? e.message : String(e) }))
          })
        } else if (candidate) {
          if (pc.remoteDescription) void pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {})
          else pendingIce.push(candidate)
        }
      }) as (...args: never[]) => void)

      pc.onicecandidate = (ev) => {
        if (ev.candidate) socket?.emit('signal', { target: hostId, data: { candidate: ev.candidate.toJSON() } })
      }

      socket.on('viewers', ((p: { count?: number }) => live.onViewers?.(p?.count ?? 0)) as (...args: never[]) => void)
      socket.on('live-ended', (() => {
        if (destroyed) return
        live.onState?.('ended')
        options.onError?.(rt.liveEnded)
      }) as (...args: never[]) => void)

      options.onCaps?.(caps)
    } catch (e) {
      if (destroyed) return
      window.clearTimeout(watchdog)
      live.onState?.('error')
      const msg = e instanceof Error ? e.message : String(e)
      options.onError?.(msg === 'not found' ? rt.liveGone : msg === 'full' ? rt.liveFull : fmt(rt.liveFailed, { msg }))
    }
  })()

  options.onCaps?.(caps)

  return {
    caps,
    volume: 1,
    setVolume(next: number) {
      const v = Math.max(0, Math.min(1, next))
      video.volume = v
      video.muted = v === 0
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
      window.clearTimeout(watchdog)
      host.removeEventListener('click', onClick)
      try {
        pc?.close()
      } catch {
        /* ignore */
      }
      pc = null
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

export const liveViewRuntime: Runtime = {
  id: 'liveview',
  name: 'Live',
  get description() {
    return getT().runtime.liveDesc
  },
  // 不参与「按扩展名选引擎」：看直播是用户点进来的，不是文件格式决定的
  extensions: [],
  priority: 0,
  available: () => liveEnabled(),
  supports: () => true,
  engineLabel: () => 'WebRTC',
  mount,
}
