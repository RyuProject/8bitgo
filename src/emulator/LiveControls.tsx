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
 * 失败是静默的：玩家没要求开播，推不出去也不该拿一行红字打断他打游戏。
 * 具体原因写进 console，界面上只是没有直播标记。
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

const BTN =
  'inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-md border border-line px-1.5 text-muted transition-colors hover:border-brand hover:text-fg disabled:opacity-40'

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
  const [viewers, setViewers] = useState(0)
  const [hidden, setHidden] = useState(readPrivate)
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
    setViewers(0)
    // 下播了就让大厅立刻把卡片撤掉，不用等下一轮轮询
    refreshLiveRooms()
  }, [])

  useEffect(() => {
    if (!on || !handle || !gameSlug) return
    let cancelled = false
    let timer = 0

    const attempt = async (n: number) => {
      if (cancelled || liveRef.current) return
      const sources = handle.captureSources?.()
      if (!sources || !canBroadcast(sources)) {
        // 还没有画面：再等一会儿。等不到就算了 —— 这个引擎大概抓不出画面
        if (n < RETRY_MAX) timer = window.setTimeout(() => void attempt(n + 1), RETRY_MS)
        return
      }
      try {
        const b = await startBroadcast({
          sources,
          meta: { gameSlug, gameName, platform: platform ?? '', title: gameName, hostName: playerName() },
          onViewers: setViewers,
          onState: (state) => {
            // 信令断了（服务器重启、网络抖动）就把界面收回未开播状态，
            // 别让人对着一个其实已经没在播的标记以为还在播
            if (state === 'ended' && liveRef.current) {
              liveRef.current = null
              setLive(null)
              setViewers(0)
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
        // 顺手刷一次大厅列表，主播自己切过去能立刻看见自己
        refreshLiveRooms()
      } catch (e) {
        // 静默：玩家没要求开播，推不出去就当没这回事，别打断他打游戏
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
    if (!live) return
    const url = liveLink(gameSlug, live.roomId)
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板被拦（非 https / 没授权）就把链接显示出来让人手动复制
      setManualLink(url)
    }
  }

  return (
    <div className={cx('flex flex-wrap items-center gap-1.5', className)}>
      <button
        type="button"
        className={cx(BTN, live && 'border-live bg-live/15 text-red-300')}
        onClick={toggleHidden}
        title={hidden ? tt.liveShowTitle : tt.liveHideTitle}
        aria-pressed={!hidden}
      >
        {live ? (
          <span className="tabular-nums">📡 {fmt(tt.liveOn, { n: String(viewers) })}</span>
        ) : hidden ? (
          <span className="opacity-60">📡 {tt.liveHidden}</span>
        ) : (
          '📡'
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
