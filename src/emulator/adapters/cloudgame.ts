/**
 * cloud-game 运行时：远程联机（游戏跑在服务器上，画面走 WebRTC 推回浏览器）。
 *
 * 与其它引擎最大的不同：游戏不在浏览器里运行，而是在部署了
 * https://github.com/giongto35/cloud-game 的服务器上由 libretro 核心运行，
 * 服务器把画面 / 声音编码后经 WebRTC 推回来，浏览器把手柄输入经 DataChannel 发过去。
 * 同一个房间里的所有人看的是同一路流，各自控制自己的手柄位 —— 这就是「远程联机」。
 *
 * 协议（对照 cloud-game 的 web/js/api.js）：
 *   1. WebSocket 连 coordinator：/ws?room_id=<房间>&zone=<区域>
 *   2. 收到 INIT(4)：拿到 ICE 服务器列表 → 建 RTCPeerConnection，发 offer（INIT_WEBRTC_STREAM 100）
 *   3. WEBRTC_SIGNAL(101) 往返 sdp / ice
 *   4. PeerConnection 连通后发 GAME_START(104)：{ game_name, room_id, player_index }
 *   5. 服务器回 GAME_START：{ roomId } —— 房间 id，分享给朋友就能加入
 *   6. 手柄状态打包成 10 字节（[按键位图, 左摇杆X, 左摇杆Y, 右摇杆X, 右摇杆Y]）走名为 "data" 的 DataChannel
 *
 * ROM 约定：cloud-game 只能跑它自己文件系统里的游戏（library.basePath），
 * 不能上传本地文件。本站把 R2 里的 ROM 同步到服务器，文件名 = <slug>.<ext>，
 * 因此 GAME_START 的 game_name 就是游戏 slug。见 deploy/cloudgame/README.md。
 *
 * 启用：.env 里设 VITE_CLOUDGAME_URL=https://cg.example.com（或 http://localhost:8000）。
 * 没配置时 available() 返回 false，界面上不会出现联机入口。
 */
import type { PlatformId } from '@/types'
import type { MountOptions, Runtime } from '../types'
import { getT, fmt } from '@/services/i18n'

export const CLOUDGAME_URL: string = (import.meta.env.VITE_CLOUDGAME_URL || '').replace(/\/+$/, '')
export const CLOUDGAME_ZONE: string = import.meta.env.VITE_CLOUDGAME_ZONE || ''

/** 从连上服务器到真正开始游戏的总超时。超过就报错，而不是让转圈一直转下去 */
const HANDSHAKE_TIMEOUT_MS = 30_000

/**
 * 本站平台 → 服务器 libretro 核心。
 * 键必须和 deploy/cloudgame/config.yaml 里 emulator.libretro.cores.list 的配置一致；
 * 不在这里的平台（Flash / J2ME / NDS / WonderSwan）不能联机。
 */
export const CLOUD_PLATFORM_CORES: Partial<Record<PlatformId, string>> = {
  nes: 'nestopia',
  snes: 'snes9x',
  gba: 'mgba',
  gb: 'mgba',
  n64: 'mupen64plus_next',
  psx: 'pcsx_rearmed',
  arcade: 'fbneo',
  dos: 'dosbox_pure',
  segaMD: 'genesis_plus_gx',
}

/** 联机会话参数（MountOptions.cloud） */
export interface CloudSession {
  /** 服务器游戏库里的名字（= ROM 文件名去掉后缀；本站约定为游戏 slug） */
  gameId: string
  /** 加入已有房间时传房间 id；创建新房间留空 */
  roomId?: string
  /** 想要的手柄位，0 = 1P。服务器可能改判，以 onPlayerIndex 为准 */
  playerIndex: number
  /** 房间就绪（创建 / 加入成功）时回调，带服务器分配的房间 id */
  onRoom?: (roomId: string) => void
  /** 服务器确认 / 改判手柄位时回调 */
  onPlayerIndex?: (index: number) => void
  /** 连接状态变化（用于界面提示） */
  onState?: (state: CloudState) => void
}

export type CloudState = 'connecting' | 'negotiating' | 'starting' | 'playing' | 'disconnected' | 'no-slots'

/* ---------------- 协议常量（见 cloud-game web/js/api.js） ---------------- */
const EP = {
  LATENCY_CHECK: 3,
  INIT: 4,
  INIT_WEBRTC_STREAM: 100,
  WEBRTC_SIGNAL: 101,
  GAME_START: 104,
  GAME_QUIT: 105,
  GAME_SAVE: 106,
  GAME_LOAD: 107,
  GAME_SET_PLAYER_INDEX: 108,
  GAME_ERROR_NO_FREE_SLOTS: 112,
  GAME_RESET: 113,
} as const

interface Packet {
  t: number
  id?: string
  p?: unknown
}

interface InitPayload {
  wid?: string
  ice?: Array<{ urls: string; username?: string; credential?: string }>
}

/**
 * libretro RETRO_DEVICE_ID_JOYPAD_* 顺序，位图第 n 位对应第 n 个按键。
 * 顺序必须与 cloud-game web/js/input/keys.js 的 JOYPAD_KEYS 一致。
 */
const JOYPAD = ['b', 'y', 'select', 'start', 'up', 'down', 'left', 'right', 'a', 'x', 'l', 'r', 'l2', 'r2', 'l3', 'r3'] as const
type PadKey = (typeof JOYPAD)[number]
const BIT: Record<PadKey, number> = Object.fromEntries(JOYPAD.map((k, i) => [k, 1 << i])) as Record<PadKey, number>

/** 键盘映射：与本站 EmulatorJS 的默认键位保持一致（见 src/lib/emulator.ts 的 defaultKeymap） */
const KEYMAP: Record<string, PadKey> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  KeyZ: 'a',
  KeyX: 'b',
  KeyA: 'x',
  KeyS: 'y',
  KeyQ: 'l',
  KeyE: 'r',
  Enter: 'start',
  KeyV: 'select',
  ShiftLeft: 'select',
  Digit1: 'l2',
  Digit2: 'r2',
}

/** 浏览器 Gamepad API 标准布局（standard mapping）的按钮序号 → RetroPad */
const GAMEPAD_BUTTONS: Array<PadKey | null> = [
  'b', // 0 南（Xbox A）
  'a', // 1 东（Xbox B）
  'y', // 2 西（Xbox X）
  'x', // 3 北（Xbox Y）
  'l', // 4
  'r', // 5
  'l2', // 6
  'r2', // 7
  'select', // 8
  'start', // 9
  'l3', // 10
  'r3', // 11
  'up', // 12
  'down', // 13
  'left', // 14
  'right', // 15
]

/** 焦点在输入框里时不要抢键盘 */
function isEditable(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable === true
}

function wsUrl(roomId: string | undefined): string {
  const base = CLOUDGAME_URL.replace(/^http/, 'ws')
  const url = new URL(`${base}/ws`)
  if (roomId) url.searchParams.set('room_id', roomId)
  if (CLOUDGAME_ZONE) url.searchParams.set('zone', CLOUDGAME_ZONE)
  return url.toString()
}

function mount(container: HTMLElement, options: MountOptions): () => void {
  const rt = getT().runtime
  const cloud = options.cloud

  if (!CLOUDGAME_URL) {
    options.onError?.(rt.cloudNotConfigured)
    return () => {}
  }
  if (!cloud) {
    options.onError?.(rt.cloudNoSession)
    return () => {}
  }

  let destroyed = false
  let ws: WebSocket | null = null
  let pc: RTCPeerConnection | null = null
  let dataChannel: RTCDataChannel | null = null
  /** GAME_START 已发出（用于去重），不代表服务器已接受 */
  let startSent = false
  /** 服务器已确认开始，游戏真正跑起来了 */
  let playing = false
  /** 服务器分配的房间 id：退出、存档等消息都要带它，不能用请求里的空值 */
  let assignedRoomId = cloud.roomId ?? ''
  const stream = new MediaStream()
  const pendingIce: RTCIceCandidateInit[] = []

  const setState = (s: CloudState) => {
    if (!destroyed) cloud.onState?.(s)
  }
  const fail = (msg: string) => {
    window.clearTimeout(watchdog)
    if (!destroyed) options.onError?.(msg)
  }

  // 握手看门狗：连不上 / 服务器不回应时给出明确错误，而不是永远转圈
  const watchdog = window.setTimeout(() => {
    if (!destroyed && !playing) {
      setState('disconnected')
      fail(rt.cloudTimeout)
    }
  }, HANDSHAKE_TIMEOUT_MS)

  /* ---------------- 画面 ---------------- */
  const host = document.createElement('div')
  host.tabIndex = 0
  host.style.cssText = 'position:relative;width:100%;height:100%;background:#000;outline:none;display:flex;align-items:center;justify-content:center'
  const video = document.createElement('video')
  video.autoplay = true
  video.playsInline = true
  video.muted = false
  video.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;image-rendering:pixelated'
  video.srcObject = stream
  host.appendChild(video)
  container.appendChild(host)

  /* ---------------- 信令 ---------------- */
  const send = (t: number, p?: unknown) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t, ...(p !== undefined ? { p } : {}) }))
  }

  const startGame = () => {
    if (startSent || destroyed) return
    startSent = true
    setState('starting')
    send(EP.GAME_START, {
      game_name: cloud.gameId,
      room_id: cloud.roomId ?? '',
      player_index: cloud.playerIndex,
    })
  }

  const setupPeer = (init: InitPayload | undefined) => {
    // 重复的 INIT 不能再建一条连接，否则上一条会泄漏（销毁函数只关得掉最后一条）
    if (pc || destroyed) return
    setState('negotiating')
    const iceServers = (init?.ice ?? []).map((s) => ({
      urls: s.urls,
      ...(s.username ? { username: s.username } : {}),
      ...(s.credential ? { credential: s.credential } : {}),
    }))
    pc = new RTCPeerConnection({ iceServers })

    // 输入通道：双方约定 id=0、不重传（丢一帧输入无所谓，低延迟更重要）
    dataChannel = pc.createDataChannel('data', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 })
    dataChannel.binaryType = 'arraybuffer'
    // 服务器也可能把控制消息从这条通道推过来
    dataChannel.onmessage = (ev) => {
      let packet: Packet | null = null
      try {
        const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer)
        packet = JSON.parse(text) as Packet
      } catch {
        return // 非 JSON 数据忽略
      }
      handlePacket(packet)
    }

    pc.addTransceiver('video', { direction: 'recvonly' })
    pc.addTransceiver('audio', { direction: 'recvonly' })
    pc.ontrack = (ev) => {
      stream.addTrack(ev.track)
      void video.play().catch(() => {
        /* 自动播放被拦时用户点一下画面即可 */
      })
    }
    pc.onicecandidate = (ev) => {
      if (ev.candidate) send(EP.WEBRTC_SIGNAL, { ice: JSON.stringify(ev.candidate) })
    }
    pc.onconnectionstatechange = () => {
      if (!pc || destroyed) return
      if (pc.connectionState === 'connected') startGame()
      else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        setState('disconnected')
        fail(rt.cloudDisconnected)
      }
    }
    pc.onsignalingstatechange = () => {
      if (pc?.signalingState === 'stable') flushIce()
    }

    void (async () => {
      try {
        const offer = await pc.createOffer()
        // Chrome：强制 Opus 立体声（与官方客户端一致）
        offer.sdp = offer.sdp?.replace(/(a=fmtp:111 .*)/g, '$1;stereo=1')
        await pc.setLocalDescription(offer)
        send(EP.INIT_WEBRTC_STREAM, { initiator: true, sdp: JSON.stringify(offer) })
      } catch (e) {
        fail(fmt(rt.cloudWebrtcFailed, { msg: e instanceof Error ? e.message : String(e) }))
      }
    })()
  }

  const flushIce = () => {
    if (!pc || !pc.remoteDescription) return
    while (pendingIce.length) {
      const c = pendingIce.shift()!
      void pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})
    }
  }

  const onPacket = (m: Packet) => {
    if (destroyed) return
    switch (m.t) {
      case EP.INIT:
        setupPeer(m.p as InitPayload | undefined)
        break
      case EP.WEBRTC_SIGNAL: {
        const p = (m.p ?? {}) as { ice?: string; sdp?: string }
        if (p.sdp && pc) {
          void pc
            .setRemoteDescription(new RTCSessionDescription(JSON.parse(p.sdp)))
            .then(flushIce)
            .catch((e: unknown) => {
              fail(fmt(rt.cloudWebrtcFailed, { msg: e instanceof Error ? e.message : String(e) }))
            })
        } else if (p.ice) {
          const cand = JSON.parse(p.ice) as RTCIceCandidateInit
          if (pc?.remoteDescription && pc.signalingState === 'stable') void pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {})
          else pendingIce.push(cand)
        }
        break
      }
      case EP.GAME_START: {
        const p = (m.p ?? {}) as { roomId?: string }
        // 服务器确认开始，此时才算真的在玩
        playing = true
        window.clearTimeout(watchdog)
        if (p.roomId) {
          assignedRoomId = p.roomId
          cloud.onRoom?.(p.roomId)
        }
        setState('playing')
        options.onReady?.()
        options.onStart?.()
        startInput()
        host.focus({ preventScroll: true })
        break
      }
      case EP.GAME_SET_PLAYER_INDEX: {
        // 服务器可能改判手柄位，界面上要显示真实的那个
        const idx = Number(m.p)
        if (!Number.isNaN(idx)) cloud.onPlayerIndex?.(idx)
        break
      }
      case EP.GAME_ERROR_NO_FREE_SLOTS:
        // 服务器拒绝了，这局根本没开始
        startSent = false
        setState('no-slots')
        fail(rt.cloudNoSlots)
        break
      case EP.LATENCY_CHECK: {
        // coordinator 让我们测几个 worker 的延迟：这里不做真实测量，全部回 0 让它随便选
        const list = (m.p as string[] | undefined) ?? []
        const res: Record<string, number> = {}
        for (const addr of list) res[addr] = 0
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: EP.LATENCY_CHECK, id: m.id, p: res }))
        break
      }
      default:
        break
    }
  }

  /** 包处理里出的异常要变成可见的错误，不能静默吞掉让界面一直转圈 */
  const handlePacket = (m: Packet) => {
    try {
      onPacket(m)
    } catch (e) {
      fail(fmt(rt.cloudProtocolError, { msg: e instanceof Error ? e.message : String(e) }))
    }
  }

  setState('connecting')
  try {
    ws = new WebSocket(wsUrl(cloud.roomId))
  } catch (e) {
    fail(fmt(rt.cloudConnectFailed, { msg: e instanceof Error ? e.message : String(e) }))
    return () => {
      destroyed = true
      window.clearTimeout(watchdog)
      host.remove()
    }
  }
  ws.onmessage = (ev) => {
    let packet: Packet | null = null
    try {
      packet = JSON.parse(ev.data as string) as Packet
    } catch {
      return
    }
    handlePacket(packet)
  }
  ws.onerror = () => {
    if (!playing) fail(fmt(rt.cloudConnectFailed, { msg: CLOUDGAME_URL }))
  }
  ws.onclose = () => {
    if (destroyed) return
    // 开局前断 = 连不上；开局后断 = 信令掉线，游戏也维持不下去了
    setState('disconnected')
    fail(playing ? rt.cloudDisconnected : fmt(rt.cloudConnectFailed, { msg: CLOUDGAME_URL }))
  }

  /* ---------------- 输入 ---------------- */
  const state = new Int16Array(5) // [buttons, lx, ly, rx, ry]
  let keyboardBits = 0
  let lastSent = ''
  let raf = 0

  const sendPad = () => {
    if (dataChannel?.readyState !== 'open') return
    const sig = state.join(',')
    if (sig === lastSent) return
    lastSent = sig
    dataChannel.send(new Uint16Array(state.buffer))
  }

  const pollGamepad = () => {
    let bits = keyboardBits
    let lx = 0
    let ly = 0
    let rx = 0
    let ry = 0
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : []
    for (const gp of pads) {
      if (!gp) continue
      gp.buttons.forEach((b, i) => {
        const key = GAMEPAD_BUTTONS[i]
        if (key && (b.pressed || b.value > 0.5)) bits |= BIT[key]
      })
      const ax = (i: number) => {
        const v = gp.axes[i] ?? 0
        return Math.abs(v) < 0.15 ? 0 : Math.trunc(Math.max(-1, Math.min(1, v)) * 32767)
      }
      lx ||= ax(0)
      ly ||= ax(1)
      rx ||= ax(2)
      ry ||= ax(3)
      // 左摇杆也当十字键用
      if (lx < -16000) bits |= BIT.left
      if (lx > 16000) bits |= BIT.right
      if (ly < -16000) bits |= BIT.up
      if (ly > 16000) bits |= BIT.down
      break // 只取第一只手柄
    }
    state[0] = bits
    state[1] = lx
    state[2] = ly
    state[3] = rx
    state[4] = ry
    sendPad()
    raf = requestAnimationFrame(pollGamepad)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const key = KEYMAP[e.code]
    if (!key) return
    const active = document.activeElement
    // 在输入框里打字时不要抢键盘
    if (isEditable(active)) return
    // 焦点在页面上别的按钮 / 链接上时，Enter 留给它，别把「回车激活」吞掉
    if (e.code === 'Enter' && active && active !== document.body && !host.contains(active)) return
    e.preventDefault()
    if (e.repeat) return
    keyboardBits |= BIT[key]
  }

  /**
   * 松开永远要处理，且不能带任何焦点条件 ——
   * 否则「按住方向键时焦点跑到别处」会让这个键永远卡在按下状态。
   */
  const onKeyUp = (e: KeyboardEvent) => {
    const key = KEYMAP[e.code]
    if (!key) return
    keyboardBits &= ~BIT[key]
  }

  /** 切到别的窗口 / 标签页时把所有键松开，避免回来时角色还在跑 */
  const releaseAll = () => {
    keyboardBits = 0
  }
  const onVisibility = () => {
    if (document.hidden) releaseAll()
  }
  const onClick = () => {
    host.focus({ preventScroll: true })
    void video.play().catch(() => {})
  }

  let inputStarted = false
  const startInput = () => {
    if (inputStarted || destroyed) return
    inputStarted = true
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', releaseAll)
    document.addEventListener('visibilitychange', onVisibility)
    host.addEventListener('click', onClick)
    raf = requestAnimationFrame(pollGamepad)
  }

  /* ---------------- 销毁 ---------------- */
  return () => {
    destroyed = true
    window.clearTimeout(watchdog)
    cancelAnimationFrame(raf)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('blur', releaseAll)
    document.removeEventListener('visibilitychange', onVisibility)
    host.removeEventListener('click', onClick)
    try {
      // 只有真的开局了才需要告诉服务器退出，且必须带服务器分配的房间 id
      if (playing && assignedRoomId) send(EP.GAME_QUIT, { room_id: assignedRoomId })
    } catch {
      /* ignore */
    }
    try {
      dataChannel?.close()
      pc?.close()
    } catch {
      /* ignore */
    }
    try {
      // 先摘掉回调再关，避免 close 触发 onclose 里的 fail
      if (ws) {
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
        ws.close()
      }
    } catch {
      /* ignore */
    }
    for (const track of stream.getTracks()) {
      track.stop()
      stream.removeTrack(track)
    }
    video.srcObject = null
    host.remove()
  }
}

export const cloudGameRuntime: Runtime = {
  id: 'cloudgame',
  name: 'Cloud',
  get description() {
    return getT().runtime.cloudDesc
  },
  // 不参与「按扩展名选引擎」：联机是用户显式选择的模式，不是文件格式决定的
  extensions: [],
  priority: 0,
  available: () => Boolean(CLOUDGAME_URL),
  supports: (platform) => Boolean(CLOUD_PLATFORM_CORES[platform]),
  engineLabel: (platform) => CLOUD_PLATFORM_CORES[platform] ?? '—',
  mount,
}

/** 该平台能否联机（引擎可用且平台有对应核心） */
export function cloudPlayable(platform: PlatformId): boolean {
  return cloudGameRuntime.available() && cloudGameRuntime.supports(platform)
}
