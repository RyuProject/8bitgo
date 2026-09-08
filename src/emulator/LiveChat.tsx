import { useCallback, useEffect, useRef, useState } from 'react'
import type { LiveChatMessage } from '@/services/live'
import { cx } from '@/lib/format'
import { useT } from '@/services/i18n'
import { CHAT_MAX_LENGTH, chatTextLength, sanitizeChatText } from '../../shared/live-chat.js'

/**
 * 直播弹幕。两块东西：
 *
 *   LiveChatLane   飘过画面的那一层（贴在舞台上，pointer-events-none）
 *   LiveChatBar    画面下方的输入框。**只有输入框，没有消息列表**
 *
 * ── 为什么下面那段列表被删掉了（2026-09-07，站长要求「不要历史记录」）──
 * 这块原来是「输入框 + 最近几条」，理由是「飘过去的有气氛但留不住，中途进来的人
 * 看到的是一片空白」。那个理由本身没错，但它把弹幕做成了半个聊天记录：
 * 自己发的话会一条条堆在框里不走，看着更像评论区而不是弹幕。
 * 现在的取舍是**明确选了「飘过就没了」**：气氛优先，留痕一概不要。
 *
 * ⚠️ 连带的三件事，改回去之前先想清楚：
 *   1. **服务端的补历史不再往这儿送了**（见 adapters/liveview.ts 的 watch ack）。
 *      那批消息按设计是**不飞**的（一次性糊满屏没人读得了，见 LiveChatLane 的 seen），
 *      只进列表 —— 列表没了它们就完全看不见，push 进来纯属白传。
 *   2. 所以中途进来的观众**看不到**他进来之前说过的话，这是刻意的，不是 bug。
 *   3. `KEEP` 跟着降到只够喂飘幕（见下）。它现在不是「历史」，是飘幕的输入缓冲。
 *
 * 消息**一律来自服务端**（自己发的那条也是服务端广播回来的），本地不做乐观回显 ——
 * 这样每个人看到的顺序完全一致。代价是自己发完到看见有一个 RTT 的延迟，
 * 但弹幕本来就是「大家一起看同一条时间线」，顺序比那点延迟重要。
 */

/**
 * 本地最多留多少条。
 *
 * 这**不是历史**：唯一的消费者是 LiveChatLane，它靠这个数组的增量找出「哪些是新的」
 * （见那边的 seen）。所以只要比 FLYING_MAX 宽裕一点就够 —— 一批消息挤在同一拍到达时
 * 不至于还没起飞就被挤出数组。留 60 条那是上一版给列表滚动用的，现在纯属白占内存。
 */
const KEEP = 16
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

/* ---------------- 画面下方：只有输入框 ---------------- */

/**
 * 主播侧的一个开关（直播 / 联机共用这个形状）。
 * 文案由上游算好 —— 这里不认 Phase，也不认联机的房间状态。
 */
export interface ChatBarToggle {
  on: boolean
  /** 按钮上的字（窄屏收进 title） */
  label: string
  /** title / aria-label */
  hint: string
  busy?: boolean
  toggle: () => void
}

export function LiveChatBar({
  onSend,
  live,
  match,
  className,
}: {
  /** null = 现在发不了（还没连上 / 已经散场）。这时输入框禁用，而不是让人白打一段字 */
  onSend: ((text: string) => void) | null
  /**
   * 主播侧的两个开关：直播、联机。观众传 undefined，按钮就不画。
   *
   * 为什么放在这一行而不是工具栏：工具栏那排图标在 360pt 上已经要折行了，而这两个
   * 是**主播才用**的东西，跟观众无关；弹幕框本来就是主播的手停留的地方。
   */
  live?: ChatBarToggle | null
  match?: ChatBarToggle | null
  className?: string
}) {
  const t = useT()
  const tt = t.player.tools
  const [text, setText] = useState('')

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
      {/* 只有这一行。消息列表在 2026-09-07 整块删掉了，理由见文件头 */}
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

        {/*
          主播的两个开关。摆在「发送」左边：发送是这一行的主动作，留在最右边，
          位置固定，不会因为开关出现 / 消失而左右横跳。
          窄屏只留符号，文字进 title —— 和工具栏那排按钮同一套处理。
        */}
        {live && <ToggleButton icon="📡" t={live} />}
        {match && <ToggleButton icon="🎮" t={match} />}

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

/** 弹幕框里的开关按钮。亮着 = 开着 */
function ToggleButton({ icon, t }: { icon: string; t: ChatBarToggle }) {
  return (
    <button
      type="button"
      onClick={t.toggle}
      disabled={t.busy}
      title={t.hint}
      aria-label={t.label}
      aria-pressed={t.on}
      className={cx(
        'inline-flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition disabled:opacity-40',
        t.on
          ? 'border-live bg-live/15 text-live'
          : 'border-line text-muted hover:border-brand hover:text-brand',
      )}
    >
      <span aria-hidden>{icon}</span>
      {/* 文字只在 sm 以上出现；正在切换时无论宽窄都显示 —— 是个在变的状态，光一个符号说不清 */}
      <span className={t.busy ? undefined : 'hidden sm:inline'}>{t.label}</span>
    </button>
  )
}
