import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { DosBackend, DosWindowsVersion, GenreId, Platform, PlatformId } from '@/types'
import { platformMap } from '@/data/platforms'
import { formatBytes, isRomFileAccepted } from '@/lib/emulator'
import { detectRom, describeDetection } from './detect'
import { resolveRuntime, extOf } from './registry'
import type { Capability, LoadPhase, Runtime, RuntimeHandle, StageMode } from './types'
import { createOverallRatio, LOAD_PHASE_RANGE, windowsGuestStartupBudgetMs } from './loadProgress'
import { shouldCaptureMouse } from './mouseCapture'
import { platformBiosUrlSync } from '@/services/platformBios'
import { EmulatorTools } from './EmulatorTools'
import { TouchPad } from './TouchPad'
import { LiveControls } from './LiveControls'
import { MatchControls } from './MatchControls'
import { matchLocalArcadeHack } from './arcadeHack'
import { liveViewRuntime, type LiveSession, type LiveViewState } from './adapters/liveview'
import { emulatorJsRuntime, p2pPlayable, type NetplaySession } from './adapters/emulatorjs'
import { cloudGameRuntime, cloudPlayable, type CloudSession, type CloudState } from './adapters/cloudgame'
import { cx } from '@/lib/format'
import { Button, buttonClasses } from '@/components/ui/Button'
import { useShell } from '@/components/layout/ShellContext'
import { useT, fmt } from '@/services/i18n'
import { platformLabel } from '@/services/i18nData'
import { ROM_LANG_LABEL, type RomLang } from '@/config/languages'
import { FEATURES } from '@/config/features'
import { mobileScreenAspect } from './screenAspect'
import { recordPlay } from '@/services/store'
import { onMatchRequest } from '@/services/matchRequest'
import {
  claimRoom,
  downloadState,
  fetchNetplayRoom,
  gameIdFor,
  inviteLink,
  migrateRoom,
  netplayEnabled,
  playerName,
  refreshNetplayRooms,
  setRoomRole,
  useNetplayRooms,
  watchNetplayRoom,
  type RoomRole,
} from '@/services/netplay'
import { freePlayerIndex, keepAlive, roomLink, roomsEnabled, useRoom, MAX_PLAYERS } from '@/services/rooms'

type Status = 'idle' | 'loading' | 'running' | 'error'
type Mode = 'local' | 'online'
/** 联机走哪条路：p2p = 房主浏览器直推（默认）；cloud = 游戏跑在服务器上（付费） */
type Channel = 'p2p' | 'cloud'

/**
 * 拿不到真实字节数时，各阶段仍按这个时长缓慢推进到区间末尾前 1%。
 * 最后 1% 必须留给真正的 onReady，不能把“还在等”画成“已经成功”。
 */
const LOAD_PHASE_DURATION_MS: Record<Exclude<LoadPhase, 'starting'>, number> = {
  engine: 20_000,
  assets: 45_000,
  rom: 45_000,
}
const LOAD_PROGRESS_CEILING = 0.99
/** 自动重试只做一次：网络抖动能自愈，坏 ROM 也不会陷入无限刷新。 */
const AUTO_RETRY_LIMIT = 1

interface ActiveSession {
  id: number
  game: File | string
  /** 实际运行的平台（本地文件被识别为其他平台时可能与页面平台不同） */
  platform: PlatformId
  runtime: Runtime
  /** P2P 联机会话（游戏在房主浏览器里跑） */
  netplay?: NetplaySession
  /** 云端联机会话（游戏在服务器上跑） */
  cloud?: CloudSession
  /** 看直播：本机不跑游戏，画面来自主播的浏览器 */
  live?: LiveSession
  /** 当前这次加载已经自动重试了几次；只在启动失败时递增。 */
  retryAttempt?: number
}

interface Props {
  platform: Platform
  gameName: string
  /**
   * 游戏 slug。联机需要它：房间按 slug 分组，邀请链接也用它。
   * 不传（玩本地 ROM 页）就没有联机入口。
   */
  gameSlug?: string
  /** 该游戏支持的最大玩家数（决定房间容量）。> 1 时默认走联机 */
  maxPlayers?: number
  /**
   * 外面已经把整块高度交给播放器了（嵌入页 /embed/:slug 就是这样：h-dvh 的列里给了
   * flex-1）。窄屏上据此按游玩布局排 —— 画面吃满高度、引擎按键叠在下面 ——
   * 而不是套一个按平台比例的小框，那个框在手机上装不下引擎自带的整套按键。
   *
   * 不自己 fixed 铺满：嵌入页底下还有一条必须留着的品牌栏，盖掉就违约了。
   * 配套要给 className 一个 max-sm:h-full，高度链才连得上（见 EmbedPage）。
   */
  fill?: boolean
  /** 邀请链接带进来的 P2P 房间 id（详情页 ?p2p=） */
  invite?: string
  /** 邀请链接带进来的云端房间 id（详情页 ?room=，付费通道） */
  cloudInvite?: string
  /** 从「直播」入口进来（详情页 ?watch=1）：默认以观众身份加入，只看不玩 */
  watch?: boolean
  /**
   * 观看链接带进来的直播间 id（详情页 ?live=）。
   * 和 ?watch= 不是一回事：那个是联机房里的观众席，这个是「一人玩多人看」的直播。
   */
  liveInvite?: string
  /** 空闲态背景（例如封面） */
  backdrop?: ReactNode
  /** 空闲态显示的图标 */
  icon?: string
  className?: string
  /** 若有可直接访问的 ROM URL（对象存储 / 自制开源游戏），可跳过上传 */
  romUrl?: string
  /** 这一款游戏指定的模拟器核心。不传就用平台默认 */
  core?: string
  /** 游戏类别；DOS 射击游戏据此启用相对鼠标锁定。 */
  genres?: readonly GenreId[]
  /** FBNeo RomData（.dat 文本）；街机改版包靠它挂到现成驱动上运行。 */
  arcadeRomData?: string
  /** DOS 启动程序覆盖（zip 内相对路径），jsdos 运行时用 */
  dosExecutable?: string
  /** DOS 运行核心：Windows 客体的完整 .jsdos 镜像必须走 DOSBox-X */
  dosBackend?: DosBackend
  /** 可复用的 Windows 系统 .jsdos；游戏 ROM 仍单独加载。 */
  dosSystemUrl?: string
  /** Windows 3.x 与 9x 的“运行”入口不同；旧数据留空时按 9x 处理。 */
  dosWindowsVersion?: DosWindowsVersion
  /** 客体 Windows 切入图形模式后，等待多少秒再执行 dosExecutable。 */
  dosLaunchDelay?: number
  /** 逐游戏 DOSBox-X 启动配置覆盖；由后台高级编辑器维护。 */
  dosboxConfig?: string
  /** 这款 DOS 游戏的存档按键说明；显示在工具栏「保存进度」的说明面板里。 */
  dosSaveHint?: string
  /** 平台级 BIOS 的地址（见 services/platformBios.ts）。Neo Geo 这类平台缺了就起不来 */
  biosUrl?: string
  /** 正在探测云端 ROM 是否存在 */
  romChecking?: boolean
  /** 当前语言及英语、日语、中文回退均没有可用 ROM */
  romUnavailable?: boolean
  /**
   * 重新探测云端 ROM（会先清掉这款游戏的探测缓存）。
   *
   * 「探不到」不一定等于「真没有」：一次网络抖动或 HEAD 超时也会走到这个状态，
   * 而玩家看到的只是「选择 ROM 开始游戏」，会以为站上压根没这个游戏。
   * 给一个按钮，比让人去刷新整页强。
   */
  onRetryRom?: () => void
  /**
   * 这款游戏绑了哪几种语言的 ROM。少于两种时不显示切换入口 ——
   * 只有一份 ROM 的话「切换语言」是个假选项。
   */
  romLangs?: RomLang[]
  /** 当前用的是哪一种（由 useRomUrl 反查出来） */
  romLang?: RomLang
  /** 玩家选了别的语言。父组件据此换 romUrl，换完这边会自动重开这一局 */
  onRomLangChange?: (lang: RomLang) => void
  /**
   * 本地文件识别出的平台与页面平台不一致时如何处理：
   *   'switch' —— 用识别出的平台运行（玩本地 ROM 页）
   *   'warn'   —— 提示但仍按页面平台运行（游戏详情页）
   */
  onDetectMismatch?: 'switch' | 'warn'
  /** 平台切换回调（onDetectMismatch = 'switch' 时触发） */
  onPlatformChange?: (platform: PlatformId) => void
  /**
   * 自动识别没能判定平台、当前平台又不接受这个文件时触发。
   *
   * 「玩本地 ROM」页去掉了常驻的平台选择器，靠这个回调在识别失败时才让用户手动指定 ——
   * 否则一个内含单个 .bin 的 zip（detect.ts 只会给出 confidence: 'low' 且不给平台）
   * 会拿默认平台去跑，必然失败而且用户没有任何出路。
   *
   * 返回 true 表示页面已经接管（不再显示默认的「格式不支持」错误）。
   */
  onDetectFailed?: (file: File) => boolean | void
  /**
   * 外部要求重新运行某个本地文件。每次传入**新对象**都会重新开始一次
   * （用对象包一层而不是直接传 File，是为了同一个文件也能重试第二次）。
   */
  retryRequest?: { file: File } | null
}

/**
 * 通用播放器：根据平台从运行时注册表选择模拟器（EmulatorJS / Ruffle …）。
 *  idle    —— 显示封面与「选择 ROM 开始游戏」，支持拖拽
 *  loading —— 已选择文件，运行时资源加载中
 *  running —— 运行时已就绪（运行在独立 iframe 内）
 *
 * 联机模式（online）默认走 **P2P**：游戏在房主自己的浏览器里跑，画面经 WebRTC 直推给
 * 加入的人，不经过服务器。房间自动出现在侧边栏「联机玩」，朋友打开邀请链接即可加入。
 * cloud-game（游戏跑在服务器上）是另一条通道，成本高，由 FEATURES.cloudGame 控制，留给付费会员。
 */
/**
 * 没到 sm 断点（Tailwind 的 sm 是 min-width:640px）。
 * 写成 max-width:639.98px 而不是 639px：中间那 1px 的小数宽度（缩放、分屏）
 * 两个查询都不命中的话，CSS 的 sm: 类名和这里的判断就会各说各话。
 */
const NARROW_MQ = '(max-width: 639.98px)'
/**
 * 矮视口（手机横屏那一档）。手机横过来宽度到了 850+，NARROW_MQ 不再命中，
 * 但 330pt 左右的高度放不下详情页里那个 16:9 的框，同样得用铺满视口的游玩布局。
 * 单看高度会把窄小的桌面窗口也算进去，所以用它的地方都再叠一个 touchDevice。
 */
const SHORT_MQ = '(max-height: 499.98px)'
/** 粗指针（手指）。和 touchDevice 那个 state 用的是同一条查询，跳变时现场再问一次用 */
const COARSE_MQ = '(any-pointer:coarse)'
/** 「这是台要用游玩布局的手机」的现场判断：窄屏一律算，横屏靠「矮 + 触屏」认 */
const isCompactViewport = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  (window.matchMedia(NARROW_MQ).matches || (window.matchMedia(COARSE_MQ).matches && window.matchMedia(SHORT_MQ).matches))

/** 「手柄在这儿」的开局提示看过了没。按浏览器记 —— 教一次就够 */
const PAD_HINT_KEY = '8bitgo.padhint.seen'

/**
 * 「◧ 沉浸模式」→「◧」：手机上按钮只留前面那个符号。
 *
 * 八种语言的这几条文案都是「符号 + 空格 + 文字」的形状，省掉文字部分能让工具栏
 * 在 320pt 宽的屏幕上也保持一行（实测带文字会换行，一行 34pt 是从画面高度里扣的）。
 * 万一哪天某个语言的文案不是这个形状（开头那段里含字母或数字），就原样返回 ——
 * 宁可多占点宽度，也不能给玩家显示一个被截断的词。
 */
function glyphOnly(label: string): string {
  const [head, ...rest] = label.split(' ')
  return rest.length > 0 && head.length <= 2 && !/[\p{L}\p{N}]/u.test(head) ? head : label
}

export function EmulatorPlayer({
  platform,
  gameName,
  gameSlug,
  maxPlayers = 2,
  fill = false,
  invite,
  cloudInvite,
  watch = false,
  liveInvite,
  backdrop,
  icon,
  className,
  romUrl,
  core,
  genres,
  arcadeRomData,
  dosExecutable,
  dosBackend,
  dosSystemUrl,
  dosWindowsVersion,
  dosLaunchDelay,
  dosboxConfig,
  dosSaveHint,
  biosUrl,
  romChecking,
  romUnavailable,
  onRetryRom,
  romLangs,
  romLang,
  onRomLangChange,
  onDetectMismatch = 'warn',
  onPlatformChange,
  onDetectFailed,
  retryRequest,
}: Props) {
  const [status, setStatus] = useState<Status>('idle')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [session, setSession] = useState<ActiveSession | null>(null)
  /**
   * 从玩家上传的包里认出来的 RomData（见 arcadeHack.ts）。
   * 入库游戏由后台配 arcadeRomData，「玩本地 ROM」这一路只能靠现场识别。
   */
  const [localRomData, setLocalRomData] = useState<string | undefined>(undefined)

  const t = useT()
  const { immersive, setImmersive, toggleImmersive, available: shellAvailable } = useShell()

  /* ---------------- 联机 ---------------- */
  // 联机需要云端 ROM：房主和访客都得能拿到同一个 ROM
  const p2pOk = Boolean(gameSlug) && Boolean(romUrl) && p2pPlayable(platform.id)
  const cloudOk = FEATURES.cloudGame && Boolean(gameSlug) && cloudPlayable(platform.id)
  const onlineOk = p2pOk || cloudOk
  /** 优先 P2P；P2P 不可用而云端可用时才走云端 */
  const channel: Channel = p2pOk ? 'p2p' : 'cloud'

  const [ignoreInvite, setIgnoreInvite] = useState(false)
  /**
   * 邀请链接里的房间 id 顺着别名解析成当前真正的 id。
   *
   * 换过房主的房间在列表里是新 id，而链接里带的是旧 id —— 以前直接拿旧 id 去列表里找，
   * 找不到就判成「房间已关闭」把按钮禁掉。服务器辛辛苦苦做的别名（老链接继续有效）
   * 在前端这一步被整个废掉了。单房间接口会顺着别名走并给出 migratedTo，先问它一次。
   */
  const [resolvedInvite, setResolvedInvite] = useState<string | undefined>(undefined)
  useEffect(() => {
    setResolvedInvite(undefined)
    if (!invite || ignoreInvite || !netplayEnabled()) return
    let stop = false
    void fetchNetplayRoom(invite).then((room) => {
      if (!stop) setResolvedInvite(room?.migratedTo || room?.roomId || invite)
    })
    return () => {
      stop = true
    }
  }, [invite, ignoreInvite])
  /** 还在解析别名：这段时间别急着说「房间已关闭」 */
  const inviteResolving = Boolean(invite) && !ignoreInvite && netplayEnabled() && resolvedInvite === undefined
  const inviteId = ignoreInvite ? undefined : (resolvedInvite ?? invite)
  const cloudInviteId = ignoreInvite ? undefined : cloudInvite
  const joining = Boolean(inviteId) || Boolean(cloudInviteId)

  /**
   * 默认是否走联机：**只有点邀请链接进来的人**。
   *
   * 以前多人游戏一进来就自动建房，玩家还没决定要不要跟人玩，房间已经挂在大厅里了。
   * 现在所有人都先自己开着玩（自动开播，见 LiveControls），想让人进来再点「联机匹配」——
   * 那一下不重开游戏，直接在跑着的这一局上开房（handle.openNetplay）。
   */
  const onlineByDefault = onlineOk && joining
  const [mode, setMode] = useState<Mode>(onlineByDefault ? 'online' : 'local')
  const online = mode === 'online' && onlineOk

  const [roomId, setRoomId] = useState<string | null>(null)
  const [players, setPlayers] = useState(1)
  /**
   * 「联机匹配」开出来的房间。
   *
   * 和 session.netplay 那一路的区别：那是带着联机会话挂载起来的（点邀请链接进来的人），
   * 这一路是在**已经跑着的本机会话**上后开的房，session 里没有 netplay ——
   * 所以房间状态得自己记一格，否则工具栏认不出「我正开着房」。
   */
  const [hosting, setHosting] = useState(false)
  const [matchBusy, setMatchBusy] = useState(false)
  /** netplay 给我们分配的身份 id，服务器用它判断「谁该接手」 */
  const myIdRef = useRef<string>('')
  /** 正在接手的旧房间 id：新房间开好后要调 /migrate 把两者接上 */
  const migrateFromRef = useRef<string>('')
  /** 认领令牌（/claim 发的）：/migrate 靠它证明「我是被选中的那个人」 */
  const claimTokenRef = useRef<string>('')
  /** 新房间号先到还是新令牌先到说不准，两样都齐了才能 /migrate —— 记下已开好的新房间号 */
  const migrateToRef = useRef<string>('')
  /** 访客网络抖一下自动重进一次；连续失败就别循环了 */
  const rejoinedRef = useRef(false)
  /** 服务端下发的房间令牌：取存档、接手房主、切身份都要用它证明自己是房间成员 */
  const roomTokenRef = useRef<string>('')
  /** 我在房间里的身份。观众只收画面和声音，按键不生效 */
  const [role, setRole] = useState<RoomRole>('player')
  /**
   * 我正在看的这个直播间，主播有没有同时开着联机房（有就是房号）。
   * 来源：liveview 的 onNetplay —— 进房时的 ack 带一次，主播中途点「联机」再推一次。
   */
  const [liveNetplayRoom, setLiveNetplayRoom] = useState<string | null>(null)
  /**
   * 我是从哪个直播间点「加入联机」进来的（空 = 不是从直播间来的）。
   *
   * 联机这边散了的时候用它退回去接着看：主播结束联机之后直播是不停的，
   * 那条流还在，没道理把人扔到错误页上。
   */
  const liveReturnRef = useRef('')
  /** 我是不是房主（房主的机器在跑游戏，不能退到观众席） */
  const [isHost, setIsHost] = useState(false)
  /** 适配器交出来的「切身份」函数：不用断线重连就能上场 / 退下 */
  const roleSwitchRef = useRef<((spectator: boolean) => void) | null>(null)
  const [copied, setCopied] = useState(false)
  const slots = Math.max(1, Math.min(MAX_PLAYERS, maxPlayers))

  // P2P：从房间列表里找要加入的那个房间（判断满没满、还在不在）
  const p2pRooms = useNetplayRooms()
  const inviteRoom = inviteId ? p2pRooms.find((r) => r.roomId === inviteId) : undefined
  const inviteGone = Boolean(inviteId) && status === 'idle' && !inviteResolving && p2pRooms.length > 0 && !inviteRoom
  /** 房主掉线、正在换人：这时进去会被拒（room is changing host），先别让人点 */
  const inviteChanging = Boolean(inviteRoom?.awaitingHost)
  const inviteFull = Boolean(inviteRoom && inviteRoom.players >= inviteRoom.max)
  /**
   * 手柄位满了还有没有观众席。
   * 老服务端不下发 maxSpectators，这里会算成 0 —— 行为退回原来的「房间已满」，不会出错。
   */
  const spectatorSeatFree = Boolean(
    inviteRoom && (inviteRoom.spectators ?? 0) < (inviteRoom.maxSpectators ?? 0),
  )
  /** 能不能以观众身份进这个房间（只有 P2P 房间是一路直播） */
  const canWatch = p2pOk && Boolean(inviteRoom) && spectatorSeatFree
  /**
   * 这次进房会不会是观众：从「直播」入口点进来的（?watch=1），
   * 或者手柄位已经坐满了。按钮文案和下面的说明都跟着它走，
   * 免得写着「加入房间」结果进去发现动不了。
   */
  const willWatch = canWatch && (watch || inviteFull)
  /** 正在看的人数（自己所在的房间） */
  const myNetRoom = (session?.netplay || hosting) && roomId ? p2pRooms.find((r) => r.roomId === roomId) : undefined
  const viewers = myNetRoom?.spectators ?? 0

  // 云端：连接状态与手柄位
  const [cloudState, setCloudState] = useState<CloudState | null>(null)
  const [slotIndex, setSlotIndex] = useState(0)
  const cloudJoinRoom = useRoom(cloudOk && status === 'idle' ? cloudInviteId : undefined)
  const cloudJoinPending = Boolean(cloudInviteId) && roomsEnabled() && cloudJoinRoom === undefined
  const myCloudRoom = useRoom(session?.cloud ? (roomId ?? undefined) : undefined)

  /** 当前运行时句柄 + 它上报的能力集合（决定工具栏画哪些按钮） */
  const [handle, setHandle] = useState<RuntimeHandle | null>(null)
  /**
   * 加载进度：存的是**合成后**的整条进度（0~1），不是适配器报的分阶段进度。
   * 合成逻辑在 loadProgress.ts 的 createOverallRatio —— 每次加载新建一个，
   * 它负责把 engine / assets / rom / starting 四段折进同一条 0→100，并且只进不退。
   */
  const [loadRatio, setLoadRatio] = useState<number | null>(null)
  const overallRatio = useRef(createOverallRatio())
  /** 当前视觉阶段的起点；真实回调停顿时，计时兜底从这里继续向前走。 */
  const progressClock = useRef<{ phase: LoadPhase; startedAt: number }>({ phase: 'engine', startedAt: Date.now() })
  const [caps, setCaps] = useState<Set<Capability>>(() => new Set())

  const hostRef = useRef<HTMLDivElement>(null)
  /**
   * 这台设备有没有「粗指针」（手指）。桌面鼠标是 fine，不画屏幕按键。
   * 放进 state 而不是直接算：这个组件会被 SSR，服务端没有 matchMedia，
   * 直接算会让首屏 HTML 和 hydrate 结果对不上。
   */
  const [touchDevice, setTouchDevice] = useState(false)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    setTouchDevice(window.matchMedia(COARSE_MQ).matches)
  }, [])
  /**
   * 窄屏（手机竖屏那一档）。布局要用它决定虚拟手柄摆哪儿，所以必须**订阅**而不是只算一次 ——
   * 玩家横过屏幕、或者在平板上分屏，这个值会变，手柄得跟着从「画面下面一条」换成「浮层」。
   * 同样放进 state：服务端没有 matchMedia，直接算会让首屏 HTML 和 hydrate 结果对不上。
   */
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(NARROW_MQ)
    const sync = () => setNarrow(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  /** 矮视口（见 SHORT_MQ）。同样要订阅：手机转个方向它就变 */
  const [shortViewport, setShortViewport] = useState(false)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(SHORT_MQ)
    const sync = () => setShortViewport(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  /**
   * 是不是正处在原生全屏里。
   *
   * 需要单独记一份，因为布局要按它切：全屏时画面应该吃掉除工具栏以外的全部高度
   * （flex-1），而非全屏时移动端要给画面一个按原生比例的框。光靠 CSS 的 :fullscreen
   * 也能写，但那要用嵌套的任意变体去改子元素，读起来远不如这里一个布尔清楚。
   *
   * 监听 fullscreenchange 而不是在 toggleFullscreen 里自己置位：用户按 Esc、
   * 或者浏览器自己退出全屏时不会经过我们的按钮。
   */
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === hostRef.current)
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])
  /**
   * 这台浏览器有没有元素级的 Fullscreen API。iPhone 的 Safari 没有（只给 <video>），
   * 「⛶ 全屏」点了什么都不会发生 —— 那种设备上干脆不画这颗按钮，沉浸模式就是它的全屏。
   * 放 state：SSR 没有 document，首屏 HTML 和 hydrate 结果得对上。
   */
  const [fullscreenApi, setFullscreenApi] = useState(true)
  useEffect(() => {
    setFullscreenApi(
      document.fullscreenEnabled !== false && typeof document.documentElement.requestFullscreen === 'function',
    )
  }, [])

  /**
   * 手机（含横屏）。窄屏一律算；横屏时靠「矮 + 触屏」认（见 SHORT_MQ）。
   * 和 isCompactViewport() 是同一条判断，这份是订阅着的、给渲染用。
   */
  const compact = narrow || (touchDevice && shortViewport)
  /**
   * 游玩布局：手机上的沉浸模式不再只是「隐藏顶栏」，而是把舞台 position:fixed 铺满整个视口 ——
   * 画面在上、按键在下、工具栏压底，页面的其余部分全在它底下。
   *
   * 为什么要这一层：iPhone 的 Safari 不给网页元素 Fullscreen API，「全屏」在手机上本来就
   * 不存在；而页面里那个按平台比例的小框（4:3 → 290pt 高）放不下引擎自带的整套按键
   * （230px 起），按键只能压在画面上，用户实测「根本玩不了」。铺满视口之后，画面 + 按键
   * 有 600pt 以上可用，两者各占一头（竖屏的 iframe 里画布给按键让位，见
   * adapters/emulatorjs.ts 的 FRAME_HTML）；横屏时画面占满高度、按键落在两侧黑边里。
   *
   * 原生全屏（安卓 Chrome 能进）时浏览器自己把舞台撑满了，这一层让位（!fullscreen）。
   * 舞台 DOM 结构在三种布局下完全一样，只换 className —— iframe 一旦被重新挂载游戏就重开了。
   */
  const playMode = immersive && compact && !fullscreen
  /**
   * 嵌入页在窄屏上的等价物（见 fill 属性）：一样是画面吃满高度、按键叠在下面，
   * 只是不 fixed —— 那边的高度是外面用 flex 给的，底下还有一条品牌栏要留着。
   * 用 narrow 而不是 compact：高度链靠的是 EmbedPage 传的 max-sm:h-full，两者要严格对齐。
   */
  const embedFill = fill && narrow
  /**
   * 「监视器」态：手机上游戏在跑、但不在游玩布局里（玩家点了退出沉浸，回详情页看简介）。
   * 画面缩在小框里，引擎自带的按键压在里面既按不到也挡画面 —— 让适配器先把它整套收起来，
   * 画面完整露出，整块画面变成「点一下回去玩」的按钮；回到游玩布局再放出来。
   * 见 RuntimeHandle.setStageMode 的 'monitor'。
   *
   * ⚠️ 必须先看 shellAvailable。嵌入页没有 ShellProvider，那儿的 setImmersive 是个空函数 ——
   * 不判这一条的话，嵌入页在手机上会进监视器态：按键被收起来、盖上一张「点按回去玩」，
   * 而那一点根本回不去，游戏直接变成没法操作的动图。
   */
  const monitor = shellAvailable && compact && touchDevice && !playMode && !embedFill && !fullscreen

  /**
   * 游玩布局期间锁住页面滚动，并且退出时把播放器滚回视口。
   *
   * 舞台 fixed 铺满视口之后，手指落在 iframe 里不会滚页面（引擎那边 touch-action:none），
   * 但工具栏这一条还在外层文档里，iOS 上在它上面一划、底下的详情页就跟着走，
   * 退出时不知道滚到了哪儿。锁在 <html> 上而不是 body：ShellContext 的抽屉用的是
   * body.style.overflow，两边别互相覆盖。overscroll-behavior 顺手一起关，
   * 安卓 Chrome 在页面顶上往下一拽是「下拉刷新」—— 十字键往下推一下游戏就没了。
   *
   * 退出时滚一下：舞台从 fixed 回到文档流，它 fixed 期间页面塌掉了一截，滚动位置对不上，
   * 玩家看到的可能是简介的中段而不是刚才那局。放 rAF 里等重排落定再滚。
   *
   * scrollbar-gutter 也要一起放开。index.css 给 html 设了 `scrollbar-gutter: stable`
   * （为了让长短页面的顶栏按钮不左右跳），它会**从视口里切掉**一条滚动条宽的位置，而
   * fixed inset-0 铺的是切剩下的那块 —— probe 实测 393 的视口上舞台只有 378 宽，
   * 右边留一条 15px 的白边。手机浏览器是覆盖式滚动条，这条规则本来就不生效，看不出来；
   * 但把桌面窗口拖窄到 640 以下同样会进游玩布局，那儿就是一道白杠。
   * 反正这时页面已经不滚了，槽留着没有任何意义。
   */
  const wasPlayModeRef = useRef(false)
  useEffect(() => {
    const root = document.documentElement
    if (playMode) {
      wasPlayModeRef.current = true
      const prevOverflow = root.style.overflow
      const prevOverscroll = root.style.overscrollBehavior
      const prevGutter = root.style.scrollbarGutter
      root.style.overflow = 'hidden'
      root.style.overscrollBehavior = 'none'
      root.style.scrollbarGutter = 'auto'
      return () => {
        root.style.overflow = prevOverflow
        root.style.overscrollBehavior = prevOverscroll
        root.style.scrollbarGutter = prevGutter
      }
    }
    if (!wasPlayModeRef.current) return
    wasPlayModeRef.current = false
    const raf = requestAnimationFrame(() => hostRef.current?.scrollIntoView({ block: 'start' }))
    return () => cancelAnimationFrame(raf)
  }, [playMode])

  /**
   * 手机上游戏一开始跑，就顺手进沉浸模式并把画面滚到视口顶上。
   *
   * 为什么要自动：390pt 宽的屏幕上，顶栏 + 面包屑 + 大标题在画面上方吃掉一大截可视高度。
   * 玩家点完「开始游戏」，游戏其实已经在跑了，但他看到的还是页面上半部分 ——
   * 得自己往下滑才找得到画面。沉浸模式本来就是为这个场景做的，只是以前得手动点一下。
   *
   * 三条约束，缺一条就会变成骚扰：
   *  · **只在手机上做**（isCompactViewport：窄屏，或者「矮 + 触屏」的横屏手机）。
   *    桌面端播放器本来就是个够高的 16:9 框，自动把侧边栏收掉毫无道理。
   *  · **只在「刚开始跑」这一下做**（拿 prevStatus 比对），不是每次 render 都推一把 ——
   *    否则玩家自己点「退出沉浸」会被我们立刻按回去，按钮看起来像坏的。
   *  · **我们开的我们关**：停下来 / 离开这个组件时恢复原样；玩家自己开的沉浸不去动它
   *    （所以进来时先看 immersiveRef，已经开着就不认领）。
   */
  const immersiveRef = useRef(immersive)
  immersiveRef.current = immersive
  const prevStatusRef = useRef(status)
  /** 这一局的沉浸是我们自动开的（而不是玩家手动开的），只有这种才由我们负责关掉 */
  const autoImmersiveRef = useRef(false)
  useEffect(() => {
    const was = prevStatusRef.current
    prevStatusRef.current = status
    // 现场再问一次而不是读上面那些 state：这里要的是「跳变发生的这一刻」的尺寸，
    // 不受 state 更新时序影响
    if (status === 'running' && was !== 'running') {
      if (!isCompactViewport() || immersiveRef.current) return
      autoImmersiveRef.current = true
      // 手机上沉浸 = 铺满视口的游玩布局（见 playMode），舞台是 fixed 的，不用再滚到它那儿
      setImmersive(true)
      return
    }
    if (status !== 'running' && was === 'running' && autoImmersiveRef.current) {
      autoImmersiveRef.current = false
      setImmersive(false)
    }
  }, [status, setImmersive])
  // 离开页面（切路由、切游戏）时把自动开的沉浸模式还回去
  useEffect(
    () => () => {
      if (autoImmersiveRef.current) {
        autoImmersiveRef.current = false
        setImmersive(false)
      }
    },
    [setImmersive],
  )
  /**
   * 把「场合」报给运行时（见 RuntimeHandle.setStageMode）：游玩布局 / 监视器 / 其余。
   * 只有 EmulatorJS 实现了它 —— 别的运行时没这回事，可选链跳过。
   */
  const stageMode: StageMode = playMode || embedFill ? 'play' : monitor ? 'monitor' : 'free'
  useEffect(() => {
    if (status !== 'running') return
    handle?.setStageMode?.(stageMode)
  }, [handle, status, stageMode])
  /** 从监视器态点画面回到游玩布局。算作「我们开的」：游戏一停就还回去，和自动进沉浸那条一致 */
  const enterPlayMode = useCallback(() => {
    autoImmersiveRef.current = true
    setImmersive(true)
  }, [setImmersive])
  const frameRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const sessionCounter = useRef(0)
  // gameName 只用于存档 / 截图命名，放进 effect 依赖会导致「切换语言就把正在跑的游戏重启」
  const gameNameRef = useRef(gameName)
  gameNameRef.current = gameName
  // 同理：游玩计数只在 onReady 里读一次，不该让它把正在跑的会话重建
  const gameSlugRef = useRef(gameSlug)
  gameSlugRef.current = gameSlug
  // 核心与 BIOS 也走 ref：BIOS 是异步取回来的，进依赖的话它一到货就会把
  // 正在跑的游戏重启一遍；这两个值只在挂载引擎那一刻读一次就够了
  const coreRef = useRef(core)
  coreRef.current = core
  // 分类只在新会话挂载时决定鼠标模式；后台热改分类不该中断玩家当前这一局。
  const genresRef = useRef(genres)
  genresRef.current = genres

  const arcadeRomDataRef = useRef(arcadeRomData)
  // 后台配的那份最权威（管理员可能手工调过），识别出来的只作兜底
  arcadeRomDataRef.current = arcadeRomData || localRomData
  const biosUrlRef = useRef(biosUrl)
  biosUrlRef.current = biosUrl
  // 同 core：只在挂载那一刻读一次，进依赖会把正在跑的游戏重启
  const dosExecutableRef = useRef(dosExecutable)
  dosExecutableRef.current = dosExecutable
  // 和启动程序一样，只在真正挂载 js-dos 时读取，后台配置变化不该打断已经开始的游戏
  const dosBackendRef = useRef(dosBackend)
  dosBackendRef.current = dosBackend
  // 系统镜像与等待时间也只在新会话挂载时读取；后台热改配置不应中断玩家当前这一局。
  const dosSystemUrlRef = useRef(dosSystemUrl)
  dosSystemUrlRef.current = dosSystemUrl
  const dosWindowsVersionRef = useRef(dosWindowsVersion)
  dosWindowsVersionRef.current = dosWindowsVersion
  const dosLaunchDelayRef = useRef(dosLaunchDelay)
  dosLaunchDelayRef.current = dosLaunchDelay
  const dosboxConfigRef = useRef(dosboxConfig)
  dosboxConfigRef.current = dosboxConfig
  /** 云端联机是否真的跑起来过（用于区分「没连上」和「玩到一半断了」） */
  const cloudPlayedRef = useRef(false)
  /** 看直播：观众人数与直播标题 */
  const [liveViewers, setLiveViewers] = useState(0)
  const [liveState, setLiveState] = useState<LiveViewState | null>(null)

  // 云端 ROM 也按其文件扩展名选引擎；还没拿到地址时退回平台默认
  const pageRuntime = resolveRuntime({ platform: platform.id, ext: extOf(romUrl) })
  const supported = Boolean(pageRuntime) || onlineOk
  // 云端联机连不上时的本地兜底（用 ref，避免挂载 effect 捕获到旧值）
  const localFallbackRef = useRef<{ url?: string; runtime?: Runtime }>({})
  localFallbackRef.current = { url: romUrl, runtime: pageRuntime }

  const begin = (
    game: File | string,
    targetPlatform: PlatformId,
    runtime: Runtime,
    extra?: { netplay?: NetplaySession; cloud?: CloudSession; retryAttempt?: number },
  ) => {
    sessionCounter.current += 1
    setSession({ id: sessionCounter.current, game, platform: targetPlatform, runtime, ...extra })
    // 上一局的进度必须清掉，否则新会话的遮罩会先闪一下上次的 100%。
    // 合成器也要换一个新的：它记着「已显示的最大值」，不换的话新一局会被上一局的 100% 卡住
    overallRatio.current = createOverallRatio()
    progressClock.current = { phase: 'engine', startedAt: Date.now() }
    // 自动重试仍是同一次“开始游戏”：保留玩家已经看到的进度，避免失败瞬间从高位跳回 0%，
    // 看起来像整个加载被推倒重来。玩家主动开的新一局才从头显示。
    if (!extra?.retryAttempt) setLoadRatio(null)
    setStatus('loading')
  }

  /** 阶段只允许向前走；并行请求迟到的回调不能把计时器拨回上一段。 */
  const enterProgressPhase = (phase: LoadPhase) => {
    const order: LoadPhase[] = ['engine', 'assets', 'rom', 'starting']
    if (order.indexOf(phase) <= order.indexOf(progressClock.current.phase)) return
    progressClock.current = { phase, startedAt: Date.now() }
  }

  /**
   * 有些阶段拿不到 Content-Length，甚至在 WASM 初始化期间完全没有网络回调。
   * 这时在当前阶段的固定区间内补一条缓慢前进的视觉进度：核心与镜像走到 40%，
   * ROM 走到 80%，最后 20% 按启动超时推进。真实进度更快就跟真实进度走。
   */
  useEffect(() => {
    if (status !== 'loading' || !session) return
    setLoadRatio((current) => Math.max(current ?? 0, 0.01))
    const timer = window.setInterval(() => {
      const { phase, startedAt } = progressClock.current
      const [phaseStart, phaseEnd] = LOAD_PHASE_RANGE[phase]
      let duration: number
      if (phase === 'starting') {
        const windowsGuest = session.platform === 'dos' && dosBackendRef.current === 'dosboxX' && dosSystemUrlRef.current
        // Windows 客体要先在 WASM 里挂近百 MB 的系统盘；视觉进度与真实失败兜底共用预算，
        // 慢设备不会先停在 99%，更不会在本来还能成功时被旧的 45 秒门槛判死。
        duration = windowsGuest ? windowsGuestStartupBudgetMs(dosLaunchDelayRef.current) : 45_000
      } else {
        duration = LOAD_PHASE_DURATION_MS[phase]
      }
      const elapsed = Date.now() - startedAt
      const visualStart = Math.max(0.01, phaseStart)
      const visualEnd = Math.min(LOAD_PROGRESS_CEILING, phaseEnd - 0.01)
      const timed = visualStart + (visualEnd - visualStart) * Math.min(1, elapsed / duration)
      setLoadRatio((current) => Math.max(current ?? 0, timed))
    }, 250)
    return () => window.clearInterval(timer)
  }, [status, session?.id])

  // 会话变化时挂载 / 卸载运行时
  useEffect(() => {
    const host = frameRef.current
    if (!session || !host) return
    /**
     * 本次挂载对应的会话号。
     *
     * 引擎都是异步初始化的：玩家连着换两个 ROM 时，上一个引擎的回调完全可能在
     * 新会话已经跑起来之后才到。不判断的话，正在玩的画面会被上一个的报错顶掉 ——
     * 表现是「画面突然没了，只剩一条红字，但声音还在响」。
     * 在这里统一挡一道，比在每个适配器里各写一遍 destroyed 判断可靠。
     */
    const mountedId = session.id
    const isCurrent = () => sessionCounter.current === mountedId
    /** 已经进入游戏后再报错属于运行期故障，不能按“加载失败”自动重启，免得吞掉玩家进度。 */
    let ready = false
    const handle = session.runtime.mount(host, {
      platform: session.platform,
      game: session.game,
      gameName: gameNameRef.current,
      // 按游戏覆盖核心 / 平台级 BIOS：都用 ref 读当前值，
      // 放进 effect 依赖会让「BIOS 异步到货」把正在跑的游戏重启一遍
      core: coreRef.current,
      mouseCapture: shouldCaptureMouse(session.platform, genresRef.current),
      arcadeRomData: arcadeRomDataRef.current,
      dosExecutable: dosExecutableRef.current,
      dosBackend: dosBackendRef.current,
      dosSystemUrl: dosSystemUrlRef.current,
      dosWindowsVersion: dosWindowsVersionRef.current,
      dosLaunchDelay: dosLaunchDelayRef.current,
      dosboxConfig: dosboxConfigRef.current,
      /**
       * BIOS 按**本次会话真正的平台**取，父组件传下来的只作首选。
       *
       * 「玩本地 ROM」页的平台是拖进文件才识别出来的（detect -> onPlatformChange），
       * 父组件那边的 biosUrl 还停留在识别前的默认平台上；等它算出新值，
       * 引擎已经挂载完了，而这里刻意不会为了 BIOS 迟到去重启游戏。
       * 所以再按 session.platform 同步兜一次 —— 缓存早在进页面时就拉好了。
       */
      biosUrl: biosUrlRef.current || platformBiosUrlSync(session.platform),
      // 存档按 slug 归档。玩家自己拖进来的 ROM 不能用页面的 slug ——
      // 那会把他那份存档写到本页官方 ROM 的档位上（见 saveSlugOf）
      gameSlug: saveSlugOf(session),
      netplay: session.netplay,
      cloud: session.cloud,
      live: session.live,
      // 有些引擎要等核心起来才知道自己支持什么，这里允许它后补
      onCaps: (next) => {
        if (!isCurrent()) return
        setCaps(new Set(next))
      },
      onProgress: (next) => {
        if (!isCurrent()) return
        enterProgressPhase(next.phase)
        const actual = Math.min(LOAD_PROGRESS_CEILING, overallRatio.current(next))
        setLoadRatio((current) => Math.max(current ?? 0, actual))
      },
      onReady: () => {
        if (!isCurrent()) return
        ready = true
        setLoadRatio(null)
        setStatus('running')
        // 游戏真的跑起来了才算一次游玩 —— 打开详情页、加载失败、选错文件都不算
        if (gameSlugRef.current) recordPlay(gameSlugRef.current)
      },
      onError: (message: string) => {
        if (!isCurrent()) return
        const cloud = session.cloud

        // 只重试普通的本机加载。联机、云游戏和直播都带外部会话状态，擅自重建会造成重复房间；
        // 游戏已经运行后再出错也不能重启，否则玩家这一局的进度会直接丢掉。
        const attempt = session.retryAttempt ?? 0
        if (!ready && !session.netplay && !session.cloud && !session.live && attempt < AUTO_RETRY_LIMIT) {
          setError(null)
          begin(session.game, session.platform, session.runtime, { retryAttempt: attempt + 1 })
          return
        }

        // 出错后必须把会话拆掉：否则运行时会在隐藏的挂载点里继续活着
        endSession()

        // 云端自己开房没开成（服务器满了 / 连不上），而这游戏本来就能在浏览器里跑：
        // 直接退回本地运行，别让人因为服务器容量问题玩不了。
        const fb = localFallbackRef.current
        if (cloud && !cloud.roomId && !cloudPlayedRef.current && fb.url && fb.runtime) {
          setMode('local')
          setError(null)
          setNotice(fmt(t.player.cloudFellBack, { msg: message }))
          begin(fb.url, platform.id, fb.runtime)
          return
        }

        setError(message)
        setStatus('error')
      },
    })
    setHandle(handle)
    setCaps(new Set(handle.caps))
    return () => {
      setHandle(null)
      setCaps(new Set())
      handle.destroy()
    }
  }, [session])

  // 云端联机期间向本站后端心跳（P2P 不需要：信令服务器本来就知道房间）
  useEffect(() => {
    if (!session?.cloud || !roomId || !gameSlug) return
    return keepAlive({
      roomId,
      gameSlug,
      // 服务器分的座位号（onPlayerIndex -> slotIndex），不是我们本地猜的那个：
      // 两个人同时点同一条邀请链接会猜到同一个空位，房间列表里就出现两个人占一格
      playerIndex: slotIndex,
      host: !session.cloud.roomId,
    })
  }, [session, roomId, gameSlug, slotIndex])

  /**
   * 在 P2P 房间里时盯着房间状态：
   *   - 房主掉线且服务器选中了我 → 取存档、接手，游戏接着跑
   *   - 房间已经换了房主 → 跟到新房间
   *   - 房间没了 → 提示这局结束
   * 服务器保留 60 秒宽限期，2.5 秒一轮足够。
   */
  useEffect(() => {
    if (!session?.netplay || !roomId || status === 'error') return
    let stopped = false
    /** 处理一次房间快照（首次 fetch 与后续 SSE 推送共用同一段逻辑） */
    const handle = async (room: Awaited<ReturnType<typeof fetchNetplayRoom>>) => {
      if (stopped) return
      if (!room) {
        // 房间彻底消失（宽限期内没人接手）
        endSession()
        setStatus('error')
        setError(t.player.hostLeft)
        return
      }
      if (room.migratedTo && room.migratedTo !== roomId) {
        setNotice(t.player.hostChanged)
        startP2p(room.migratedTo)
        return
      }
      if (room.awaitingHost && room.nextHostUserId && room.nextHostUserId === myIdRef.current && !claimTokenRef.current) {
        stopped = true
        setNotice(t.player.takingOver)
        // 先认领再重挂引擎：重挂会断掉旧连接，不先认领的话服务器看到唯一的访客断了
        // 就把房间散掉（老邀请链接跟着死）；多人房则 8 秒后轮给下一位，两个人抢着接
        const claim = await claimRoom(roomId, roomTokenRef.current)
        if (!claim) {
          // 认领没成（被别人抢先、房间已经没了）：交回给推送流程，看房间接下来变成什么样
          stopped = false
          return
        }
        claimTokenRef.current = claim ?? ''
        const state = room.hasState ? await downloadState(roomId, claim || roomTokenRef.current) : null
        startP2p(undefined, { from: roomId, state })
      }
    }

    const tick = async () => handle(await fetchNetplayRoom(roomId))
    // 首次立刻对一次，之后交给 SSE 推送（服务端有变化才发）。
    // 以前是每 2.5 秒轮询一次自己的房间，纯粹为了等「房主掉线」这个几乎不发生的事件；
    // 换成推送之后平时零请求，房主一掉线也是立刻知道，接手更快。
    void tick()
    const stop = watchNetplayRoom(roomId, {
      onRoom: (room) => {
        if (stopped) return
        void handle(room)
      },
      onGone: () => {
        if (stopped) return
        endSession()
        setStatus('error')
        setError(t.player.hostLeft)
      },
    })
    return () => {
      stopped = true
      stop()
    }
  }, [session, roomId, status])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(timer)
  }, [copied])

  /**
   * P2P：开房间（join 为空）、加入房间，或接手别人掉线后的房间（带 initialState）。
   */
  const startP2p = (
    join?: string,
    takeOver?: { from: string; state: Uint8Array | null },
    asRole: RoomRole = 'player',
  ) => {
    if (!gameSlug || !romUrl) return
    setError(null)
    if (!takeOver) setNotice(null)
    setRoomId(join ?? null)
    setPlayers(1)
    setRole(asRole)
    setIsHost(!join)
    roleSwitchRef.current = null
    migrateFromRef.current = takeOver?.from ?? ''
    migrateToRef.current = ''
    if (!takeOver) claimTokenRef.current = ''
    // 上个房间的令牌对新房间没用；清掉，免得 /migrate 拿着旧令牌去证明新房间是我开的
    roomTokenRef.current = ''
    /**
     * 接手的最后一步：新房间号（轮询到 extra.sessionid）和新房间的令牌（room-token 事件）
     * 谁先到说不准 —— 房间号往往在服务器 ack 之前就能看到。两样齐了才发 /migrate。
     */
    const tryMigrate = () => {
      const from = migrateFromRef.current
      const to = migrateToRef.current
      const claim = claimTokenRef.current
      const tk = roomTokenRef.current
      if (!from || !to || !claim || !tk || from === to) return
      migrateFromRef.current = ''
      claimTokenRef.current = ''
      void migrateRoom(from, to, claim, tk).then((okDone) => {
        if (okDone) setNotice(t.player.tookOver)
        refreshNetplayRooms()
      })
    }
    begin(romUrl, platform.id, emulatorJsRuntime, {
      netplay: {
        gameId: gameIdFor(gameSlug),
        roomName: gameName,
        playerName: playerName(),
        maxPlayers: slots,
        mode: join ? 'join' : 'host',
        role: asRole,
        onSpectatorControl: (fn) => (roleSwitchRef.current = fn),
        roomId: join,
        initialState: takeOver?.state ?? undefined,
        onIdentity: (id) => (myIdRef.current = id),
        onToken: (tk) => {
          roomTokenRef.current = tk
          tryMigrate()
        },
        onRoom: (id, host) => {
          setRoomId(id)
          setIsHost(host)
          rejoinedRef.current = false
          // 接手房主之后自然就不是观众了
          if (host) setRole('player')
          // 接手成功：把新房间和旧房间接上，老邀请链接才能继续用
          if (host && migrateFromRef.current) {
            migrateToRef.current = id
            tryMigrate()
          }
          refreshNetplayRooms()
        },
        onPlayers: (n) => setPlayers(n),
        onHostLeft: () => {
          /**
           * 信令断了，引擎已经自己退了房。分三种情况：
           *   我是房主   → 服务器那边开始换房主，游戏在我这儿还在跑。不报错，只提示一句
           *   房间还在   → 多半是我自己的网抖了一下，自动重进一次（EmulatorJS 不会自己重连）
           *   房间没了 / 正在换房主 / 已经重进过 → 这局对我来说结束了
           */
          // join 为空 = 这是接手后开的房，我是房主（别读 isHost：闭包里的是过期值）
          if (!join) {
            setNotice(t.player.hostLinkLost)
            setRoomId(null)
            return
          }
          const wanted = join ?? ''
          void fetchNetplayRoom(wanted).then((room) => {
            const alive = room && !room.awaitingHost && !room.migratedTo
            if (alive && !rejoinedRef.current) {
              rejoinedRef.current = true
              setNotice(t.player.rejoining)
              startP2p(wanted, undefined, asRole)
              return
            }
            /**
             * 这局联机对我结束了 —— 但**如果我本来是从直播间点进来的，主播多半还在播**。
             * 他只是点了「结束联机」（closeMatch 之后直播照推，见 LiveControls 的 active），
             * 这时候把人扔到一张「房主已离开」的错误页上是死路：他明明还能接着看。
             * 退回去继续看，比报错有用得多。
             */
            const back = liveReturnRef.current
            if (back) {
              liveReturnRef.current = ''
              setNotice(t.player.backToWatching)
              startWatchLive(back)
              return
            }
            endSession()
            setStatus('error')
            setError(t.player.hostLeft)
          })
        },
      },
    })
  }

  /**
   * 联机匹配：在**正在跑的这一局**上开房，让别人能加进来。
   *
   * 和 startP2p() 的分工：那个是「从头开一局联机的」，会重新挂载引擎；
   * 这个是玩到一半才想联机的路径，重开等于把玩家已经打的进度扔掉，所以走
   * handle.openNetplay() —— 引擎实例不动，只是把 netplay 接上去（见 adapters/emulatorjs.ts）。
   */
  const openMatch = () => {
    if (!gameSlug || !handle?.openNetplay || hosting || matchBusy) return
    setMatchBusy(true)
    setError(null)
    setNotice(null)
    setRoomId(null)
    setPlayers(1)
    setRole('player')
    setIsHost(true)
    roleSwitchRef.current = null
    const ok = handle.openNetplay({
      gameId: gameIdFor(gameSlug),
      roomName: gameName,
      playerName: playerName(),
      maxPlayers: slots,
      mode: 'host',
      role: 'player',
      onSpectatorControl: (fn) => (roleSwitchRef.current = fn),
      onIdentity: (id) => (myIdRef.current = id),
      onToken: (tk) => (roomTokenRef.current = tk),
      onRoom: (id, host) => {
        setRoomId(id)
        setIsHost(host)
        refreshNetplayRooms()
      },
      onPlayers: (n) => setPlayers(n),
      onHostLeft: () => {
        // 信令断了、引擎已经退房。房间在服务器那边开始换房主，游戏在这儿继续自己玩；
        // 界面得跟上，不能挂着一个已经不存在的房间
        setHosting(false)
        setRoomId(null)
        setPlayers(1)
        setNotice(t.player.matchLost)
        refreshNetplayRooms()
      },
    })
    if (!ok) {
      setMatchBusy(false)
      setNotice(t.player.matchFailed)
      setIsHost(false)
      return
    }
    setHosting(true)
    // openNetplay 是同步返回的，但房间号要等 netplay 轮询到才有（约 1 秒）。
    // 按钮一直显示「正在开房…」直到房间号到手，玩家才不会对着一个没有邀请链接的房间发愣。
  }

  /** 房间号到手（或者等太久了）就把「正在开房…」收掉 */
  useEffect(() => {
    if (!matchBusy) return
    if (roomId) {
      setMatchBusy(false)
      return
    }
    const timer = window.setTimeout(() => setMatchBusy(false), 8000)
    return () => window.clearTimeout(timer)
  }, [matchBusy, roomId])

  /**
   * 详情页那个「👥 创建联机房间」按下来了。
   *
   * 它以前是个跳转链接（`to="/games?multiplayer=1"`），点了只是去游戏库筛多人游戏 ——
   * 按钮叫「创建联机房间」，却什么房也不创建。现在它喊一声，由这里真的去开。
   *
   * 游戏还没跑起来的话先跑起来：开房必须在**已经挂载的引擎**上做
   * （openNetplay 的前提），所以记一个「跑起来就开房」的标记，
   * 等 status 变成 running 再补上那一步。
   */
  const wantMatchRef = useRef(false)
  useEffect(
    () =>
      onMatchRequest(() => {
        if (hosting || matchBusy) return
        // 已经在跑：立刻开，用不着留标记
        if (status === 'running') return openMatch()
        /**
         * 还没跑：先跑起来，running 之后由下面那个 effect 补上开房。
         *
         * ⚠️ 标记只在**确定这一次真能开起来**时才留。
         * 以前是无条件先 `wantMatchRef.current = true` 再看情况 —— 于是
         * 「没有 ROM / 这个平台没有可用运行时」这类点了没反应的情况，标记会一直挂着，
         * 等玩家过一会儿自己传个本地 ROM 开始玩，冷不丁就被开了个房。
         * 而且设 ref 不触发渲染，指望后面的 effect 去兜底是兜不住的（可能根本不再渲染）。
         */
        if (status === 'idle' && romUrl && pageRuntime) {
          wantMatchRef.current = true
          void start(null)
        } else if (status === 'loading') {
          // ROM 正在下：等它跑起来
          wantMatchRef.current = true
        }
      }),
    // openMatch / start 每次渲染都是新的，订阅只要一次 —— 用 ref 读最新的状态即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status, hosting, matchBusy, romUrl, pageRuntime],
  )

  // 游戏跑起来了，而且是因为「想开房」才跑的 —— 把那一步补上
  useEffect(() => {
    if (!wantMatchRef.current) return
    /**
     * 开局失败、或者玩家把这一局停了：这一次「想开房」的意图就此作废。
     * 不清的话它会活到下一次开局，在玩家没点任何东西的情况下自己开个房出来。
     */
    if (status === 'error' || status === 'idle') {
      wantMatchRef.current = false
      return
    }
    if (status !== 'running') return
    // 这个引擎 / 平台开不了房：别把标记一直挂着，等下一次真的点
    wantMatchRef.current = false
    if (handle?.openNetplay) openMatch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, handle])

  /** 结束联机，回到一个人玩。游戏不重开，自动开播会接着上（见 LiveControls） */
  const closeMatch = () => {
    if (!hosting) return
    handle?.closeNetplay?.()
    setHosting(false)
    setRoomId(null)
    setPlayers(1)
    setIsHost(false)
    setRole('player')
    roleSwitchRef.current = null
    // 让大厅立刻把房间卡片撤掉，不用等下一轮轮询
    refreshNetplayRooms()
  }

  /** 云端：创建房间（join 为空）或加入房间 */
  const startCloud = (join?: string) => {
    if (!gameSlug) return
    setError(null)
    setNotice(null)
    setRoomId(join ?? null)
    setCloudState('connecting')
    const playerIndex = join ? (cloudJoinRoom ? freePlayerIndex(cloudJoinRoom, slots) : Math.min(1, slots - 1)) : 0
    setSlotIndex(playerIndex)
    cloudPlayedRef.current = false
    begin(romUrl ?? '', platform.id, cloudGameRuntime, {
      cloud: {
        gameId: gameSlug,
        roomId: join,
        playerIndex,
        onRoom: (id) => setRoomId(id),
        onPlayerIndex: (i) => setSlotIndex(i),
        onState: (s) => {
          if (s === 'playing') cloudPlayedRef.current = true
          setCloudState(s)
        },
      },
    })
  }

  /**
   * 看直播：本机什么都不跑，只收主播推过来的画面和声音。
   * 走的是独立的 liveview 运行时，和联机那两条路互不相干。
   */
  const startWatchLive = useCallback(
    (roomId: string) => {
      setError(null)
      setNotice(null)
      setLiveViewers(0)
      setLiveState('connecting')
      // 换一间看：上一间的联机房号跟这一间无关，不清的话「加入联机」会指向别人的房间
      setLiveNetplayRoom(null)
      // begin() 里那两行同样要做：不清的话遮罩会用上一局的阶段和起始时间算进度，
      // 第一拍就把条子顶到那个阶段的天花板（79% / 99%）再慢慢爬，看着像卡住
      overallRatio.current = createOverallRatio()
      progressClock.current = { phase: 'engine', startedAt: Date.now() }
      setLoadRatio(null)
      sessionCounter.current += 1
      setSession({
        id: sessionCounter.current,
        game: '',
        platform: platform.id,
        runtime: liveViewRuntime,
        live: {
          roomId,
          onViewers: setLiveViewers,
          onState: setLiveState,
          onInfo: (info) => setNotice(info.hostName ? `${info.title} · ${info.hostName}` : info.title),
          onNetplay: setLiveNetplayRoom,
        },
      })
      setStatus('loading')
    },
    [platform.id],
  )

  // 观看链接进来就直接开看，不用再点一次。
  // ignoreInvite 是「玩家自己离开过」的闸：没有它的话，看直播时切一次 ROM 语言（reset()）
  // 就会立刻被这个 effect 拉回直播间，出不去
  useEffect(() => {
    if (liveInvite && !ignoreInvite && !session && status === 'idle') startWatchLive(liveInvite)
  }, [liveInvite, ignoreInvite, session, status, startWatchLive])

  const startOnline = () => {
    if (cloudInviteId && cloudOk) return startCloud(cloudInviteId)
    if (inviteId && p2pOk) return startP2p(inviteId, undefined, willWatch ? 'spectator' : 'player')
    if (channel === 'p2p') return startP2p()
    return startCloud()
  }

  const start = useCallback(
    async (picked: File | null) => {
      setError(null)
      setNotice(null)

      // 云端 ROM
      if (!picked) {
        if (!romUrl || !pageRuntime) return
        begin(romUrl, platform.id, pageRuntime)
        return
      }

      /*
        街机改版包：先认一遍指纹表。认出来就换成正确的包名、配好 RomData ——
        不然核心只会说一句「Romset is unknown」，玩家完全无从下手。
        放在 detectRom 之前：改版包和原版包的扩展名、魔数都一样，
        detectRom 认不出这层差别，而这一步会换掉文件本身。
      */
      if (platform.id === 'arcade') {
        const matched = await matchLocalArcadeHack(picked)
        if (matched?.hack.romData) {
          setLocalRomData(matched.hack.romData)
          setNotice(fmt(t.player.arcadeHackFound, { title: matched.hack.title, driver: matched.hack.driver }))
          setFile(matched.file)
          begin(matched.file, 'arcade', emulatorJsRuntime)
          return
        }
        // 认得出但没有加载方案，或者压根不认识：清掉上一次的，别让旧 dat 串到新包上
        setLocalRomData(undefined)
        if (matched) {
          setError(fmt(t.player.arcadeHackNoPlan, { title: matched.hack.title }))
          return
        }
      }

      // 本地文件：先嗅探类型，决定运行时
      const detection = await detectRom(picked)
      let targetPlatform: PlatformId = platform.id
      if (detection.platform && detection.platform !== platform.id && detection.confidence !== 'low') {
        if (onDetectMismatch === 'switch') {
          targetPlatform = detection.platform
          onPlatformChange?.(detection.platform)
          setNotice(describeDetection(detection))
        } else if (!isRomFileAccepted(picked, platform.romExtensions)) {
          // 页面平台不接受这种文件，但识别出了别的平台：直接用识别结果运行
          targetPlatform = detection.platform
          setNotice(fmt(t.player.detectUse, { reason: describeDetection(detection) }))
        } else {
          setNotice(
            fmt(t.player.detectKeep, {
              reason: describeDetection(detection),
              platform: platformLabel(t, platform.id, platform.name),
            }),
          )
        }
      } else if (!isRomFileAccepted(picked, platform.romExtensions)) {
        // 没识别出平台，当前平台也不接受这个文件。先问页面要不要接管
        // （玩本地 ROM 页会弹出手动选择），页面不接管才报默认错误。
        if (onDetectFailed?.(picked)) return
        setError(
          fmt(t.player.badFormat, {
            platform: platformLabel(t, platform.id, platform.name),
            exts: platform.romExtensions.join(t.player.extSep),
          }),
        )
        return
      }

      // 按「平台 + 文件扩展名」选引擎：.nes 会走 jsnes，.swf 走 Ruffle，其余交给 EmulatorJS
      const runtime = resolveRuntime({ platform: targetPlatform, ext: extOf(picked) })
      if (!runtime) {
        setError(
          fmt(t.player.noRuntime, {
            platform: platformLabel(t, targetPlatform, platformMap[targetPlatform]?.name ?? targetPlatform),
          }),
        )
        return
      }
      setFile(picked)
      begin(picked, targetPlatform, runtime)
    },
    [platform, romUrl, pageRuntime, onDetectMismatch, onPlatformChange, onDetectFailed, t],
  )

  /**
   * 外部重试：用户在识别失败后手动选了平台，页面把同一个文件递回来重跑一次。
   * 用 ref 记住处理过的请求对象，避免 StrictMode 下的重复挂载跑两遍。
   */
  const handledRetryRef = useRef<unknown>(null)
  useEffect(() => {
    if (!retryRequest || handledRetryRef.current === retryRequest) return
    handledRetryRef.current = retryRequest
    void start(retryRequest.file)
  }, [retryRequest, start])

  /**
   * 切完 ROM 语言之后要接着开的那一局。
   * ROM 换了就是另一份程序，没法热切 —— 只能把会话拆掉、
   * 等父组件把新地址传下来再重开（见下面那个 effect）。
   */
  const restartWithLangRef = useRef<RomLang | null>(null)

  /**
   * 收掉当前这一局。
   *
   * **必须**同时把 sessionCounter 往前推一格：mount effect 里那个 isCurrent() 就是拿它
   * 和自己挂载时的 id 比对，用来挡住「已经拆掉的引擎迟到的回调」。而计数器以前只在
   * begin() / startWatchLive() 里加 —— 也就是说「拆掉但没有下一局」的那些路径（reset、
   * 报错收尾、房间没了）过后，isCurrent() 依然为真：一个迟到的 onReady 能把状态推回
   * 「运行中」，而 session 和 handle 都已经是 null，界面停在一块什么都没有的黑框上，
   * 除了刷新页面没有别的出路。
   */
  const endSession = () => {
    sessionCounter.current += 1
    setSession(null)
  }

  /**
   * 这一局的存档归档键。
   *
   * `types.ts` 早就定好了「玩家自己上传的 ROM 用 `local:文件名`」，但一直没人真的这么传 ——
   * 播放器把页面的 slug 原样递下去，于是在 /games/contra 里拖进自己的魔改 ROM 存一次档，
   * 就把官方 Contra 的云存档盖掉了；反过来读档时又会把一份不兼容的快照喂给另一个二进制。
   * 各适配器里那句 `options.gameSlug || 'local:'+name` 的兜底因此从来没生效过。
   */
  const saveSlugOf = (s: ActiveSession | null): string | undefined => {
    if (!s) return gameSlugRef.current
    if (typeof s.game !== 'string') return `local:${s.game.name}`
    return gameSlugRef.current
  }
  /** 工具栏用的那一份（存档 / 读档 / 归档都按它走） */
  const saveSlug = saveSlugOf(session)

  const reset = () => {
    // 主动离开房间后，URL 里的 ?p2p= / ?room= 就不该再把人拉回同一个房间
    // 直播也算：离开之后别被上面那个自动开看的 effect 又拽回去
    if (session?.netplay || session?.cloud || session?.live || joining) setIgnoreInvite(true)
    endSession()
    setStatus('idle')
    setFile(null)
    setError(null)
    setNotice(null)
    setRoomId(null)
    setPlayers(1)
    setHosting(false)
    setMatchBusy(false)
    setCloudState(null)
    // 身份跟着房间一起清掉，不然下次开自己的房还会被当成观众
    setRole('player')
    setIsHost(false)
    roleSwitchRef.current = null
    if (inputRef.current) inputRef.current.value = ''
  }

  /**
   * 换 ROM 语言。
   *
   * ROM 换了就是另一份程序，存档、内存布局都不通用，没法热切。所以正在玩的话
   * 只能重开这一局：先把会话拆掉，把想要的语言记在 ref 上，等父组件按新语言
   * 解析出 romUrl 传下来，下面那个 effect 再自动开起来 —— 玩家看到的就是
   * 「黑一下，然后是另一个语言的同一款游戏」，不用自己再点一次开始。
   */
  const switchRomLang = (next: RomLang) => {
    if (!next || next === romLang) return
    // 有会话在跑才需要重开；空闲状态直接换地址就行，玩家还没开始
    if (session) {
      restartWithLangRef.current = next
      reset()
    }
    onRomLangChange?.(next)
  }

  // 语言换完了，父组件把新的 romUrl 传下来，把这一局接着开起来
  useEffect(() => {
    const pending = restartWithLangRef.current
    if (!pending || !romUrl) return
    restartWithLangRef.current = null
    void start(null)
    // start() 里会先清掉提示，所以这句要放它后面
    setNotice(fmt(t.player.romLangSwitched, { lang: ROM_LANG_LABEL[pending] }))
    // 只认 romUrl 的变化：start 是 useCallback，放进依赖会让它在无关的重建时也触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [romUrl])

  const copyInvite = async () => {
    if (!gameSlug || !roomId) return
    const link = session?.cloud ? roomLink(gameSlug, roomId) : inviteLink(gameSlug, roomId)
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
    } catch {
      /* 剪贴板不可用时忽略 */
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const dropped = e.dataTransfer.files?.[0]
    if (dropped) void start(dropped)
  }

  const toggleFullscreen = () => {
    const el = hostRef.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void el.requestFullscreen?.()
  }

  const busy = status === 'loading' || status === 'running'
  /** 「在房间里」：挂载时就联机的，或者玩到一半点「联机匹配」开出来的 */
  const inRoom = Boolean(session?.netplay || session?.cloud || hosting)
  /** 这个房间是 P2P 那一路（工具栏的观众数、观众席、身份切换只对它有意义） */
  const netplayOn = Boolean(session?.netplay) || hosting
  const activeRuntime =
    session?.runtime ?? (online ? (channel === 'p2p' ? emulatorJsRuntime : cloudGameRuntime) : pageRuntime)
  const cloudStateLabel = cloudState ? t.player.cloudState[cloudState] : ''

  // 进度条加载期间最多走到 99%，真正启动后遮罩才消失
  const ratio = loadRatio ?? 0
  // 服务端的 players 不含观众，比本地 onPlayers 更准；拿不到时退回本地计数
  const roomPlayers = session?.cloud ? (myCloudRoom?.players ?? 1) : (myNetRoom?.players ?? players)
  const joinBlocked = online && ((inviteFull && !canWatch) || inviteGone || inviteChanging || inviteResolving || cloudJoinPending)

  /**
   * 上场 / 退到观众席。
   * 服务端那边记账（手柄位够不够由它说了算），本地那边掐断或恢复输入转发 ——
   * 真正管用的是本地这一下，因为按键是走 WebRTC 直接到房主的，不经过服务器。
   */
  /**
   * 观众 →「加入联机」。
   *
   * 这是「看着看着就能上场」那条路的最后一步：主播点了联机，直播没停，
   * 正在看的人这里多出一个按钮，点一下就从「看直播」切成「进这个联机房」。
   *
   * 手柄位满了就以观众身份进（服务端 join-room 本来也是这么判的：
   * playerCount >= maxPlayers 就自动收成 spectator）—— 进去之后 1P/2P 谁掉线退出，
   * 工具栏那个「上场」按钮就能用了，不用退出去重来。
   *
   * 房间列表还没到货（p2pRooms 是空的）时按玩家进：服务端会兜住，
   * 宁可让它把我们收成观众，也不要因为前端一时不知道人数就自降身份。
   */
  const joinLiveNetplay = () => {
    const target = liveNetplayRoom
    if (!target) return
    const room = p2pRooms.find((r) => r.roomId === target)
    const asRole: RoomRole = room && room.players >= room.max ? 'spectator' : 'player'
    /**
     * 不在这里把 liveNetplayRoom 清掉。
     *
     * startP2p 开头有 `if (!gameSlug || !romUrl) return` —— 先清了再调，万一它直接返回，
     * 观众就眼看着按钮消失、什么也没发生，而且**再也点不了第二次**。
     * 顺利的话 session 会换成 netplay，按钮的渲染条件（session?.live）自然就不成立了，
     * 根本不需要手动清。真正该清的地方是换一个直播间去看的时候（见 startWatchLive）。
     */
    liveReturnRef.current = session?.live?.roomId ?? ''
    startP2p(target, undefined, asRole)
  }

  const toggleRole = async () => {
    if (!roomId || isHost) return
    const next: RoomRole = role === 'spectator' ? 'player' : 'spectator'
    const ok = await setRoomRole(roomId, roomTokenRef.current, next)
    if (!ok) {
      setNotice(t.player.roleFailed)
      return
    }
    roleSwitchRef.current?.(next === 'spectator')
    setRole(next)
    setNotice(null)
    refreshNetplayRooms()
  }

  /** 状态文案。徽章的 title 和可见文字共用一份，别在两处各写一遍三元 */
  /**
   * 该不该画屏幕手柄。三个条件缺一不可：
   *  · 游戏真的在跑（没跑的时候画面上是开始按钮，手柄挡着它）
   *  · 这是台触屏设备（鼠标玩家有键盘，浮层只会挡视野）
   *  · 运行时声明了 'touchpad'（EmulatorJS 自带手柄，不声明这个能力）
   */
  const showPad = status === 'running' && touchDevice && caps.has('touchpad')
  /** 手机竖屏且不在全屏里 —— 这时手柄放画面下面，别压着画面 */
  const padInline = narrow && !fullscreen
  /**
   * 屏幕上到底有没有能按的东西。开局提示只在这个为真时才该出现。
   *
   * 两种都算数：我们自己画的那套（touchpad），以及 EmulatorJS 自带、并且适配器
   * **确认真的画出来了**的那套（enginePad，见 adapters/emulatorjs.ts 的
   * showVirtualGamepad）。两个都没有的引擎（Flash / html5）在手机上是真没有按键 ——
   * 那种情况下说一句「手柄在下面」只会让玩家白找一圈，宁可不说。
   */
  const hasOnscreenPad =
    status === 'running' && touchDevice && (caps.has('touchpad') || caps.has('enginePad') || caps.has('enginePointer'))
  /**
   * 这台机器本身就是戳屏幕玩的（NDS 下屏）。
   * 提示要说的话完全不一样 —— 不是「按键在哪儿」，而是「画面就能点」。
   */
  const touchScreenConsole = caps.has('enginePointer')
  /**
   * 手柄画在画面**下面**还是**画面上**。
   * 只有我们那套的 inline 摆法在下面；浮层和 EmulatorJS 自带的都压在画面里。
   * 提示气泡要靠它决定贴上边还是贴下边 —— 贴错的话，气泡正好盖住要指的那排按键。
   */
  const padBelow = showPad && padInline
  /**
   * 引擎自带的按键这时是不是也在画面**下面**：手机竖屏的游玩布局 / 竖屏的原生全屏里
   * iframe 是竖着的，画布给按键让位、按键贴底（见 adapters/emulatorjs.ts 的 FRAME_HTML）。
   * 气泡照旧贴上沿（贴下沿会盖住按键），但文案要说「在下方 👇」而不是「就在画面上」。
   */
  const enginePadStacked = caps.has('enginePad') && narrow && (playMode || embedFill || fullscreen)

  /**
   * 开局提示：告诉玩家「怎么玩、手柄在哪儿」。
   *
   * 为什么需要：手机上手柄在画面**下面**，而玩家点完开始之后眼睛盯着画面 ——
   * 不往下看就以为这游戏没法操作。桌面端玩家有键盘（提示文案在按钮 title 里），
   * 手机上没有任何地方能顺手说这句话。
   *
   * 什么时候不再出现：
   *  · 玩家真的按了一下屏幕手柄（onInput）—— 手都摸到了，教完了，记进 localStorage
   *  · 玩家点了「知道了」—— 同上
   *  · 9 秒自动淡出，但**不记**已看过：他可能压根没注意到，下一局还该提醒
   */
  const [padHint, setPadHint] = useState(false)
  const padHintTimer = useRef(0)
  const dismissPadHint = useCallback(() => {
    window.clearTimeout(padHintTimer.current)
    setPadHint(false)
    try {
      localStorage.setItem(PAD_HINT_KEY, '1')
    } catch {
      /* 隐私模式下记不住，那就每局都提醒一次 */
    }
  }, [])
  useEffect(() => {
    if (!hasOnscreenPad) return
    let seen = false
    try {
      seen = localStorage.getItem(PAD_HINT_KEY) === '1'
    } catch {
      /* 读不了就当没看过 */
    }
    if (seen) return
    setPadHint(true)
    padHintTimer.current = window.setTimeout(() => setPadHint(false), 9000)
    return () => {
      window.clearTimeout(padHintTimer.current)
      setPadHint(false)
    }
  }, [hasOnscreenPad])

  /**
   * 把键盘 / 手柄的焦点交给运行时。
   *
   * 玩家点的「▶ 开始」在外层页面上，而 EmulatorJS / Flash / html5 / J2ME / webretro
   * 都跑在 iframe 里 —— 不主动交焦点的话，引擎在里面既收不到 keydown，也读不到手柄
   * （手柄只对「按下那一刻有焦点的文档」可见）。玩家的说法是「插了手柄没反应」
   * 「不先点一下画面键盘是死的」。原理和实测见 frameFocus.ts。
   *
   * 三个时机：
   *  · 刚跑起来 —— 排在 rAF 里，等自动沉浸那次重排落定，别和它抢
   *  · 进出全屏 / 游玩布局 —— 玩家是点我们的按钮进去的，焦点跟着落在按钮上，得还回去
   *  · 手柄接上 —— gamepadconnected 打在**外层**恰恰说明焦点在外层，正是该还回去的时候
   */
  useEffect(() => {
    if (status !== 'running' || !handle?.focus) return
    const give = () => handle.focus?.()
    const raf = requestAnimationFrame(give)
    window.addEventListener('gamepadconnected', give)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('gamepadconnected', give)
    }
  }, [status, handle, fullscreen, playMode])

  const statusLabel =
    status === 'running'
      ? t.player.statusRunning
      : status === 'loading'
        ? t.player.statusLoading
        : status === 'error'
          ? t.player.statusError
          : t.player.statusIdle

  /** 空闲态主按钮 */
  const primaryAction = () => {
    if (online) return startOnline()
    if (romUrl) void start(null)
    else inputRef.current?.click()
  }

  return (
    <div data-testid="emulator-player" className={cx('overflow-hidden rounded-2xl border border-line bg-black', className)}>
      {/*
        桌面端：播放器整体固定 16:9，工具栏是框里的最后一行 —— 它在普通模式和全屏模式里
        都属于模拟器，不会额外撑高详情页；画面区让出工具栏的实际高度，也不会盖住
        EmulatorJS 自己的底部菜单。

        移动端：这套不成立。390pt 宽的屏幕上 16:9 只有 200pt 高，工具栏（三行图标）一占
        就剩不到 80pt 给画面，红白机的游戏窗口小到几乎看不见。所以手机上改成
        「画面自己占一个按平台原生比例的框（见 screenAspect.ts），工具栏排在框下面」——
        页面因此多长几十 pt，手机上滑一下就过去了，换来的是画面高度翻两倍多。

        工具栏本身在手机上也收紧过：状态徽章只留圆点（文字进 title）、间距减半，
        次要按钮（音量 / 手柄 / 另存 / 截屏 / 录像）收进「⋯」弹出层（见 EmulatorTools.tsx），
        于是留在行内的只剩暂停 + 存读档 + ⋯ + 沉浸 + 全屏，三行变一行。

        手机上真正**玩**的时候走的是第三种：游玩布局（playMode）。上面那个小框只是详情页里的
        预览 —— 引擎自带的整套按键（230px 起）塞不进 290pt 高的画面框，只能压在画面上，
        用户实测「按键挡住了，根本玩不了」。所以游戏一跑起来（或玩家点沉浸），舞台自己
        fixed 铺满视口：画面在上、按键在下、这条工具栏压底。退出沉浸回到小框时按键整套收起
        （monitor），点画面回来。DOM 结构三种布局完全一样，只换 className —— iframe 不能重挂。
      */}
      <div
        ref={hostRef}
        data-testid="emulator-stage"
        className={cx(
          'flex w-full flex-col bg-black',
          // 全屏：浏览器已经把它撑满视口，画面吃掉工具栏以外的高度
          // 游玩布局（手机上的沉浸模式，见 playMode）：自己 fixed 铺满视口，压在页面上；
          //         z-[60] 要高过 Layout 那颗 z-50 的「退出沉浸」浮钮（它会盖住画面右上角），
          //         又要低于登录弹窗的 z-[80]
          // 非全屏：桌面端仍是整体 16:9（工具栏在框内，不额外撑高详情页）；
          //         移动端不给整体比例 —— 高度 = 画面的原生比例框 + 工具栏
          fullscreen ? 'relative h-full' : playMode ? 'fixed inset-0 z-[60]' : embedFill ? 'relative h-full' : 'relative sm:aspect-video',
          dragging && 'ring-2 ring-brand ring-inset',
        )}
        onDragOver={(e) => {
          e.preventDefault()
          if (!busy) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <div
          className={cx(
            'relative min-h-0',
            // 全屏和游玩布局都是「吃掉工具栏以外的全部高度」；iframe 竖着的话，
            // EmulatorJS 那边画布会给按键让位（见 adapters/emulatorjs.ts 的 FRAME_HTML）
            fullscreen || playMode || embedFill
              ? 'flex-1'
              : cx(
                  // 移动端：自己占一个按平台原生比例的框。flex-none 是必须的 ——
                  // 外层此时是 auto 高度，带着 flex-1（flex-basis:0）会被算成 0 高，画面整块消失
                  'flex-none sm:flex-1 sm:aspect-auto',
                  mobileScreenAspect(platform.id),
                  // 极矮的屏幕上兜一道，别让竖屏平台（NDS / J2ME）把整页顶开
                  'max-h-[72dvh] sm:max-h-none',
                ),
          )}
        >
          {/* 运行时挂载点：iframe 由运行时注入，React 不管理其子节点 */}
          <div ref={frameRef} className={cx('absolute inset-0', busy ? 'block' : 'hidden')} />

          {/*
            监视器态（见 monitor）的「点一下回去玩」。手机上退出沉浸后游戏还在这个小框里跑，
            但这儿是按不了的：引擎的按键已经收起，我们那套行内手柄也不在这儿。
            整块画面做成一个按钮，点哪儿都回到游玩布局，底下压一行字说明白。
            只在跑起来之后画 —— 加载中画面上是进度条，空闲时是开始按钮，都不该被盖住。
          */}
          {monitor && status === 'running' && (
            <button
              type="button"
              onClick={enterPlayMode}
              aria-label={t.player.tapToPlay}
              className="absolute inset-0 z-30 flex items-end justify-center bg-transparent pb-3"
            >
              <span className="rounded-full border border-white/25 bg-black/70 px-3 py-1.5 text-[11px] font-semibold text-white/90 shadow-lg backdrop-blur">
                ◧ {t.player.tapToPlay}
              </span>
            </button>
          )}

          {/*
            触屏手柄（浮层那一路）。只对声明了 'touchpad' 能力的运行时出现 ——
            EmulatorJS 自带虚拟手柄（见 adapters/emulatorjs.ts 的 showVirtualGamepad），
            两套不能同时冒出来。

            手机竖屏时不走这里，改成画面下面单独一条（见下面 padInline 那块）：
            画面框只有 291pt 高，浮层的十字键要压掉四成。
          */}
          {showPad && !padInline && <TouchPad handle={handle} onInput={dismissPadHint} highlight={padHint} />}

          {/*
            开局提示气泡。玩家的视线在画面里，所以提示画在画面里，然后把他引到按键那儿去。

            贴哪一边由 padBelow 决定，这一格不能搞错：
              手柄在画面**下面**（我们那套 inline）→ 贴画面下沿，紧挨着它，箭头往下指
              手柄压在画面**上**（我们的浮层 / EmulatorJS 自带的那套）→ 必须贴**上**沿，
              贴下沿的话气泡正好盖住要指的那排按键 —— 教人按键的东西把按键挡了。
            两种情况都用 👇：手柄要么在下面，要么在画面靠下的位置，方向是一致的。
          */}
          {hasOnscreenPad && padHint && (
            <div
              className={cx(
                'pointer-events-none absolute inset-x-0 z-30 flex justify-center px-2',
                padBelow ? 'bottom-0 pb-2' : 'top-0 pt-2',
              )}
            >
              <div className="pointer-events-auto flex items-start gap-2 rounded-xl border border-white/20 bg-black/80 px-3 py-2 text-left text-[11px] leading-snug text-white/90 shadow-lg backdrop-blur">
                <span aria-hidden className="text-base leading-none">
                  🎮
                </span>
                <span>
                  <span className="block font-semibold text-white">
                    {touchScreenConsole
                      ? t.player.padHintTouch
                      : padBelow || enginePadStacked
                        ? t.player.padHintBelow
                        : t.player.padHintOverlay}
                  </span>
                  {/*
                    第二行按机型分三套：
                      触屏机型（NDS）—— 按键默认是收起的，得告诉他去哪儿调出来
                      DOS —— 键位和主机完全不是一回事（A=Ctrl 开火、B=Alt、START=回车）
                      其余 —— 主机那套十字键 + A/B
                  */}
                  {touchScreenConsole
                    ? t.player.padHintTouchKeys
                    : activeRuntime?.id === 'jsdos'
                      ? t.player.padHintKeysDos
                      : t.player.padHintKeys}
                </span>
                <button
                  type="button"
                  onClick={dismissPadHint}
                  className="ml-1 shrink-0 rounded-md border border-white/25 px-2 py-1 font-semibold text-white/80 hover:border-white/50 hover:text-white"
                >
                  {t.player.padHintGot}
                </button>
              </div>
            </div>
          )}

          {!busy && (
            <div className="absolute inset-0">
              <div className="absolute inset-0 opacity-60 blur-sm">{backdrop}</div>
              <div className="scanlines absolute inset-0" aria-hidden />
              <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-black/20" />

              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
              {icon && (
                <span className="hidden text-6xl drop-shadow-[0_8px_16px_rgba(0,0,0,0.6)] sm:block sm:text-7xl" aria-hidden>
                  {icon}
                </span>
              )}
              {supported ? (
                <>
                  <Button size="lg" disabled={(!online && romChecking) || joinBlocked} onClick={primaryAction}>
                    <span aria-hidden>{online ? (willWatch ? '👀' : '👥') : '▶'}</span>{' '}
                    {joining && online
                      ? willWatch
                        ? t.player.watchRoom
                        : inviteFull
                          ? t.player.roomFull
                          : inviteGone
                            ? t.player.roomGoneShort
                            : t.player.joinRoom
                      : online
                        ? t.player.onlineStart
                        : romChecking
                          ? t.player.checkingCloud
                          : romUrl
                            ? t.player.start
                            : t.player.pickRom}
                  </Button>
                  <p className="max-w-md text-[11px] leading-relaxed text-white/70 sm:text-xs">
                    {joining && online ? (
                      <>
                        {inviteGone
                          ? t.player.roomGone
                          : inviteChanging
                            ? t.player.hostChanged
                            : willWatch
                            ? inviteFull
                              ? t.player.watchHint
                              : t.player.watchHintPick
                            : inviteRoom
                              ? fmt(t.player.joinHint, {
                                  host: inviteRoom.host?.nickname ?? '—',
                                  players: String(inviteRoom.players),
                                  max: String(inviteRoom.max),
                                  slot: String(Math.min(inviteRoom.players + 1, inviteRoom.max)),
                                })
                              : t.player.roomLookup}
                        <br />
                        {/* 位子还空着，但只想看别人玩 */}
                        {canWatch && !willWatch && inviteId && (
                          <button
                            type="button"
                            className="mx-1 underline underline-offset-2 hover:text-white"
                            onClick={() => startP2p(inviteId, undefined, 'spectator')}
                          >
                            {t.player.watchInstead}
                          </button>
                        )}
                        <button
                          type="button"
                          className="mx-1 underline underline-offset-2 hover:text-white"
                          onClick={() => setIgnoreInvite(true)}
                        >
                          {t.player.createOwnRoom}
                        </button>
                      </>
                    ) : online ? (
                      <>
                        {fmt(channel === 'p2p' ? t.player.p2pHint : t.player.onlineHint, { max: String(slots) })}
                        <br />
                        {t.player.alsoCan}
                        <button type="button" className="mx-1 underline underline-offset-2 hover:text-white" onClick={() => setMode('local')}>
                          {t.player.localInstead}
                        </button>
                        {pageRuntime ? fmt(t.player.localInsteadHint, { runtime: pageRuntime.name }) : ''}
                      </>
                    ) : romUrl ? (
                      <>
                        {fmt(t.player.cloudHint, { runtime: pageRuntime?.name ?? '' })}
                        <br />
                        {t.player.alsoCan}
                        <button type="button" className="mx-1 underline underline-offset-2 hover:text-white" onClick={() => inputRef.current?.click()}>
                          {t.player.pickLocal}
                        </button>
                        {t.player.orDrag}
                        {onlineOk && (
                          <>
                            {' '}
                            <button type="button" className="mx-1 underline underline-offset-2 hover:text-white" onClick={() => setMode('online')}>
                              {t.player.onlineInstead}
                            </button>
                          </>
                        )}
                      </>
                    ) : romChecking ? (
                      <>{t.player.checkingHint}</>
                    ) : (
                      <>
                        {romUnavailable && (
                          <>
                            <span className="font-semibold text-white">{t.player.noCurrentLanguageVersion}</span>
                            {/* 探不到 ≠ 真没有：网络抖一下也会落到这里，给个按钮重新探，
                                比让玩家去刷新整页强 */}
                            {onRetryRom && (
                              <>
                                {' '}
                                <button
                                  type="button"
                                  onClick={onRetryRom}
                                  className="underline underline-offset-2 hover:text-white"
                                >
                                  {t.player.retryRom}
                                </button>
                              </>
                            )}
                            <br />
                          </>
                        )}
                        {fmt(t.player.dropHint, { platform: platformLabel(t, platform.id, platform.name) })}
                        <br />
                        {fmt(t.player.formats, {
                          exts: platform.romExtensions.join(' '),
                          runtime: pageRuntime?.name ?? '',
                        })}
                      </>
                    )}
                  </p>
                </>
              ) : (
                <div className="max-w-md rounded-xl border border-line bg-black/60 p-4 text-sm text-white/80 backdrop-blur">
                  <p className="font-semibold text-white">{t.player.unsupportedTitle}</p>
                  <p className="mt-1 text-xs leading-relaxed">
                    {fmt(t.player.unsupportedBody, { platform: platformLabel(t, platform.id, platform.name) })}
                  </p>
                </div>
              )}
              {error && (
                <p role="alert" className="max-w-md rounded-lg bg-live/20 px-3 py-2 text-xs text-red-200">
                  {error}
                </p>
              )}
              </div>
            </div>
          )}

          {status === 'loading' && (
          /*
           * 加载遮罩：只有「少女祈祷中....」和一个只进不退的百分比。
           *
           * 「一种状态」是刻意的：适配器报的是每个阶段各自的 0~1，四个阶段直接画上去，
           * 玩家一局加载里会看到条子涨满又归零好几次，像坏了。合成在 loadProgress.ts 里做。
           *
           * 两层意思。一是不遮不行 —— 资源没下完就让玩家点下去，按键喂给一个还没起来的
           * 引擎，表现是「怎么按都没反应」，比等一会儿更让人困惑，所以这里故意不加
           * pointer-events-none。二是必须盖住引擎**自己**的加载界面：EmulatorJS 会用
           * 它自己的语言包弹「下载游戏数据 16%」那一套文案，CheerpJ 也有自己的加载框
           * —— 不盖住的话这些字照样会露出来。
           *
           * 盖住不等于丢掉进度：EmulatorJS 那边的真实字节数被适配器接了出来
           * （包一层 iframe 里的 XHR，见 adapters/emulatorjs.ts 的 installProgressTap），
           * 照样走这根条 —— 玩家看到的是进度，而不是引擎自己那行中文字。
           *
           * 没有真实字节数时也会在当前阶段里缓慢前进：核心与镜像 0–40%，ROM 40–80%，
           * 启动与超时 80–99%。这样静默阶段不再像页面卡死，真正成功仍只认 onReady。
           */
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black px-8">
            <div className="flex w-full max-w-xs flex-col items-center gap-3">
              <p className="text-sm font-medium tracking-wide text-white/90">
                少女祈祷中.... <span className="tabular-nums text-brand-hover">{Math.round(ratio * 100)}%</span>
              </p>
              <div
                role="progressbar"
                aria-label="少女祈祷中"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(ratio * 100)}
                className="h-1.5 w-full overflow-hidden rounded-full bg-white/15"
              >
                <div
                  className="h-full rounded-full bg-brand-hover transition-[width] duration-300 ease-out"
                  style={{ width: `${Math.round(ratio * 100)}%` }}
                />
              </div>
            </div>
          </div>
          )}

          <input
            ref={inputRef}
            type="file"
            accept={onDetectMismatch === 'switch' ? undefined : platform.romExtensions.join(',')}
            className="hidden"
            onChange={(e) => void start(e.target.files?.[0] ?? null)}
          />
        </div>

        {/*
          触屏手柄（行内那一路）。手机竖屏专用：排在画面框和工具栏之间，谁也不压谁。
          整条的边框、底色和收起状态都在 TouchPad 里，收起来只剩一颗 🎮 的高度。
        */}
        {showPad && padInline && <TouchPad handle={handle} layout="inline" onInput={dismissPadHint} highlight={padHint} />}

        {/* 工具栏放进播放器框体底部，而不是作为详情页里的下一块内容 */}
        <div
          data-testid="emulator-toolbar"
          className={cx(
            // 窄屏 gap-1：320pt 上七道间隙省下 14px，正好是「一行」和「两行」的差别
            'relative z-20 flex shrink-0 flex-wrap items-center gap-1 border-t border-line bg-surface px-2 py-1.5 text-xs sm:gap-2 sm:px-3 sm:py-2',
            // 游玩布局：这一条压在视口最底下 —— 手指在上面一划不能把底下的页面滚走（touch-none），
            // 底边让出 iPhone 的 Home 指示条（safe-area），没有的设备上 max() 取回原来的 py
            playMode && 'touch-none pb-[max(0.375rem,env(safe-area-inset-bottom))]',
          )}
        >
        {/*
          手机上文字部分收起来，只留那个圆点。
          原因是宽度：390pt 的屏幕上「● 运行中」加上工具栏那排图标按钮排不下，
          状态徽章会被挤成独立的一行 —— 为一句话多占 34pt，而颜色本身已经把
          「在跑 / 在加载 / 出错」说清楚了。文字进 title 和 aria-label，读屏照样能读到。
        */}
        <span
          title={statusLabel}
          aria-label={statusLabel}
          className={cx(
            /*
              窄屏上整颗徽章都不画（原本只是把文字收进 title，留一颗圆点）。
              圆点在手机上说不出任何新东西：跑起来了画面自己在动、加载中画面里有进度条、
              出错了有红字。而它连着间距要占 26px —— 360pt 上工具栏正好差这一点排不下，
              折出来的第二行是从画面高度里扣的（probe 实测 360/320 都因此变成两行）。

              ⚠️ 用 max-sm:hidden 这个**变体**，不是在 inline-flex 后面追一个裸 hidden：
              两个都是 display 工具类、同层同特异性，谁赢由 Tailwind 生成的先后顺序决定
              （inline-flex 排在后面），裸 hidden 根本不生效 —— 第一版就是这么写的，
              probe 量出来徽章照样占着 22px。带变体的规则生成在后面，才盖得住。
            */
            'inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-semibold max-sm:hidden',
            status === 'running'
              ? 'bg-online/15 text-online'
              : status === 'loading'
                ? 'bg-brand-soft text-brand-hover'
                : status === 'error'
                  ? 'bg-live/15 text-live'
                  : 'bg-white/5 text-muted',
          )}
        >
          <span className={cx('h-1.5 w-1.5 rounded-full', status === 'running' ? 'bg-online' : 'bg-current')} />
          <span className="hidden sm:inline">{statusLabel}</span>
        </span>

        {inRoom ? (
          <>
            <span className="inline-flex items-center gap-1 rounded-md bg-brand-soft px-2 py-1 font-semibold text-brand-hover" title={roomId ?? ''}>
              👥 {fmt(t.player.roomBadge, { players: String(roomPlayers), max: String(slots) })}
              {session?.cloud && <span className="font-normal text-muted">· {fmt(t.player.slotLabel, { n: String(slotIndex + 1) })}</span>}
              {netplayOn && <span className="font-normal text-muted">· {t.player.p2pTag}</span>}
            </span>
            {netplayOn && viewers > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md bg-white/5 px-2 py-1 font-semibold text-muted">
                👀 {fmt(t.player.viewers, { n: String(viewers) })}
              </span>
            )}
            {session?.netplay && role === 'spectator' && (
              <span className="inline-flex items-center gap-1 rounded-md bg-live/15 px-2 py-1 font-semibold text-live">
                {t.player.spectatorTag}
              </span>
            )}
            {session?.netplay && roomId && !isHost && (
              <button
                type="button"
                onClick={() => void toggleRole()}
                /*
                  位子满了就先禁掉，别让人点了才看到一句「操作失败」——
                  观众等的就是 1P/2P 走人，按钮能不能按本身就是那个信号。
                  房间信息还没到货（myNetRoom 为空）时不禁：宁可点了服务端拒，
                  也不要因为列表慢一拍把唯一的入口锁死。
                */
                disabled={role === 'spectator' && Boolean(myNetRoom) && roomPlayers >= slots}
                title={
                  role === 'spectator' && Boolean(myNetRoom) && roomPlayers >= slots
                    ? t.player.seatsFull
                    : undefined
                }
                className="rounded-md border border-line px-2 py-1 text-muted transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted"
              >
                {role === 'spectator' ? t.player.takeSeat : t.player.goWatch}
              </button>
            )}
            {roomId && (
              <button type="button" onClick={() => void copyInvite()} className="rounded-md border border-line px-2 py-1 text-muted hover:text-fg">
                {copied ? t.player.copied : t.player.copyInvite}
              </button>
            )}
            {session?.cloud && status === 'running' && cloudState && cloudState !== 'playing' && (
              <span className="text-live">{cloudStateLabel}</span>
            )}
          </>
        ) : file ? (
          <span className="truncate text-muted" title={file.name}>
            📄 {file.name} · {formatBytes(file.size)}
          </span>
        ) : null}
        {/* 运行时·核心标签（EmulatorJS · gba 之类）不再常驻展示 —— 对玩家是噪音。
            只有真没有可用运行时（这游戏压根跑不了）才提示一句 */}
        {!activeRuntime && (
          <span className="text-muted" title={t.player.runtimeCore}>
            {t.player.noRuntimeShort}
          </span>
        )}
        {notice && (
          <span data-testid="detect-notice" className="truncate text-brand-hover">
            {notice}
          </span>
        )}

        {status === 'running' && (
          <EmulatorTools
            handle={handle}
            caps={caps}
            gameName={gameName}
            gameSlug={saveSlug}
            runtimeId={session?.runtime.id ?? activeRuntime?.id}
            dosSaveHint={dosSaveHint}
            // 快捷键要能在游戏开着时按 —— 得从这一块里找到模拟器的 iframe。见 hotkeyBridge.ts
            stageRef={hostRef}
          />
        )}

        {/* 观众席：直播间的人数和状态 */}
        {session?.live && (
          <span className="inline-flex items-center gap-1 rounded-md bg-live/15 px-2 py-1 font-semibold text-live">
            📡 {fmt(t.player.tools.liveOn, { n: String(liveViewers) })}
            {/* 过渡态给人话，别把 'reconnecting' 这种英文状态名直接糊上去 */}
            {liveState === 'host-away' && <span className="font-normal text-muted">· {t.runtime.liveHostAway}</span>}
            {liveState === 'reconnecting' && <span className="font-normal text-muted">· {t.runtime.liveReconnecting}</span>}
            {liveState === 'connecting' && <span className="font-normal text-muted">· …</span>}
          </span>
        )}

        {/*
          主播把这一局开成了联机房 —— 正在看的人这里就能上场。
          放在观众席徽章旁边而不是藏进菜单：这是个**限时**的邀请（手柄位会被别人坐掉），
          藏起来就等于没有。房间满了照样让点，进去当观众，等位子空出来再上。
        */}
        {session?.live && liveNetplayRoom && romUrl && (
          <button
            type="button"
            onClick={joinLiveNetplay}
            className="inline-flex items-center gap-1 rounded-md border border-brand bg-brand-soft px-2 py-1 font-semibold text-brand-hover transition-colors hover:bg-brand/20"
          >
            <span aria-hidden>👋</span>
            {t.player.joinMatch}
          </button>
        )}

        {/*
          自动开播。玩就是播 —— 不用玩家点，画面推出去的是录像用的那份副本，
          本机这一局不受影响。想安静玩的人在按钮上点一下「不公开」，选择记在本地。
          联机房里的房主不重复推：房间本身就带观众席，再推一路是白占上行。
        */}
        {status === 'running' && !session?.live && (
          <LiveControls
            handle={handle}
            gameName={gameName}
            gameSlug={gameSlug}
            platform={session?.platform ?? platform.id}
            /*
              只有「我是别人房里的客人」才停播 —— 画面本来就是房主推过来的。
              **自己开的联机房不停**：以前这里是 `!inRoom`，把自己开的房也算进去了，
              于是点一下「联机」正在看的人当场断流。现在直播照推，把房号报上去，
              大厅把直播卡和联机卡合成一张（见 services/allRooms.ts）。
            */
            active={!session?.netplay && !session?.cloud}
            netplayRoomId={hosting ? roomId : null}
            captureRef={hostRef}
          />
        )}

        {/*
          联机匹配。接替原来「开播」的位置：开播已经不需要玩家决定了，
          「让别人进来一起玩」才需要。点下去在**正在跑的这一局**上开房，游戏不重开。
        */}
        {status === 'running' && !session?.live && !session?.netplay && !session?.cloud && (
          <MatchControls
            handle={handle}
            maxPlayers={slots}
            canPlayOnline={p2pOk}
            open={hosting}
            busy={matchBusy}
            onOpen={openMatch}
            onClose={closeMatch}
          />
        )}

          <div className="ml-auto flex items-center gap-1.5">
          {/*
            ROM 语言切换。两个前提：
              1. 这款游戏确实有两种以上语言的 ROM —— 只有一种时切了也是它自己
              2. 不在联机房里 —— 房主和访客必须跑同一份 ROM，中途换语言这局就废了
          */}
          {romLangs && romLangs.length > 1 && onRomLangChange && !inRoom && (
            <label className="relative" title={t.player.romLangTitle}>
              <span className="sr-only">{t.player.romLang}</span>
              <select
                value={romLang ?? ''}
                onChange={(e) => switchRomLang(e.target.value as RomLang)}
                className={cx(buttonClasses('secondary', 'sm'), 'cursor-pointer appearance-none pr-7')}
              >
                {/* 当前用的是通用 rom（不属于任何语言槽）时，给个占位项，
                    免得 select 自作主张显示成第一个语言，看起来像已经选了它 */}
                {!romLang && <option value="">{t.player.romLang}</option>}
                {romLangs.map((l) => (
                  <option key={l} value={l}>
                    {ROM_LANG_LABEL[l]}
                  </option>
                ))}
              </select>
              <span aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-muted">
                ▾
              </span>
            </label>
          )}
          {/*
            这个位置只有两种情况需要按钮：
              online  —— 在房间里，得有个「离开房间」
              file    —— 玩的是玩家自己选的本地文件，才谈得上「更换 ROM」
            跑云端 ROM 时两个都不成立：ROM 是站点提供的，没有可换的东西，
            按钮放在那儿只会让人以为自己该做点什么。
          */}
          {(busy || status === 'error') && (online || file) && (
            <Button variant="ghost" size="sm" onClick={reset}>
              {online ? t.player.leaveRoom : t.player.changeRom}
            </Button>
          )}
          {/*
            沉浸 / 全屏这两个按钮在手机上只留前面那个符号（见 glyphOnly）。
            带上文字的话，320pt 宽的屏幕上工具栏正好差几个像素排不下，
            为两个词多占一整行 —— 而这一行是从画面高度里扣的。
          */}
          {supported && (
            <>
              {/* 嵌入页没有 ShellProvider，toggleImmersive 是空函数 —— 别画一颗点了没反应的按钮 */}
              {shellAvailable && (
              <Button
                variant={immersive ? 'primary' : 'secondary'}
                size="sm"
                /*
                  窄屏上收成和工具栏其余图标钮一样的 h-7 / px-1.5（那边是 EmulatorTools 的 BTN）。
                  这两颗原本是 h-8 px-3 的 Button，在只画一个符号的手机上白占 14px 宽、4px 高，
                  而 360pt 的屏幕上正好就差这十几个像素会把工具栏挤成两行。
                  用 max-sm: 而不是裸 h-7：裸的和 Button 自己的 h-8 同层同特异性，
                  Tailwind 把 h-8 排在 h-7 后面，追加的会被吃掉（和上面徽章那条是同一个坑）；
                  带变体的规则生成在后面，才盖得住。
                */
                className="max-sm:h-7 max-sm:px-1.5"
                onClick={toggleImmersive}
                title={t.player.immersiveTitle}
                aria-label={immersive ? t.player.exitImmersive : t.player.enterImmersive}
                aria-pressed={immersive}
              >
                <span className="sm:hidden" aria-hidden>
                  {glyphOnly(immersive ? t.player.exitImmersive : t.player.enterImmersive)}
                </span>
                <span className="hidden sm:inline">{immersive ? t.player.exitImmersive : t.player.enterImmersive}</span>
              </Button>
              )}
              {/* 没有 Fullscreen API 的浏览器（iPhone Safari）不画：点了什么都不发生的按钮比没有更糟 */}
              {fullscreenApi && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="max-sm:h-7 max-sm:px-1.5"
                  onClick={toggleFullscreen}
                  title={t.player.fullscreenTitle}
                  aria-label={t.player.fullscreen}
                >
                  <span className="sm:hidden" aria-hidden>
                    {glyphOnly(t.player.fullscreen)}
                  </span>
                  <span className="hidden sm:inline">{t.player.fullscreen}</span>
                </Button>
              )}
            </>
          )}
          </div>
        </div>
      </div>
    </div>
  )
}
