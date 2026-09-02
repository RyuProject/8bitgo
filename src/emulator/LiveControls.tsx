/**
 * 主播侧的开播按钮（一人玩、多人看）。
 *
 * 为什么单独一个组件而不是塞进 EmulatorTools：那边是「操作正在跑的模拟器」，
 * 这边是「把画面推出去」，两件事的生命周期和失败模式都不一样，混在一起不好收拾。
 *
 * 用在哪：本来就没法联机的平台。GBA 是最典型的 —— 联机靠的是当年的连接线，
 * 浏览器里的核心没有那套东西，所以「一起玩」做不到，「一起看」是能做的那一半。
 * 判据不是写死平台名，而是这个游戏支不支持多人（maxPlayers），
 * 支持联机的游戏应该去开联机房，而不是开直播。
 */
import { useEffect, useRef, useState } from 'react'
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
  className?: string
}

const BTN =
  'inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-md border border-line px-1.5 text-muted transition-colors hover:border-brand hover:text-fg disabled:opacity-40'

export function LiveControls({ handle, gameName, gameSlug, platform, className }: Props) {
  const t = useT()
  const tt = t.player.tools
  const [live, setLive] = useState<Broadcast | null>(null)
  const [viewers, setViewers] = useState(0)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [msg, setMsg] = useState('')
  const liveRef = useRef<Broadcast | null>(null)
  const msgTimer = useRef(0)

  const say = (text: string) => {
    setMsg(text)
    window.clearTimeout(msgTimer.current)
    msgTimer.current = window.setTimeout(() => setMsg(''), 5000)
  }

  // 换游戏 / 离开页面就下播：推的是上一局的画布，留着没有意义
  useEffect(() => {
    return () => {
      liveRef.current?.stop()
      liveRef.current = null
      window.clearTimeout(msgTimer.current)
    }
  }, [handle])

  if (!handle || !gameSlug || !liveEnabled()) return null
  if (!canBroadcast(handle.captureSources?.())) return null

  const toggle = async () => {
    if (busy) return
    if (liveRef.current) {
      liveRef.current.stop()
      liveRef.current = null
      setLive(null)
      setViewers(0)
      // 下播了就让大厅立刻把卡片撤掉，不用等下一轮轮询
      refreshLiveRooms()
      return
    }
    const sources = handle.captureSources?.()
    if (!sources) return
    setBusy(true)
    say(tt.liveStarting)
    try {
      const b = await startBroadcast({
        sources,
        meta: { gameSlug, gameName, platform: platform ?? '', title: gameName, hostName: playerName() },
        onViewers: setViewers,
        onState: (state) => {
          // 信令断了（服务器重启、网络抖动）就把界面收回未开播状态，
          // 别让人对着一个其实已经没在播的按钮以为还在播
          if (state === 'ended' && liveRef.current) {
            liveRef.current = null
            setLive(null)
            setViewers(0)
          }
        },
      })
      liveRef.current = b
      setLive(b)
      // 开播成功就顺手刷一次大厅列表，主播自己切过去能立刻看见自己
      refreshLiveRooms()
      say(tt.liveHint)
    } catch (e) {
      say(fmt(tt.liveFail, { msg: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(false)
    }
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
      say(url)
    }
  }

  return (
    <div className={cx('flex flex-wrap items-center gap-1.5', className)}>
      <button
        type="button"
        className={cx(BTN, live && 'border-live bg-live/15 text-red-300')}
        onClick={() => void toggle()}
        disabled={busy}
        title={live ? tt.stopLive : tt.goLive}
        aria-pressed={Boolean(live)}
      >
        {live ? <span className="tabular-nums">📡 {fmt(tt.liveOn, { n: String(viewers) })}</span> : '📡'}
      </button>
      {live && (
        <button type="button" className={BTN} onClick={() => void copy()} title={tt.liveLink}>
          {copied ? tt.liveCopied : '🔗'}
        </button>
      )}
      {msg && <span className="max-w-[18rem] truncate text-muted">{msg}</span>}
    </div>
  )
}
