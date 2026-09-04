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
import { liveEnabled, liveLink, refreshLiveRooms } from '@/services/live'
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

export function LiveControls({ handle, gameName, gameSlug, platform, active = true, netplayRoomId = null, captureRef, className }: Props) {
  const t = useT()
  const tt = t.player.tools
  const [live, setLive] = useState<Broadcast | null>(null)
  /** 房间号单独存：重连后接不回原房间时会换（见 broadcast.ts 文件头），Broadcast 对象本身不变 */
  const [roomId, setRoomId] = useState('')
  /** 信令断了、正在重连。画面多半还在流（WebRTC 是点对点的），所以只是标记变灰，不撤掉 */
  const [reconnecting, setReconnecting] = useState(false)
  const [viewers, setViewers] = useState(0)
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
    if (!liveRef.current) return
    liveRef.current.stop()
    liveRef.current = null
    setLive(null)
    setRoomId('')
    setReconnecting(false)
    setViewers(0)
    // 下播了就让大厅立刻把卡片撤掉，不用等下一轮轮询
    refreshLiveRooms()
  }, [])

  useEffect(() => {
    if (!on || !handle || !gameSlug) return
    let cancelled = false
    let timer = 0
    // 重新开始尝试就回到「连接中」。已经在播的那一路（依赖变化引起的重跑）不动它
    if (!liveRef.current) setConnecting(true)

    const attempt = async (n: number) => {
      if (cancelled || liveRef.current) return
      const sources = handle.captureSources?.()
      if (!sources || !canBroadcast(sources)) {
        // 运行时压根没有抓画面的能力（webretro），或者明说了永远抓不到（跨源 iframe）：
        // 别让人对着「连接中…」白等九秒，直接落到手动分享那条路
        const hopeless = !handle.captureSources || handle.captureBlocked?.() === true
        // 还没有画面：再等一会儿。等不到就算了 —— 这个引擎大概抓不出画面
        if (!hopeless && n < RETRY_MAX) timer = window.setTimeout(() => void attempt(n + 1), RETRY_MS)
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
      if (!hasAudio && n < AUDIO_WAIT_MAX) {
        timer = window.setTimeout(() => void attempt(n + 1), RETRY_MS)
        return
      }
      try {
        const b = await startBroadcast({
          sources,
          meta: { gameSlug, gameName, platform: platform ?? '', title: gameName, hostName: playerName() },
          onViewers: setViewers,
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
  }, [on, handle, gameSlug, gameName, platform, stop])

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
        onRoom: setRoomId,
        onState: (state) => {
          if (state === 'reconnecting') setReconnecting(true)
          else if (state === 'live') setReconnecting(false)
          else if (state === 'ended' && liveRef.current) {
            liveRef.current = null
            stop()
          }
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

  if (!handle || !gameSlug || !liveEnabled() || !active) return null

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
    if (!live || !roomId) return
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
  const hint: Record<Phase, string> = {
    live: tt.liveHideTitle,
    reconnecting: tt.liveReconnectingTitle,
    starting: tt.liveStartingTitle,
    off: tt.liveOffTitle,
    manual: tt.liveManualTitle,
    hidden: tt.liveShowTitle,
  }

  return (
    <div className={cx('flex flex-wrap items-center gap-1.5', className)}>
      <button
        type="button"
        className={cx(STATE_BTN, TONE[phase])}
        onClick={toggleHidden}
        title={hint[phase]}
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
