import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { DosBackend, Platform, PlatformId } from '@/types'
import { platformMap } from '@/data/platforms'
import { formatBytes, isRomFileAccepted } from '@/lib/emulator'
import { detectRom, describeDetection } from './detect'
import { resolveRuntime, extOf } from './registry'
import type { Capability, LoadPhase, Runtime, RuntimeHandle } from './types'
import { createOverallRatio, LOAD_PHASE_RANGE, windowsGuestStartupBudgetMs } from './loadProgress'
import { platformBiosUrlSync } from '@/services/platformBios'
import { EmulatorTools } from './EmulatorTools'
import { LiveControls } from './LiveControls'
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
import { recordPlay } from '@/services/store'
import {
  downloadState,
  fetchNetplayRoom,
  gameIdFor,
  inviteLink,
  migrateRoom,
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
  /** DOS 启动程序覆盖（zip 内相对路径），jsdos 运行时用 */
  dosExecutable?: string
  /** DOS 运行核心：Windows 95/98 的完整 .jsdos 镜像必须走 DOSBox-X */
  dosBackend?: DosBackend
  /** 可复用的 Windows 95/98 系统 .jsdos；游戏 ROM 仍单独加载。 */
  dosSystemUrl?: string
  /** 客体 Windows 切入图形模式后，等待多少秒再执行 dosExecutable。 */
  dosLaunchDelay?: number
  /** 平台级 BIOS 的地址（见 services/platformBios.ts）。Neo Geo 这类平台缺了就起不来 */
  biosUrl?: string
  /** 正在探测云端 ROM 是否存在 */
  romChecking?: boolean
  /** 当前语言及英语、日语、中文回退均没有可用 ROM */
  romUnavailable?: boolean
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
export function EmulatorPlayer({
  platform,
  gameName,
  gameSlug,
  maxPlayers = 2,
  invite,
  cloudInvite,
  watch = false,
  liveInvite,
  backdrop,
  icon,
  className,
  romUrl,
  core,
  dosExecutable,
  dosBackend,
  dosSystemUrl,
  dosLaunchDelay,
  biosUrl,
  romChecking,
  romUnavailable,
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

  const t = useT()
  const { immersive, toggleImmersive } = useShell()

  /* ---------------- 联机 ---------------- */
  // 联机需要云端 ROM：房主和访客都得能拿到同一个 ROM
  const p2pOk = Boolean(gameSlug) && Boolean(romUrl) && p2pPlayable(platform.id)
  const cloudOk = FEATURES.cloudGame && Boolean(gameSlug) && cloudPlayable(platform.id)
  const onlineOk = p2pOk || cloudOk
  /** 优先 P2P；P2P 不可用而云端可用时才走云端 */
  const channel: Channel = p2pOk ? 'p2p' : 'cloud'

  const [ignoreInvite, setIgnoreInvite] = useState(false)
  const inviteId = ignoreInvite ? undefined : invite
  const cloudInviteId = ignoreInvite ? undefined : cloudInvite
  const joining = Boolean(inviteId) || Boolean(cloudInviteId)

  /**
   * 默认是否走联机：多人游戏，或者点邀请链接进来的人。
   * 单人游戏默认在本地跑（可手动切联机，相当于开个直播给人看）。
   */
  const onlineByDefault = onlineOk && (maxPlayers > 1 || joining)
  const [mode, setMode] = useState<Mode>(onlineByDefault ? 'online' : 'local')
  const online = mode === 'online' && onlineOk

  const [roomId, setRoomId] = useState<string | null>(null)
  const [players, setPlayers] = useState(1)
  /** netplay 给我们分配的身份 id，服务器用它判断「谁该接手」 */
  const myIdRef = useRef<string>('')
  /** 正在接手的旧房间 id：新房间开好后要调 /migrate 把两者接上 */
  const migrateFromRef = useRef<string>('')
  /** 服务端下发的房间令牌：取存档、接手房主、切身份都要用它证明自己是房间成员 */
  const roomTokenRef = useRef<string>('')
  /** 我在房间里的身份。观众只收画面和声音，按键不生效 */
  const [role, setRole] = useState<RoomRole>('player')
  /** 我是不是房主（房主的机器在跑游戏，不能退到观众席） */
  const [isHost, setIsHost] = useState(false)
  /** 适配器交出来的「切身份」函数：不用断线重连就能上场 / 退下 */
  const roleSwitchRef = useRef<((spectator: boolean) => void) | null>(null)
  const [copied, setCopied] = useState(false)
  const slots = Math.max(1, Math.min(MAX_PLAYERS, maxPlayers))

  // P2P：从房间列表里找要加入的那个房间（判断满没满、还在不在）
  const p2pRooms = useNetplayRooms()
  const inviteRoom = inviteId ? p2pRooms.find((r) => r.roomId === inviteId) : undefined
  const inviteGone = Boolean(inviteId) && status === 'idle' && p2pRooms.length > 0 && !inviteRoom
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
  const myNetRoom = session?.netplay && roomId ? p2pRooms.find((r) => r.roomId === roomId) : undefined
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
  const dosLaunchDelayRef = useRef(dosLaunchDelay)
  dosLaunchDelayRef.current = dosLaunchDelay
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
      dosExecutable: dosExecutableRef.current,
      dosBackend: dosBackendRef.current,
      dosSystemUrl: dosSystemUrlRef.current,
      dosLaunchDelay: dosLaunchDelayRef.current,
      /**
       * BIOS 按**本次会话真正的平台**取，父组件传下来的只作首选。
       *
       * 「玩本地 ROM」页的平台是拖进文件才识别出来的（detect -> onPlatformChange），
       * 父组件那边的 biosUrl 还停留在识别前的默认平台上；等它算出新值，
       * 引擎已经挂载完了，而这里刻意不会为了 BIOS 迟到去重启游戏。
       * 所以再按 session.platform 同步兜一次 —— 缓存早在进页面时就拉好了。
       */
      biosUrl: biosUrlRef.current || platformBiosUrlSync(session.platform),
      // 存档按 slug 归档；玩家自己上传的 ROM 没有 slug，交给引擎退回文件名
      gameSlug: gameSlugRef.current,
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
        setSession(null)

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
      playerIndex: session.cloud.playerIndex,
      host: !session.cloud.roomId,
    })
  }, [session, roomId, gameSlug])

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
        setSession(null)
        setStatus('error')
        setError(t.player.hostLeft)
        return
      }
      if (room.migratedTo && room.migratedTo !== roomId) {
        setNotice(t.player.hostChanged)
        startP2p(room.migratedTo)
        return
      }
      if (room.awaitingHost && room.nextHostUserId && room.nextHostUserId === myIdRef.current) {
        stopped = true
        setNotice(t.player.takingOver)
        const state = room.hasState ? await downloadState(roomId, roomTokenRef.current) : null
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
        setSession(null)
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
        onToken: (tk) => (roomTokenRef.current = tk),
        onRoom: (id, host) => {
          setRoomId(id)
          setIsHost(host)
          // 接手房主之后自然就不是观众了
          if (host) setRole('player')
          // 接手成功：把新房间和旧房间接上，老邀请链接才能继续用
          const from = migrateFromRef.current
          if (host && from && from !== id) {
            migrateFromRef.current = ''
            void migrateRoom(from, id, myIdRef.current).then((okDone) => {
              if (okDone) setNotice(t.player.tookOver)
            })
          }
          refreshNetplayRooms()
        },
        onPlayers: (n) => setPlayers(n),
        onHostLeft: () => {
          setSession(null)
          setStatus('error')
          setError(t.player.hostLeft)
        },
      },
    })
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
        },
      })
      setStatus('loading')
    },
    [platform.id],
  )

  // 观看链接进来就直接开看，不用再点一次
  useEffect(() => {
    if (liveInvite && !session && status === 'idle') startWatchLive(liveInvite)
  }, [liveInvite, session, status, startWatchLive])

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

  const reset = () => {
    // 主动离开房间后，URL 里的 ?p2p= / ?room= 就不该再把人拉回同一个房间
    if (session?.netplay || session?.cloud || joining) setIgnoreInvite(true)
    setSession(null)
    setStatus('idle')
    setFile(null)
    setError(null)
    setNotice(null)
    setRoomId(null)
    setPlayers(1)
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
  const inRoom = Boolean(session?.netplay || session?.cloud)
  const activeRuntime =
    session?.runtime ?? (online ? (channel === 'p2p' ? emulatorJsRuntime : cloudGameRuntime) : pageRuntime)
  const cloudStateLabel = cloudState ? t.player.cloudState[cloudState] : ''

  // 进度条加载期间最多走到 99%，真正启动后遮罩才消失
  const ratio = loadRatio ?? 0
  // 服务端的 players 不含观众，比本地 onPlayers 更准；拿不到时退回本地计数
  const roomPlayers = session?.cloud ? (myCloudRoom?.players ?? 1) : (myNetRoom?.players ?? players)
  const joinBlocked = online && ((inviteFull && !canWatch) || inviteGone || cloudJoinPending)

  /**
   * 上场 / 退到观众席。
   * 服务端那边记账（手柄位够不够由它说了算），本地那边掐断或恢复输入转发 ——
   * 真正管用的是本地这一下，因为按键是走 WebRTC 直接到房主的，不经过服务器。
   */
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

  /** 空闲态主按钮 */
  const primaryAction = () => {
    if (online) return startOnline()
    if (romUrl) void start(null)
    else inputRef.current?.click()
  }

  return (
    <div data-testid="emulator-player" className={cx('overflow-hidden rounded-2xl border border-line bg-black', className)}>
      {/*
        播放器自身固定为 16:9，工具栏是其中的最后一行。
        这样它在普通模式和全屏模式里都属于模拟器，不会再额外撑高详情页；画面区域让出
        工具栏的实际高度，也不会把 EmulatorJS 自己的底部菜单盖住。
      */}
      <div
        ref={hostRef}
        data-testid="emulator-stage"
        className={cx('relative flex aspect-video w-full flex-col bg-black', dragging && 'ring-2 ring-brand ring-inset')}
        onDragOver={(e) => {
          e.preventDefault()
          if (!busy) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <div className="relative min-h-0 flex-1">
          {/* 运行时挂载点：iframe 由运行时注入，React 不管理其子节点 */}
          <div ref={frameRef} className={cx('absolute inset-0', busy ? 'block' : 'hidden')} />

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

        {/* 工具栏放进播放器框体底部，而不是作为详情页里的下一块内容 */}
        <div
          data-testid="emulator-toolbar"
          className="relative z-20 flex shrink-0 flex-wrap items-center gap-2 border-t border-line bg-surface px-3 py-2 text-xs"
        >
        <span
          className={cx(
            'inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-semibold',
            status === 'running'
              ? 'bg-online/15 text-online'
              : status === 'loading'
                ? 'bg-brand-soft text-brand-hover'
                : status === 'error'
                  ? 'bg-live/15 text-red-300'
                  : 'bg-white/5 text-muted',
          )}
        >
          <span className={cx('h-1.5 w-1.5 rounded-full', status === 'running' ? 'bg-online' : 'bg-current')} />
          {status === 'running'
            ? t.player.statusRunning
            : status === 'loading'
              ? t.player.statusLoading
              : status === 'error'
                ? t.player.statusError
                : t.player.statusIdle}
        </span>

        {inRoom ? (
          <>
            <span className="inline-flex items-center gap-1 rounded-md bg-brand-soft px-2 py-1 font-semibold text-brand-hover" title={roomId ?? ''}>
              👥 {fmt(t.player.roomBadge, { players: String(roomPlayers), max: String(slots) })}
              {session?.cloud && <span className="font-normal text-muted">· {fmt(t.player.slotLabel, { n: String(slotIndex + 1) })}</span>}
              {session?.netplay && <span className="font-normal text-muted">· {t.player.p2pTag}</span>}
            </span>
            {session?.netplay && viewers > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md bg-white/5 px-2 py-1 font-semibold text-muted">
                👀 {fmt(t.player.viewers, { n: String(viewers) })}
              </span>
            )}
            {session?.netplay && role === 'spectator' && (
              <span className="inline-flex items-center gap-1 rounded-md bg-live/15 px-2 py-1 font-semibold text-red-300">
                {t.player.spectatorTag}
              </span>
            )}
            {session?.netplay && roomId && !isHost && (
              <button
                type="button"
                onClick={() => void toggleRole()}
                className="rounded-md border border-line px-2 py-1 text-muted hover:text-fg"
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
              <span className="text-red-300">{cloudStateLabel}</span>
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
            gameSlug={gameSlug}
            runtimeId={session?.runtime.id ?? activeRuntime?.id}
          />
        )}

        {/* 观众席：直播间的人数和状态 */}
        {session?.live && (
          <span className="inline-flex items-center gap-1 rounded-md bg-live/15 px-2 py-1 font-semibold text-red-300">
            📡 {fmt(t.player.tools.liveOn, { n: String(liveViewers) })}
            {liveState && liveState !== 'watching' && <span className="font-normal text-muted">· {liveState}</span>}
          </span>
        )}

        {/*
          开播入口。只给「本来就没法联机」的游戏 —— GBA 是最典型的：
          联机靠当年的连接线，浏览器里的核心没有那套东西，所以「一起玩」做不到，
          能做的是「一起看」。支持多人的游戏应该去开联机房，不在这里出现。
        */}
        {status === 'running' && !session?.live && !inRoom && maxPlayers <= 1 && (
          <LiveControls handle={handle} gameName={gameName} gameSlug={gameSlug} platform={session?.platform ?? platform.id} />
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
          {supported && (
            <>
              <Button
                variant={immersive ? 'primary' : 'secondary'}
                size="sm"
                onClick={toggleImmersive}
                title={t.player.immersiveTitle}
                aria-pressed={immersive}
              >
                {immersive ? t.player.exitImmersive : t.player.enterImmersive}
              </Button>
              <Button variant="secondary" size="sm" onClick={toggleFullscreen} title={t.player.fullscreenTitle}>
                {t.player.fullscreen}
              </Button>
            </>
          )}
          </div>
        </div>
      </div>
    </div>
  )
}
