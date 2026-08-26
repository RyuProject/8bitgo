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
import type { MountOptions, Runtime } from '../types'
import { getT, fmt } from '@/services/i18n'
import { ICE_SERVERS, NETPLAY_URL, socketIoScriptUrl, uploadState } from '@/services/netplay'

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
}

/** 房主每隔多久把存档传给信令服务器（掉线时交给新房主） */
const STATE_UPLOAD_MS = 25_000

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
  socket?: { connected?: boolean } | null
}
interface EjsGameManager {
  getState: () => Uint8Array
  loadState: (state: Uint8Array) => void
}
interface EjsEmulator {
  netplay?: EjsNetplay
  gameManager?: EjsGameManager
  isNetplay?: boolean
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

function mount(container: HTMLElement, options: MountOptions): () => void {
  const rt = getT().runtime
  const core = platformMap[options.platform]?.core
  if (!core) {
    options.onError?.(fmt(rt.ejsNoCore, { platform: options.platform }))
    return () => {}
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
    playersTimer = window.setInterval(() => {
      if (destroyed) return
      const cur = win.EJS_emulator as EjsEmulator | undefined
      const n = cur?.netplay
      if (!n) return
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
      // 房主走了：服务器广播 host-left，netplay 会断开
      if (reportedRoom && !n.socket?.connected) {
        window.clearInterval(playersTimer)
        netplay.onHostLeft?.()
      }
    }, 1000)
  }

  /** 房主定期把存档托管到信令服务器（只上传，不广播给访客） */
  const startStateUpload = (win: Window & Record<string, unknown>, roomId: string) => {
    if (stateTimer || destroyed) return
    const push = () => {
      if (destroyed) return
      const emu = win.EJS_emulator as EjsEmulator | undefined
      const np = emu?.netplay
      if (!np?.owner || !np.playerID || !emu?.gameManager) return
      let state: Uint8Array | undefined
      try {
        state = emu.gameManager.getState()
      } catch {
        return // 有些核心在某些时刻取不到存档，跳过这一轮就行
      }
      if (!state?.length) return
      void uploadState(roomId, np.playerID, state)
    }
    stateTimer = window.setInterval(push, STATE_UPLOAD_MS)
    // 开局后先传一份，别让刚开房就掉线的情况一无所有
    window.setTimeout(push, 3000)
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
      EJS_color: '#0078f2',
      EJS_backgroundColor: '#0b0b0f',
      EJS_language: 'zh-CN',
      EJS_startOnLoaded: true,
      EJS_volume: 0.6,
      EJS_ready: () => options.onReady?.(),
      EJS_onGameStart: () => {
        options.onStart?.()
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

    void (async () => {
      try {
        // socket.io 客户端必须在 loader.js 之前就位：netplay 用的是全局 io()
        if (NETPLAY_URL) {
          await injectScript(doc, socketIoScriptUrl()).catch(() => {
            // 信令服务器不可达时不阻断单机游戏，只是联机用不了
            options.onError?.(fmt(rt.netplaySignalUnreachable, { url: socketIoScriptUrl() }))
          })
        }
        if (destroyed) return
        await injectScript(doc, `${EJS_PATH}loader.js`)
      } catch {
        options.onError?.(fmt(rt.ejsLoadFailed, { path: EJS_PATH }))
      }
    })()
  })

  container.appendChild(iframe)

  return () => {
    destroyed = true
    window.clearInterval(playersTimer)
    window.clearInterval(stateTimer)
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
    if (isFile) URL.revokeObjectURL(gameUrl)
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
