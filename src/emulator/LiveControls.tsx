/**
 * 「玩就是播」：本机游玩会话自动开播，加上一个联机匹配的入口。
 *
 * 为什么是自动的：以前这里是一个「开播」按钮，等玩家自己想起来点。结果是几乎没人点 ——
 * 大厅永远空着，观众看不到任何人在玩，主播也不知道有人想看。推流本来就是画面的副本
 * （和录像用的是同一份 CaptureSources），不影响本机这一局，那就没有理由让玩家先做决定。
 * 想安静玩的人点一下「不公开」即可，这个选择记在本地，下次沿用。
 *
 * 为什么单独一个组件而不是塞进 EmulatorTools：那边是「操作正在跑的模拟器」，
 * 这边是「把画面推出去 / 把别人放进来」，生命周期和失败模式都不一样，混在一起不好收拾。
 *
 * 失败是静默的：玩家没要求开播，推不出去也不该拿一行红字打断他打游戏，
 * 具体原因写进 console。但静默不等于**看不出状态**：这个按钮以前只在「直播中」和
 * 「不公开」两种情况下有文字，其余时候界面上只剩一个 📡 —— 玩家分不清自己是正在连、
 * 已经在播、还是压根没推出去。现在五种状态各有一个圆点加一句话（见下面的 Phase）。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { RuntimeHandle } from './types'
import { canBroadcast, startBroadcast, type Broadcast } from './broadcast'
import { liveEnabled, liveLink, refreshLiveRooms, type LiveChatMessage } from '@/services/live'
import { playerName } from '@/services/netplay'
import { useT, fmt } from '@/services/i18n'
import { cx } from '@/lib/format'

interface Props {
  handle: RuntimeHandle | null
  gameName: string
  /** 观看链接按 slug 生成，没有就没法开播 */
  gameSlug?: string
  platform?: string
  /**
   * 这一局该不该自动开播。
   *
   * 传 false 的只有一种情况：**我是别人房里的客人**（session.netplay / session.cloud）——
   * 画面本来就是房主推过来的，我再转推一路毫无意义。
   *
   * ⚠️ 自己开了联机房**不算**。以前这里传的是 `!inRoom`，把「我开的房」也算进去了，
   * 于是主播一点「联机」直播就停、正在看的人当场断流。现在直播照推，
   * 只是把联机房号报上去（netplayRoomId），大厅那边合成一张卡。
   */
  active?: boolean
  /**
   * 我这一局同时开着的联机房号（没开就传 null）。
   * 只是报给服务器让大厅能把两张卡认成一回事，不影响推流本身。
   */
  netplayRoomId?: string | null
  /**
   * 玩家点「开播」走标签页分享时，把画面裁到这个元素（播放器那一块），不带旁边的站点 UI。
   * Region Capture 目前只有 Chrome 系有；没有就整个标签页一起推，能用。
   */
  captureRef?: RefObject<HTMLElement | null>
  /**
   * 不画自己那颗按钮，只干推流的活。
   *
   * 2026-09-08 起开关挪到了弹幕输入框旁边（那儿才是主播的手停留的地方，
   * 而工具栏那一排图标已经挤到 360pt 上要折行了）。但**这个组件不能不挂**——
   * 推流、重连、观众数、弹幕收发全在它里面。所以是「藏起来」而不是「不渲染」。
   */
  chromeless?: boolean
  /**
   * 把开关和当前状态交出去，让别处（弹幕框）画那颗按钮。
   * 传 null = 现在没得可控（组件因为不满足开播条件而没挂）。
   */
  onControls?: (c: LiveControlsHandle | null) => void
  /** 收到一条弹幕。主播和观众看到的是同一份消息流，只是入口不同（观众那边走 liveview） */
  onChat?: (msg: LiveChatMessage) => void
  /**
   * 推流会话本身。播放器拿它是为了**发**弹幕（`sendChat`）——
   * 收在上面那个回调里，发得有个句柄。null = 现在没在播。
   */
  onSession?: (live: Broadcast | null) => void
  className?: string
}

/** 🔗 那类附属按钮 */
const BTN =
  'inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-md border border-line px-1.5 text-muted transition-colors hover:border-brand hover:text-fg disabled:opacity-40'

/**
 * 按钮上的五种状态。
 *
 *   starting      自动开播还在尝试（等第一帧画面，或者推流正在握手）
 *   live          真的在播，带在看人数
 *   reconnecting  信令断了，画面多半还在流（WebRTC 是点对点的），所以不撤标记
 *   off           试过了没成 —— 失败是静默的，界面上只有这一处能看出来
 *   manual        抓不到画面（跨源的 HTML5 游戏、没有 canvas 的页面），但浏览器支持
 *                 getDisplayMedia：点一下弹选择器、选本标签页，画面带声音一起推出去。
 *                 这是这类游戏唯一能播的路 —— iframe 里的东西浏览器不让读，不是我们能绕的
 *   hidden        玩家自己关掉了公开
 *
 * off 和 starting 必须分开：它们以前长得一模一样（都是一个光板 📡），
 * 而对玩家来说「再等等」和「这局没人看得到」是两件完全不同的事。
 */
type Phase = 'starting' | 'live' | 'reconnecting' | 'off' | 'manual' | 'hidden'

/** 交给别处画按钮用的一小把东西。文案在这边算好，调用方不用再认 Phase */
export interface LiveControlsHandle {
  phase: Phase
  /** 正在播（含重连中） */
  on: boolean
  viewers: number
  /** 按钮文字 */
  label: string
  /** 按钮说明（title） */
  hint: string
  toggle: () => void
}

/**
 * 状态按钮的底样式。颜色一概不写在这里 —— 每种状态的边框色/文字色由 TONE 给，
 * 一个元素上只留一个同族类名（cx 只是拼字符串，同族类名谁生效取决于 CSS 里的先后，
 * 不是 class 属性里的先后，写两个就是碰运气）。
 */
const STATE_BTN = 'inline-flex h-7 min-w-7 items-center justify-center gap-1.5 rounded-md border px-1.5 transition-colors'

const TONE: Record<Phase, string> = {
  live: 'border-live bg-live/15 text-live hover:bg-live/25',
  reconnecting: 'border-live/40 bg-live/5 text-muted hover:bg-live/15',
  starting: 'border-line text-muted hover:border-brand hover:text-fg',
  off: 'border-line text-dim hover:border-brand hover:text-fg',
  manual: 'border-brand/50 text-fg hover:border-brand hover:bg-brand/10',
  hidden: 'border-line text-dim hover:border-brand hover:text-fg',
}

/** 圆点跟大厅卡片上的 LIVE 标记用同一套语言（见 RoomCard）：红色跳动 = 真的在播 */
const DOT: Record<Phase, string> = {
  live: 'animate-pulse bg-live',
  reconnecting: 'animate-pulse bg-coin',
  starting: 'animate-pulse bg-coin',
  off: 'bg-dim',
  manual: 'bg-brand',
  hidden: 'bg-dim',
}

/**
 * 分享标签页的码率：按实际分辨率给。默认那 1.5 Mbps 是给 240×160 画布的，
 * 裁到播放器之后一般是 800×600 上下，整页则到 1080p —— 每像素每帧约 0.1 bit，
 * 下限还是 1.5 Mbps，上限 6 Mbps（再高家宽上行扛不住多个观众）。
 */
function tabBitrate(stream: MediaStream): number {
  const { width = 1280, height = 720 } = stream.getVideoTracks()[0]?.getSettings() ?? {}
  return Math.round(Math.max(1_500_000, Math.min(6_000_000, width * height * 30 * 0.1)))
}

/** 浏览器有没有「分享标签页」这条路（Safari iOS 没有；非 https 也没有） */
function canShareTab(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function'
}

/**
 * 让玩家选本标签页，拿到画面 + 声音。
 * preferCurrentTab / selfBrowserSurface 是 Chrome 的扩展：选择器直接把本页顶到最前，
 * 少点一次。Region Capture（cropTo）再把画面裁到播放器，观众看不到旁边的站点 UI。
 * 这几个 API 都不在 TS 的 lib 里，所以下面一堆 as。
 */
async function shareTab(cropTo: HTMLElement | null): Promise<MediaStream> {
  const constraints = {
    video: { displaySurface: 'browser' },
    audio: true,
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
    surfaceSwitching: 'exclude',
    systemAudio: 'exclude',
  } as unknown as DisplayMediaStreamOptions
  const stream = await navigator.mediaDevices.getDisplayMedia(constraints)
  const track = stream.getVideoTracks()[0] as (MediaStreamTrack & { cropTo?: (t: unknown) => Promise<void> }) | undefined
  const CropTarget = (window as unknown as { CropTarget?: { fromElement: (el: Element) => Promise<unknown> } }).CropTarget
  if (track?.cropTo && CropTarget && cropTo) {
    try {
      await track.cropTo(await CropTarget.fromElement(cropTo))
    } catch {
      /* 裁不了就整页推，能用 */
    }
  }
  return stream
}

/** 「不公开」是玩家的长期选择，不是这一局的临时状态，所以记在本地 */
const PRIVATE_KEY = '8bit.live.private'

function readPrivate(): boolean {
  try {
    return localStorage.getItem(PRIVATE_KEY) === '1'
  } catch {
    // 隐私模式 / 存储被禁：当作没关过，行为退回默认的自动开播
    return false
  }
}

function writePrivate(next: boolean) {
  try {
    if (next) localStorage.setItem(PRIVATE_KEY, '1')
    else localStorage.removeItem(PRIVATE_KEY)
  } catch {
    /* 存不进去也不影响这一局 */
  }
}

/** 画布要等引擎把第一帧挂上来才有，开局那一下取不到是正常的 */
const RETRY_MS = 600
const RETRY_MAX = 15
/**
 * 画布有了但声音还没有：再等几轮。
 * 推流是一次性拼好的（broadcast.ts 的 buildStream），开播之后声音节点再出现也接不进去。
 * 有的引擎（js-dos）画布一挂载就在，AudioContext 要等模拟器报出采样率才建 —— 差着一两秒。
 * 不等的话 DOS 直播永远是哑的。等不到（引擎本来就没有声音节点）就哑着播，别耽误太久。
 */
const AUDIO_WAIT_MAX = 8

export function LiveControls({ handle, gameName, gameSlug, platform, active = true, netplayRoomId = null, captureRef, className,
  chromeless = false,
  onControls,
  onChat,
  onSession,
}: Props) {
  const t = useT()
  const tt = t.player.tools
  const [live, setLive] = useState<Broadcast | null>(null)

  /** 房间号单独存：重连后接不回原房间时会换（见 broadcast.ts 文件头），Broadcast 对象本身不变 */
  const [roomId, setRoomId] = useState('')
  /** 信令断了、正在重连。画面多半还在流（WebRTC 是点对点的），所以只是标记变灰，不撤掉 */
  const [reconnecting, setReconnecting] = useState(false)
  /**
   * 推流受限的原因（来自 WebRTC 的 qualityLimitationReason）。
   * 以前这条链路上一个 getStats 都没有 —— 画质被压下去了主播也不知道为什么，
   * 只能等观众来说「好卡」。cpu 那一档尤其要让人看见：**每多一个观众就多一路编码**，
   * 而游戏主循环和它们抢的是同一颗 CPU。
   */
  const [quality, setQuality] = useState<'none' | 'cpu' | 'bandwidth' | 'other'>('none')
  const [viewers, setViewersRaw] = useState(0)
  /**
   * 人数归零时把「受限」的标记一起清掉。getStats 没有观众就不采样（broadcast.ts 的 statsTick 早退），
   * 所以最后一次采到的 cpu / bandwidth 会一直挂在按钮说明里 —— 明明一个人都没在看，
   * 主播 hover 上去还写着「编码跟不上」。
   */
  const setViewers = useCallback((n: number) => {
    setViewersRaw(n)
    if (n === 0) setQuality('none')
  }, [])
  const [hidden, setHidden] = useState(readPrivate)
  /**
   * 自动开播还在尝试。落定后无论成没成都置 false —— 界面靠它把「连接中…」和
   * 「未开播」分开。初值是 true：组件挂上来的那一刻尝试就已经开始了，
   * 从 false 起步会先闪一下「未开播」。
   */
  const [connecting, setConnecting] = useState(true)
  const [copied, setCopied] = useState(false)
  /** 剪贴板被拦时把链接摊在界面上让人自己复制，而不是弹一个模态框 */
  const [manualLink, setManualLink] = useState('')
  /** 自动开播抓不到画面（跨源 HTML5 之类）：这局只能靠玩家点一下分享标签页 */
  const [needsManual, setNeedsManual] = useState(false)
  /** 正在弹选择器 / 握手，别让人连点 */
  const [manualBusy, setManualBusy] = useState(false)
  const liveRef = useRef<Broadcast | null>(null)
  /**
   * 弹幕回调走 ref。
   *
   * 开播那个 effect 的依赖列表已经很长了，把一个每次渲染都换新的函数加进去，
   * 结果是父组件一重渲染就重新开播一次 —— 抓屏权限弹窗会再弹一遍。
   */
  const onChatRef = useRef(onChat)
  onChatRef.current = onChat

  // 把推流会话交给播放器（它要用 sendChat 发弹幕）。没在播时传 null，输入框会自己禁用
  const onSessionRef = useRef(onSession)
  onSessionRef.current = onSession
  useEffect(() => {
    onSessionRef.current?.(live)
  }, [live])

  /**
   * 把联机房号报给直播间。房号变了报一次，开播晚于点联机时也要补报 ——
   * 玩家完全可能先点「联机」（那会儿还没开播成功）再等自动开播接上。
   * broadcast 内部记着最后一次报的值，重连 / 重开房之后会自己再报（见 relink）。
   */
  useEffect(() => {
    liveRef.current?.linkNetplay(netplayRoomId)
  }, [netplayRoomId, live])
  /** 分享标签页拿到的流：停播时要把轨停掉，否则浏览器角上那条「正在分享」一直亮着 */
  const tabStreamRef = useRef<MediaStream | null>(null)

  const on = Boolean(handle) && Boolean(gameSlug) && liveEnabled() && active && !hidden

  const stop = useCallback(() => {
    if (tabStreamRef.current) {
      for (const tr of tabStreamRef.current.getTracks()) tr.stop()
      tabStreamRef.current = null
    }
    /*
      ⚠️ 别在这里早退。
      手动分享那条路的 onState('ended') 以前是先把 liveRef 置空再调 stop()，于是这道
      早退闸在**界面复位之前**就返回了：红点继续跳、还显示着断线前的在看人数、
      🔗 复制出去的是一个已经不存在的房间链接。broadcast.stop() 自己有 stopped 守卫，
      重复调是安全的，所以这里改成「有就停，然后无论如何都把界面收干净」。
    */
    liveRef.current?.stop()
    liveRef.current = null
    setLive(null)
    setRoomId('')
    setReconnecting(false)
    setViewers(0)
    // 下播了就让大厅立刻把卡片撤掉，不用等下一轮轮询
    refreshLiveRooms()
  }, [setViewers])

  useEffect(() => {
    if (!on || !handle || !gameSlug) return
    let cancelled = false
    let timer = 0
    // 重新开始尝试就回到「连接中」。已经在播的那一路（依赖变化引起的重跑）不动它
    if (!liveRef.current) setConnecting(true)

    /**
     * @param n     等**画布**等了几轮
     * @param audioN 等**声音**等了几轮
     *
     * ⚠️ 两个计数器必须分开。以前共用一个 n：画布出得晚的引擎（冷启动、大 ROM、慢机器）
     * 走到有 sources 的时候 n 已经 ≥ AUDIO_WAIT_MAX 了，于是「等声音」那一档
     * **一轮都不等**就开播 —— 而 buildStream 是一次性拼好的，开播之后声音节点再出现也接不进去，
     * 这一整场直播就是哑的，主播界面显示「直播中」，没有任何提示，观众以为自己静音了。
     * Ruffle 尤其容易踩：它的 AudioContext 是等第一声才建的。
     */
    const attempt = async (n: number, audioN = 0) => {
      if (cancelled || liveRef.current) return
      const sources = handle.captureSources?.()
      if (!sources || !canBroadcast(sources)) {
        // 运行时压根没有抓画面的能力（webretro），或者明说了永远抓不到（跨源 iframe）：
        // 别让人对着「连接中…」白等九秒，直接落到手动分享那条路
        const hopeless = !handle.captureSources || handle.captureBlocked?.() === true
        // 还没有画面：再等一会儿。等不到就算了 —— 这个引擎大概抓不出画面
        if (!hopeless && n < RETRY_MAX) timer = window.setTimeout(() => void attempt(n + 1, audioN), RETRY_MS)
        else {
          // 等不到就别让按钮永远停在「连接中」上骗人。抓不到画面的游戏（跨源 HTML5、
          // 没有 canvas 的页面）还有一条路：玩家点一下分享标签页
          setConnecting(false)
          setNeedsManual(canShareTab())
        }
        return
      }
      setNeedsManual(false)
      const hasAudio = Boolean(sources.stream?.getAudioTracks().length || (sources.audioNode && sources.audioContext))
      if (!hasAudio && audioN < AUDIO_WAIT_MAX) {
        timer = window.setTimeout(() => void attempt(n, audioN + 1), RETRY_MS)
        return
      }
      try {
        const b = await startBroadcast({
          // 传函数不传对象：画布被运行时换掉（Ruffle 读档 reload）时 broadcast 会重新来要一次。
          // 传上面那个 sources 死对象的话，直播会永远冻在换画布前那一帧（见 captureFeed.ts）
          sources: () => handle.captureSources?.() ?? null,
          meta: { gameSlug, gameName, platform: platform ?? '', title: gameName, hostName: playerName() },
          onViewers: setViewers,
          // 弹幕直接转给播放器：LiveControls 只是工具条，不该拿着消息列表
          onChat: (msg) => onChatRef.current?.(msg),
          onQuality: (q) => setQuality(q.reason),
          onRoom: setRoomId,
          onState: (state) => {
            if (state === 'reconnecting') setReconnecting(true)
            else if (state === 'live') setReconnecting(false)
            else if (state === 'ended' && liveRef.current) {
              // 断线重连由 broadcast.ts 自己扛（接回原房间或重开）。走到 ended 是它放弃了：
              // 收回界面，同时**必须** stop() 放掉抓屏轨和音频节点 —— 以前这里只丢引用，
              // 轨和 PeerConnection 全泄漏，而且这一局再也不会开播
              const b = liveRef.current
              liveRef.current = null
              b.stop()
              setLive(null)
              setRoomId('')
              setReconnecting(false)
              setViewers(0)
              setConnecting(false)
              refreshLiveRooms()
            }
          },
        })
        // 等推流握手的这几秒里玩家可能已经切走了；这时候要把刚建好的连接收掉
        if (cancelled) {
          b.stop()
          return
        }
        liveRef.current = b
        setLive(b)
        setRoomId(b.roomId)
        setConnecting(false)
        // 顺手刷一次大厅列表，主播自己切过去能立刻看见自己
        refreshLiveRooms()
      } catch (e) {
        // 静默：玩家没要求开播，推不出去就当没这回事，别打断他打游戏；
        // 但按钮要落到「未开播」，不然玩家会一直以为还在连
        setConnecting(false)
        console.warn('[live] 自动开播失败', e)
      }
    }

    void attempt(0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      setNeedsManual(false)
      stop()
    }
  }, [on, handle, gameSlug, gameName, platform, stop, setViewers])

  /** 玩家点了「开播」：选本标签页，画面带声音一起推 */
  const startManual = async () => {
    if (!gameSlug || manualBusy || liveRef.current) return
    setManualBusy(true)
    let stream: MediaStream | null = null
    try {
      stream = await shareTab(captureRef?.current ?? null)
      tabStreamRef.current = stream
      const b = await startBroadcast({
        sources: { stream },
        maxBitrate: tabBitrate(stream),
        meta: { gameSlug, gameName, platform: platform ?? '', title: gameName, hostName: playerName() },
        onViewers: setViewers,
        onQuality: (q) => setQuality(q.reason),
        onRoom: setRoomId,
        onState: (state) => {
          if (state === 'reconnecting') setReconnecting(true)
          else if (state === 'live') setReconnecting(false)
          else if (state === 'ended') stop()
        },
      })
      liveRef.current = b
      setLive(b)
      setRoomId(b.roomId)
      refreshLiveRooms()
      // 玩家在浏览器那条「正在分享」上点了停止：跟着下播
      for (const tr of stream.getTracks()) tr.addEventListener('ended', () => stop(), { once: true })
    } catch (e) {
      // 多半是玩家在选择器里点了取消（NotAllowedError）—— 那就当没这回事
      if (stream) for (const tr of stream.getTracks()) tr.stop()
      tabStreamRef.current = null
      console.warn('[live] 分享标签页没成', e)
    } finally {
      setManualBusy(false)
    }
  }

  /*
    原来这里是 `return null`。改成一个布尔量往下带，因为下面要加一个把开关交出去的
    useEffect —— 早退挡在它前面就成了条件调用 hook，React 会当场报错。
    真正的 return null 挪到 JSX 之前。
  */
  const available = Boolean(handle && gameSlug && liveEnabled() && active)

  const toggleHidden = () => {
    // 走标签页分享的这一路，点一下就是开 / 停，不碰「不公开」那个长期选择：
    // 这类游戏的开播本来就是每局手动一次，没有「默认公开」可关
    if (needsManual && !hidden) {
      if (liveRef.current) stop()
      else void startManual()
      return
    }
    const next = !hidden
    setHidden(next)
    writePrivate(next)
    if (next) stop()
  }

  const copy = async () => {
    // gameSlug 的判断以前是靠上面那句 early return 收窄的；它改成 available 之后
    // 这里的类型不再被收窄，得自己判一次
    if (!live || !roomId || !gameSlug) return
    const url = liveLink(gameSlug, roomId)
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板被拦（非 https / 没授权）就把链接显示出来让人手动复制
      setManualLink(url)
    }
  }

  // 「不公开」是玩家的选择，优先于一切；其余按推流自己的进度排
  const phase: Phase = hidden
    ? 'hidden'
    : live
      ? reconnecting
        ? 'reconnecting'
        : 'live'
      : connecting || manualBusy
        ? 'starting'
        : needsManual
          ? 'manual'
          : 'off'

  const label: Record<Phase, string> = {
    live: fmt(tt.liveOn, { n: String(viewers) }),
    reconnecting: t.runtime.liveReconnecting,
    starting: tt.liveStarting,
    off: tt.liveOff,
    manual: tt.liveManual,
    hidden: tt.liveHidden,
  }

  /** 点下去干什么，也随状态变 —— 在播是「停止公开」，不公开是「开始公开」 */
  /** 受限时把原因缀在按钮说明后面 —— 不新增界面元素，但主播一 hover 就知道为什么糊 */
  const qualityNote =
    phase !== 'live' || quality === 'none' || quality === 'other'
      ? ''
      : ` · ${quality === 'cpu' ? t.runtime.liveLimitedCpu : t.runtime.liveLimitedBandwidth}`

  const hint: Record<Phase, string> = {
    live: tt.liveHideTitle,
    reconnecting: tt.liveReconnectingTitle,
    starting: tt.liveStartingTitle,
    off: tt.liveOffTitle,
    manual: tt.liveManualTitle,
    hidden: tt.liveShowTitle,
  }

  /*
    把开关交出去，让弹幕框那边画按钮。

    toggleHidden 每次渲染都是新函数，直接放进依赖数组会让这个 effect 每帧都跑，
    父组件跟着每帧重渲染。所以存一个 ref，对外给的是一个**恒定**的包装函数，
    依赖数组里只留真正会变的那几个值。
  */
  const toggleRef = useRef(toggleHidden)
  toggleRef.current = toggleHidden
  const stableToggle = useCallback(() => toggleRef.current(), [])

  const btnLabel = label[phase]
  const btnHint = hint[phase] + qualityNote
  useEffect(() => {
    if (!onControls) return
    onControls(
      available ? { phase, on: phase === 'live' || phase === 'reconnecting', viewers, label: btnLabel, hint: btnHint, toggle: stableToggle } : null,
    )
    // 卸载时收回：播放器换局、或者这一局不该开播了，按钮不能还留在弹幕框上
    return () => onControls(null)
  }, [onControls, available, phase, viewers, btnLabel, btnHint, stableToggle])

  if (!available) return null
  // 开关已经交给弹幕框了，这边就不画第二份（推流该干的活在上面的 effect 里照跑）
  if (chromeless) return null

  return (
    <div className={cx('flex flex-wrap items-center gap-1.5', className)}>
      <button
        type="button"
        className={cx(STATE_BTN, TONE[phase])}
        onClick={toggleHidden}
        title={hint[phase] + qualityNote}
        aria-label={label[phase]}
        aria-pressed={!hidden}
      >
        <span aria-hidden>📡</span>
        <span aria-hidden className={cx('h-1.5 w-1.5 shrink-0 rounded-full', DOT[phase])} />
        {/*
          窄屏上圆点是唯一的状态标记：工具栏在 320px 上要收在一行里，文字进 title 和
          aria-label（和 EmulatorTools 里状态徽章的处理一致）。只有两样东西值得在窄屏
          上占宽度：在看人数，和重连时的 ⏳ —— 重连中那个人数是断线前的，继续显示就是在骗人。
        */}
        <span aria-hidden className="hidden sm:inline">
          {label[phase]}
        </span>
        {phase === 'live' && (
          <span aria-hidden className="tabular-nums sm:hidden">
            {viewers}
          </span>
        )}
        {phase === 'reconnecting' && (
          <span aria-hidden className="sm:hidden">
            ⏳
          </span>
        )}
      </button>
      {live && (
        <button type="button" className={BTN} onClick={() => void copy()} title={tt.liveLink}>
          {copied ? tt.liveCopied : '🔗'}
        </button>
      )}
      {manualLink && (
        <input
          readOnly
          value={manualLink}
          onFocus={(e) => e.currentTarget.select()}
          className="w-48 rounded-md border border-line bg-transparent px-1.5 py-0.5 text-muted"
        />
      )}
    </div>
  )
}
