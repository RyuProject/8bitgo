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
 *   2. EJS_netplayUrl —— 信令地址（server/src/netplay.js）。⚠️ 必须是绝对地址：iframe 是 srcdoc，
 *      location 是 about:srcdoc，socket.io 拿相对地址会拼成 http://about:80/…（见 netplayUrlForFrame）
 *   3. EJS_gameId     —— 必须是数字，用来给房间分组（见 services/netplay.ts 的 gameIdFor）
 *
 * ⚠️ 官方 CDN 的 stable / nightly 目前都是 4.2.3，**不含 netplay**。
 *    要用联机必须自建 EmulatorJS 构建，见 docs 或 README。
 */
import type { PlatformId } from '@/types'
import { platformMap } from '@/data/platforms'
import { EJS_DEFAULT_CONTROLS } from '@/lib/keymapData'
import type { Capability, CaptureSources, LoadPhase, LoadProgress, MountOptions, RuntimeHandle, StageMode } from '../types'
import { fetchBlobWithProgress, fetchWithProgress, throttleProgress } from '../loadProgress'
import { romCacheGet, romCacheGetBlob, romCacheKey, romCachePut, romCachePutBlob } from '../romCache'
import { focusFrame, frameGamepads } from '../frameFocus'
import { installAudioTap, type AudioTap } from '../audioTap'
import { getT, fmt } from '@/services/i18n'
import { getLang } from '@/services/lang'
import type { Lang } from '@/config/languages'
import { ICE_SERVERS, NETPLAY_URL, fetchIceConfig, gameIdFor, netplayUrlForFrame, socketIoScriptUrl, uploadState } from '@/services/netplay'
import { guardInputChannel } from '../netplayGuard'
import { isZip, listZipEntries } from '@/lib/unzip'
import { matchArcadeHack, type ArcadeHack } from '@/data/arcadeHacks'
import { deriveArcadeHackBytes } from '../arcadeHack'

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
export { EJS_PATH } from '../paths'
import { EJS_PATH, isDiscPlatform, isSelfDownloadPlatform } from '../paths'
import { applyTuning, sizeOfTrack, tuningFor, usableVideoSize } from '../videoTuning'
import {
  findLayoutOption,
  findTouchModeOption,
  isDualScreen,
  isWideBox,
  parseCoreOptionsText,
  preferredLayout,
  showsTouchScreen,
  type LayoutOption,
  type TouchModeOption,
} from '../dualScreen'

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
/**
 * 联机的码率**下限**（不是固定值）。真正的码率由 videoTuning 按画面大小算，
 * 算出来低于这个数时按这个走。
 *
 * 给得比直播（1Mbps）宽：联机是 1 对 3，上行压力小得多，而访客的操作手感
 * 直接受画质影响 —— 看不清子弹和看不清像素是两回事。
 */
const NETPLAY_MIN_BITRATE = Number(import.meta.env.VITE_NETPLAY_MAX_BITRATE) || 2_000_000
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
 * 连着几轮拿不到房间令牌才报警。
 * 第一轮在开局后 3 秒，之后每 STATE_UPLOAD_MS 一轮 —— 3 轮 ≈ 23 秒，
 * 足够熬过一次慢握手，又不至于让真的失败埋太久。
 */
const MISS_BEFORE_WARN = 3
/**
 * 开房 / 进房最多等多久。信令握手 + open-room 的 ack 正常一两秒；移动网络、跨洋线路慢一些也就几秒。
 * 以前是 1 秒后看到 socket 没连上就按「房主断线」处理 —— 握手慢一点的正常用户开房就被拆掉。
 */
const JOIN_TIMEOUT_MS = 20_000
/** 多久把 EJS_netplayICEServers 续一次。TURN 凭证默认 1 小时过期，10 分钟一次很宽裕 */
const ICE_REFRESH_MS = 10 * 60_000
/** 信令报过 connect_error 且这么久还没连上，就不用等满 JOIN_TIMEOUT_MS 了（Mixed Content、服务器挂了） */
const SIGNAL_FAIL_MS = 6_000
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
  /*
    手机竖屏的游玩布局：容器竖着（比宽还高）时，画面缩到屏幕按键**上面**，两者不再互相压。

    引擎的画布是 width/height:100% + object-fit:contain + object-position:top ——
    「铺满容器、按比例缩、贴顶」；虚拟手柄则是 position:absolute; bottom:50px，贴着容器
    底部画。容器够高时两者本来就各占一头，只是引擎从不保证「够高」：手机竖屏里画面按 4:3
    是 290px 上下，手柄整套要 230px 以上（SNES/GBA 带 L/R 要 330px），容器不够高，
    手柄就整个压到画面上 —— 用户截图里拳皇 99 被按键糊满就是这样来的。
    这里把画布的高度扣掉手柄的实际高度（--pad-h，由适配器量出来写在 <html> 上，
    见 refreshPadMetrics），object-fit 会把画面缩进剩下的那块里，仍然贴顶、水平居中。

    只在竖着的容器里生效：横屏（手机横过来 / 桌面 / 横屏全屏）容器是宽的，画面本来就
    占满高度、手柄落在两侧黑边里，再扣高度只会把画面压成一条。
    !important 是为了盖住联机观众那张画布的行内样式（引擎给它写了 object-position:center）。
  */
  @media (orientation: portrait) {
    .ejs_canvas {
      height: calc(100% - var(--pad-h, 0px)) !important;
      object-position: top center !important;
    }
    /*
      SNES / GBA / 土星这几套把 L、R 挂在左右分区的 top:-100px（引擎写在行内样式里，所以要
      !important）—— 那是给横屏设计的：让肩键靠近屏幕上角。竖着叠放时它们只是把手柄整体
      拔高了 100px，画面就得再缩 100px（iPhone SE 上超任的画面只剩 200px 宽）。
      收到 -45px：刚好落在 X 键（分区顶上那颗）上方 14px，手柄矮了 55px，画面等比长回来。
      N64 的 L/R/Z 在 .ejs_virtualGamepad_top 里，不在这条规则内。
    */
    .ejs_virtualGamepad_left > .b_l,
    .ejs_virtualGamepad_right > .b_r {
      top: -45px !important;
    }
  }
  /*
    场合（RuntimeHandle.setStageMode，播放器写在 <html> 的 data-stage 上）：
      monitor —— 手机上退出沉浸后的小框：整套按键收起，画面完整露出。用属性 + !important
                 而不是去改引擎的 style.display，那一格是引擎自己的开关在写，我们再去写就分不清
                 「谁关的」，放开时也不知道该恢复成什么。
      play    —— 手机上的游玩布局：引擎容器 touch-action:none。iOS 会把非滚动 iframe 里的滑动
                 手势链到外层文档，手指在画面上一划、底下的详情页就跟着走。引擎自己那些能滚的
                 面板（设置菜单、联机弹窗）是各自的滚动容器，手势在它们那儿就被接住了，不受影响。
  */
  html[data-stage="monitor"] .ejs_virtualGamepad_parent { display: none !important; }
  html[data-stage="play"] .ejs_parent { touch-action: none; }
  /*
    引擎自带的底栏（播放 / 存读档 / 金手指 / 设置 / 音量 / 全屏…）整条藏掉（09-07 用户拍板）。
    播放器自己的工具栏现在叠在画面底部、自动隐藏，两条叠在同一个位置会撞在一起。
    代价：EJS 设置菜单里的画面滤镜 / 加速 / 存档槽位、重启、金手指暂时没有入口 —— 后续按需补到
    EmulatorTools 里。只藏不删：引擎内部还引用着这些元素（elements.menu），删了会抛。

    ⚠️ 别以为这条把引擎所有面板都吃掉了：那些弹窗是 createPopup() 建的，而它内部是
    this.elements.parent.appendChild(...) —— **挂在播放器根元素上，不是这条栏的后代**。
    所以藏了栏之后面板本身照样弹得出来，缺的只是入口。改键那个入口已经补回来了
    （openControls 把 controlMenu 的 display 置空，露在 EmulatorTools 的 🎮 面板里）；
    上面列的那几个要补也是同一个套路，不用去改这条 CSS。

    （这段注释里刻意不写反引号 —— 它在 srcdoc 那个模板字符串里面，一个反引号就把它截断了。）
  */
  .ejs_menu_bar { display: none !important; }
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
  /** socketId → 和那个人的连接。房主这边靠它认出一条 DataChannel 对面坐的是谁（见 guardInputChannel） */
  peerConnections?: Record<string, { pc?: RTCPeerConnection | null; dataChannel?: RTCDataChannel | null } | undefined>
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
  /**
   * 核心自报的选项表（就是核心的 retro_core_options_v2），新版本才有 ——
   * 引擎自己的设置菜单就是拿它建的。屏幕布局那一项从这里认（见 dualScreen.ts）。
   * 拿不到时返回 null；老一点的构建连这个 cwrap 都没有，所以调用前要判空。
   */
  getCoreOptionsJSON?: () => { options?: unknown[] } | null
  /** 老格式：一行一项的字符串（`key|default; a|b|c`）。只在 JSON 那个拿不到时兜底 */
  getCoreOptions?: () => string
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
   * 引擎自带的改键面板（`.ejs_popup_container`）。
   *
   * 它是 `createPopup(..., true)` 建出来的、一开始就 `display:none`，
   * 而 `createPopup` 内部是 `this.elements.parent.appendChild(...)` ——
   * **挂在播放器根元素上，不在 `.ejs_menu_bar` 里**，所以下面那句把整条底栏
   * `display:none !important` 的 CSS 吃不到它。引擎自己的底栏按钮做的也就是
   * `controlMenu.style.display = ""`（emulator.min.js 里 buttonOpts.gamepad 那一处），
   * 我们照抄这一句就把入口补回来了。
   */
  controlMenu?: HTMLElement
  /** 引擎自己有没有开着弹窗（改键 / 金手指 / 联机 / 输入框）。给 hotkeyBridge 让路用 */
  isPopupOpen?: () => boolean
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
  /**
   * **玩家自己存下来的**那份设置。和 getSettingValue 不是一回事：
   * `getSettingValue(k)` 读的是 `allSettings[k] || settings[k]`，而 allSettings 里
   * 混着「引擎按 EJS_defaultOptions 套上去的默认」—— 两者分不开。
   * 而这一格只有走过 changeSettingOption(k, v) （第三参不为 true）才会写，
   * 也正是 saveSettings() 落进 localStorage 的那一份，所以它等于
   * **「玩家在这款游戏上明确选过什么」**。屏幕布局要靠它区分「玩家选的」和
   * 「我们按容器方向给的默认」，见 setupScreenLayout。
   */
  settings?: Record<string, string>
  /**
   * 改一项设置。第三个参数是关键：
   *   `changeSettingOption(k, v)`       → 写 settings，会被 saveSettings 持久化 = 玩家的选择
   *   `changeSettingOption(k, v, true)` → 只写 allSettings，**不持久化** = 一个默认值
   * 两条都会通知菜单里那一行 → menuOptionChanged → gameManager.setVariable(k, v)，
   * 也就是说两条都立刻对核心生效，区别只在「下一局还算不算数」。
   */
  changeSettingOption?: (key: string, value: string, isDefault?: boolean) => void
  /**
   * 引擎的「点画布就锁定鼠标指针」开关（设置菜单里的 Lock Mouse，出厂是开的）。
   * 走 changeSettingOption('lockMouse', …) 时引擎自己会经 handleSpecialOptions 改它；
   * 这里声明出来是为了在那条路走不通时直接写标志兜底，见 releaseMouseLock。
   */
  enableMouseLock?: boolean
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
 * 只在**像致命错误**时才往上报（见 FATAL_PHRASES）：核心启动时会打一堆无关紧要的
 * warning，全报上去等于没报。其余的都留在缓冲区里，由 engineLog() 取。
 */
const LOG_LIMIT = 60
/** 命中这些词才认为是「这局跑不起来了」，而不是普通噪音 */
/**
 * 街机专用的屏幕手柄布局。
 *
 * **为什么必须自己给一份**：引擎的 `setVirtualGamepad()` 是按 `getControlScheme()` 分支的，
 * 而那张表里**根本没有 arcade / mame 这两档** —— 街机落进最后那个 else，拿到的是一套
 * SNES 布局：`Y X B A` 四颗 + nipplejs 摇杆 + Start + Select。于是：
 *
 *   ① **按键 5 / 6（libretro R=11、L=10）在屏幕上根本不存在。** 手机上打街霸 II、
 *      恐龙快打这类 CPS 六键格斗，**重拳和重脚永远出不来**，大招全废 —— 而页面底下
 *      那张键位表明写着「按键 5 / 按键 6」。拳皇是 Neo Geo 四键（A/B/C/D = 按键 1~4），
 *      刚好够用，所以**只测拳皇是发现不了这个 bug 的**。
 *   ② 方向用的是 `type:"zone"`（nipplejs）。它对没命中的方向不是立刻置 0，而是排一个
 *      30ms 的定时器去松开，**而且从不 clearTimeout**：手指从 ↓ 滚到 ↘，30ms 后那个
 *      旧定时器把「右」松掉，握住对角线只剩一个方向 —— 波动拳、蹲防全搓不出来。
 *      `type:"dpad"` 那条路每次 touchmove 把四个方向**同步全量**重写一遍，没有定时器，
 *      对角线是干净的；街机本来就是八向微动摇杆，方格判定也更贴近实机。
 *   ③ 投币键屏幕上标的是 `localization("Select")` = **「选择」**。引擎只在键盘改键面板里
 *      对 arcade/mame 把它改名成 INSERT COIN，虚拟手柄那条路没有这段。**街机不投币
 *      按 START 什么都不会发生**，而唯一能救玩家的那颗按钮上写着「选择」。
 *
 * 几何照抄引擎自带的世嘉土星布局（同样是两排三颗的六键排法，是它自己发出来、
 * 验证过的坐标），只换 text / id / input_value。
 *
 * **按键的摆位有讲究**：编号来自 `ARCADE_GENERIC_BUTTONS = [0, 8, 1, 9, 11, 10]`
 * （按键 1..6 → libretro B A Y X R L），但摆的时候按**三拳三脚**那套排：
 *
 *     上排  按键3(Y) 按键4(X) 按键6(L)   ← 轻拳 中拳 重拳
 *     下排  按键1(B) 按键2(A) 按键5(R)   ← 轻脚 中脚 重脚
 *
 * 这样六键格斗的拳脚各占一排，和真机一致；而 Neo Geo 只用按键 1~4 时，它们正好
 * 落成左边一个干净的 2×2 方块（1 2 在下、3 4 在上），也是 KOF 在手柄上的通行摆法。
 * 按数字顺序 1 2 3 / 4 5 6 摆反而会把拳和脚打散（实测：拳会落到左上、右下、右中）。
 */
const ARCADE_VIRTUAL_PAD: readonly Record<string, unknown>[] = [
  // 上排：轻拳 中拳 重拳
  { type: 'button', text: '3', id: 'arc_3', location: 'right', right: 145, top: 0, bold: true, input_value: 1 },
  { type: 'button', text: '4', id: 'arc_4', location: 'right', right: 75, top: 0, bold: true, input_value: 9 },
  { type: 'button', text: '6', id: 'arc_6', location: 'right', right: 5, top: 0, bold: true, input_value: 10 },
  // 下排：轻脚 中脚 重脚
  { type: 'button', text: '1', id: 'arc_1', location: 'right', right: 145, top: 70, bold: true, input_value: 0 },
  { type: 'button', text: '2', id: 'arc_2', location: 'right', right: 75, top: 70, bold: true, input_value: 8 },
  { type: 'button', text: '5', id: 'arc_5', location: 'right', right: 5, top: 70, bold: true, input_value: 11 },
  // 八向摇杆走 dpad，别用 zone（理由见上面第 ② 条）
  { type: 'dpad', id: 'dpad', location: 'left', left: '50%', right: '50%', joystickInput: false, inputValues: [4, 5, 6, 7] },
  // 文案交给引擎的 localization()：zh.json 里 'INSERT COIN' → 「投币」
  { type: 'button', text: 'INSERT COIN', id: 'arc_coin', location: 'center', left: -5, fontSize: 13, block: true, input_value: 2 },
  { type: 'button', text: 'Start', id: 'arc_start', location: 'center', left: 60, fontSize: 15, block: true, input_value: 3 },
]

/**
 * 确定致命的**整句**。命中就当这一局起不来了。
 *
 * ⚠️ **这张表是 2026-09-11 收紧过的，别再往回放宽。**
 *
 * 原来它是一串单词：`missing` / `not found` / `romset` / `crc` / `bios` …
 * 当时那么写没出事，纯粹是因为**核心的 stderr 根本出不来** —— 引擎把 Emscripten 的
 * `printErr` 写成了 `t=>{this.debug&&console.log(t)}`，而 `this.debug` 来自从没设过的
 * `EJS_DEBUG_XX`，所以那九个词一个都命不中，整套分流是死代码。
 *
 * 09-11 在 `scripts/patch-emulatorjs.mjs` 里把 `printErr` 改成无条件 `console.warn` 打通之后，
 * 核心原文第一次真的流进来了 —— 而 **MAME 2003 / 2003-Plus 在「能跑但有缺件」时照样会打
 * `NOT FOUND`、`INCORRECT CHECKSUM`、`WARNING: the game might not run correctly`**。
 * 按老那张表，这些会在游戏本来能正常启动的情况下直接 onError 把这一局毙掉。
 *
 * 所以现在只认少数确定致命的整句，宁可漏判：漏判的代价是玩家多等几秒看到引擎自己的报错，
 * 误杀的代价是一款本来能玩的游戏永远打不开。其余原文一律只进 `engineLog()` 供排查。
 */
const FATAL_PHRASES = [
  // FBNeo：认不出这个 romset，必然起不来
  'romset is unknown',
  // MAME：缺件已经到了跑不了的程度（区别于它那些 NOT FOUND 警告）
  'required files are missing',
  // 引擎自己：运行时没加载上 / startGame 抛了
  'error loading emulatorjs',
  'failed to start game',
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
    if (level !== 'log' && FATAL_PHRASES.some((h) => low.includes(h))) onFatal(text.trim())
  }

  /**
   * ⚠️ `log` 也要接，但**只进缓冲区、不参与 FATAL 判定**（上面那句 `level !== 'log'` 守着）。
   *
   * 引擎自己的 `startGameError()` 是用 `console.log` 打的，核心的 stdout 也走这一路 ——
   * 不接的话 `engineLog()` 里连「引擎当时到底说了什么」都没有，排查街机起不来只能靠猜。
   */
  const c = win.console as Console | undefined
  for (const level of ['error', 'warn', 'log'] as const) {
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

  /* ---------------- fetch（引擎真正在用的那条） ---------------- */

  /**
   * ⚠️ **主路必须包 fetch，不能只包 XHR。**
   *
   * 这整个探针本来只包了 `XMLHttpRequest.prototype`，而自建的 `emulator.min.js` 里
   * `XMLHttpRequest` 只出现 4 次、**全部属于内嵌的 socket.io（engine.io polling）**；
   * 引擎自己的 `downloadFile` 和 `loader.js` 早就改用 `fetch` 了。也就是说核心、
   * `*-wasm.data`、ROM、BIOS **没有一趟走 XHR**，下面那段 XHR 代码线上一次都不会执行。
   *
   * 三个后果（都实测得出来）：
   *   · `onFailed` / `critical()` 是死代码。BIOS 的 objectKey 配错 → 引擎自己 catch 成
   *     `startGameError("Network Error")` 且那个 promise **永不 resolve** ——
   *     玩家看到「引擎报错：Network Error」，管理员分不清是断网、没绑 BIOS 还是 key 打错。
   *   · 卡死检测失去唯一的网络心跳，只剩 `.ejs_loading_text` 的文案变化；而那行字
   *     **只有响应带 Content-Length 时才逐帧更新**（静态层用 chunked / 动态 gzip 就没有），
   *     于是核心明明在正常下载，30 秒后却报「加载在 Download Game Core 这一步停住了」。
   *   · 街机后半程（核心 8~40MB）没有任何真实进度，条子靠合成计时器爬到 99% 然后钉死。
   *
   * 实现上用 `TransformStream` 直通计数，**不用 `tee()`** —— tee 出来的两路读速不一致时
   * 快的那路会把数据缓冲在内存里，而这里下的正是几十上百 MB 的东西。
   */
  const origFetch = win.fetch as typeof fetch | undefined
  const W = win as unknown as {
    Response?: typeof Response
    TransformStream?: typeof TransformStream
  }
  if (typeof origFetch === 'function' && typeof W.Response === 'function' && typeof W.TransformStream === 'function') {
    win.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : ((input as Request)?.url ?? String(input))
      const res = await origFetch.call(win, input as RequestInfo, init)
      if (!ctx.live() || !url) return res
      ctx.onBeat()

      // 4xx / 5xx 必须在这里截住 —— 交给 EmulatorJS 的话它会死锁，见 critical() 的说明
      if (res.status >= 400) {
        if (critical(url)) ctx.onFailed(res.status, url)
        return res
      }
      // 没有 body（HEAD、204、opaque）就没什么可数的
      if (!res.body) return res

      const phase = phaseOf(url)
      const len = Number(res.headers.get('content-length') || 0)
      /*
       * 压缩过的响应里 Content-Length 是**压缩后**的大小，而读出来的是解压后的字节，
       * 比例会冲过 100%。冲过就转成不确定态，和 loadProgress.ts 的处理保持一致。
       */
      let total: number | undefined = len > 0 ? len : undefined
      let loaded = 0
      try {
        const counting = res.body.pipeThrough(
          new W.TransformStream!<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              loaded += chunk.byteLength
              if (total !== undefined && loaded > total) total = undefined
              if (ctx.live()) {
                ctx.onBeat()
                emit({ phase, loaded, total, ratio: total ? Math.min(loaded / total, 1) : undefined })
              }
              controller.enqueue(chunk)
            },
            flush() {
              // 下完这一趟就把条推满，别停在 97% 上等解压
              if (loaded > 0 && ctx.live()) emit({ phase, loaded, total: loaded, ratio: 1 }, true)
            },
          }),
        )
        return new W.Response!(counting, { status: res.status, statusText: res.statusText, headers: res.headers })
      } catch {
        // 包不上就原样放行 —— 少一层进度，总好过把下载弄断
        return res
      }
    } as typeof fetch
  }

  /* ---------------- XHR（socket.io 那一路，留着兜底） ---------------- */

  const proto = (win.XMLHttpRequest as typeof XMLHttpRequest | undefined)?.prototype
  if (!proto) return

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
function instrumentRtc(
  win: Window & Record<string, unknown>,
  onState?: (s: RTCPeerConnectionState) => void,
  /**
   * 这一局的源是不是两块屏拼出来的（NDS）。像素画那一档要按单块屏判，
   * 见 ../videoTuning.ts 的 dualScreen —— 不传的话 NDS 的 256×384 会被当成大源，
   * 访客那边一紧张就把两块屏各缩成 128×96。
   * 从参数进来而不是读闭包：这个函数在模块层，拿不到 mount 的 options。
   */
  dualScreen = false,
) {
  const Native = win.RTCPeerConnection as typeof RTCPeerConnection | undefined
  if (typeof Native !== 'function') return

  /**
   * 按这条轨的**实际画面大小**定编码参数（和直播共用 ../videoTuning.ts）。
   *
   * ⚠️ 原来这里写死 `maintain-framerate` + 固定 2.5Mbps，注释是「宁可糊一点也不要卡」。
   * 那句话对 640×480 的 DOS 成立，对 256×240 的红白机是**反的** ——
   * maintain-framerate 的意思是「扛不住就缩分辨率」，而 256×240 缩一半是 128×120，
   * 访客的屏幕还要放大回去：得到的不是糊一点，是认不出字的马赛克。
   * 现在按源大小分档，小源保分辨率、掉帧率。
   */
  const tuneVideo = (sender: RTCRtpSender, track: MediaStreamTrack) => {
    const { width, height } = sizeOfTrack(track)
    applyTuning(sender, tuningFor({ width, height, fps: VIDEO_MAX_FPS, minBitrate: NETPLAY_MIN_BITRATE, dualScreen }))
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

    // 只有房主会主动建通道（引擎里访客走 ondatachannel），守的正是房主这一端
    const nativeCreateDataChannel = pc.createDataChannel.bind(pc)
    pc.createDataChannel = ((label: string, init?: RTCDataChannelInit) => {
      const ch = nativeCreateDataChannel(label, init)
      guardInputChannel(() => (win.EJS_emulator as EjsEmulator | undefined)?.netplay, ch, pc)
      return ch
    }) as typeof pc.createDataChannel

    const nativeAddTrack = pc.addTrack.bind(pc)
    pc.addTrack = (track: MediaStreamTrack, ...streams: MediaStream[]) => {
      /**
       * contentHint 要在**协商之前**设 —— 它影响编码器怎么建起来，设晚了这一路
       * 已经按默认建好了。而 setParameters 相反，要等 sender 协商完才生效。
       * 所以这里分两次：先定 hint，一秒后再写参数。
       */
      if (track.kind === 'video') {
        const { width, height } = sizeOfTrack(track)
        try {
          track.contentHint = tuningFor({ width, height, fps: VIDEO_MAX_FPS, minBitrate: NETPLAY_MIN_BITRATE, dualScreen }).contentHint
        } catch {
          /* 老浏览器没有 contentHint */
        }
      }
      const sender = nativeAddTrack(track, ...streams)
      if (track.kind === 'video') window.setTimeout(() => tuneVideo(sender, track), 1000)
      return sender
    }
    return pc
  } as unknown as typeof RTCPeerConnection

  Wrapped.prototype = Native.prototype
  win.RTCPeerConnection = Wrapped
}

/** 往 iframe 里注入一个脚本，resolve 表示加载完成 */
function injectScript(doc: Document, src: string, timeoutMs?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = doc.createElement('script')
    /*
      ⚠️ 只给**可选的**脚本设超时。
      浏览器要等 TCP 超时（三十几秒起步）才会给静默丢包的地址打 onerror ——
      对 socket.io 这种「挂了也只是联机用不了」的脚本，等那么久等于把开局拖死。
      loader.js 不传这个参数：它慢是因为在下核心，不是因为连不上。
    */
    const timer = timeoutMs
      ? window.setTimeout(() => {
          s.onload = null
          s.onerror = null
          reject(new Error(`${src} (超时)`))
        }, timeoutMs)
      : 0
    const done = (fn: () => void) => {
      if (timer) window.clearTimeout(timer)
      fn()
    }
    s.src = src
    s.async = false
    s.onload = () => done(resolve)
    s.onerror = () => done(() => reject(new Error(src)))
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
/**
 * 认指纹、必要时把合成 ROM 补进包，产出交给引擎的 blob 地址。
 *
 * ⚠️ **合成这一步以前只有「玩本地 ROM」那条路接了，入库的游戏这条没接。**
 * 入库这条当时只做两件事：套 `hack.romData`、把包名改成 `hack.zipName` ——
 * 而 dat 里引用的 `tk2_gfx1cn.rom` / `tk2_gfx3cn.rom` 偏偏是**合成产物**
 * （原图形 ROM 的一个字节窗口被中文补丁片盖过）。包里根本没有这两块，
 * 核心按 dat 去找就是两条 missing → FATAL → 游戏必死，
 * 而后台界面还绿字写着「✓ 识别为已知改版包，已填好 RomData」。
 *
 * 两条路现在都走这里，同一张指纹表、同一套合成。
 */
async function arcadeBlobFrom(data: ArrayBuffer, name: string): Promise<{ url: string; name: string; hack: ArcadeHack | null }> {
  const hack = hackOf(data)
  let bytes: ArrayBuffer | Uint8Array = data
  if (hack?.derive) {
    // 合成失败不能静默放行 —— 放行的结果是 100% 起不来，而报错会指向完全无关的方向
    const merged = await deriveArcadeHackBytes(data, listZipEntries(data), hack)
    if (merged) {
      bytes = merged
      console.info(`[arcade] ${hack.title}：已现场合成 ${hack.derive.outputs.join(' / ')} 并补进包里`)
    }
  }
  return { url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/zip' })), name, hack }
}

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
      // ⚠️ 必须带 cached: true。EmulatorPlayer 对**任何** phase==='rom' 且 total≥64MB 的帧
      // 都会去更新那个「本局需下载 XXX MB」的遮罩文案（不只光盘平台），不带的话
      // 玩过一次的大 romset 第二次秒开，界面上却还写着「需下载 180 MB」，自相矛盾。
      onProgress?.({ phase: 'rom', loaded: cached.byteLength, total: cached.byteLength, ratio: 1, cached: true })
      // 缓存这一路也要认一遍：第二次玩同一款改版包不能因为走了缓存就少了 dat、也不能少了合成
      return arcadeBlobFrom(cached, name)
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

  return arcadeBlobFrom(data, name)
}

/**
 * 光盘镜像的加载路径（PS1 / PS2）。
 *
 * ── 为什么不让引擎自己下 ─────────────────────────────────────
 * EmulatorJS 自己那套 XHR 下载有两个问题，在几十 MB 的卡带机上都无所谓，
 * 到了几百 MB 的盘上就是致命的：
 *
 *   1. **下完就扔**。同一个玩家第二次进同一款游戏，几百 MB 从头再来一遍。
 *      romCache 覆盖不到引擎内部的 XHR（见 romCache.ts 的说明），
 *      所以要缓存就只能把这一步接管过来。
 *   2. **开局前不知道要下多少**。玩家点了「开始」之后看着一个百分比慢慢爬，
 *      不知道是 20MB 还是 700MB，也就无从判断该不该等 —— 这是「网页游戏怎么这么卡」
 *      的一大半来源。接管之后 Content-Length 在第一帧就有了。
 *
 * ── 为什么是 Blob 不是 ArrayBuffer ──────────────────────────
 * 街机那条路（上面的 prepareRemoteArcadeRom）拿的是 ArrayBuffer，因为它要验中央目录、
 * 要算改版包指纹。光盘这条什么都不用验，只需要一个能交给引擎的 URL ——
 * 而 ArrayBuffer 要求一整块连续内存，700MB 的连续分配在手机上本来就悬，
 * 加上后面 Blob 一份、引擎 XHR 回来再一份，峰值是文件的两三倍，标签页直接被系统杀掉。
 * 走 Blob 则全程只有分片在内存里待过，浏览器还会把大 Blob 落到磁盘。
 *
 * ⚠️ **不做格式校验**。盘的种类太多（.chd 是 MAME 自己的容器、.pbp 是 PSP 打包格式、
 * .cue 是纯文本、.iso 的 magic 在第 32769 字节），在这里判一遍只会把本来能跑的挡在门外。
 * 真跑不起来时核心报的原文会经 FATAL_PHRASES 那条路送上来，比我们猜得准。
 */
/**
 * 从播放地址里取出带扩展名的文件名，交给引擎当 EJS_gameName。
 *
 * 必须去掉查询串：播放地址带着 `?romv=<etag>`（内容寻址用，见 romCache.ts），
 * 留着的话核心看到的扩展名是 `.chd?romv=abc123`，一样认不出容器格式。
 */
export function discNameFor(url: string, fallback: string): string {
  try {
    const path = new URL(url, location.href).pathname
    const base = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1))
    if (/\.[a-z0-9]{2,5}$/i.test(base)) return base
  } catch {
    /* 相对地址解析不了就用兜底名 */
  }
  return fallback
}

export async function prepareRemoteDiscRom(
  url: string,
  onProgress: MountOptions['onProgress'],
  signal: AbortSignal,
): Promise<{ url: string; bytes: number }> {
  const cacheKey = romCacheKey(url)
  if (cacheKey) {
    const cached = await romCacheGetBlob(cacheKey)
    if (cached) {
      if (signal.aborted) throw new DOMException('已取消', 'AbortError')
      // 命中也要发满进度那一帧：播放器的加载遮罩靠进度回调收尾。
      // cached 标记让遮罩显示「已缓存」而不是「需下载 620 MB」—— 秒开时那行字必须对得上。
      onProgress?.({ phase: 'rom', loaded: cached.size, total: cached.size, ratio: 1, cached: true })
      return { url: URL.createObjectURL(cached), bytes: cached.size }
    }
  }

  const blob = await fetchBlobWithProgress(url, {
    phase: 'rom',
    onProgress,
    signal,
    check: (res) => {
      const type = res.headers.get('content-type') ?? ''
      // 地址或反代配错时，SSR 常会回 200 + HTML；状态码正常也绝不能当成镜像交给核心
      if (/text\/html|application\/xhtml/i.test(type)) throw new Error(`HTTP ${res.status}`)
    },
  })

  // 不 await：写几百 MB 要花时间，不该让玩家在开局前干等。Blob 本身是不可变的，
  // 下面 createObjectURL 之后照样能安全写盘
  if (cacheKey) void romCachePutBlob(cacheKey, blob).catch(() => {})

  return { url: URL.createObjectURL(blob), bytes: blob.size }
}

export function mount(container: HTMLElement, options: MountOptions): RuntimeHandle {
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
  /**
   * 连着几轮没拿到房间令牌了。
   *
   * ⚠️ 不能第一次拿不到就喊。`startStateUpload` 开局 3 秒就先探一次，而令牌是服务端在
   * open-room 的 ack 之后紧接着单独发的 —— 信令握手慢一点（跨境、TURN 还在协商），
   * 这一次探测本来就该是空的。以前 `stateUploadWarned` 是个一次性闩：那一下就把
   * 「房主进度托管未启动」印在控制台上再也不撤，**哪怕令牌半秒后就到了、托管一直在正常跑**。
   * 于是这条警告既报假警，又把真正的失败（服务端没发、socket.io 没加载、令牌被清掉）
   * 混在同一句话里，看到的人分不出是哪种。
   * 改成连着 MISS_BEFORE_WARN 轮（约 23 秒）都没有才算真出事。
   */
  let stateTokenMisses = 0
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
  let audioTap: AudioTap | null = null
  let volume = 0.6
  const caps = new Set<Capability>(['pause', 'saveState', 'volume', 'screenshot', 'record', 'gamepad', 'remapKeys'])
  /** 取 iframe 里的模拟器实例；还没起来时是 undefined */
  const emuOf = (): EjsEmulator | undefined =>
    (iframe.contentWindow as (Window & Record<string, unknown>) | null)?.EJS_emulator as EjsEmulator | undefined
  /** EmulatorJS 的画布在 iframe 里，同源所以能直接拿 */
  const canvasOf = (): HTMLCanvasElement | null =>
    emuOf()?.canvas ?? iframe.contentDocument?.querySelector('canvas') ?? null

  /**
   * 引擎那些元素**属于 iframe 那个 realm**，所以 `instanceof HTMLElement` 恒为 false ——
   * 父窗口的 HTMLElement 和 iframe 里的不是同一个构造函数。
   * 拿它当判据的话，能力会被静默摘掉、按钮永远点不动（这个坑当场踩过一次）。
   * 按形状认：能写 style.display 就够我们用了。
   */
  const canSetDisplay = (el: HTMLElement | undefined): el is HTMLElement =>
    typeof el?.style?.display === 'string'

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
    // 改键面板是 createBottomMenuBar() 里建的。我们只用 CSS 把那条栏藏了、没删，
    // 所以正常情况下它一定在；真没有（引擎换了实现）就把按钮摘掉，别亮一个点了没反应的
    if (!canSetDisplay(emu.controlMenu)) caps.delete('remapKeys')
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
  /** 信令最后一次 connect_error 的时间。轮询靠它区分「握手慢」和「连不上」 */
  let signalErrorAt = 0
  /** 上次刷新 EJS_netplayICEServers 的时间，见 ICE_REFRESH_MS */
  let lastIceAt = 0
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
          // 信令连不上时引擎只在自己的弹窗里闪一句 "Connect error"，适配器这边什么都不知道，
          // 下面的轮询看到 socket 没连上就按「房主断线」处理 —— 排查时至少要在引擎日志里留下真相。
          // 重连每次都会触发，只记第一次
          let signalErrorLogged = false
          sock?.on?.('connect_error', (e: unknown) => {
            signalErrorAt = Date.now()
            if (signalErrorLogged) return
            signalErrorLogged = true
            logEngine(`[netplay] 信令连接失败：${e instanceof Error ? e.message : String(e)}`)
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
   * ⚠️ 只在**开局前**往上报。播放器收到 onError 会把这局拆掉（进度全丢），而 FATAL_PHRASES
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
  /** 同上，光盘那条路的。两条路的失败提示不一样，不能合成一个标志 */
  let discRomPrepared = false
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
    stateTokenMisses = 0
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

    /**
     * 开房 / 进房前把 ICE 配置刷一遍。
     *
     * 引擎每建一条 PeerConnection 都现读 `window.EJS_netplayICEServers`，但这个全局是**挂载时**
     * 写进去的那一份 —— 而 TURN 是短期凭证（默认 1 小时过期）。玩了两小时才点「联机匹配」，
     * 拿的就是两小时前的凭证，TURN 直接鉴权失败、退化成纯 STUN，穿不过 NAT 的那部分玩家全连不上。
     * fetchIceConfig 自带缓存（快过期才真去取），所以这里绝大多数时候只是读内存。
     */
    void fetchIceConfig().then((ice) => {
      if (destroyed || netplay !== cfg) return
      win.EJS_netplayICEServers = ice.iceServers
      lastIceAt = Date.now()
      cfg.onIceReady?.(ice.hasTurn)
    })

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
    /** 信令连上过没有：没连上过时的「未连接」是还在握手，不是掉线 */
    let connectedOnce = false
    const openedAt = Date.now()
    playersTimer = window.setInterval(() => {
      if (destroyed) return
      const cur = win.EJS_emulator as EjsEmulator | undefined
      const n = cur?.netplay
      if (!n) return
      if (n.socket?.connected) connectedOnce = true
      /**
       * 凭证续期。房间可能开几个小时，而**中途进来的每个人**都会让引擎新建一条 PeerConnection，
       * 读的就是这个全局。不续的话，开播一小时之后进来的人全部拿不到 TURN。
       * 借这条 1 秒一次的轮询做节流，不另起定时器；fetchIceConfig 只在快过期时才真的发请求。
       */
      if (Date.now() - lastIceAt > ICE_REFRESH_MS) {
        lastIceAt = Date.now()
        void fetchIceConfig().then((ice) => {
          if (!destroyed) win.EJS_netplayICEServers = ice.iceServers
        })
      }
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
      /**
       * 房间号只在服务器 ack 之后才报。
       * 房主的 sessionid 是引擎本地生成的，openRoom() 一调 extra 里就有了 —— 但那时 open-room
       * 可能还卡在发送缓冲区里（信令还在握手），服务器上根本没有这个房间。以前这里一看到 sessionid
       * 就报 onRoom，播放器紧接着去查房间、404、按「房间没了」把整局拆掉；open-room 被拒
       * （满员、限流）时则会一直挂着一个不存在的房间。roomJoined() 是引擎收到 ack 之后才跑的，
       * 它把 isNetplay 置 true —— 拿它当「真的进了房」的信号。
       */
      const extra = (n as unknown as { extra?: { sessionid?: string } }).extra
      if (extra?.sessionid && cur?.isNetplay && extra.sessionid !== reportedRoom) {
        reportedRoom = extra.sessionid
        cfg.onRoom?.(extra.sessionid, n.owner)
        // 房主开始定期上传存档，掉线时新房主就能接着玩
        if (n.owner) startStateUpload(win, extra.sessionid)
      }
      if (n.playerID && n.playerID !== reportedId) {
        reportedId = n.playerID
        cfg.onIdentity?.(n.playerID)
      }
      if (!reportedRoom) {
        /**
         * 一直没进成房。两种情况：信令连不上（Mixed Content、服务器挂了 —— connect_error 会先到），
         * 或者 open-room / join-room 被拒（引擎自己会弹对话框）。给足时间，连不上才算失败；
         * 以前 1 秒后看到 socket 没连上就按「房主断线」处理，握手慢一点的正常用户也会中招。
         */
        const waited = Date.now() - openedAt
        const hopeless = signalErrorAt > openedAt && waited > SIGNAL_FAIL_MS
        if (hopeless || waited > JOIN_TIMEOUT_MS) {
          window.clearInterval(playersTimer)
          try {
            n.leaveRoom?.()
          } catch {
            /* 还没连上，没什么可退的 */
          }
          failNetplay(hopeless ? fmt(rt.netplaySignalUnreachable, { url: netplayUrlForFrame() }) : rt.netplayJoinTimeout)
        }
        return
      }
      // 信令断开。EmulatorJS 的 socket 一 disconnect 就自己 leaveRoom 了 —— 不管是谁的网抖，
      // 这个 netplay 实例都已经退了房，不会自己重连回去。所以两边都得告诉播放器：
      //   访客：多半是自己网络抖了，房间大概还在，让播放器查一下再决定重进还是报错
      //   房主：房间在服务器那边已经进入换房主流程，游戏本身还在跑；进度托管得停，
      //         否则接下来每 10 秒一次 403（以前这里 return 掉，界面一直挂着一个不存在的房间）
      if (connectedOnce && !n.socket?.connected) {
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
        stateTokenMisses += 1
        // 开局那次探测拿不到是正常的（令牌还在路上），连着几轮都没有才是真出事
        if (stateTokenMisses >= MISS_BEFORE_WARN && !stateUploadWarned) {
          stateUploadWarned = true
          logEngine('[netplay] 一直没收到房间令牌，房主进度托管未启动 —— 掉线后接手的人会拿不到进度')
          console.warn('[netplay] 没有房间令牌，房主进度托管未启动')
        }
        return
      }
      if (stateTokenMisses) {
        // 令牌是迟到的，不是没来。留一句，免得日志里只剩下那条吓人的警告
        if (stateUploadWarned) console.info('[netplay] 房间令牌已到，房主进度托管开始')
        stateTokenMisses = 0
        stateUploadWarned = false
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
      // 关页面前的那一次要带 keepalive，否则请求跟着页面一起被撕掉（见 uploadState）
      void uploadState(roomId, auth, state, { keepalive: force })
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

  /**
   * 这台机器本身就是靠戳屏幕玩的（POINTER_FIRST 的平台 **且** 确实是触屏设备）。
   * applyTouchInput 里定，之后 syncTouchCaps 和布局那一套都读它。
   */
  let pointerFirst = false

  /**
   * 把两个「屏幕上有什么」的能力同步给播放器：开局提示和工具栏开关都看它们。
   *
   * `enginePointer` 不能只看平台。同一台 NDS，布局切到「只有上屏」时下屏
   * 整块不画 —— 画面上再也没有可戳的东西了，这时候还声明 enginePointer，
   * 开局提示就会理直气壮地叫玩家「点画面下方那块屏幕」，而那儿什么都没有。
   * 所以这一位是「平台是触屏」和「当前布局真把触摸屏画出来了」的与。
   */
  const syncTouchCaps = () => {
    if (padShown) caps.add('enginePad')
    else caps.delete('enginePad')
    if (pointerFirst && showsTouchScreen(layoutValue)) caps.add('enginePointer')
    else caps.delete('enginePointer')
    options.onCaps?.(caps)
  }

  /* ---------------- 双屏布局（见 dualScreen.ts） ---------------- */

  /** 核心里认出来的布局项。null = 这个核心没这回事，整块功能不存在 */
  let layoutOpt: LayoutOption | null = null
  /** 现在生效的布局值（核心自报取值里的原样字符串）。非双屏平台恒为空串 */
  let layoutValue = ''
  /** 上一次报给播放器的画面几何。没量到过就是 null */
  let geometry: { width: number; height: number } | null = null
  /** 切完布局之后盯几何的那个定时器 */
  let geometryWatch = 0
  /**
   * 因为切到「只有上屏」而被我们强行放出来的按键。
   * 切回看得见下屏的布局时要还原成收起 —— 不还原的话，玩家只是去看了一眼上屏，
   * 回来发现按键永久压在他的触摸屏上了，而他并没有做过这个选择。
   */
  let padForcedByLayout = false

  /** 画布的真实像素尺寸 = 核心 av_info 的几何。太小的当没量到（理由同 usableVideoSize） */
  const readGeometry = (emu: EjsEmulator | undefined) => {
    const c = emu?.canvas
    const width = Number(c?.width) || 0
    const height = Number(c?.height) || 0
    return usableVideoSize(width, height) ? { width, height } : null
  }

  /** 量到**变化**才报。返回「这一次报了没有」，盯几何那个定时器靠它决定停不停 */
  const reportGeometry = (emu: EjsEmulator | undefined) => {
    const g = readGeometry(emu)
    if (!g) return false
    if (geometry && geometry.width === g.width && geometry.height === g.height) return false
    geometry = g
    options.onGeometry?.(g)
    return true
  }

  /** 切完布局盯几何盯多久 / 多密。见 watchGeometry */
  const GEOMETRY_WATCH_MS = 3000
  const GEOMETRY_TICK_MS = 120

  /**
   * 切完布局之后盯一会儿画面几何。
   *
   * 为什么是盯而不是查表：换布局是把核心的变量改掉（gameManager.setVariable →
   * ejs_set_variable），核心要在**下一次 retro_run 里读到 variables_updated**
   * 才重算几何、再经 SET_SYSTEM_AV_INFO 把画布尺寸改过来 —— 这一步既没有事件
   * 也不是同步的。而混合布局的比例还取决于我们不读的另外几项
   * （melonds_hybrid_small_screen 之类），查表必错。所以一律等它变，量到了才报。
   *
   * 有上限：核心万一根本不认这一项（换了个核心、key 对得上但语义不同），
   * 几何永远不会变 —— 那就让容器停在上一个**正确**的比例，别留一个常驻定时器
   * 在那儿空转（这个仓库为「玩就是播」的常驻开销付过一次学费，见 play_perf 记忆）。
   */
  const watchGeometry = () => {
    if (geometryWatch) window.clearInterval(geometryWatch)
    const until = Date.now() + GEOMETRY_WATCH_MS
    geometryWatch = window.setInterval(() => {
      if (destroyed || reportGeometry(emuOf()) || Date.now() > until) {
        window.clearInterval(geometryWatch)
        geometryWatch = 0
      }
    }, GEOMETRY_TICK_MS)
  }

  /**
   * 布局变了之后把「屏幕上有什么」重新算一遍。
   *
   * ⚠️ 这是这一整块里最要紧的一步，别把它省成「切完刷一下 UI」。
   * NDS 的触摸屏是下面那块，`Top Only` 把它整块藏掉；而指针优先的平台默认是
   * **收起引擎那套按键**的（见 POINTER_FIRST）。两件事叠起来就是：玩家一切到
   * 「只有上屏」，这一局画面点不到、按键收着、手机上又没有键盘 —— 一个能按的
   * 东西都没有，而且全程不会有任何报错。所以这里在**藏掉触摸屏的同时**把按键补上。
   */
  const syncLayoutInput = () => {
    const touchVisible = showsTouchScreen(layoutValue)
    if (pointerFirst && !touchVisible && !padShown && padAvailable) {
      padForcedByLayout = true
      setEnginePad(true)
      return
    }
    if (pointerFirst && touchVisible && padForcedByLayout) {
      padForcedByLayout = false
      setEnginePad(false)
      return
    }
    syncTouchCaps()
  }

  /**
   * 换布局。`byPlayer` 决定要不要记住：
   *   true  玩家在工具栏里点的 → `changeSettingOption(k, v)`，引擎会持久化，下一局照旧
   *   false 我们按容器方向给的默认 → 第三参传 true，**只对这一局生效，不落盘**
   *
   * 为什么这个区分非做不可：默认值是按**当前容器方向**算的（桌面给并排、
   * 手机竖屏给上下叠）。要是把它也持久化，玩家在电脑上开过一次的游戏，
   * 到手机上就永远是并排 —— 两块屏各缩成一条，比不做这个功能还糟。
   * 引擎那个第三参数的语义正好就是这件事，不用我们另建一套存储。
   */
  const applyLayout = (value: string, byPlayer: boolean) => {
    const emu = emuOf()
    if (!emu || !layoutOpt || !layoutOpt.values.includes(value)) return
    layoutValue = value
    try {
      emu.changeSettingOption?.(layoutOpt.key, value, byPlayer ? undefined : true)
    } catch (e) {
      console.warn('[emulatorjs] 换屏幕布局失败：', e)
    }
    options.onScreenLayout?.({ key: layoutOpt.key, values: layoutOpt.values, current: value })
    syncLayoutInput()
    watchGeometry()
  }

  /** 读一遍核心的触控模式项：JSON 优先，拿不到退回老格式文本（desmume2015 那一支就是 v1 格式）。都没有返回 null */
  const readTouchModeOption = (emu: EjsEmulator): TouchModeOption | null => {
    const gm = emu.gameManager
    const fromJson = findTouchModeOption(gm?.getCoreOptionsJSON?.() ?? null)
    if (fromJson) return fromJson
    if (typeof gm?.getCoreOptions === 'function') return findTouchModeOption(parseCoreOptionsText(gm.getCoreOptions()))
    return null
  }
  /** 核心选项的取值比较：核心报的原文可能带空格或大小写不一 */
  const sameValue = (a: string | null | undefined, b: string) => !!a && a.trim().toLowerCase() === b.trim().toLowerCase()

  /**
   * 把引擎的「点画布锁定鼠标指针」关掉。**指针优先的平台（POINTER_FIRST）无条件做**。
   *
   * 玩家先看到的是这个：在 NDS 上点一下画面，Chrome 顶上压下来一条
   * 「8bitgo.com – 若要显示光标，请按 esc」，鼠标指针没了。对一台**靠戳屏幕玩**的机器，
   * 这是纯粹的损失 —— 触控笔的落点全靠指针指，指针一藏就只能凭感觉点。
   *
   * 底下还有一层，比那条横幅更要紧：RetroArch 的 Emscripten 输入驱动
   * （`input/drivers/rwebinput_input.c`）**锁定与不锁定走的是两套坐标**。
   *   不锁定：`mouse.x = targetX * dpr` —— CSS 像素乘 dpr，正好落在画布的物理像素视口上，
   *           指针指哪儿就是哪儿，`RETRO_DEVICE_POINTER`（melonDS 的 `Touch` 档）要的就是这个。
   *   锁定后：改成 `mouse.x += movementX` 累加成一个虚拟位置，再按**物理像素**尺寸夹住 ——
   *           movementX 是 CSS 像素、不乘 dpr，于是 Retina（dpr 2）上每动 1 个 CSS 像素只走
   *           1 个物理像素，绝对坐标那一路直接**速度对半 + 起点错位**。
   * 叠上 melonDS 在 `Touch` 档**不画十字光标**（`input.cpp`：`cursor_enabled()` 只在
   * Mouse / Joystick 为真），锁定 = 没有系统指针、也没有游戏光标，一个参照物都不剩。
   *
   * 相对位移那一档（`Mouse`）不锁也照样能用：`pending_delta_x` 是从 movementX 累加的，
   * 而普通 mousemove 一样带 movementX —— 锁定在这一档换来的只有「指针跑不出画布」，
   * 抵不上藏掉指针的代价。所以这里不分档，进 POINTER_FIRST 就关。
   *
   * 和触控模式一样只当默认值改（第三参 true），玩家在引擎菜单里明确开过锁定就尊重他。
   * 除了走 `changeSettingOption`，**还要直接写 `emu.enableMouseLock`** ——
   * 引擎那句 `requestPointerLock()` 在画布的 click 监听里只看这个布尔，而
   * `changeSettingOption` 要靠设置菜单里那一行的监听转发才会经 handleSpecialOptions
   * 改到它；菜单那一行万一没建（引擎换版本、hideSettings 藏了它），少了这一句就等于没关。
   */
  const releaseMouseLock = (emu: EjsEmulator) => {
    if (emu.settings?.lockMouse === 'enabled') {
      console.info('[emulatorjs] 玩家自己开过「锁定鼠标」，保留（这台机器靠戳屏幕玩，锁定后没有任何可见指针，不建议）')
      return
    }
    try {
      emu.changeSettingOption?.('lockMouse', 'disabled', true)
    } catch (e) {
      console.warn('[emulatorjs] 关鼠标锁定失败：', e)
    }
    // 兜底：引擎点画布时只看这个布尔（见上面注释最后一段）
    emu.enableMouseLock = false
    // 已经锁上了就当场退出来（玩家在部署前的版本里点过、或者我们跑得比他第一下点击晚）
    const doc = emu.canvas?.ownerDocument
    if (doc?.pointerLockElement && doc.pointerLockElement === emu.canvas) {
      try {
        doc.exitPointerLock()
      } catch {
        /* 有的浏览器不允许非手势下退出，忽略 —— 玩家按一下 esc 就出来了 */
      }
    }
  }

  /**
   * 把触控笔切到**绝对坐标**那一档（melonDS 的 `melonds_touch_mode = Touch`）。
   *
   * 为什么必须改：核心的出厂默认是 `Mouse`，而那是 libretro 的 RETRO_DEVICE_MOUSE ——
   * **相对位移**：每 1 个 CSS 像素的鼠标移动 = 触摸屏上 1 个像素，而触摸屏在画布上是
   * 放大显示的（624 宽的并排布局是 1.22×，只显示下屏时 2.4× 起），玩家的感受就是
   * 「光标比鼠标快一到两倍、越划越偏」，而且这个倍率随窗口大小变，改缩放也压不下去。
   * `Touch` 档是 RETRO_DEVICE_POINTER，rwebinput 用 targetX × dpr 对到物理像素视口，
   * 核心再按整个布局的 buffer 尺寸换算、落在下屏范围内才算触到 —— 这一路我们在
   * 4:3 画布 + 8:3 并排布局（上下各留黑边）上实测过：点哪儿就是哪儿。
   * 详细的取证与订正记在 `dualScreen.ts` 的 findTouchModeOption 上面。
   *
   * 四条约束，缺一条都会出别的毛病：
   *
   * 1. **第三参传 true**（只写 allSettings、不落盘）。这是个我们替核心纠正的默认值，
   *    不是玩家的选择 —— 落盘的话，将来核心把默认改对了、或者玩家想试 Joystick，
   *    这一格会一直压着他。和 applyLayout 里 `byPlayer` 的取舍是同一个道理。
   * 2. **玩家自己选过就一个字都不动**。判据只能是 `emu.settings[key]` ——
   *    只有 changeSettingOption(k, v)（第三参不为 true）才写那一格。
   *    `getSettingValue()` 返回的是 `allSettings[k] || settings[k]`，混着默认值，分不开。
   *    ⚠️ 这一格是**按游戏**存在 localStorage 里的：玩家以前在引擎菜单里点过一次
   *    Mouse，那款游戏就一直是相对位移 —— 所以跳过时要在控制台**说清楚**，否则
   *    排查时看到的现象和代码对不上。
   * 3. **认不出就什么都不做**。findTouchModeOption 找不到 key、或者取值里没有
   *    `Touch` 那一档时返回 null；这时保持核心自己的默认，别拿猜的字符串去写。
   * 4. **改完要回读核对**。changeSettingOption 是引擎在 setupSettingsMenu 里才挂上的
   *    实例闭包，`?.()` 在它还不存在时是**静默**不做；核心那边要到 setVariable
   *    之后才改。光打一句「已改」等于没验 —— 回读核心选项，当前值不是 Touch 就 warn。
   *
   * 只在双屏机型（= NDS）上调。别的平台没有触控笔这回事，多写一格 allSettings
   * 虽然无害，但那是往「我们改过什么」这份账里塞噪声。
   */
  const applyTouchModeDefault = (emu: EjsEmulator) => {
    let opt: TouchModeOption | null = null
    try {
      opt = readTouchModeOption(emu)
    } catch (e) {
      console.warn('[emulatorjs] 读核心选项失败，触控模式这块跳过：', e)
      return
    }
    if (!opt) {
      console.info('[emulatorjs] 核心没报出触控模式那一项（或没有绝对坐标那一档），保持核心默认')
      return
    }
    const chosen = emu.settings?.[opt.key]
    if (typeof chosen === 'string' && opt.values.includes(chosen)) {
      console.info(`[emulatorjs] 玩家在引擎菜单里选过 ${opt.key} = ${chosen}，不改（要换回绝对坐标：设置 → Core Options → ${opt.absolute}）`)
      return
    }
    // 已经是绝对坐标了就别多写一次（换核心版本、以后核心改了默认都可能命中这里）
    if (!sameValue(opt.current, opt.absolute)) {
      try {
        emu.changeSettingOption?.(opt.key, opt.absolute, true)
      } catch (e) {
        console.warn('[emulatorjs] 设置触控模式失败：', e)
        return
      }
    }
    // 回读核对：核心那边到底是不是 Touch，别只报「我们改了」
    let effective = ''
    try {
      effective = readTouchModeOption(emu)?.current ?? ''
    } catch {
      /* 读不到就按下面的 warn 处理 */
    }
    if (sameValue(effective, opt.absolute)) {
      console.info(`[emulatorjs] 触控笔走绝对坐标：${opt.key} = ${effective}（核心出厂默认 ${opt.fallback || '未知'}）`)
    } else {
      console.warn(`[emulatorjs] 触控模式没改成：${opt.key} 回读到「${effective || '空'}」，期望 ${opt.absolute}。changeSettingOption 在不在：${typeof emu.changeSettingOption}`)
    }
  }

  /**
   * 开局后把画面几何报出去，并（双屏机型）把屏幕布局摆正。
   *
   * 几何是**所有平台**都报的：播放器的容器比例本来靠查表，查表给的是 CRT 年代的
   * 显示比例，对单屏机型仍然以表为准（见 screenAspect.ts 的注释），
   * 但报上去没坏处 —— 那边自己挑用不用。
   *
   * 布局只对双屏机型做，而且**只在核心自报的取值里挑**。挑不出来（换了个核心、
   * 取值一个也归不了类）就什么都不动，让核心保持它自己的默认 ——
   * 宁可没有这个功能，也不要按猜出来的字符串去改一个我们不认识的选项。
   */
  const setupScreenLayout = (win: Window & Record<string, unknown>) => {
    const emu = win.EJS_emulator as EjsEmulator | undefined
    if (!emu) return
    reportGeometry(emu)
    if (!isDualScreen(options.platform)) return

    // 布局之前先把触控笔摆对：它和布局互不相干，但都要在核心选项读得到之后做
    applyTouchModeDefault(emu)

    let found: LayoutOption | null = null
    try {
      const gm = emu.gameManager
      found = findLayoutOption(gm?.getCoreOptionsJSON?.() ?? null)
      // JSON 那条拿不到就退回老格式的文本（引擎自己也是这么兜的）
      if (!found && typeof gm?.getCoreOptions === 'function') {
        found = findLayoutOption(parseCoreOptionsText(gm.getCoreOptions()))
      }
    } catch (e) {
      console.warn('[emulatorjs] 读核心选项失败，屏幕布局这块跳过：', e)
    }
    layoutOpt = found
    if (!layoutOpt) {
      console.info('[emulatorjs] 核心没报出屏幕布局那一项，不画布局 UI')
      return
    }

    /*
      「玩家自己选过」和「引擎/核心的默认」必须分开，判据是 emu.settings ——
      只有 changeSettingOption(k, v) （第三参不为 true）才会写那一格，也正是
      saveSettings 落盘的那一份。allSettings 里混着默认值，getSettingValue 分不开。
    */
    const chosen = emu.settings?.[layoutOpt.key]
    const playerChose = typeof chosen === 'string' && layoutOpt.values.includes(chosen)
    layoutValue = playerChose ? chosen : layoutOpt.current || layoutOpt.fallback || layoutOpt.values[0]

    if (!playerChose) {
      // 按**引擎容器**的方向定默认，不是按窗口 —— 手机竖屏的游玩布局里
      // 容器是竖的，而同一台手机横过来（或桌面）容器是宽的，两者要给不同的布局
      const box = emu.elements?.parent?.getBoundingClientRect()
      const want = preferredLayout(layoutOpt.values, isWideBox(box?.width ?? 0, box?.height ?? 0))
      if (want && want !== layoutValue) {
        applyLayout(want, false)
        return
      }
    }
    options.onScreenLayout?.({ key: layoutOpt.key, values: layoutOpt.values, current: layoutValue })
    syncLayoutInput()
    watchGeometry()
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

  /** 播放器报的场合（见 RuntimeHandle.setStageMode）。记下来是因为可能来得比开局早 */
  let stageMode: StageMode = 'free'
  /** 盯着引擎自己开关按键那一格 style 的观察者，开局后装一次 */
  let padObserver: MutationObserver | null = null
  /** 手柄上沿和画面之间留的一线空隙，别让画面最底下一行像素贴着按键 */
  const PAD_GAP = 6

  const applyStageMode = () => {
    const root = iframe.contentDocument?.documentElement
    if (!root) return
    if (stageMode === 'free') root.removeAttribute('data-stage')
    else root.setAttribute('data-stage', stageMode)
  }

  /**
   * 量出引擎屏幕按键从容器底部往上一共占多高，写进 iframe 根节点的 --pad-h；
   * 竖屏布局下画布按它让位（见 FRAME_HTML 里那段 CSS）。按键收着的时候写 0。
   *
   * 为什么是量而不是查表：按键排布按核心走（引擎的 getControlScheme），SNES / GBA 多一对
   * L/R 挂在 top:-100px、N64 还有一整排在 .ejs_virtualGamepad_top 里，站长还能改
   * EJS_VirtualGamepadSettings —— 查表迟早对不上，量出来的永远是眼前这套。
   * 量的是各按键 / 十字键 / 摇杆区 getBoundingClientRect 并集的上沿到 .ejs_parent 底边的距离：
   * 手柄整套是 bottom 定位的，这个距离不随容器高度变，容器矮到按键顶出去了也量得准。
   * 空的分区容器不能算：.ejs_virtualGamepad_top 只有 N64 用，平时是个 0 高的空 div，
   * 却 bottom:250px 吊在半空 —— 算进去会白白多扣一截，所以只认有实际尺寸的元素。
   * 引擎的 handleResize 有个小动作：按键收着时会把它 opacity:0 亮 250ms 量尺寸再收回去，
   * 那一下 display 是空的、opacity 是 0，得当成「收着」，否则转屏时画布会抖一下。
   */
  /** 上一次写进去的 --pad-h。相同就不写（见 refreshPadMetrics 末尾） */
  let lastPadH = -1
  const refreshPadMetrics = () => {
    const win = iframe.contentWindow as (Window & Record<string, unknown>) | null
    const root = iframe.contentDocument?.documentElement
    const emu = emuOf()
    if (!win || !root || !emu) return
    const pad = emu.virtualGamepad
    const parent = emu.elements?.parent
    let height = 0
    if (pad && parent && pad.style.opacity !== '0' && win.getComputedStyle(pad).display !== 'none') {
      const base = parent.getBoundingClientRect().bottom
      let top = Infinity
      const parts = pad.querySelectorAll<HTMLElement>(
        '.ejs_virtualGamepad_button, .ejs_dpad_main, .nipple, .ejs_virtualGamepad_left, .ejs_virtualGamepad_right',
      )
      parts.forEach((el) => {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) return
        if (r.top < top) top = r.top
      })
      if (top !== Infinity) height = Math.max(0, Math.ceil(base - top) + PAD_GAP)
    }
    /*
      ⚠️ 值没变就别写。

      写 --pad-h 会改画布高度 → 引擎的 handleResize 跟着跑 → 而它有个小动作：
      把按键 opacity:0 亮 250ms 量完尺寸再收回去。那两次 style 写入又会触发我们盯着
      pad.style 的 MutationObserver → 再回到这里。写不写得一样并不影响循环成不成立，
      但**每写一次就是一次 style 失效 + 一次强制同步布局**（上面那圈 getBoundingClientRect），
      转屏、地址栏收放、引擎自己 resize 的时候会连着抖好几下。
      加这一道之后，量出来没变化的那些轮次直接就地停住。
    */
    if (height === lastPadH) return
    lastPadH = height
    root.style.setProperty('--pad-h', `${height}px`)
  }

  /** 见 RuntimeHandle.setStageMode。开局前调也行，开局时会补上（applyTouchInput） */
  const setStageMode = (mode: StageMode) => {
    stageMode = mode
    applyStageMode()
    refreshPadMetrics()
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
    pointerFirst = POINTER_FIRST.has(options.platform)
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
    syncTouchCaps()

    // 播放器可能在开局前就报过场合（见 setStageMode），到这儿才有稳定的 <html> 可写
    applyStageMode()
    refreshPadMetrics()
    /*
      引擎自己也会开关这套按键（玩家在它的设置菜单里点「虚拟手柄：关闭」），走的是
      style.display，我们收不到任何回调 —— 盯住 style 属性，一变就重量一次，
      否则按键已经收了、画布还留着那截空白。
    */
    if (pad && !padObserver && typeof MutationObserver === 'function') {
      // 用外层的 MutationObserver 盯 iframe 里的节点：同源，跨 realm 观察没有问题
      const observer = new MutationObserver(() => refreshPadMetrics())
      observer.observe(pad, { attributes: true, attributeFilter: ['style'] })
      padObserver = observer
    }
  }

  /** 工具栏那个「屏幕按键」开关走这里。引擎压根没画出按键时是空操作 */
  const setEnginePad = (show: boolean) => {
    if (!padAvailable) return
    const emu = emuOf()
    if (!emu) return
    emu.touch = true
    emu.toggleVirtualGamepad?.(show)
    padShown = show
    syncTouchCaps()
    refreshPadMetrics()
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
      指针优先的平台（画布本身就是触摸屏）绝不能让引擎锁鼠标指针，见 releaseMouseLock。

      ⚠️ 这一句**不能挪进 applyTouchInput** —— 那个函数一开头就 `if (!isMobile &&
      !hasTouchScreen && !coarse) return`，桌面浏览器根本进不去；而锁定指针恰恰只在
      桌面上发生（手机上没有 pointer lock 这回事）。放在这里、按平台判，才覆盖得到。
    */
    if (POINTER_FIRST.has(options.platform)) {
      const emu = emuOf()
      if (emu) releaseMouseLock(emu)
    }
    setupScreenLayout(win)
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
        /**
         * 光盘平台（PS1）：接管下载，为的是能缓存、能提前告诉玩家要下多少
         * （见 prepareRemoteDiscRom 的说明）。和街机那条互斥 —— 一个平台不会同时是两者。
         */
        if (!isFile && isSelfDownloadPlatform(options.platform) && !isDiscPlatform(options.platform)) {
          /*
            自己下载的**卡带**平台（目前只有 NDS，见 paths.ts 的 SELF_DOWNLOAD_PLATFORMS）。

            和光盘那条走的是同一个 prepareRemoteDiscRom，但**失败处理刻意不同**：
            光盘平台没得选（几百 MB 交给引擎的单条 XHR 本来就跑不完），失败就得报错；
            NDS 一直是引擎自己下的，所以这里失败只要**退回老路**就行 ——
            玩家最坏也只是没吃到缓存和断点重传，而不是本来能玩的游戏突然打不开。
            这一条的价值全在「不要为了一个优化把可玩性赔进去」，别改成往上报错。
          */
          try {
            const prepared = await prepareRemoteDiscRom(
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
            /*
              名字必须留住原始扩展名：EmulatorJS 是按扩展名认容器的，melonDS 的
              core.json 写的是 extensions:["nds"]。blob: 地址本身不带扩展名，
              喂错名字核心会当成裸镜像去解析（理由同 discNameFor 的注释）。
            */
            engineGameName = discNameFor(remoteGameUrl, options.gameName)
          } catch (error) {
            // 真的被取消了（换游戏 / 退出播放器）就到此为止，别接着往下开局
            if (destroyed || prepareAbort.signal.aborted) return
            console.warn('[emulatorjs] 自己下载 ROM 失败，改让引擎自己下：', error)
          }
        } else if (!isFile && isDiscPlatform(options.platform)) {
          const prepared = await prepareRemoteDiscRom(
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
          /**
           * ⚠️ 引擎的名字必须保留**原始扩展名**：核心是按扩展名认容器格式的
           * （.chd 是 MAME 容器、.pbp 是 PSP 打包、.cue 是文本清单）。
           * blob: 地址本身不带扩展名，这里不把名字喂对，核心会当成裸镜像去解析，
           * 报的是「格式不支持」而不是「名字不对」—— 完全指错方向。
           */
          engineGameName = discNameFor(remoteGameUrl, options.gameName)
          discRomPrepared = true
        } else if (!isFile && options.platform === 'arcade') {
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
          // 街机：引擎没有 arcade 分支，不给这份布局手机上就只有 4 颗动作键、
          // 摇杆还会把对角线松掉、投币键写着「选择」。见 ARCADE_VIRTUAL_PAD 的注释
          ...(options.platform === 'arcade' ? { EJS_VirtualGamepadSettings: ARCADE_VIRTUAL_PAD } : {}),
          /*
            默认键位：左手 WASD、右手 UIJK、Shift 投币、Enter 开始（见 keymapData 的 EJS_KEY_OVERRIDE）。
            引擎会把这份**逐颗按钮合并**进它出厂那套，没给的按钮（肩键、L2/R2）保持原样。

            ⚠️ 只影响**没改过键的人**。引擎把玩家改过的键位存在 localStorage 里，
            存过就一直用存的那份 —— 这是对的（不能替人把改过的键改回去），
            但也意味着你自己的浏览器上大概率看不到这次改动，要清掉引擎的控制设置才看得到。
          */
          EJS_defaultControls: EJS_DEFAULT_CONTROLS,
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
                // 不能直接给 NETPLAY_URL（/netplay）：这个 iframe 的 location 是 about:srcdoc，
                // socket.io 会把相对地址算成 http://about:80/…，HTTPS 页面上被 Mixed Content 拦掉，
                // 信令永远连不上。先在父页面这边解析成绝对地址
                EJS_netplayUrl: netplayUrlForFrame(),
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
            /*
              写失败**不拦着开局**（和上面 installRomDataInjector 的注释一致）：没了改版 dat，
              核心还能按原始 romset 试一把，比直接红字强。以前这里走 onError —— 而 onReady 之后的
              onError 等于拆掉这一局（第一轮体检的铁律），一个可选的补丁没写进去就把游戏关了。
              真缺文件的话核心自己会报「缺 xxx」，那条走 errorTap，比这里更准。
            */
            if (!destroyed) console.warn('[emulatorjs] RomData 没写进虚拟文件系统，按原始 romset 继续：', fmt(rt.ejsRomDataFailed, { msg }))
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

        // socket.io 客户端必须在 loader.js 之前就位：netplay 用的是全局 io()
        if (NETPLAY_URL) {
          await injectScript(doc, socketIoScriptUrl(), 8_000).catch(() => {
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
          instrumentRtc(win, (state) => netplay?.onLinkState?.(state), isDualScreen(options.platform))
        }
        if (destroyed) return
        // 清掉旧时代缓存的坏核心（见 purgePoisonedEngineCache 的注释），
        // 必须在 loader.js 之前 —— 引擎一起来就会去查这个库
        await purgePoisonedEngineCache()

        /**
         * ⚠️ 看门狗必须放在这里，不能更早。
         *
         * 它盯的两样东西（`.ejs_error_text`、`win.EJS_emulator.started`）都是 loader.js
         * 跑起来之后才可能出现的，早装一秒也看不到任何东西 —— 却会开始 30 秒倒计时。
         * 而它上面那几步全是**没有超时**的等待：注入 socket.io、取 ICE 配置、清缓存。
         * 信令主机被防火墙静默丢包（DROP 而不是 RST）时，`<script>` 要等到 TCP 超时才 onerror，
         * 三十几秒起步 —— 这期间没有任何东西能喂心跳（installNetTap 只包 iframe 里的 XHR，
         * `<script>` 和父窗口的 fetch 都不走它；`.ejs_loading_text` 此时还不存在）。
         * 于是**单机开一局街机也会被判「卡住了」**，重试一次再等 30 秒，最后红字。
         * 那一局根本不需要联机。
         */
        watchStart(win)
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
        if (!isFile && isDiscPlatform(options.platform) && !discRomPrepared) {
          const message = error instanceof Error ? error.message : String(error)
          options.onError?.(fmt(rt.ejsDiscDownloadFailed, { msg: message }))
          return
        }
        // 给运维看的细节进控制台；红字只说玩家能理解的那句
        console.warn(`[emulatorjs] failed to load runtime from ${EJS_PATH} — check the network or set VITE_EJS_PATH to a self-hosted copy`)
        options.onError?.(fmt(rt.ejsLoadFailed, { path: EJS_PATH }))
      }
    })()
  })

  container.appendChild(iframe)
  options.onCaps?.(caps)

  const destroy = () => {
    destroyed = true
    padObserver?.disconnect()
    padObserver = null
    prepareAbort.abort()
    window.clearInterval(playersTimer)
    window.clearInterval(stateTimer)
    window.clearInterval(startWatch)
    window.clearInterval(saveFlushTimer)
    // 盯几何那个是**有上限**的短定时器，正常自己会停；这里兜一道，
    // 免得玩家在切完布局那 3 秒里退出播放器，留一个跑在已销毁 iframe 上的回调
    window.clearInterval(geometryWatch)
    geometryWatch = 0
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
    /**
     * ⚠️ 先把核心停住再拆。
     *
     * 下面 iframe 只是 `display:none`，真正 remove 要等 `FS.syncfs` 回调或 1.5 秒超时；
     * 而 React 的 effect cleanup 一跑完就会立刻挂新会话 —— 中间这段**两套 WASM 堆是重叠的**。
     * 在详情页之间连点三款街机（或连点三次重试），手机上就同时存在 2~3 个
     * `mame2003_plus` 实例，每个几十到两百 MB，标签页会被系统回收。
     * 存档已经在上面 flushSaveFiles 里写过了，这里暂停不影响它。
     */
    try {
      emuOf()?.pause?.()
    } catch {
      /* 引擎还没起来 / 已经没了，都无所谓 */
    }
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
    /** 见 RuntimeHandle.openControls 的注释：把引擎自带改键面板的入口补回来 */
    openControls() {
      const menu = emuOf()?.controlMenu
      if (!canSetDisplay(menu)) return
      try {
        menu.style.display = ''
      } catch {
        /* 元素已经被引擎拆了就当没这回事 */
      }
    },
    popupOpen() {
      try {
        return emuOf()?.isPopupOpen?.() === true
      } catch {
        return false
      }
    },
    setScreenLayout: (value: string) => applyLayout(value, true),
    setStageMode,
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



