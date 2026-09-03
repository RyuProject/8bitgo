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
import { useCallback, useEffect, useRef, useState } from 'react'
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
   * 这一局该不该自动开播。联机房里的房主传 false ——
   * 房间本身就带观众席，再推一路直播是白白多占一份上行。
   */
  active?: boolean
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
 *   hidden        玩家自己关掉了公开
 *
 * off 和 starting 必须分开：它们以前长得一模一样（都是一个光板 📡），
 * 而对玩家来说「再等等」和「这局没人看得到」是两件完全不同的事。
 */
type Phase = 'starting' | 'live' | 'reconnecting' | 'off' | 'hidden'

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
  hidden: 'border-line text-dim hover:border-brand hover:text-fg',
}

/** 圆点跟大厅卡片上的 LIVE 标记用同一套语言（见 RoomCard）：红色跳动 = 真的在播 */
const DOT: Record<Phase, string> = {
  live: 'animate-pulse bg-live',
  reconnecting: 'animate-pulse bg-coin',
  starting: 'animate-pulse bg-coin',
  off: 'bg-dim',
  hidden: 'bg-dim',
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

export function LiveControls({ handle, gameName, gameSlug, platform, active = true, className }: Props) {
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
  const liveRef = useRef<Broadcast | null>(null)

  const on = Boolean(handle) && Boolean(gameSlug) && liveEnabled() && active && !hidden

  const stop = useCallback(() => {
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
        // 还没有画面：再等一会儿。等不到就算了 —— 这个引擎大概抓不出画面
        if (n < RETRY_MAX) timer = window.setTimeout(() => void attempt(n + 1), RETRY_MS)
        // 等不到就别让按钮永远停在「连接中」上骗人，落到「未开播」
        else setConnecting(false)
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
      stop()
    }
  }, [on, handle, gameSlug, gameName, platform, stop])

  if (!handle || !gameSlug || !liveEnabled() || !active) return null

  const toggleHidden = () => {
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
  const phase: Phase = hidden ? 'hidden' : live ? (reconnecting ? 'reconnecting' : 'live') : connecting ? 'starting' : 'off'

  const label: Record<Phase, string> = {
    live: fmt(tt.liveOn, { n: String(viewers) }),
    reconnecting: t.runtime.liveReconnecting,
    starting: tt.liveStarting,
    off: tt.liveOff,
    hidden: tt.liveHidden,
  }

  /** 点下去干什么，也随状态变 —— 在播是「停止公开」，不公开是「开始公开」 */
  const hint: Record<Phase, string> = {
    live: tt.liveHideTitle,
    reconnecting: tt.liveReconnectingTitle,
    starting: tt.liveStartingTitle,
    off: tt.liveOffTitle,
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
