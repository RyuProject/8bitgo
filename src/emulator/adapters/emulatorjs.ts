/**
 * EmulatorJS 运行时：主机 / 掌机 / 街机 / DOS，以及 **P2P 联机**。
 *
 * EmulatorJS 通过全局 window.EJS_* 读取配置，并在顶层声明 `class EmulatorJS`，
 * 不能在同一页面反复注入，因此放进独立的 srcdoc iframe 里运行：切换游戏直接销毁 iframe，
 * 画面、声音与 WebAssembly 内存随之释放；React StrictMode 二次挂载也不会重复实例化。
 *
 * 资源默认走官方 CDN；自托管时把发行包 data/ 放到 public/emulatorjs/ 并设置 VITE_EJS_PATH=/emulatorjs/
 *
 * ── 关于联机 ─────────────────────────────────────────────
 * EmulatorJS 4.3.0-pre 起自带 netplay（data/src/netplay.js）：房主的浏览器正常跑游戏，
 * 用 captureStream 把画面 / 声音经 WebRTC 直推给访客，访客的按键走 DataChannel 回来，
 * 房主调 simulateInput 注入到对应手柄位。**画面不经过我们的服务器**，只有握手信息经过信令。
 *
 * 需要三样东西：
 *   1. 全局的 io()  —— socket.io 客户端，EmulatorJS 自己不加载，得我们注入进 iframe
 *   2. EJS_netplayUrl —— 信令地址（server/src/netplay.js）
 *   3. EJS_gameId     —— 必须是数字，用来给房间分组（见 services/netplay.ts 的 gameIdFor）
 *
 * ⚠️ 官方 CDN 的 stable / nightly 目前都是 4.2.3，**不含 netplay**。
 *    要用联机必须自建 EmulatorJS 构建，见 docs 或 README。
 */
import { platformMap } from '@/data/platforms'
import type { Capability, CaptureSources, MountOptions, Runtime, RuntimeHandle } from '../types'
import { getT, fmt } from '@/services/i18n'
import { ICE_SERVERS, NETPLAY_URL, fetchIceConfig, socketIoScriptUrl, uploadState } from '@/services/netplay'

export const EJS_PATH: string = (() => {
  const p = import.meta.env.VITE_EJS_PATH || 'https://cdn.emulatorjs.org/stable/data/'
  return p.endsWith('/') ? p : `${p}/`
})()

/** 联机会话参数（MountOptions.netplay） */
export interface NetplaySession {
  /** 由游戏 slug 派生的数字 id，房间按它分组 */
  gameId: number
  /** 房间显示名 */
  roomName: string
  /** 我在房间里的名字 */
  playerName: string
  maxPlayers: number
  /** host = 开新房间；join = 加入 roomId 指定的房间 */
  mode: 'host' | 'join'
  /**
   * 以什么身份加入：
   *   player    占一个手柄位，能操作（默认）
   *   spectator 只看不操作 —— 这就是「直播观众」
   *
   * 观众这一侧我们会把 netplay 的输入转发函数换成空实现，
   * 所以他按键盘不会影响房主那边的游戏。手柄位的分配在服务端，见 server/src/netplay.js。
   */
  role?: 'player' | 'spectator'
  /**
   * 进房后把「切身份」的函数交给调用方，观众想上场时不用断线重连。
   * 传 true 掐断输入（观众），传 false 恢复（玩家）。
   */
  onSpectatorControl?: (setSpectator: (on: boolean) => void) => void
  roomId?: string
  password?: string
  /**
   * 接手别人的房间时用：先把这份存档载进模拟器再开房，游戏就能接着玩。
   * 房主迁移时由播放器从信令服务器取来（见 services/netplay.ts 的 downloadState）。
   */
  initialState?: Uint8Array
  /** 进入房间后回调，带房间 id（host 模式下是客户端生成的） */
  onRoom?: (roomId: string, isHost: boolean) => void
  /** netplay 内部给我们分配的身份 id —— 服务器就是用它来判断「谁该接手」 */
  onIdentity?: (playerId: string) => void
  /** 房间人数变化 */
  onPlayers?: (count: number) => void
  /** 房主离开（这局结束了） */
  onHostLeft?: () => void
  /** 服务端下发的房间令牌：上传存档、接手房主都要用它证明身份 */
  onToken?: (token: string) => void
  /**
   * WebRTC 连接状态（'connecting' | 'connected' | 'failed' | 'disconnected'）。
   * 用来在界面上区分「还在连」和「连不通」——以前连不通时界面上什么都不显示，
   * 玩家只看到一片黑，不知道是在加载还是已经失败了。
   */
  onLinkState?: (state: RTCPeerConnectionState) => void
  /** 没有 TURN 兜底时为 false，可据此提示「部分网络可能连不上」 */
  onIceReady?: (hasTurn: boolean) => void
}

/**
 * 视频发送参数。
 *
 * captureStream 出来的轨道，浏览器默认会为了保住分辨率而牺牲帧率
 * （degradationPreference 默认偏向 maintain-resolution）。老游戏本来就是
 * 256×240 这种分辨率，糊一点没人在意，卡顿却直接影响能不能玩 ——
 * 所以明确要求「优先保帧率」，并给一个够用的码率上限，避免把房主的上行占满
 * （上行一满，存档上传和按键回传都会跟着变卡）。
 */
const VIDEO_MAX_BITRATE = Number(import.meta.env.VITE_NETPLAY_MAX_BITRATE) || 2_500_000
const VIDEO_MAX_FPS = 60

/**
 * 房主每隔多久把存档传给信令服务器（掉线时交给新房主）。
 *
 * 从 25 秒降到 10 秒：接手的人是从这份存档接着玩的，间隔多长就意味着最多丢多少进度，
 * 25 秒足够打完一条命。之所以敢降，是因为下面加了「内容没变就不传」——
 * 暂停、看菜单、挂机时一个字节都不会发，真正上传的只有进度确实在推进的时候。
 */
const STATE_UPLOAD_MS = 10_000

const FRAME_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; height: 100%; background: #0b0b0f; overflow: hidden; }
  #game { width: 100%; height: 100%; }
</style>
</head>
<body><div id="game"></div></body>
</html>`

/** EmulatorJS 内部对象（只声明我们会用到的部分） */
interface EjsNetplay {
  name: string | null
  owner: boolean
  playerID?: string
  players: Record<string, unknown>
  openRoom: (roomName: string, maxPlayers: number, password: string) => void
  joinRoom: (roomId: string, roomName: string, maxPlayers: number, password: string | null) => void
  leaveRoom?: () => void
  /** 把访客的按键转发给房主；观众这一侧会被换成空实现 */
  simulateInput?: (player: number, index: number, value: number) => void
  socket?: { connected?: boolean } | null
}
interface EjsGameManager {
  getState: () => Uint8Array
  loadState: (state: Uint8Array) => void
  /** 新版本才有；没有就退回读画布 */
  screenshot?: () => Uint8Array
}
interface EjsEmulator {
  netplay?: EjsNetplay
  gameManager?: EjsGameManager
  isNetplay?: boolean
  /** 下面这些是给统一工具栏用的，各版本 EmulatorJS 不一定都有，调用前都要判空 */
  pause?: () => void
  play?: () => void
  paused?: boolean
  volume?: number
  setVolume?: (v: number) => void
  canvas?: HTMLCanvasElement
  elements?: { parent?: HTMLElement }
}

/** 我们塞进 iframe 的音频探针，见 installAudioTap */
interface EjsAudioTap {
  ctx: AudioContext | null
  node: GainNode | null
}

/**
 * 在 iframe 里装一个音频探针，供录像取声音用。
 *
 * EmulatorJS 的声音走 iframe 内部自己的 AudioContext，外面既拿不到节点也接不上
 * MediaRecorder。办法是趁 loader.js 还没跑，先把 AudioContext 换成一个子类
 * （记下第一个实例并建一个 GainNode），再劫持 AudioNode.prototype.connect：
 * 谁连到 ctx.destination，就顺手也连一份到我们的探针上。
 * 这样声音照常播放，我们只是多接了一路旁路。
 */
/**
 * 把 iframe 里引擎自己打出来的错误接出来。
 *
 * 为什么非要这一层：街机 ROM 出问题时，核心报的是「缺哪个文件、哪个 CRC 对不上」，
 * 这句话只出现在 iframe 内部的 console 里。外面只能看到「加载失败」四个字，
 * 而街机 romset 版本极其挑剔，看不到这句原文基本没法排查 ——
 * 这是街机比卡带机麻烦得多的地方。
 *
 * 只在**像致命错误**时才往上报（见 FATAL_HINTS）：核心启动时会打一堆无关紧要的
 * warning，全报上去等于没报。其余的都留在缓冲区里，由 engineLog() 取。
 */
const LOG_LIMIT = 60
/** 命中这些词才认为是「这局跑不起来了」，而不是普通噪音 */
const FATAL_HINTS = [
  'missing',
  'not found',
  'no such file',
  'romset',
  'crc',
  'failed to load',
  'error loading',
  'could not load',
  'bios',
]

function installErrorTap(
  win: Window & Record<string, unknown>,
  onFatal: (line: string) => void,
): { lines: string[] } {
  const lines: string[] = []
  const push = (level: string, text: string) => {
    const line = `[${level}] ${text}`.slice(0, 500)
    lines.push(line)
    if (lines.length > LOG_LIMIT) lines.shift()
    const low = text.toLowerCase()
    if (level !== 'log' && FATAL_HINTS.some((h) => low.includes(h))) onFatal(text.trim())
  }

  const c = win.console as Console | undefined
  for (const level of ['error', 'warn'] as const) {
    const native = c?.[level]
    if (typeof native !== 'function' || !c) continue
    c[level] = (...args: unknown[]) => {
      try {
        push(level, args.map((a) => (typeof a === 'string' ? a : safeStr(a))).join(' '))
      } catch {
        /* 记日志本身不能把游戏搞挂 */
      }
      native.apply(c, args as [])
    }
  }
  win.addEventListener('error', (e) => push('error', (e as ErrorEvent).message || 'script error'))
  win.addEventListener('unhandledrejection', (e) => {
    const r = (e as PromiseRejectionEvent).reason
    push('error', r instanceof Error ? r.message : safeStr(r))
  })
  return { lines }
}

function safeStr(v: unknown): string {
  if (v instanceof Error) return v.message
  try {
    return typeof v === 'object' ? JSON.stringify(v) : String(v)
  } catch {
    return String(v)
  }
}

function installAudioTap(win: Window & Record<string, unknown>): EjsAudioTap {
  const tap: EjsAudioTap = { ctx: null, node: null }
  const Native = (win.AudioContext || win.webkitAudioContext) as typeof AudioContext | undefined
  const NodeProto = (win as unknown as { AudioNode?: { prototype: AudioNode } }).AudioNode?.prototype
  if (typeof Native !== 'function' || !NodeProto) return tap

  class TappedAudioContext extends Native {
    constructor(...args: unknown[]) {
      super(...(args as [AudioContextOptions?]))
      if (!tap.ctx) {
        tap.ctx = this
        try {
          tap.node = this.createGain()
        } catch {
          tap.node = null
        }
      }
    }
  }
  win.AudioContext = TappedAudioContext
  if (win.webkitAudioContext) win.webkitAudioContext = TappedAudioContext

  const origConnect = NodeProto.connect
  NodeProto.connect = function (this: AudioNode, dest: AudioNode | AudioParam, ...rest: unknown[]) {
    const ret = (origConnect as (...a: unknown[]) => unknown).call(this, dest, ...rest)
    try {
      // 只旁路「直接连到扬声器」的那一路，避免中间节点被重复采集
      if (tap.ctx && tap.node && dest === tap.ctx.destination) {
        ;(origConnect as (...a: unknown[]) => unknown).call(this, tap.node)
      }
    } catch {
      /* 旁路失败只影响录音里的声音，不影响游戏 */
    }
    return ret as AudioNode
  } as AudioNode['connect']

  return tap
}

/**
 * 在 iframe 里包一层 RTCPeerConnection。
 *
 * EmulatorJS 的 netplay 在内部自己建连接，没有对外暴露任何钩子。包一层之后我们能做三件事：
 *   1. 把连接状态报上去，界面上能区分「连接中」和「连不通」
 *   2. 连接失败时自动 restartIce 再试一次（换网、切 Wi-Fi 时很常见）
 *   3. 调发送端参数：优先保帧率、限码率（见 VIDEO_MAX_BITRATE 的说明）
 *
 * 必须在 loader.js 之前装好，否则 netplay 拿到的是原生构造函数。
 */
function instrumentRtc(win: Window & Record<string, unknown>, onState?: (s: RTCPeerConnectionState) => void) {
  const Native = win.RTCPeerConnection as typeof RTCPeerConnection | undefined
  if (typeof Native !== 'function') return

  const tuneVideo = (sender: RTCRtpSender) => {
    try {
      const params = sender.getParameters()
      if (!params.encodings || !params.encodings.length) params.encodings = [{}]
      for (const e of params.encodings) {
        e.maxBitrate = VIDEO_MAX_BITRATE
        e.maxFramerate = VIDEO_MAX_FPS
      }
      // 游戏画面：宁可糊一点也不要卡
      ;(params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference =
        'maintain-framerate'
      void sender.setParameters(params)
    } catch {
      /* 老浏览器不支持就算了，只是少一层优化 */
    }
  }

  const Wrapped = function (this: unknown, config?: RTCConfiguration, ...rest: unknown[]) {
    const pc = new Native(config, ...(rest as []))

    let restarted = false
    pc.addEventListener('connectionstatechange', () => {
      onState?.(pc.connectionState)
      // 失败时自动重来一次：换 Wi-Fi、切移动网络之后很常见，
      // 不重试的话画面就永远停在那里，玩家只能自己刷新
      if (pc.connectionState === 'failed' && !restarted) {
        restarted = true
        try {
          pc.restartIce?.()
        } catch {
          /* 不支持就算了 */
        }
      }
      if (pc.connectionState === 'connected') restarted = false
    })

    const nativeAddTrack = pc.addTrack.bind(pc)
    pc.addTrack = (track: MediaStreamTrack, ...streams: MediaStream[]) => {
      // 告诉编码器这是「运动画面」，它会自己偏向保帧率
      try {
        if (track.kind === 'video') track.contentHint = 'motion'
      } catch {
        /* ignore */
      }
      const sender = nativeAddTrack(track, ...streams)
      if (track.kind === 'video') {
        // 参数要等 sender 真正协商完才生效，稍等一下再设
        window.setTimeout(() => tuneVideo(sender), 1000)
      }
      return sender
    }
    return pc
  } as unknown as typeof RTCPeerConnection

  Wrapped.prototype = Native.prototype
  win.RTCPeerConnection = Wrapped
}

/** 往 iframe 里注入一个脚本，resolve 表示加载完成 */
function injectScript(doc: Document, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = doc.createElement('script')
    s.src = src
    s.async = false
    s.onload = () => resolve()
    s.onerror = () => reject(new Error(src))
    doc.head.appendChild(s)
  })
}

function mount(container: HTMLElement, options: MountOptions): RuntimeHandle {
  const rt = getT().runtime
  // 按游戏覆盖优先，其次才是平台默认。街机一个平台底下其实是好几套硬件，
  // 拳皇 / 街霸 / 老板子各要各的核心，光靠平台默认值盖不住
  const core = options.core || platformMap[options.platform]?.core
  if (!core) {
    options.onError?.(fmt(rt.ejsNoCore, { platform: options.platform }))
    return { destroy: () => {}, caps: new Set<Capability>() }
  }
  const netplay = options.netplay

  const iframe = document.createElement('iframe')
  iframe.title = fmt(rt.emulatorTitle, { name: options.gameName })
  iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#0b0b0f'
  iframe.setAttribute('allow', 'fullscreen; gamepad; autoplay; camera; microphone; clipboard-write')
  iframe.srcdoc = FRAME_HTML

  let destroyed = false
  let playersTimer = 0
  let stateTimer = 0
  let audioTap: EjsAudioTap | null = null
  let volume = 0.6
  const caps = new Set<Capability>(['pause', 'saveState', 'volume', 'screenshot', 'record', 'gamepad'])
  /** 取 iframe 里的模拟器实例；还没起来时是 undefined */
  const emuOf = (): EjsEmulator | undefined =>
    (iframe.contentWindow as (Window & Record<string, unknown>) | null)?.EJS_emulator as EjsEmulator | undefined
  /** EmulatorJS 的画布在 iframe 里，同源所以能直接拿 */
  const canvasOf = (): HTMLCanvasElement | null =>
    emuOf()?.canvas ?? iframe.contentDocument?.querySelector('canvas') ?? null

  /**
   * 核心跑起来之后核对一遍能力。
   * EmulatorJS 的版本（尤其走 CDN 的 stable/latest）随时可能变，
   * 与其让工具栏亮着一个点了没反应的按钮，不如按实际存在的方法把它摘掉。
   */
  const refineCaps = () => {
    const emu = emuOf()
    if (!emu) return
    if (typeof emu.pause !== 'function' || typeof emu.play !== 'function') caps.delete('pause')
    if (typeof emu.setVolume !== 'function' && !('volume' in emu)) caps.delete('volume')
    if (typeof emu.gameManager?.getState !== 'function') caps.delete('saveState')
    if (!canvasOf()) {
      caps.delete('screenshot')
      caps.delete('record')
    }
    options.onCaps?.(caps)
  }
  /** 服务端下发的房间令牌，上传存档要用 */
  let stateToken = ''
  /** 关页面前补传存档用 */
  let flushState: (() => void) | null = null
  /** 引擎日志探针。街机 ROM 排查全靠它 —— 详见 installErrorTap */
  let errorTap: { lines: string[] } | null = null
  const reportedErrors = new Set<string>()
  // 本地文件转成 blob: URL（同源 iframe 可直接访问）；gameName 用原始文件名以保留扩展名
  const isFile = typeof options.game !== 'string'
  const gameUrl = isFile ? URL.createObjectURL(options.game as File) : (options.game as string)
  const gameName = isFile ? (options.game as File).name : options.gameName

  /** 游戏跑起来之后再开 / 加入房间 —— 房主要先有画面才能 captureStream */
  const startNetplay = (win: Window & Record<string, unknown>) => {
    if (destroyed || !netplay) return
    const emu = win.EJS_emulator as EjsEmulator | undefined
    const np = emu?.netplay
    if (!np) {
      options.onError?.(rt.netplayUnavailable)
      return
    }
    np.name = netplay.playerName

    // 接手别人的房间：先把存档载进去，不然游戏会从开机画面重来
    if (netplay.initialState && emu?.gameManager) {
      try {
        emu.gameManager.loadState(netplay.initialState)
      } catch (e) {
        // 载不进去也继续，大不了从头玩
        console.warn('[netplay] 加载存档失败', e)
      }
    }

    // 观众：把 netplay 的输入转发换成空实现。
    // EmulatorJS 里 键盘 → GameManager.simulateInput → netplay.simulateInput，
    // 而 netplay.simulateInput 既把输入喂给本地模拟器、又发 sync-control 给房主，
    // 所以换掉这一环，观众按什么都不会生效，画面和声音照常收。
    const realInput = np.simulateInput?.bind(np)
    const applyRole = (spectator: boolean) => {
      try {
        if (spectator) np.simulateInput = () => {}
        else if (realInput) np.simulateInput = realInput
      } catch {
        /* 换不掉也不致命：服务端那边本来就不给观众手柄位 */
      }
    }
    applyRole(netplay.role === 'spectator')
    netplay.onSpectatorControl?.(applyRole)

    try {
      if (netplay.mode === 'join' && netplay.roomId) {
        np.joinRoom(netplay.roomId, netplay.roomName, netplay.maxPlayers, netplay.password || null)
      } else {
        np.openRoom(netplay.roomName, netplay.maxPlayers, netplay.password || '')
      }
    } catch (e) {
      options.onError?.(fmt(rt.netplayFailed, { msg: e instanceof Error ? e.message : String(e) }))
      return
    }

    // netplay 没有对外的事件回调，只能轮询它自己的状态（很轻，一秒一次）
    let lastCount = -1
    let reportedRoom = ''
    let reportedId = ''
    let tokenHooked = false
    playersTimer = window.setInterval(() => {
      if (destroyed) return
      const cur = win.EJS_emulator as EjsEmulator | undefined
      const n = cur?.netplay
      if (!n) return
      // 服务端在开房 / 加入成功后，会通过这条 socket 单独发一个房间令牌给本人。
      // iframe 是同源的 srcdoc，所以页面这边能直接挂监听。
      if (!tokenHooked && n.socket) {
        const sock = n.socket as unknown as { on?: (ev: string, cb: (d: unknown) => void) => void }
        if (typeof sock.on === 'function') {
          tokenHooked = true
          sock.on('room-token', (d: unknown) => {
            const token = (d as { token?: string } | null)?.token
            if (!token) return
            stateToken = token
            netplay.onToken?.(token)
          })
        }
      }

      const count = Object.keys(n.players || {}).length
      if (count !== lastCount) {
        lastCount = count
        netplay.onPlayers?.(count)
      }
      // 房主的房间 id 是客户端生成的，只能从 extra 里取
      const extra = (n as unknown as { extra?: { sessionid?: string } }).extra
      if (extra?.sessionid && extra.sessionid !== reportedRoom) {
        reportedRoom = extra.sessionid
        netplay.onRoom?.(extra.sessionid, n.owner)
        // 房主开始定期上传存档，掉线时新房主就能接着玩
        if (n.owner) startStateUpload(win, extra.sessionid)
      }
      if (n.playerID && n.playerID !== reportedId) {
        reportedId = n.playerID
        netplay.onIdentity?.(n.playerID)
      }
      // 信令断开。注意：这既可能是「房主走了」，也可能是**我自己**掉线了。
      // 以前一律当成房主走了报错，用户自己网络抖一下就被踢出房间。
      // 房主自己不可能「房主走了」，所以房主这边只当作网络问题，交给 socket.io 自己重连。
      if (reportedRoom && !n.socket?.connected) {
        if (n.owner) return
        window.clearInterval(playersTimer)
        netplay.onHostLeft?.()
      }
    }, 1000)
  }

  /**
   * 房主定期把存档托管到信令服务器（只上传，不广播给访客）。
   *
   * 两处优化：
   * 1. **内容没变就不传**。以前每 25 秒无条件全量上传一份，暂停、看菜单、挂机时
   *    传的都是同一份数据。N64 / PS1 的存档能到几 MB，这些流量全部占用房主的上行 ——
   *    而房主的上行同时还扛着推给所有访客的画面，一挤画面就卡。
   *    这里算一个便宜的指纹（长度 + 采样异或），一样就跳过。
   * 2. **页面要关的时候补传一次**。原来只靠定时器，最坏情况下新房主拿到的是
   *    25 秒前的进度；关页面前补一次，接手的人基本能无缝接上。
   */
  const startStateUpload = (win: Window & Record<string, unknown>, roomId: string) => {
    if (stateTimer || destroyed) return
    let lastFingerprint = ''

    /** 便宜的指纹：全量哈希几 MB 太贵，采样 512 个点就足够区分「变了没有」 */
    const fingerprint = (buf: Uint8Array): string => {
      let h = 0x811c9dc5
      const step = Math.max(1, Math.floor(buf.length / 512))
      for (let i = 0; i < buf.length; i += step) {
        h ^= buf[i]
        h = Math.imul(h, 0x01000193)
      }
      return `${buf.length}:${h >>> 0}`
    }

    const push = (force = false) => {
      if (destroyed && !force) return
      const emu = win.EJS_emulator as EjsEmulator | undefined
      const np = emu?.netplay
      if (!np?.owner || !emu?.gameManager) return
      // 有房间令牌就用令牌（服务端加固后的方式），没有就退回 netplay 内部的
      // playerID —— 兼容还没升级信令服务器的部署
      const auth = stateToken || np.playerID || ''
      if (!auth) return
      let state: Uint8Array | undefined
      try {
        state = emu.gameManager.getState()
      } catch {
        return // 有些核心在某些时刻取不到存档，跳过这一轮就行
      }
      if (!state?.length) return
      const fp = fingerprint(state)
      if (!force && fp === lastFingerprint) return // 进度没动，不用重复传
      lastFingerprint = fp
      void uploadState(roomId, auth, state)
    }

    stateTimer = window.setInterval(() => push(), STATE_UPLOAD_MS)
    // 开局后先传一份，别让刚开房就掉线的情况一无所有
    window.setTimeout(() => push(), 3000)

    // 关页面 / 切后台前补一次，让接手的人拿到尽量新的进度
    flushState = () => push(true)
    window.addEventListener('pagehide', flushState)
  }

  iframe.addEventListener('load', () => {
    if (destroyed) return
    const win = iframe.contentWindow as (Window & Record<string, unknown>) | null
    const doc = iframe.contentDocument
    if (!win || !doc) {
      options.onError?.(rt.ejsInitFailed)
      return
    }
    Object.assign(win, {
      EJS_player: '#game',
      EJS_core: core,
      EJS_gameUrl: gameUrl,
      EJS_gameName: gameName,
      EJS_pathtodata: EJS_PATH,
      // 平台级 BIOS。Neo Geo 这类平台不给就直接起不来；不需要 BIOS 的平台
      // 这里是空串，等于没设
      ...(options.biosUrl ? { EJS_biosUrl: options.biosUrl } : {}),
      EJS_color: '#0078f2',
      EJS_backgroundColor: '#0b0b0f',
      EJS_language: 'zh-CN',
      EJS_startOnLoaded: true,
      EJS_volume: 0.6,
      EJS_ready: () => options.onReady?.(),
      EJS_onGameStart: () => {
        options.onStart?.()
        refineCaps()
        if (netplay) startNetplay(win)
      },
      // 联机相关（没有 netplay 会话时也设上，用户可以自己点模拟器里的联机按钮）
      ...(NETPLAY_URL
        ? {
            EJS_netplayUrl: NETPLAY_URL,
            EJS_netplayICEServers: ICE_SERVERS,
            EJS_gameId: netplay?.gameId,
          }
        : {}),
    })

    // 录像要取声音，必须赶在 loader.js 建 AudioContext 之前装探针
    audioTap = installAudioTap(win)

    // 引擎的报错探针也要赶在 loader.js 之前装：核心是在加载过程中打错误的，
    // 装晚了那句「缺哪个文件」就已经过去了
    errorTap = installErrorTap(win, (line) => {
      if (destroyed) return
      // 同一句话可能被核心打好几遍，只报第一次，免得把界面刷成一片红
      if (reportedErrors.has(line)) return
      reportedErrors.add(line)
      options.onError?.(fmt(rt.ejsEngineError, { msg: line }))
    })

    void (async () => {
      try {
        // socket.io 客户端必须在 loader.js 之前就位：netplay 用的是全局 io()
        if (NETPLAY_URL) {
          await injectScript(doc, socketIoScriptUrl()).catch(() => {
            // 信令服务器不可达时不阻断单机游戏，只是联机用不了
            if (destroyed) return
            options.onError?.(fmt(rt.netplaySignalUnreachable, { url: socketIoScriptUrl() }))
          })

          // ICE 配置向服务端要：那边按请求现算一份短期 TURN 凭证，
          // 凭证不进前端包，换 TURN 也不用重新构建（见 services/netplay.ts）
          try {
            const ice = await fetchIceConfig()
            win.EJS_netplayICEServers = ice.iceServers
            netplay?.onIceReady?.(ice.hasTurn)
          } catch {
            /* 取不到就用上面设的兜底 STUN */
          }

          // 包一层 RTCPeerConnection：观察连接状态、失败自动重试、限码率保帧率。
          // 必须在 loader.js 之前装，否则 netplay 拿到的是原生构造函数。
          if (netplay) instrumentRtc(win, (state) => netplay.onLinkState?.(state))
        }
        if (destroyed) return
        await injectScript(doc, `${EJS_PATH}loader.js`)
      } catch {
        // 加载过程中被销毁的，别再往新会话上报错
        if (destroyed) return
        options.onError?.(fmt(rt.ejsLoadFailed, { path: EJS_PATH }))
      }
    })()
  })

  container.appendChild(iframe)
  options.onCaps?.(caps)

  const destroy = () => {
    destroyed = true
    window.clearInterval(playersTimer)
    window.clearInterval(stateTimer)
    if (flushState) {
      window.removeEventListener('pagehide', flushState)
      flushState = null
    }
    try {
      // 先干净地退出房间，别让别人看到一个已经没人的房间
      const win = iframe.contentWindow as (Window & Record<string, unknown>) | null
      const np = (win?.EJS_emulator as EjsEmulator | undefined)?.netplay
      np?.leaveRoom?.()
    } catch {
      /* ignore */
    }
    try {
      iframe.srcdoc = ''
      iframe.src = 'about:blank'
    } catch {
      /* ignore */
    }
    iframe.remove()
    audioTap = null
    if (isFile) URL.revokeObjectURL(gameUrl)
  }

  return {
    caps,
    destroy,
    // EmulatorJS 默认 0.6，工具栏滑块要跟它对上
    volume,
    engineLog: () => errorTap?.lines.slice() ?? [],
    setPaused(next: boolean) {
      const emu = emuOf()
      try {
        if (next) emu?.pause?.()
        else emu?.play?.()
      } catch {
        /* 核心还没起来就忽略 */
      }
    },
    setVolume(next: number) {
      volume = Math.max(0, Math.min(1, next))
      const win = iframe.contentWindow as (Window & Record<string, unknown>) | null
      if (win) win.EJS_volume = volume
      const emu = emuOf()
      try {
        if (typeof emu?.setVolume === 'function') emu.setVolume(volume)
        else if (emu) emu.volume = volume
      } catch {
        /* ignore */
      }
    },
    async saveState() {
      const state = emuOf()?.gameManager?.getState?.()
      if (!state?.length) return null
      // 复制一份：核心里的那块内存随时可能被覆写
      return new Blob([new Uint8Array(state).slice().buffer], { type: 'application/octet-stream' })
    },
    async loadState(data: ArrayBuffer) {
      const gm = emuOf()?.gameManager
      if (!gm?.loadState) throw new Error(rt.ejsInitFailed)
      gm.loadState(new Uint8Array(data))
    },
    async screenshot() {
      const canvas = canvasOf()
      if (!canvas) return null
      // EmulatorJS 的画布是 WebGL 且没开 preserveDrawingBuffer，
      // 直接 toBlob 多半是黑的，优先用它自己的截图接口
      const shot = emuOf()?.gameManager?.screenshot?.()
      if (shot?.length) return new Blob([new Uint8Array(shot).slice().buffer], { type: 'image/png' })
      return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    },
    captureSources(): CaptureSources | null {
      const canvas = canvasOf()
      if (!canvas) return null
      return { canvas, audioNode: audioTap?.node ?? null, audioContext: audioTap?.ctx ?? null }
    },
  }
}

/** EmulatorJS 覆盖面最广：把所有配了 core 的平台的扩展名收进来 */
const EJS_EXTS: string[] = [
  ...new Set(
    Object.values(platformMap)
      .filter((p) => p.core)
      .flatMap((p) => p.romExtensions ?? []),
  ),
].map((e) => e.replace(/^\./, '').toLowerCase())

export const emulatorJsRuntime: Runtime = {
  id: 'emulatorjs',
  name: 'EmulatorJS',
  get description() {
    return getT().runtime.ejsDesc
  },
  extensions: EJS_EXTS,
  // 通用兜底引擎，优先级最低：有更专精的引擎（如 .nes 的 jsnes）时让给它
  priority: 5,
  available: () => true,
  supports: (platform) => Boolean(platformMap[platform]?.core),
  engineLabel: (platform) => platformMap[platform]?.core ?? '—',
  mount,
}

/** 该平台能否 P2P 联机：需要 EmulatorJS 能跑（即配了 core）且信令已配置 */
export function p2pPlayable(platform: string): boolean {
  return Boolean(NETPLAY_URL) && Boolean(platformMap[platform as keyof typeof platformMap]?.core)
}
