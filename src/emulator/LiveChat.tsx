import { useCallback, useEffect, useRef, useState } from 'react'
import type { LiveChatMessage } from '@/services/live'
import { cx } from '@/lib/format'
import { useT } from '@/services/i18n'
import { CHAT_MAX_LENGTH, chatTextLength, sanitizeChatText } from '../../shared/live-chat.js'

/**
 * 直播弹幕。两块东西共用同一份消息流：
 *
 *   LiveChatLane   飘过画面的那一层（贴在舞台上，pointer-events-none）
 *   LiveChatBar    画面下方的输入框 + 最近几条
 *
 * 为什么两块都要：飘过去的有气氛但留不住，中途进来的人看到的是一片空白；
 * 下面那一小段是「刚才说了什么」的唯一去处。数据是同一份，只是渲染两次。
 *
 * 消息**一律来自服务端**（自己发的那条也是服务端广播回来的），本地不做乐观回显 ——
 * 这样每个人看到的顺序完全一致。代价是自己发完到看见有一个 RTT 的延迟，
 * 但弹幕本来就是「大家一起看同一条时间线」，顺序比那点延迟重要。
 */

/** 本地最多留多少条。比服务端的历史多一些，够下面那段列表滚 */
const KEEP = 60
/** 画面上同时最多飘几条。再多就糊成一片，谁也读不了 */
const FLYING_MAX = 8
/** 弹幕分几条轨道 */
const LANES = 4

export interface LiveChatState {
  messages: LiveChatMessage[]
  push: (msg: LiveChatMessage) => void
  clear: () => void
}

/**
 * 消息流。放在播放器那一层拿着 —— 主播和观众收弹幕的入口不是同一个
 * （前者是 Broadcast.onChat，后者是 LiveSession.onChat），但显示的东西是一样的。
 */
export function useLiveChat(): LiveChatState {
  const [messages, setMessages] = useState<LiveChatMessage[]>([])
  const push = useCallback((msg: LiveChatMessage) => {
    setMessages((prev) => {
      // 服务端重连、或者补历史时可能重发同一条，按 id 去重
      if (prev.some((m) => m.id === msg.id)) return prev
      const next = [...prev, msg]
      return next.length > KEEP ? next.slice(next.length - KEEP) : next
    })
  }, [])
  const clear = useCallback(() => setMessages([]), [])
  return { messages, push, clear }
}

/** 一条弹幕的署名。登录用昵称，游客用服务端发的号 —— 两者都不是客户端说了算的 */
function useAuthorLabel() {
  const t = useT()
  return (msg: LiveChatMessage) => msg.name || `${t.player.tools.chatGuest} ${msg.guest ?? ''}`.trim()
}

/* ---------------- 飘过画面的那一层 ---------------- */

interface Flying extends LiveChatMessage {
  /** 第几条轨道 */
  lane: number
  /** 这一条飘多久（秒）。按 id 派生，不用随机数 —— 重渲染时不能变，否则动画会重来 */
  dur: number
}

export function LiveChatLane({ messages, className }: { messages: LiveChatMessage[]; className?: string }) {
  const authorLabel = useAuthorLabel()
  const boxRef = useRef<HTMLDivElement>(null)
  const [flying, setFlying] = useState<Flying[]>([])
  const seen = useRef(new Set<string>())
  const lane = useRef(0)

  /**
   * 只让**新**消息起飞。
   *
   * 补历史那一批（中途进来时 watch 的 ack 给的）不该一次性糊满画面 ——
   * 那些是「刚才说的」，属于下面那段列表，不属于此刻的画面。
   * 第一次渲染时把已有的全部记成看过，之后新增的才飞。
   */
  useEffect(() => {
    const fresh = messages.filter((m) => !seen.current.has(m.id))
    for (const m of fresh) seen.current.add(m.id)
    if (!fresh.length) return
    setFlying((prev) => {
      const add = fresh.map((m) => {
        lane.current = (lane.current + 1) % LANES
        // id 是 base64url，取两个字符当种子，够把时长摊开一点
        const seed = (m.id.charCodeAt(0) + m.id.charCodeAt(1)) % 5
        return { ...m, lane: lane.current, dur: 8 + seed * 0.6 }
      })
      const next = [...prev, ...add]
      return next.length > FLYING_MAX ? next.slice(next.length - FLYING_MAX) : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages])

  /**
   * 舞台有多宽 —— 弹幕的起点在右边界外，而 translateX 的百分比是相对**自身**宽度的，
   * 拿它做不出「从容器右边进来」。所以量一次宽度，用 px 喂给 --danmaku-span。
   */
  useEffect(() => {
    const el = boxRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const apply = () => el.style.setProperty('--danmaku-span', `${el.clientWidth}px`)
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div
      ref={boxRef}
      className={cx('pointer-events-none absolute inset-0 overflow-hidden', className)}
      aria-hidden
    >
      {flying.map((m) => (
        <span
          key={m.id}
          onAnimationEnd={() => setFlying((prev) => prev.filter((x) => x.id !== m.id))}
          style={{ top: `${m.lane * 2 + 0.5}rem`, ['--danmaku-dur' as string]: `${m.dur}s` }}
          className={cx(
            'absolute left-0 whitespace-nowrap px-2 text-sm font-semibold [animation:var(--animate-danmaku)]',
            // 描边而不是加底色：底色会挡住游戏画面，而弹幕本来就该让位给画面
            '[text-shadow:0_1px_2px_rgba(0,0,0,.9),0_0_1px_rgba(0,0,0,.9)]',
            m.host ? 'text-coin' : 'text-white',
          )}
        >
          {m.host && '★ '}
          <span className="opacity-80">{authorLabel(m)}</span>
          <span className="mx-1 opacity-50">:</span>
          {m.text}
        </span>
      ))}
    </div>
  )
}

/* ---------------- 画面下方：输入框 + 最近几条 ---------------- */

export function LiveChatBar({
  messages,
  onSend,
  className,
}: {
  messages: LiveChatMessage[]
  /** null = 现在发不了（还没连上 / 已经散场）。这时输入框禁用，而不是让人白打一段字 */
  onSend: ((text: string) => void) | null
  className?: string
}) {
  const t = useT()
  const tt = t.player.tools
  const authorLabel = useAuthorLabel()
  const [text, setText] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  // 新消息进来自动贴底。只在本来就在底部时才滚 —— 用户往上翻看历史时不该被拽回来
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (atBottom) el.scrollTop = el.scrollHeight
  }, [messages])

  const send = () => {
    const clean = sanitizeChatText(text)
    if (!clean || !onSend) return
    onSend(clean)
    setText('')
  }

  const used = chatTextLength(text)
  const remaining = CHAT_MAX_LENGTH - used

  return (
    <div className={cx('rounded-xl border border-line bg-surface', className)}>
      <div ref={listRef} className="max-h-28 space-y-0.5 overflow-y-auto px-3 pt-2 text-xs">
        {messages.length === 0 ? (
          <p className="py-1 text-dim">{tt.chatEmpty}</p>
        ) : (
          messages.map((m) => (
            <p key={m.id} className="leading-relaxed">
              <span className={cx('font-semibold', m.host ? 'text-coin' : 'text-muted')}>
                {m.host && '★ '}
                {authorLabel(m)}
              </span>
              <span className="mx-1 text-dim">:</span>
              <span className="text-fg">{m.text}</span>
            </p>
          ))
        )}
      </div>

      <div className="flex items-center gap-2 px-3 py-2">
        <input
          value={text}
          onChange={(e) => {
            // 按码点截断，和服务端同一套算法（shared/live-chat.js）
            const v = e.target.value
            setText(chatTextLength(v) > CHAT_MAX_LENGTH ? Array.from(v).slice(0, CHAT_MAX_LENGTH).join('') : v)
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            // 输入法组字中途的回车是「上屏」，不是「发送」
            if (e.nativeEvent.isComposing) return
            send()
          }}
          disabled={!onSend}
          placeholder={tt.chatPlaceholder}
          className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-fg placeholder:text-dim focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:opacity-50"
        />
        {remaining < 20 && <span className="shrink-0 text-[11px] tabular-nums text-dim">{remaining}</span>}
        <button
          type="button"
          onClick={send}
          disabled={!onSend || !sanitizeChatText(text)}
          className="shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-xs font-semibold text-fg transition hover:border-brand hover:text-brand disabled:opacity-40 disabled:hover:border-line disabled:hover:text-fg"
        >
          {tt.chatSend}
        </button>
      </div>
    </div>
  )
}
