/**
 * EmulatorJS 运行时：主机 / 掌机 / 街机 / DOS，以及 **P2P 联机**。
 *
 * EmulatorJS 通过全局 window.EJS_* 读取配置，并在顶层声明 `class EmulatorJS`，
 * 不能在同一页面反复注入，因此放进独立的 srcdoc iframe 里运行：切换游戏直接销毁 iframe，
 * 画面、声音与 WebAssembly 内存随之释放；React StrictMode 二次挂载也不会重复实例化。
 *
 * 资源**默认自托管**：public/emulatorjs/（已随仓库提交，构建时被 Vite 原样拷进 dist/client/）。
 * 想切回官方 CDN 设 VITE_EJS_PATH=https://cdn.emulatorjs.org/stable/data/ —— 但街机别切，见下。
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
import type { PlatformId } from '@/types'
import { platformMap } from '@/data/platforms'
import { platformLabel } from '@/services/i18nData'
import type { Capability, CaptureSources, LoadPhase, LoadProgress, MountOptions, Runtime, RuntimeHandle } from '../types'
import { fetchWithProgress, throttleProgress } from '../loadProgress'
import { romCacheGet, romCacheKey, romCachePut } from '../romCache'
import { focusFrame, frameGamepads } from '../frameFocus'
import { getT, fmt } from '@/services/i18n'
import { getLang } from '@/services/lang'
import type { Lang } from '@/config/languages'
import { ICE_SERVERS, NETPLAY_URL, fetchIceConfig, gameIdFor, socketIoScriptUrl, uploadState } from '@/services/netplay'
import { isZip, listZipEntries } from '@/lib/unzip'
import { matchArcadeHack, type ArcadeHack } from '@/data/arcadeHacks'

/**
 * EmulatorJS 资源根路径。**默认是自托管的 /emulatorjs/，不是 CDN。**
 *
 * 这个默认值是被坑出来的，别随手改回 CDN：
 *
 *   1. CDN 的 stable 至今是 **4.2.3**，不含 `dontExtractIfCore`。没有它，加载 BIOS 时
 *      EmulatorJS 看见 `neogeo.zip` 是个压缩包就先解压再喂给核心，FBNeo 拿到的是一堆散
 *      文件，于是报「四个 Neo Geo BIOS 成员缺失」——街机（拳皇 97 之类）直接起不来。
 *      main 分支有这个判断，`public/emulatorjs/` 就是从 main 构建出来的。
 *      （注意 main 的 version.json 仍然写着 4.2.3，别拿版本号当验收标准，
 *        验收看 `grep -c dontExtractIfCore public/emulatorjs/emulator.min.js` = 1。）
 *   2. 曾经默认值是 CDN、真实路径靠 `.env.local` 里的 VITE_EJS_PATH 顶上去，而
 *      `.env.local` 被 .gitignore 的 `*.local` 挡住 —— 构建机上根本没有这个文件，
 *      于是线上悄悄退回 4.2.3，本地怎么试都是好的。默认值写死才治得了这个。
 *
 * 核心（cores/*.data）**也自托管**，和运行时一起提交在 public/emulatorjs/ 里，
 * git pull 即得；升级见 scripts/copy-ejs-cores.mjs 头注释。
 * 千万别指望引擎的 CDN 回落 —— 这个 main 构建自称 4.3.0-pre，回落地址是
 * cdn.emulatorjs.org/4.3.0-pre/，实测取回来的核心初始化不出 EJS_Runtime，
 * 玩家看到的就是「Error loading EmulatorJS runtime」。本地有核心，这条路不会走。
 */
export const EJS_PATH: string = (() => {
  const p = import.meta.env.VITE_EJS_PATH || '/emulatorjs/'
  return p.endsWith('/') ? p : `${p}/`
})()

/**
 * 站点语言 → EmulatorJS 自带的界面语言包（data/localization/*.json）。
 *
 * 写死 'zh-CN' 的年代，英文站的玩家一点开模拟器自己的设置菜单，看到的是一水儿的
 * 简体中文，引擎报错原文也是中文（那句话现在会被我们接出来显示在播放器上，更得对语言）。
 *
 * **码必须和我们自建构建里的文件名一字不差**（zh.json / fr.json 这样的两字码）。
 * 别想依赖 loader.js 的「404 就砍掉破折号重试」兜底 —— 那个兜底只认 HTTP 错误状态，
 * 而 Vite dev 对不存在的路径回的是 **200 + index.html**，loader 拿去 JSON.parse
 * 炸出 "Unexpected token '<'" 后直接把语言包整个扔了，界面退回英文，开发时中文
 * 全没了还以为是构建坏了。写成第一发就命中，两个环境都不吃这套。
 *
 * 两个坑，改之前先看清楚：
 *
 *   1. 这些两字码只在**我们自建的 main 构建**里存在。官方 CDN 4.2.3 用的是
 *      zh-CN.json / af-FR.json 那套老名字 —— 但反正 CDN 版会把街机 BIOS 解压，
 *      早就不能切回去了（见 EJS_PATH 的注释），不用为它留后路。
 *   2. **没有繁体**。构建里只有简体，繁体退到简体是矮子里拔将军 —— 至少还是中文。
 *      真要繁体得自己托管一份 JSON，再用 EJS_paths 指过去（见 loader.js 的语言加载）。
 *
 * 语言码填错或者文件不存在都不会把游戏搞挂：loader.js 那边 try/catch 兜着，
 * 退回英文而已。写成 Record<Lang, string> 则是为了以后站点加语言时编译期就报错，
 * 而不是让新语言悄没声地退回英文。
 */
const EJS_LANG: Record<Lang, string> = {
  'zh-Hans': 'zh',
  'zh-Hant': 'zh',
  en: 'en',
  es: 'es',
  fr: 'fr',
  it: 'it',
  de: 'de',
  ja: 'ja',
}

/**
 * 一次性清掉 EmulatorJS 的 IndexedDB 工件缓存（库名 EmulatorJS-Cache）。
 *
 * 为什么：引擎会把下载完（且解压完）的核心按**文件名**缓存进 IndexedDB，下次直接用，
 * 连网都不上。在「核心还没自托管」的那段时间里，引擎从 cdn.emulatorjs.org/4.3.0-pre/
 * 回落拉核心，拉回来的东西初始化不出 EJS_Runtime —— 而这份坏数据**被缓存了**。
 * 之后就算本地 cores/ 已经齐了，控制台也只会看到
 *   [EJS Core] Data is already decompressed cache item
 *   EJS_Runtime is not defined!
 * 它压根不再下载，清浏览器 HTTP 缓存、硬刷新都无济于事 —— 毒在 IndexedDB 里。
 *
 * 所以按「代次」清一次：GENERATION 变了才清，确认删除成功后才在 localStorage 记账，
 * 每个访客只清一回，正常人感知不到（下一局重新下载一次核心而已，还有 HTTP 缓存兜着）。
 * 引擎构建再出现不兼容的更换时，把 GENERATION +1。
 *
 * ⚠️ `deleteDatabase` 遇到其它标签页仍占着数据库时会触发 `blocked`。以前这里把
 * blocked / 超时也当成成功并写入代次，结果数据库根本没删，浏览器却永远不再重试，
 * 同一份正确 ROM 就会时好时坏。现在失败只放行本次开局，不记账；下次启动继续删。
 *
 * 里面只有可重新下载的工件（核心/ROM/BIOS 的副本），删了不丢任何用户数据；
 * 存档在另一个库（EmulatorJS-states）和我们自己的云存档里，不碰。
 */
const EJS_CACHE_GENERATION = '2026-08-29.arcade-blob-loader'
const EJS_CACHE_PURGED_KEY = '8bitgo.ejs.cachePurged'

async function purgePoisonedEngineCache(): Promise<void> {
  try {
    if (localStorage.getItem(EJS_CACHE_PURGED_KEY) === EJS_CACHE_GENERATION) return
  } catch {
    /* localStorage 不可用就每次都清，代价只是核心重新下载 */
  }
  const markDone = () => {
    try {
      localStorage.setItem(EJS_CACHE_PURGED_KEY, EJS_CACHE_GENERATION)
    } catch {
      /* ignore */
    }
  }
  const DB = 'EmulatorJS-Cache'

  /**
   * 优先「开库、把每个表清空」而不是 deleteDatabase。
   *
   * deleteDatabase 要等**所有**连接关掉才会执行；另一个标签页正开着 EmulatorJS 的话它一直 blocked，
   * 而按规范同名库上后来的 open() 都排在这个删除请求后面 —— 本页引擎的 open() 就再也不 resolve，
   * 30 秒后被卡死检测报成「卡住了」。清表只要一个 readwrite 事务，不用别人关连接。
   * 库不存在时不能用 open()（会凭空建一个版本 1 的空库，引擎再开就对不上），所以先用
   * indexedDB.databases() 确认；没有这个 API 的浏览器退回 deleteDatabase。
   */
  try {
    const list = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : null
    if (list) {
      if (!list.some((d) => d.name === DB)) return markDone() // 本来就没有，没什么可清
      const cleared = await new Promise<boolean>((resolve) => {
        let settled = false
        const done = (ok: boolean) => {
          if (settled) return
          settled = true
          resolve(ok)
        }
        const req = indexedDB.open(DB)
        req.onerror = () => done(false)
        req.onblocked = () => done(false)
        req.onsuccess = () => {
          const db = req.result
          try {
            const names = Array.from(db.objectStoreNames)
            if (!names.length) {
              db.close()
              return done(true)
            }
            const tx = db.transaction(names, 'readwrite')
            for (const n of names) tx.objectStore(n).clear()
            tx.oncomplete = () => {
              db.close()
              done(true)
            }
            tx.onerror = tx.onabort = () => {
              db.close()
              done(false)
            }
          } catch {
            db.close()
            done(false)
          }
        }
        setTimeout(() => done(false), 4000)
      })
      if (cleared) markDone()
      return
    }
  } catch {
    /* 走下面的老路 */
  }

  const deleted = await new Promise<boolean>((resolve) => {
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    try {
      const req = indexedDB.deleteDatabase(DB)
      // 就算已经因为超时放行了本局，删除真的完成时也要记下来 —— 否则删得慢的机器上每次开局都会再删一遍
      req.onsuccess = () => {
        markDone()
        done(true)
      }
      req.onerror = () => done(false)
      // 有别的标签页开着数据库就先放行本局，但绝不能写「清理完成」；下次启动再试。
      req.onblocked = () => done(false)
      // 浏览器实现异常时也不能把开局一直卡住；超时同样保持未完成状态。
      setTimeout(() => done(false), 2000)
    } catch {
      done(false)
    }
  })
  if (deleted) markDone()
}

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
  /**
   * 信令断了、引擎已经自己退了房（EmulatorJS 的 socket 一 disconnect 就 leaveRoom）。
   * 访客收到它多半是自己网络抖了一下 —— 房间很可能还在，可以重新加入；
   * 房主收到它则是房间没了（服务器那边已经开始换房主），游戏本身还在跑。
   * 到底是哪种，调用方自己查一下房间状态再决定。
   */
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
/**
 * 电池存档（SRAM）主动落盘的间隔。
 *
 * 玩家在 RPG 里按的「保存」写的是 SRAM，不是快照存档 —— 这才是他们真正会心疼的东西。
 * 引擎给核心的 retroarch.cfg 里写死 `autosave_interval = 60`（而 retroarchOpts 是从
 * core.json 读的，我们改不了），也就是说核心每 60 秒才把 .srm 落到 /data/saves 一次。
 * /data/saves 是 IDBFS + autoPersist，落到那儿之后会自动同步进 IndexedDB。
 *
 * 缺口在最后那 60 秒：引擎只在 `exit`（iframe 的 beforeunload）里补刷一次，而
 * autoPersist 的同步是 `setTimeout(0)` + 异步 IndexedDB 事务，iframe 在同一个同步块里
 * 就被拆了 —— 那一刀基本落不下去。所以我们自己按这个节奏补刷，把最坏窗口砍掉一半。
 */
const SAVE_FLUSH_MS = 30_000

/**
 * 多久没动静就认定「卡死了」。
 *
 * 「动静」= 有网络进度，或者引擎自己那行状态文字变了（解压、写文件系统这些阶段
 * 没有网络请求，只有那行字在变）。两样都停下来这么久，基本可以断定它不会自己好了：
 * EmulatorJS 有好几处 promise 断在半路就再也不 resolve（见 installNetTap 的说明），
 * 没有这道闸，玩家就只能对着一根不动的进度条一直等下去。
 *
 * 30 秒是给最慢的一步留的余量：几十 MB 的核心在慢手机上编译 wasm 期间既没有网络请求、
 * 也不更新文案，实测能安静十几秒。
 */
const STALL_MS = 30_000

const FRAME_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; height: 100%; background: #0b0b0f; overflow: hidden; }
  /*
    长按虚拟手柄会选中字符：iOS 把「按住不动」当成开始选字，安卓会弹出选区手柄。
    引擎自己的样式只给按钮设了 user-select:none，选区却是从 body 上起的，
    而且没关 -webkit-touch-callout（iOS 长按弹出的那条菜单）。这里在根上一起关掉；
    引擎的聊天输入框自己带 user-select:text!important，不受影响。
  */
  html, body {
    -webkit-user-select: none; user-select: none;
    -webkit-touch-callout: none;
    -webkit-tap-highlight-color: transparent;
  }
  .ejs_virtualGamepad_parent, .ejs_virtualGamepad_parent * { touch-action: none; -webkit-touch-callout: none; }
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
  /** 核心自报支不支持快照存档（cwrap supports_states）；街机的一些驱动就是不支持 */
  supportsStates?: () => boolean
  /** 把电池存档（SRAM）从核心刷进 /data/saves（cwrap cmd_savefiles）*/
  saveSaveFiles?: () => void
  /** Emscripten 的虚拟文件系统。RomData 要往里塞一个 .dat，见 installRomDataInjector */
  FS?: { writeFile: (path: string, data: string | Uint8Array) => void }
}
/**
 * 「这台机器本身就是靠戳屏幕玩的」—— 画布必须收得到指针事件，
 * 而且引擎那套压在画面下半部分的虚拟按键默认要收起来（见 applyTouchInput）。
 *
 * 现在只有 NDS：下屏是电阻触摸屏，《瓦力欧制造 触摸版》《应援团》这类游戏
 * 除了戳屏幕没有别的输入。以后接 3DS / Wii U 之类再往里加。
 *
 * ⚠️ 别把 PSX、土星这些「有鼠标外设但基本没人用」的平台加进来：
 * 放开画布指针事件本身没坏处，但顺带把屏幕按键收起来就是净损失了。
 */
const POINTER_FIRST = new Set<PlatformId>(['nds'])

interface EjsEmulator {
  netplay?: EjsNetplay
  gameManager?: EjsGameManager
  /**
   * loader.js 在开局前拼好的配置。这里只声明我们会碰的那一个字段：
   * gameId —— 开房时会被写进房间的 game_id，大厅靠它认出房间属于哪款游戏。
   * 中途开房（openNetplay）时引擎的 config 早就定死了，得补写这一格。
   */
  config?: { gameId?: number }
  /** 引擎真正把 ROM 交给核心的那一步；RomData 注入器包在它外面 */
  startGame?: () => void
  isNetplay?: boolean
  /** startGame() 一路跑完才置 true —— 兜底轮询靠它判断「到底开局了没有」 */
  started?: boolean
  /** 下面这些是给统一工具栏用的，各版本 EmulatorJS 不一定都有，调用前都要判空 */
  pause?: () => void
  play?: () => void
  paused?: boolean
  volume?: number
  setVolume?: (v: number) => void
  canvas?: HTMLCanvasElement
  elements?: { parent?: HTMLElement }
  /**
   * 引擎判断「要不要显示虚拟手柄」用的标志。只有玩家用手指点了「开始游戏」按钮才置 true
   * —— 我们设了 EJS_startOnLoaded，那个按钮根本不由玩家点。见 showVirtualGamepad。
   */
  touch?: boolean
  /** 引擎自己算的触屏判断，比我们细（UA + maxTouchPoints + any-pointer:coarse） */
  isMobile?: boolean
  hasTouchScreen?: boolean
  /** 显示 / 隐藏虚拟手柄。是实例上的闭包，setVirtualGamepad() 里装的 */
  toggleVirtualGamepad?: (show: boolean) => void
  /** 虚拟手柄那个容器。要它是为了**确认按键真的画出来了**，见 showVirtualGamepad */
  virtualGamepad?: HTMLElement
  /** 读一项设置的当前值（玩家自己关掉虚拟手柄时是 'disabled'） */
  getSettingValue?: (key: string) => string | undefined
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

/**
 * 把 FBNeo 的 RomData（.dat）塞进模拟器的虚拟文件系统。
 *
 * ── 为什么要有这东西 ─────────────────────────────────────────
 * 街机核心靠压缩包名认游戏（见 AGENTS.md §2.8）。汉化版、修改版这类包不在 FBNeo
 * 的驱动表里，叫什么名字都是「Romset is unknown」。FBNeo 给这种包留了 RomData：
 * 一份 .dat 写明 ZipName（包名）、DrvName（借哪个驱动跑）和整份 ROM 清单，
 * 核心把该驱动的包名「寄生」成 ZipName，并整个改用 dat 里的清单，
 * 于是和原版对不上的那几个 ROM 也能按自己的长度、CRC 加载。
 *
 * ── 为什么放在 ROM 旁边而不是 system 目录 ─────────────────────
 * 核心的 retro_dat_romset_path() 在内容名查不到驱动时，**先找和内容同目录的
 * `<basename>.dat`**，找不到才去 `<system>/fbneo/romdata/`。EmulatorJS 把 ROM 写在
 * 文件系统根目录（`callMain(["/" + fileName])`），所以 /wofcn.zip 对应 /wofcn.dat。
 * 走这条路还有两个好处：不必打开 fbneo-allow-patched-romsets，也不用先加载一遍
 * 原版 romset 再去核心选项里勾 —— 那是 RetroArch 那套交互，网页上没法要求玩家做。
 *
 * ── 为什么劫持 startGame ─────────────────────────────────────
 * 文件必须在 gameManager（也就是 Emscripten 的 FS）建好之后、callMain 之前写进去。
 * 引擎在这两步之间没有可挂的事件，而 startGame() 正好是最后一道门：
 * downloadFiles() → initializeGameManager() → 下载各类文件 → startGameFromDownload()
 * → **startGame()** → callMain。所以在 loader.js 之前给 window.EJS_emulator 装一个
 * setter，实例一挂上来就用自有属性盖掉原型上的 startGame。
 *
 * 写失败不拦着开局：那样至少还能按原始 romset 试一把，比直接黑屏强，
 * 玩家会收到一条说明，日志里也留得下线索。
 */
function installRomDataInjector(
  win: Window & Record<string, unknown>,
  datPath: string,
  dat: string,
  onFail: (msg: string) => void,
): void {
  let emu: EjsEmulator | undefined
  let wrapped = false

  const wrap = (next: EjsEmulator | undefined) => {
    if (!next || wrapped) return
    const original = next.startGame
    if (typeof original !== 'function') return
    wrapped = true
    next.startGame = function (this: unknown) {
      try {
        const fs = next.gameManager?.FS
        if (!fs) throw new Error('gameManager.FS 还没建好')
        fs.writeFile(datPath, dat)
      } catch (e) {
        onFail(e instanceof Error ? e.message : String(e))
      }
      return original.call(this)
    }
  }

  Object.defineProperty(win, 'EJS_emulator', {
    configurable: true,
    get: () => emu,
    set: (next: EjsEmulator | undefined) => {
      emu = next
      wrap(next)
    },
  })
}

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
 * 包一层 iframe 里的 XMLHttpRequest —— EmulatorJS 的下载全走它（见 emulator.js 的
 * downloadFile），所以这一层能同时干三件事：报进度、逮住下载失败、给卡死检测拍心跳。
 *
 * ── 为什么要报进度 ──
 *
 * 它自己**是**有真实百分比的，但只往 iframe 里的 .ejs_loading_text 写一行字
 * （「下载游戏数据 16%」），既没有事件也没有回调。而播放器的加载遮罩是块不透明黑底，
 * 正好把那行字盖住 —— 于是两头不讨好：遮罩在，玩家看着一根永远转不完的不确定条；
 * 遮罩撤早了，露出来的就是引擎自己那行文字（GBA 上看到的就是这个）。
 * 包一层 XHR 就能拿到 loaded / total，再按 URL 分辨这一趟在下什么，
 * 不改它一行代码，也不依赖它的任何文案。
 *
 * ── 为什么要逮失败 ──
 * EmulatorJS 接不住 4xx / 5xx：downloadFile 遇到它们回调的是数字 -1，而
 * downloadRom / downloadGameFile 拿到 -1 之后直接读 `res.headers["content-length"]`，
 * 抛 TypeError；这个异常发生在 `new Promise(async …)` 的执行体里，被 promise 吞掉，
 * 于是那个 promise **永远不 resolve**：不报错、不重试，downloadFiles() 的 await 就此卡住，
 * startGame() 再也不会被调用。表现就是加载遮罩一直挂着、进度条停在某个数字上不动。
 *
 * ⚠️ 只在开局前上报：netplay 的 socket.io 走 XHR 轮询，一秒好几趟，
 *    开局之后还接着报只会让播放器白白重渲染。
 */
function installNetTap(
  win: Window & Record<string, unknown>,
  ctx: {
    gameUrl: string
    biosUrl?: string
    live: () => boolean
    onProgress?: (p: LoadProgress) => void
    /** 有任何网络动静就拍一下，卡死检测靠它判断「引擎还有没有在动」 */
    onBeat: () => void
    /** 开不了局的文件下载失败了（HTTP 4xx / 5xx） */
    onFailed: (status: number, url: string) => void
  },
) {
  const proto = (win.XMLHttpRequest as typeof XMLHttpRequest | undefined)?.prototype
  if (!proto) return
  const emit = throttleProgress(ctx.onProgress)
  const URL_KEY = '__8bitgoUrl'

  /**
   * 这一趟是不是「没有它就开不了局」。
   *
   * 只认 ROM 和 BIOS —— 正好是上面那个 TypeError 死锁的两条路径。核心不算：
   * 它下载失败时 EmulatorJS 会自己退到官方 CDN 再试一次，抢在它前面报错，
   * 等于把本来能救回来的一局掐掉；socket.io 之类断了更不影响单机。
   */
  const critical = (url: string): boolean =>
    Boolean(url) &&
    ((Boolean(ctx.gameUrl) && url.startsWith(ctx.gameUrl)) || (Boolean(ctx.biosUrl) && url.startsWith(ctx.biosUrl!)))

  /** 按 URL 认这一趟在下什么。认不出来的（socket.io 之类）一律算配套资源 */
  const phaseOf = (url: string): LoadPhase => {
    if (url && ctx.gameUrl && url.startsWith(ctx.gameUrl)) return 'rom'
    // 核心与它的资源包：cores/<core>-wasm.data
    if (/\/cores\/|-wasm\.data/.test(url)) return 'engine'
    return 'assets'
  }

  const open = proto.open
  proto.open = function (this: Record<string, unknown>, method: string, url: string | URL, ...rest: unknown[]) {
    this[URL_KEY] = String(url)
    return (open as (...a: unknown[]) => unknown).call(this, method, url, ...rest)
  } as XMLHttpRequest['open']

  const send = proto.send
  proto.send = function (this: XMLHttpRequest & Record<string, unknown>, ...args: unknown[]) {
    const url = String(this[URL_KEY] ?? '')
    const phase = phaseOf(url)
    let seen = 0
    this.addEventListener('progress', (e: ProgressEvent) => {
      if (!ctx.live()) return
      ctx.onBeat()
      seen = e.loaded
      /*
       * 响应被 gzip / br 压缩过时，Content-Length 是**压缩后**的大小，而读出来的
       * 是解压后的字节，比例会冲过 100%。与其显示 120%，不如转成不确定态
       * —— 跟 loadProgress.ts 里 fetchWithProgress 的处理保持一致。
       */
      let total = e.lengthComputable && e.total > 0 ? e.total : undefined
      if (total !== undefined && e.loaded > total) total = undefined
      emit({ phase, loaded: e.loaded, total, ratio: total ? Math.min(e.loaded / total, 1) : undefined })
    })
    this.addEventListener('load', () => {
      if (!ctx.live()) return
      ctx.onBeat()
      // 4xx / 5xx 必须在这里截住 —— 交给 EmulatorJS 的话它会死锁，见上面的说明
      if (this.status >= 400) {
        if (critical(url)) ctx.onFailed(this.status, url)
        return
      }
      // 下完这一趟就把条推满，别停在 97% 上等解压。
      // 只对真的下过东西的请求补这一帧：比对缓存用的 HEAD 一个字节都没有，
      // 跟着推满的话进度条会先满一下再弹回 0
      if (seen > 0) emit({ phase, loaded: seen, total: seen, ratio: 1 }, true)
    })
    return (send as (...a: unknown[]) => unknown).call(this, ...args)
  } as XMLHttpRequest['send']
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

/**
 * 从远程地址取出街机核心真正要看的 romset 文件名。
 *
 * FBNeo 不看页面标题，也不看数据库 slug，只看压缩包名：`kof98.zip` 才会选中 kof98
 * 驱动。查询串是对象 ETag（用于换缓存 key），不能跟着进文件名；URL 编码也必须还原，
 * 否则 `%20` 之类会被核心当成名字的一部分。
 */
export function arcadeRomsetName(url: string): string {
  try {
    const pathname = new URL(url, window.location.href).pathname
    const encoded = pathname.split('/').pop() ?? ''
    return decodeURIComponent(encoded)
  } catch {
    return url.split(/[?#]/)[0].split('/').pop() ?? ''
  }
}

class InvalidArcadeArchiveError extends Error {}

/**
 * 拿包里的 CRC 认一个已知改版包（data/arcadeHacks.ts）。
 *
 * CRC 是白捡的：zip 的中央目录里本来就存着每个成员的 CRC-32，**不用解压**，
 * 二十几 MB 的街机包也是一瞬间的事。
 *
 * 认不出、包坏了、读取抛错都返回 null —— 这一步是锦上添花，
 * 绝不能因为它让本来能跑的游戏跑不起来。
 */
function hackOf(buf: ArrayBuffer): ArcadeHack | null {
  try {
    if (!isZip(buf)) return null
    return matchArcadeHack(listZipEntries(buf).map((e) => e.crc32))
  } catch {
    return null
  }
}

/**
 * 远程街机 ROM 不能继续把 URL 原样交给 EmulatorJS。
 *
 * 引擎自己的下载缓存曾把中断请求留下的空壳当成完整 ROM；之后 FBNeo 虽然能从文件名
 * 认出 kof98 驱动，却在空壳里找不到任何成员，于是一次报出十几个 missing files。
 * 这里先由站点完整下载并核对 ZIP 的中央目录，成功后再转成 blob:：
 *   - 不完整响应在进入核心前就会被拦住，玩家得到明确错误；
 *   - blob: 分支由我们的 EmulatorJS 补丁使用 EJS_gameName，文件名稳定是 kof98.zip；
 *   - blob: 不会按旧的远程 URL 命中 EmulatorJS-Cache，杜绝半截 ROM 复活。
 */
export async function prepareRemoteArcadeRom(
  url: string,
  onProgress: MountOptions['onProgress'],
  signal: AbortSignal,
): Promise<{ url: string; name: string; hack: ArcadeHack | null }> {
  const name = arcadeRomsetName(url)
  if (!name || !/\.zip$/i.test(name)) throw new InvalidArcadeArchiveError(name || 'ROM')

  // ROM 不可变，反复玩同一款街机游戏没必要每次重下。缓存里的那份一定是下面
  // 验过中央目录才写进去的，半截 ZIP 永远进不来，所以命中后不用再验一遍。
  const cacheKey = romCacheKey(url)
  if (cacheKey) {
    const cached = await romCacheGet(cacheKey)
    if (cached) {
      if (signal.aborted) throw new DOMException('已取消', 'AbortError')
      // 命中也要发满进度那一帧：播放器的加载遮罩靠进度回调收尾
      onProgress?.({ phase: 'rom', loaded: cached.byteLength, total: cached.byteLength, ratio: 1 })
      // 缓存这一路也要认一遍：第二次玩同一款改版包不能因为走了缓存就少了 dat
      return { url: URL.createObjectURL(new Blob([cached], { type: 'application/zip' })), name, hack: hackOf(cached) }
    }
  }

  const data = await fetchWithProgress(url, {
    phase: 'rom',
    onProgress,
    signal,
    check: (res) => {
      const type = res.headers.get('content-type') ?? ''
      // 地址或反代配错时，SSR 常会回 200 + HTML；状态码正常也绝不能交给核心。
      if (/text\/html|application\/xhtml/i.test(type)) throw new InvalidArcadeArchiveError(name)
    },
  })
  // 只看开头的 PK 还不够：截断文件通常仍有正确文件头；中央目录在末尾，能列出来才算完整。
  let entryCount = 0
  try {
    entryCount = isZip(data) ? listZipEntries(data).length : 0
  } catch {
    // 畸形偏移可能让 DataView 主动抛错；对玩家而言同样就是损坏的 ZIP。
  }
  if (entryCount === 0) throw new InvalidArcadeArchiveError(name)

  // 不 await：下面 Blob 会自己复制一份字节，data 不会被谁 transfer 走，写盘慢也不耽误开局。
  if (cacheKey) void romCachePut(cacheKey, data).catch(() => {})

  const blobUrl = URL.createObjectURL(new Blob([data], { type: 'application/zip' }))
  return { url: blobUrl, name, hack: hackOf(data) }
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
  /**
   * 联机会话。**可变**：一开始可能没有（玩家先自己开着玩），
   * 后面点「联机匹配」时由 openNetplay() 补进来，游戏不用重开。
   */
  let netplay = options.netplay
  /**
   * 房间分组用的数字 id。**始终**算出来，不再只在有联机会话时才有 ——
   * 玩家可能玩到一半才点「联机匹配」，那时引擎的配置已经定死，来不及再补。
   * 自己上传的 ROM（local: 前缀）没有 slug 可归组，留空即可。
   */
  const gameId =
    options.netplay?.gameId ??
    (options.gameSlug && !options.gameSlug.startsWith('local:') ? gameIdFor(options.gameSlug) : undefined)

  const iframe = document.createElement('iframe')
  iframe.title = fmt(rt.emulatorTitle, { name: options.gameName })
  iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#0b0b0f'
  iframe.setAttribute('allow', 'fullscreen; gamepad; autoplay; camera; microphone; clipboard-write')
  iframe.srcdoc = FRAME_HTML

  let destroyed = false
  let playersTimer = 0
  let stateTimer = 0
  let saveFlushTimer = 0
  /** 联机存档托管失败只报第一次，免得每 10 秒刷一条 */
  let stateUploadWarned = false
  /** 开局标志：EJS_onGameStart 与兜底轮询谁先到都行，但只放行一次 */
  let started = false
  let startWatch = 0
  /** 最近一次「引擎还在动」的时刻，卡死检测用 */
  let lastBeat = Date.now()
  /** 引擎自己那行状态文字上次的内容，变了就算有动静 */
  let lastStage = ''
  const beat = () => {
    lastBeat = Date.now()
  }
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
   * 存档能力必须**真调一次**才算数。
   *
   * 光看 `typeof gameManager.getState === 'function'` 查不出任何问题 —— 那是类方法，
   * 永远在。真正会断的是它内部依赖的核心导出：引擎自建自 main（自称 4.3.0-pre）走
   * `Module.EmulatorJSGetState`，而 cores/ 里 npm 发布版的核心只导出老 ABI 的
   * `save_state_info`，对不上时 getState() 抛 TypeError，玩家点保存只看到引擎那句
   * 红字「FAILED TO SAVE STATE」，而按钮一直亮着。
   * 这个不匹配已经由 scripts/patch-emulatorjs.mjs 的「存档 ABI 回退」补住，
   * 这里是第二道闸：升级引擎忘了重跑补丁时，至少按钮会自己灭掉。
   *
   * 失败不当场下结论：有些核心要跑过几帧才给得出存档，开局那一瞬取到的是空的。
   * 先隔 1.5s 复查一次，两次都不行才摘掉能力并重新广播。
   */
  const probeSaveState = (retry = true) => {
    if (destroyed || !caps.has('saveState')) return
    // 核心自己就说不支持（街机的一些驱动），不用等重试，当场摘掉
    try {
      const gm = emuOf()?.gameManager
      if (typeof gm?.supportsStates === 'function' && !gm.supportsStates()) {
        caps.delete('saveState')
        options.onCaps?.(caps)
        return
      }
    } catch {
      /* 问不出来就当支持，交给下面真调一次 */
    }
    let ok = false
    try {
      ok = Boolean(emuOf()?.gameManager?.getState?.()?.length)
    } catch (e) {
      logEngine(`[probeSaveState] ${e instanceof Error ? e.message : String(e)}`)
      ok = false
    }
    if (ok) return
    if (retry) {
      window.setTimeout(() => probeSaveState(false), 1500)
      return
    }
    caps.delete('saveState')
    options.onCaps?.(caps)
  }

  /**
   * 把电池存档从核心刷进 /data/saves（随后由 IDBFS 的 autoPersist 同步进 IndexedDB）。
   * 幂等且便宜：一份 .srm 通常几十到一百多 KB，写重复内容也没关系。
   */
  const flushSaveFiles = () => {
    if (!started) return
    try {
      emuOf()?.gameManager?.saveSaveFiles?.()
    } catch (e) {
      logEngine(`[saveFiles] ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * 页面转入后台时补刷一次。
   *
   * 这是最要紧的一个时点：切标签页、最小化、手机按 home —— 移动端浏览器常常从这个
   * 状态直接把页面回收掉，玩家再回来就发现存档退回上一次自动保存。这时页面还活着，
   * autoPersist 的异步同步跑得完，和 destroy 那一刀不一样。
   */
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flushSaveFiles()
  }

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
    // 上面广播完再探：探测失败时它会自己再广播一次（可能是 1.5s 之后）
    probeSaveState()
  }
  /** 服务端下发的房间令牌，上传存档要用 */
  let stateToken = ''
  /**
   * 把 room-token 的监听挂到 socket **诞生的那一刻**。
   *
   * 服务端是在 open-room / join-room 的 ack 之后紧接着发 room-token 的，前后差几毫秒；
   * 而下面那个一秒一次的轮询要等看到 n.socket 才挂监听 —— 十有八九已经错过了。
   * 错过的后果：上传存档没有令牌可用，房主的进度托管整个不工作。
   * 所以在 EmulatorJS 调 io() 建 socket 的瞬间就把监听挂上：把 iframe 里的 io 包一层 Proxy，
   * 函数上挂着的那些属性（io.connect、io.Manager…）Proxy 会原样透出去。
   */
  const hookRoomToken = (win: Window & Record<string, unknown>) => {
    const realIo = win.io
    if (typeof realIo !== 'function' || (realIo as { __8bit?: boolean }).__8bit) return
    const proxy = new Proxy(realIo as (...a: unknown[]) => unknown, {
      apply(target, thisArg, args) {
        const sock = Reflect.apply(target, thisArg, args) as { on?: (ev: string, cb: (d: unknown) => void) => void } | undefined
        try {
          sock?.on?.('room-token', (d: unknown) => {
            const token = (d as { token?: string } | null)?.token
            if (!token) return
            stateToken = token
            netplay?.onToken?.(token)
          })
        } catch {
          /* 不是 socket.io 的 socket？那就算了，轮询那边还有一次兜底 */
        }
        return sock
      },
    })
    ;(proxy as unknown as { __8bit: boolean }).__8bit = true
    win.io = proxy
  }
  /** 关页面前补传存档用 */
  let flushState: (() => void) | null = null
  /** 引擎日志探针。街机 ROM 排查全靠它 —— 详见 installErrorTap */
  let errorTap: { lines: string[] } | null = null
  /**
   * 往引擎日志里补一条我们自己的观察。
   * 探针只收 iframe 里的 console，适配器这一侧抓到的异常（比如取存档抛的 TypeError）
   * 进不去，但那恰恰是排查时最想看到的一条，所以手动塞进同一个缓冲区。
   */
  const logEngine = (line: string) => {
    if (!errorTap) return
    errorTap.lines.push(line.slice(0, 500))
    if (errorTap.lines.length > LOG_LIMIT) errorTap.lines.shift()
  }
  const reportedErrors = new Set<string>()
  /** 开局前的致命错误：报上去并停掉轮询（播放器收到 onError 会把这局拆掉） */
  const failLoad = (message: string) => {
    if (destroyed || started) return
    window.clearInterval(startWatch)
    options.onError?.(message)
  }
  /**
   * 同一句话可能被核心打好几遍，只报第一次，免得把界面刷成一片红。
   *
   * ⚠️ 只在**开局前**往上报。播放器收到 onError 会把这局拆掉（进度全丢），而 FATAL_HINTS
   * 那几个词（missing / failed to load / bios…）在游戏跑起来之后照样会出现 —— 比如玩家
   * 手动载入一份不兼容的即时存档，核心打一行 "Failed to load state"，就因为这一句把
   * 正在玩的游戏毙掉，是惩罚而不是报错。跑起来之后的错误只进日志探针。
   */
  const reportEngineError = (line: string) => {
    if (destroyed || !line || reportedErrors.has(line)) return
    reportedErrors.add(line)
    if (started) {
      logEngine(`[engine] ${line}`)
      return
    }
    options.onError?.(fmt(rt.ejsEngineError, { msg: line }))
  }
  // 本地文件转成 blob: URL（同源 iframe 可直接访问）；gameName 用原始文件名以保留扩展名
  const isFile = typeof options.game !== 'string'
  const remoteGameUrl = isFile ? '' : (options.game as string)
  let gameUrl = isFile ? URL.createObjectURL(options.game as File) : remoteGameUrl
  let engineGameName = isFile ? (options.game as File).name : options.gameName
  /** 远程街机 ROM 的预下载可以随会话销毁立刻取消，避免切游戏后还在后台吞几十 MB。 */
  const prepareAbort = new AbortController()
  /** 预下载生成的 blob:。引擎通常会自行回收，销毁时再兜一次是幂等的。 */
  let preparedArcadeBlobUrl = ''
  /** 区分「ROM 预下载失败」与后续 loader.js / 核心加载失败，避免错误提示张冠李戴。 */
  let arcadeRomPrepared = false
  /** 按指纹认出来、由 data/arcadeHacks.ts 提供的 RomData。管理员填了的话不会用到 */
  let builtInRomData = ''

  /**
   * 开 / 加入房间。两个入口：
   *   1. 带着联机会话挂载的（点邀请链接进来的人）—— finishStart 里自动调
   *   2. 已经在玩了，中途点「联机匹配」—— handle.openNetplay() 调
   * 两种情况都必须等游戏真的跑起来：房主要先有画面才能推给别人。
   */
  const startNetplay = (win: Window & Record<string, unknown>) => {
    // netplay 是可变的（中途开房会后补），闭包里收窄不了 —— 先钉在局部常量上
    const cfg = netplay
    if (destroyed || !cfg) return
    // 上一个房间的令牌对新房间没用，别让它冒充「已经拿到令牌」
    stateToken = ''
    stateUploadWarned = false
    const emu = win.EJS_emulator as EjsEmulator | undefined
    const np = emu?.netplay
    /**
     * 开不了房怎么报：带着联机会话挂载进来的（点邀请链接的访客、接手房主的人），联机开不了
     * 这局就没意义，走 onError。玩到一半点「联机匹配」的，游戏本身好好地在跑 ——
     * onError 会让播放器把这局拆掉，那是惩罚不是报错；只收回会话、通知界面复位。
     */
    const fromMount = cfg === options.netplay
    const failNetplay = (message: string) => {
      if (fromMount) {
        options.onError?.(message)
        return
      }
      console.warn('[netplay]', message)
      if (netplay === cfg) netplay = undefined
      cfg.onHostLeft?.()
    }
    if (!np) {
      failNetplay(rt.netplayUnavailable)
      return
    }
    np.name = cfg.playerName

    // 接手别人的房间：先把存档载进去，不然游戏会从开机画面重来
    if (cfg.initialState && emu?.gameManager) {
      try {
        emu.gameManager.loadState(cfg.initialState)
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
    applyRole(cfg.role === 'spectator')
    cfg.onSpectatorControl?.(applyRole)

    try {
      if (cfg.mode === 'join' && cfg.roomId) {
        np.joinRoom(cfg.roomId, cfg.roomName, cfg.maxPlayers, cfg.password || null)
      } else {
        np.openRoom(cfg.roomName, cfg.maxPlayers, cfg.password || '')
      }
    } catch (e) {
      failNetplay(fmt(rt.netplayFailed, { msg: e instanceof Error ? e.message : String(e) }))
      return
    }

    // netplay 没有对外的事件回调，只能轮询它自己的状态（很轻，一秒一次）。
    // 中途开房时先把上一轮的定时器收掉，别叠成两条。
    window.clearInterval(playersTimer)
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
            cfg.onToken?.(token)
          })
        }
      }

      const count = Object.keys(n.players || {}).length
      if (count !== lastCount) {
        lastCount = count
        cfg.onPlayers?.(count)
      }
      // 房主的房间 id 是客户端生成的，只能从 extra 里取
      const extra = (n as unknown as { extra?: { sessionid?: string } }).extra
      if (extra?.sessionid && extra.sessionid !== reportedRoom) {
        reportedRoom = extra.sessionid
        cfg.onRoom?.(extra.sessionid, n.owner)
        // 房主开始定期上传存档，掉线时新房主就能接着玩
        if (n.owner) startStateUpload(win, extra.sessionid)
      }
      if (n.playerID && n.playerID !== reportedId) {
        reportedId = n.playerID
        cfg.onIdentity?.(n.playerID)
      }
      // 信令断开。EmulatorJS 的 socket 一 disconnect 就自己 leaveRoom 了 —— 不管是谁的网抖，
      // 这个 netplay 实例都已经退了房，不会自己重连回去。所以两边都得告诉播放器：
      //   访客：多半是自己网络抖了，房间大概还在，让播放器查一下再决定重进还是报错
      //   房主：房间在服务器那边已经进入换房主流程，游戏本身还在跑；进度托管得停，
      //         否则接下来每 10 秒一次 403（以前这里 return 掉，界面一直挂着一个不存在的房间）
      if (reportedRoom && !n.socket?.connected) {
        window.clearInterval(playersTimer)
        window.clearInterval(stateTimer)
        stateTimer = 0
        if (flushState) {
          window.removeEventListener('pagehide', flushState)
          flushState = null
        }
        // 会话作废：不清的话 openNetplay() 会一直以为「已经在房间里」，房主断线后
        // 再点「联机匹配」永远是「现在开不了房」，只能刷新页面
        if (netplay === cfg) netplay = undefined
        cfg.onHostLeft?.()
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
      // 只用房间令牌。以前没令牌就退回 playerID，可服务端那条路是谁都能伪造的，已经关掉；
      // 令牌现在在 socket 诞生时就挂了监听（hookRoomToken），拿不到才是异常
      const auth = stateToken
      if (!auth) {
        if (!stateUploadWarned) {
          stateUploadWarned = true
          console.warn('[netplay] 没有房间令牌，房主进度托管未启动')
        }
        return
      }
      let state: Uint8Array | undefined
      try {
        state = emu.gameManager.getState()
      } catch (e) {
        // 有些核心在某些时刻取不到存档，跳过这一轮就行。但如果是引擎和核心的 ABI
        // 对不上，这里会**每一轮都失败**且永远没人知道（房主以为进度在托管，
        // 接手的人却拿到空的）—— 所以第一次一定要留下痕迹。
        if (!stateUploadWarned) {
          stateUploadWarned = true
          logEngine(`[netplay] getState 失败，房主进度托管已停摆：${e instanceof Error ? e.message : String(e)}`)
          console.warn('[netplay] 取存档失败，房主进度托管已停摆', e)
        }
        return
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

  /** 引擎自带的屏幕按键这台设备上到底有没有（触屏 + 引擎真画得出来），决定要不要给开关 */
  let padAvailable = false
  /** 现在显示着没有 */
  let padShown = false

  /** 把两个「屏幕上有什么」的能力同步给播放器：开局提示和工具栏开关都看它们 */
  const syncTouchCaps = (pointer: boolean) => {
    if (padShown) caps.add('enginePad')
    else caps.delete('enginePad')
    if (pointer) caps.add('enginePointer')
    else caps.delete('enginePointer')
    options.onCaps?.(caps)
  }

  /**
   * 触屏设备上，引擎给画布挂了 `ejs-canvas-no-pointer`（CSS 里就是 pointer-events:none），
   * 好让虚拟手柄浮在上面接手指。可它是在**构造函数**里按 isMobile/hasTouchScreen 一次性加的，
   * 跟虚拟手柄的开关无关 —— 玩家把手柄关掉，这个类也不会摘。
   *
   * 对 NDS 这种「机器本身就是触屏」的平台，这一条等于把游戏废了：核心的鼠标 / 触摸事件是
   * Emscripten 绑在 `Module.canvas`（就是 emu.canvas）上的，画布不收指针事件，
   * 下屏就一下也点不到。《瓦力欧制造 触摸版》《押忍！战斗！应援团》这类纯触控笔的游戏
   * 在手机上直接没法玩。
   */
  const setCanvasPointer = (emu: EjsEmulator, on: boolean) => {
    if (on) emu.canvas?.classList.remove('ejs-canvas-no-pointer')
    else emu.canvas?.classList.add('ejs-canvas-no-pointer')
  }

  /**
   * 开局后把触屏输入摆正：谁接手指、屏幕按键要不要画。
   *
   * ── 为什么要管虚拟手柄 ─────────────────────────────────────
   * EmulatorJS 显示虚拟手柄的条件是 `this.touch`（startGame 末尾那句
   * `this.touch && (this.virtualGamepad.style.display = "")`），而 touch 只在
   * **玩家用手指点了「开始游戏」按钮**时才置 true —— 监听挂在 createStartButton
   * 建出来的那个按钮上。我们设了 EJS_startOnLoaded，按钮建出来就被程序自己点掉了，
   * 玩家的手指从来没碰到它，于是 touch 永远是 false，虚拟手柄一直是 display:none。
   *
   * ── 指针优先的平台默认不画按键 ─────────────────────────────
   * 引擎的虚拟手柄是 `position:absolute; bottom:50px; width:100%`，正正压在画面下半部分 ——
   * 而 NDS 的触摸屏就是下面那块。默认收起来，把整块屏幕留给手指；需要实体按键的游戏
   * （马力欧赛车 DS 之类）玩家可以在工具栏 🎮 里调回来（handle.setEnginePad）。
   *
   * 触屏判断优先用引擎自己算好的 isMobile / hasTouchScreen，拿不到再自己看指针类型；
   * matchMedia 要在 iframe 那个 window 上问，不是外面这个。
   * 玩家在设置里主动关掉过虚拟手柄就尊重他的选择，不强行打开。
   */
  const applyTouchInput = (win: Window & Record<string, unknown>) => {
    const emu = win.EJS_emulator as EjsEmulator | undefined
    if (!emu) return
    const coarse = typeof win.matchMedia === 'function' && win.matchMedia('(any-pointer:coarse)').matches
    if (!emu.isMobile && !emu.hasTouchScreen && !coarse) return

    // 这台机器本身就是靠戳屏幕玩的 → 画布必须收得到指针事件
    const pointerFirst = POINTER_FIRST.has(options.platform)
    if (pointerFirst) setCanvasPointer(emu, true)

    /*
      先真的打开一次，**确认它真的画出来了**，再决定要不要留着。

      光看 toggleVirtualGamepad 存在不算数。那个容器是 setVirtualGamepad() 按核心
      的按键表填的，核心认不出来时会是个空 div；CSS 没加载时 display 也可能还是 none。
      两样都验一遍，padAvailable 才作数 —— 工具栏那个开关和开局提示都靠它，
      说错了比不说更糟：玩家会照着提示在画面上乱按。

      注意「能不能画」和「默认画不画」是两回事：玩家在引擎设置里关过虚拟手柄，
      那只决定默认收起，**不代表这台设备画不出来**。要是把它当成不可用，
      工具栏那个开关就会变成一颗按了没反应的死按钮。
      中间这一开一关在同一个任务里跑完，不会真的闪一下。
    */
    emu.touch = true
    emu.toggleVirtualGamepad?.(true)
    const pad = emu.virtualGamepad
    padAvailable = Boolean(pad && pad.children.length > 0 && win.getComputedStyle(pad).display !== 'none')

    // 默认收起的两种情况：指针优先的平台（别压着触摸屏）、玩家自己在引擎设置里关过
    const settingOff = emu.getSettingValue?.('virtual-gamepad') === 'disabled'
    padShown = padAvailable && !pointerFirst && !settingOff
    if (padAvailable) emu.toggleVirtualGamepad?.(padShown)
    syncTouchCaps(pointerFirst)
  }

  /** 工具栏那个「屏幕按键」开关走这里。引擎压根没画出按键时是空操作 */
  const setEnginePad = (show: boolean) => {
    if (!padAvailable) return
    const emu = emuOf()
    if (!emu) return
    emu.touch = true
    emu.toggleVirtualGamepad?.(show)
    padShown = show
    syncTouchCaps(caps.has('enginePointer'))
  }

  /**
   * 撤加载遮罩的唯一入口。
   *
   * ⚠️ 以前接的是 EJS_ready，那是个陷阱：EmulatorJS 在建完「开始游戏」按钮之后 20ms
   * 就发 ready（见 emulator.js 的 createStartButton），这时核心和 ROM 一个字节都还没下。
   * 遮罩一撤，露出来的正是引擎自己那行「下载游戏数据 16%」—— 玩家看到的是文字而不是
   * 进度条，而且这时候按键根本没人接。真正「能玩了」的信号是 start，
   * 它在 startGame() 的最后一行发出，那时画布已经挂上、主循环已经在跑。
   */
  const finishStart = (win: Window & Record<string, unknown>) => {
    if (started || destroyed) return
    started = true
    window.clearInterval(startWatch)
    options.onReady?.()
    options.onStart?.()
    refineCaps()
    applyTouchInput(win)
    /*
      把焦点交给 iframe —— 手柄和键盘都指着它。

      玩家点的「▶ 开始」在外层页面上，不主动交焦点的话 iframe 一直没有焦点：
      引擎在里面读 navigator.getGamepads() 只能读到一串 null（手柄按下的那一刻
      哪个文档有焦点才给哪个），键盘监听也收不到 keydown。见 frameFocus.ts。
    */
    focusFrame(iframe)
    // 电池存档的补刷：定时 + 转入后台。两者都只在开局之后才有意义
    saveFlushTimer = window.setInterval(flushSaveFiles, SAVE_FLUSH_MS)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', flushSaveFiles)
    if (netplay) startNetplay(win)
  }

  /**
   * 开局前的兜底轮询（400ms 一次，开局或销毁即停）。管三件事：
   *
   * 1. **引擎起不来时把话接出来**。startGameError() 只把错误写进它自己那个加载框，
   *    外加一句 console.log —— 级别太低，错误探针（只收 error / warn）逮不着；
   *    而那个框正被遮罩盖着，不接出来的话玩家就对着一块黑屏干等。
   * 2. **start 事件万一没来**。走 CDN 的 EmulatorJS 版本随时会变，多认一个
   *    emulator.started 标志，比只认事件保险 —— 否则遮罩就再也撤不掉了。
   * 3. **卡死了要有个交代**。EmulatorJS 有好几处 promise 断在半路就再也不 resolve
   *    （4xx/5xx 的 TypeError 死锁是一种，syncfs 之类被 IndexedDB 挡住是另一种），
   *    这时候它既不报错也不动 —— 遮罩会一直挂着。超过 STALL_MS 没动静就报出来，
   *    并且**把引擎当时那行状态文字一起带上**：那行字（「下载游戏数据 100%」
   *    「解压游戏数据」）直接指出卡在哪一步，否则这种问题根本没法查。
   */
  const watchStart = (win: Window & Record<string, unknown>) => {
    // 从「真正开始盯」这一刻起算。lastBeat 的初值是挂载时刻，而挂载和这里之间隔着街机 ROM 的
    // 预下载（几十 MB 的 romset 在慢网上要几十秒）—— 不重置的话第一拍就判成「卡住了」，
    // 白白下完的 ROM 被扔掉重来
    beat()
    startWatch = window.setInterval(() => {
      if (destroyed || started) {
        window.clearInterval(startWatch)
        return
      }
      const doc = iframe.contentDocument
      const msg = doc?.querySelector('.ejs_error_text')?.textContent?.trim()
      if (msg) {
        window.clearInterval(startWatch)
        reportEngineError(msg)
        return
      }
      if ((win.EJS_emulator as EjsEmulator | undefined)?.started) {
        finishStart(win)
        return
      }
      const stage = doc?.querySelector('.ejs_loading_text')?.textContent?.trim() ?? ''
      if (stage !== lastStage) {
        lastStage = stage
        beat()
      }
      if (Date.now() - lastBeat > STALL_MS) failLoad(fmt(rt.ejsStalled, { stage: lastStage || core }))
    }, 400)
  }

  iframe.addEventListener('load', () => {
    if (destroyed) return
    const win = iframe.contentWindow as (Window & Record<string, unknown>) | null
    const doc = iframe.contentDocument
    if (!win || !doc) {
      options.onError?.(rt.ejsInitFailed)
      return
    }
    void (async () => {
      try {
        /**
         * 只处理「远程 + 街机」：本地文件本来就是 Blob，其他平台的压缩包需要让引擎照常
         * 解开，不能一刀切。必须在写 EJS_* 和加载 loader.js 之前完成，否则引擎会抢先
         * 读取旧 URL，这一局里再改全局变量已经来不及。
         */
        if (!isFile && options.platform === 'arcade') {
          const prepared = await prepareRemoteArcadeRom(
            remoteGameUrl,
            (p) => {
              beat() // 下载在动就不算卡
              options.onProgress?.(p)
            },
            prepareAbort.signal,
          )
          if (destroyed) {
            URL.revokeObjectURL(prepared.url)
            return
          }
          preparedArcadeBlobUrl = prepared.url
          gameUrl = prepared.url
          engineGameName = prepared.name
          arcadeRomPrepared = true

          /**
           * 后台没填 RomData，而这个包按指纹认出来是已知改版包 → 用内置的那份。
           *
           * 为什么要有这条：改版包（汉化版 / 修改版）不在 FBNeo 的驱动表里，没有 dat
           * 一定报 Romset is unknown。以前这份 dat 只有两个来源 —— 管理员在后台手贴，
           * 或者玩家走「运行我的 ROM」时由 arcadeHack.ts 现认。同一张指纹表
           * （data/arcadeHacks.ts）两条路只接了一条，库里的游戏全靠人不忘记贴。
           *
           * **管理员填了就以他为准**：他可能针对这一份包改过清单，自动的不该盖掉。
           *
           * 包名也要跟着换成 dat 里的 ZipName —— 核心会 BurnDrvSetZipName(ZipName)
           * 然后去找**那个名字**的包，对不上等于没配。只在走自动这一路时改，
           * 手写 dat 的 ZipName 是管理员自己定的，不能替他改。
           */
          if (!options.arcadeRomData?.trim() && prepared.hack?.romData) {
            builtInRomData = prepared.hack.romData
            engineGameName = `${prepared.hack.zipName}.zip`
            console.info(`[arcade] 按指纹认出改版包：${prepared.hack.title}（借 ${prepared.hack.driver} 驱动），已套用内置 RomData`)
          }
        }

        Object.assign(win, {
          EJS_player: '#game',
          EJS_core: core,
          EJS_gameUrl: gameUrl,
          EJS_gameName: engineGameName,
          EJS_pathtodata: EJS_PATH,
          // 平台级 BIOS。Neo Geo 这类平台不给就直接起不来；不需要 BIOS 的平台
          // 这里是空串，等于没设
          ...(options.biosUrl ? { EJS_biosUrl: options.biosUrl } : {}),
          EJS_color: '#0078f2',
          EJS_backgroundColor: '#0b0b0f',
          // 跟着站点语言走。切语言是整页跳转（见 services/lang.ts 的 setLang），
          // 所以这里每次挂载读到的都是当前语言，不会残留上一次的
          EJS_language: EJS_LANG[getLang()],
          EJS_startOnLoaded: true,
          EJS_volume: 0.6,
          // ⚠️ 这里**故意不接** EJS_ready：它在核心和 ROM 开始下载之前就发了，详见 finishStart
          EJS_onGameStart: () => finishStart(win),
          // 联机相关（没有 netplay 会话时也设上，用户可以自己点模拟器里的联机按钮）
          ...(NETPLAY_URL
            ? {
                EJS_netplayUrl: NETPLAY_URL,
                EJS_netplayICEServers: ICE_SERVERS,
                // ⚠️ loader.js 读的是 EJS_gameID（大写 ID），写成 EJS_gameId 等于没设：
                // 房间的 game_id 会是 undefined，大厅永远认不出这个房间是哪款游戏。
                ...(gameId !== undefined ? { EJS_gameID: gameId } : {}),
              }
            : {}),
        })

        // 录像要取声音，必须赶在 loader.js 建 AudioContext 之前装探针
        audioTap = installAudioTap(win)

        // 引擎的报错探针也要赶在 loader.js 之前装：核心是在加载过程中打错误的，
        // 装晚了那句「缺哪个文件」就已经过去了
        errorTap = installErrorTap(win, reportEngineError)

        // RomData 也要赶在 loader.js 之前装：它靠接管 window.EJS_emulator 的赋值来生效，
        // loader.js 第一行就把实例挂上去了，晚一步就接不着。
        // 文件名必须和 ROM 同名（wofcn.zip → /wofcn.dat），这是核心自己的查找规则。
        const romData = options.arcadeRomData?.trim() || builtInRomData
        if (romData) {
          const datPath = `/${engineGameName.replace(/\.[^.]*$/, '')}.dat`
          installRomDataInjector(win, datPath, `${romData}\n`, (msg) => {
            if (!destroyed) options.onError?.(fmt(rt.ejsRomDataFailed, { msg }))
          })
        }

        // 网络探针也要赶在 loader.js 之前包好，否则核心那一趟就漏过去了
        installNetTap(win, {
          gameUrl,
          biosUrl: options.biosUrl,
          live: () => !destroyed && !started,
          onProgress: options.onProgress,
          onBeat: beat,
          onFailed: (status, url) => failLoad(fmt(rt.ejsRomFailed, { status: String(status), url })),
        })

        // 开局之前一直盯着：引擎报错要接出来，start 事件不来也得有个台阶下
        watchStart(win)

        // socket.io 客户端必须在 loader.js 之前就位：netplay 用的是全局 io()
        if (NETPLAY_URL) {
          await injectScript(doc, socketIoScriptUrl()).catch(() => {
            // 信令服务器不可达时不阻断单机游戏，只是联机用不了。
            // ⚠️ onError 对播放器来说就是「这局完了」（重试一次然后拆掉），没有「警告」这一档 ——
            // 以前这里不管有没有联机会话都往上报，信令一挂（或者被广告拦截器拦掉脚本），
            // 全站所有 EmulatorJS 游戏都起不来。现在只有带着联机会话进来的才算致命
            if (destroyed) return
            logEngine(`[netplay] socket.io 脚本加载失败：${socketIoScriptUrl()}`)
            if (netplay) options.onError?.(fmt(rt.netplaySignalUnreachable, { url: socketIoScriptUrl() }))
          })
          hookRoomToken(win)

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
          // 必须在 loader.js 之前装，否则 netplay 拿到的是原生构造函数 ——
          // 也正因为「之后再装就来不及」，这里不管当下有没有联机会话都装上：
          // 玩到一半点「联机匹配」的那一路同样要靠它。回调读的是当前的 netplay。
          instrumentRtc(win, (state) => netplay?.onLinkState?.(state))
        }
        if (destroyed) return
        // 清掉旧时代缓存的坏核心（见 purgePoisonedEngineCache 的注释），
        // 必须在 loader.js 之前 —— 引擎一起来就会去查这个库
        await purgePoisonedEngineCache()
        if (destroyed) return
        await injectScript(doc, `${EJS_PATH}loader.js`)
      } catch (error) {
        // 加载过程中被销毁的，别再往新会话上报错
        if (destroyed) return
        if (error instanceof InvalidArcadeArchiveError) {
          options.onError?.(fmt(rt.ejsArcadeRomInvalid, { name: error.message }))
          return
        }
        if (error instanceof DOMException && error.name === 'AbortError') return
        // 远程街机 ROM 的预下载也在这条链路里；把真实网络错误带出来，
        // 不要一律误报成「EmulatorJS 资源加载失败」。
        if (!isFile && options.platform === 'arcade' && !arcadeRomPrepared) {
          const message = error instanceof Error ? error.message : String(error)
          options.onError?.(fmt(rt.ejsArcadeRomDownloadFailed, { msg: message }))
          return
        }
        options.onError?.(fmt(rt.ejsLoadFailed, { path: EJS_PATH }))
      }
    })()
  })

  container.appendChild(iframe)
  options.onCaps?.(caps)

  const destroy = () => {
    destroyed = true
    prepareAbort.abort()
    window.clearInterval(playersTimer)
    window.clearInterval(stateTimer)
    window.clearInterval(startWatch)
    window.clearInterval(saveFlushTimer)
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', flushSaveFiles)
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
    audioTap = null
    if (isFile) URL.revokeObjectURL(gameUrl)
    if (preparedArcadeBlobUrl) URL.revokeObjectURL(preparedArcadeBlobUrl)

    /**
     * 拆 iframe 之前把电池存档刷出去。
     *
     * 核心每 60 秒才写一次 .srm（见 SAVE_FLUSH_MS 那段），页面内切游戏 / 返回 / 换模式走的是这里，
     * 没有 pagehide —— 玩家在 RPG 里存完档、半分钟内点了别的游戏，那次存档就没了，而游戏明明
     * 告诉他「已保存」。所以先 cmd_savefiles 把 SRAM 写进 /data/saves，再让 IDBFS 有机会把它
     * 同步进 IndexedDB：能拿到 FS.syncfs 就等它回调，拿不到给一小段时间；iframe 先隐藏，
     * 玩家看不到这段延迟。
     */
    flushSaveFiles()
    let torn = false
    const tearDown = () => {
      if (torn) return
      torn = true
      try {
        iframe.srcdoc = ''
        iframe.src = 'about:blank'
      } catch {
        /* ignore */
      }
      iframe.remove()
    }
    iframe.style.display = 'none'
    if (!started) return tearDown()
    try {
      const fs = (emuOf()?.gameManager as { FS?: { syncfs?: (populate: boolean, cb: () => void) => void } } | undefined)?.FS
      if (typeof fs?.syncfs === 'function') fs.syncfs(false, tearDown)
    } catch {
      /* 没有 syncfs 就只靠下面的延时 */
    }
    window.setTimeout(tearDown, 1500)
  }

  return {
    caps,
    destroy,
    // EmulatorJS 默认 0.6，工具栏滑块要跟它对上
    volume,
    engineLog: () => errorTap?.lines.slice() ?? [],
    focus: () => focusFrame(iframe),
    gamepads: () => frameGamepads(iframe),
    setEnginePad,
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
      let state: Uint8Array | undefined
      try {
        state = emuOf()?.gameManager?.getState?.()
      } catch (e) {
        // 引擎和核心的存档 ABI 对不上时这里抛的是 TypeError，原文（"this.Module.
        // EmulatorJSGetState is not a function"）对玩家毫无意义，而 EmulatorTools
        // 的 catch 是直接 say(e.message)。返回 null 让它显示已本地化的「存档失败」，
        // 技术原文留在 engineLog 里给我们看。
        logEngine(`[saveState] ${e instanceof Error ? e.message : String(e)}`)
        return null
      }
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
    /**
     * 在**正在跑的这一局**上开房，不重开游戏。
     *
     * 为什么值得这么绕：联机会话本来是挂载参数，想开房就得重新挂载一次引擎 ——
     * 玩家打到一半点「联机匹配」，游戏会退回开机画面，这一局白打。
     * 而 EmulatorJS 的 netplay 实例其实一直都在（openRoom 只是个普通方法），
     * 需要的前置条件（socket.io、ICE、RTC 包装、gameId）在挂载时就已经备齐了，
     * 所以这里只要把会话配置补进来、再走一遍 startNetplay 即可。
     *
     * 返回 false 表示这局开不了房（引擎没起来、没有 netplay、或已经在房间里）。
     */
    openNetplay(session: NetplaySession): boolean {
      if (destroyed || !started || netplay) return false
      const win = iframe.contentWindow as (Window & Record<string, unknown>) | null
      const emu = win?.EJS_emulator as EjsEmulator | undefined
      if (!win || !emu?.netplay) return false
      // 引擎的 config 是开局前就定死的；房间的 game_id 从它读，中途开房得补写这一格
      if (emu.config && typeof session.gameId === 'number') emu.config.gameId = session.gameId
      netplay = session
      startNetplay(win)
      return true
    },
    /** 主动退房，回到自己一个人玩（游戏继续跑，不重开） */
    closeNetplay() {
      if (!netplay) return
      netplay = undefined
      window.clearInterval(playersTimer)
      window.clearInterval(stateTimer)
      // 归零，否则下次再点「联机匹配」时 startStateUpload 会以为定时器还在，进度托管不再启动
      stateTimer = 0
      if (flushState) {
        window.removeEventListener('pagehide', flushState)
        flushState = null
      }
      try {
        emuOf()?.netplay?.leaveRoom?.()
      } catch {
        /* 已经断了 */
      }
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
  /**
   * 详情页「运行时」那一格的后半截。
   *
   * 这里**不能**直接把 platformMap[platform].core 摆出去 —— 那是 EmulatorJS 内部的
   * 核心键（'arcade' / 'segaMD' / 'ws' 这种），既不是引擎名，也永远是英文小写，
   * 在中文/日文站上就是一行看不懂的字母（用户报的就是「EmulatorJS · arcade」）。
   *
   * 改成按站点语言取平台名：中文「街机」、英文「Arcade」、日文「アーケード」，
   * 用的是 t.platforms 里已有的那份，不需要新增词条。
   * 取不到（新平台还没进 locales）就退回 data/platforms.ts 里的原名，再退回 id ——
   * 无论如何不会出现空白或者 '—'。
   */
  engineLabel: (platform) =>
    platformMap[platform]?.core ? platformLabel(getT(), platform, platformMap[platform]?.name ?? platform) : '—',
  mount,
}

/** 该平台能否 P2P 联机：需要 EmulatorJS 能跑（即配了 core）且信令已配置 */
export function p2pPlayable(platform: string): boolean {
  return Boolean(NETPLAY_URL) && Boolean(platformMap[platform as keyof typeof platformMap]?.core)
}
