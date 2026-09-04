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
 *   自己的信令 socket 断了   → socket.io 自动重连，连上后重新 watch（服务器会让主播再发一轮 offer）。
 *                             画面多半没断（WebRTC 是点对点的），中间只是标记变一下。
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
import type { Capability, CaptureSources, MountOptions, Runtime, RuntimeHandle } from '../types'
import { getT, fmt } from '@/services/i18n'
import { connectLive, liveEnabled, liveIceServers, type LiveSocket } from '@/services/live'

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
}

type SignalData = { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit; gen?: number }
type WatchAck = {
  hostId: string | null
  hostAway?: boolean
  title: string
  hostName: string
  gameName: string
  viewers: number
  /** 配对的联机房号。中途进来的观众靠它，不用等 netplay-linked 那一下 */
  netplayRoomId?: string | null
}

/** 首次握手超时：连不上要给明确提示，而不是永远转圈 */
const HANDSHAKE_TIMEOUT_MS = 25_000
/** 重新 watch 之后等 offer 的时间；到点还没通就再要一次，要过几次都没用才算断 */
const REWATCH_TIMEOUT_MS = 20_000
const REWATCH_MAX = 3

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
  /** 服务器已经不认这个房间了，但画面还在流；画面一断就是真的结束 */
  let orphan = false
  let watching = false
  let rewatchTimer = 0
  let rewatchCount = 0
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

  const watchdog = window.setTimeout(() => {
    if (!destroyed && !watching) {
      live.onState?.('error')
      options.onError?.(rt.liveTimeout)
    }
  }, HANDSHAKE_TIMEOUT_MS)

  const caps = new Set<Capability>(['volume', 'screenshot', 'record'])

  const fail = (msg: string) => {
    if (destroyed) return
    window.clearTimeout(watchdog)
    window.clearTimeout(rewatchTimer)
    live.onState?.('error')
    options.onError?.(msg)
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
  const freshPc = (iceServers: RTCIceServer[], gen: number | undefined) => {
    closePc()
    pcGen = gen
    pcOffered = false
    pendingIce = []
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
    }
    next.onconnectionstatechange = () => {
      if (destroyed || pc !== next) return
      const s = next.connectionState
      if (s === 'connected') {
        window.clearTimeout(watchdog)
        window.clearTimeout(rewatchTimer)
        rewatchCount = 0
        watching = true
        live.onState?.('watching')
        options.onStart?.()
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
      // 用 pcGen 而不是参数 gen：首连时这条 pc 是空着等 offer 建的，代号要等 offer 到了才知道
      if (ev.candidate && socket?.connected && hostId && pc === next) {
        socket.emit('signal', { target: hostId, data: { candidate: ev.candidate.toJSON(), gen: pcGen } satisfies SignalData })
      }
    }
    return next
  }

  /** 进房 / 重新进房。返回 false 表示这次没成功（错误已经处理） */
  const watch = async (): Promise<boolean> => {
    if (destroyed || !socket?.connected) return false
    const s = socket
    let info: WatchAck
    try {
      info = await new Promise<WatchAck>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('watch timeout')), 10_000)
        s.emit('watch', { roomId: live.roomId }, (err: string | null, data: WatchAck) => {
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
    if (!joined) {
      joined = true
      live.onInfo?.({ title: info.title, hostName: info.hostName, gameName: info.gameName })
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
  const armRewatch = () => {
    window.clearTimeout(rewatchTimer)
    rewatchTimer = window.setTimeout(() => {
      if (!destroyed && !hostAway && pc?.connectionState !== 'connected') void rewatch()
    }, REWATCH_TIMEOUT_MS)
  }

  /** 要一轮新 offer；等不到就再要，几次都没用才算断 */
  const rewatch = async () => {
    if (destroyed || !socket?.connected) return
    window.clearTimeout(rewatchTimer)
    if (rewatchCount >= REWATCH_MAX) return fail(rt.liveLost)
    rewatchCount += 1
    live.onState?.('reconnecting')
    const ok = await watch()
    if (!ok || destroyed || hostAway) return
    armRewatch()
  }

  void (async () => {
    try {
      live.onState?.('connecting')
      socket = await connectLive()
      if (destroyed) return socket.close()
      const iceServers = await liveIceServers()
      if (destroyed) return socket.close()
      const s = socket

      // 一条空连接先立着，等主播的第一个 offer；ICE 候选在 offer 之前到的话有地方攒
      freshPc(iceServers, undefined)

      s.on('signal', ((payload: { from?: string; data?: SignalData }) => {
        if (destroyed || !payload?.data) return
        // from 必须是当前主播；主播重连后 id 换了，host-back 会更新 hostId
        if (!hostId || payload.from !== hostId) return
        const { sdp, candidate, gen } = payload.data
        if (sdp) {
          if (sdp.type && sdp.type !== 'offer') return // 主播只发 offer
          // 新一轮：代号变了，或者这条连接已经吃过 offer。主播每轮都是新建的 PeerConnection
          const stale = !pc || pcOffered || (gen !== undefined && pcGen !== undefined && gen !== pcGen)
          const cur: RTCPeerConnection = stale ? freshPc(iceServers, gen) : (pc as RTCPeerConnection)
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

      s.on('viewers', ((p: { count?: number }) => live.onViewers?.(p?.count ?? 0)) as (...args: never[]) => void)
      /**
       * 主播刚把这一局开成了联机房（传 null 就是刚关掉）。
       * 已经在看的人就是靠这一下多出「加入联机」按钮的 —— 他们不会再去刷大厅。
       */
      s.on(
        'netplay-linked',
        ((p: { roomId?: string | null }) => live.onNetplay?.(p?.roomId || null)) as (...args: never[]) => void,
      )

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
        rewatchCount = 0
        void rewatch()
      }) as (...args: never[]) => void)

      await watch()
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
