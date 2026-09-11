import { useCallback, useEffect, useRef, useState } from 'react'
import { usePrefersReducedMotion } from '@/lib/motion'
import type { LiveChatMessage } from '@/services/live'
import { cx } from '@/lib/format'
import { useT } from '@/services/i18n'
import { CHAT_MAX_LENGTH, chatTextLength, sanitizeChatText } from '../../shared/live-chat.js'
import type { ChatSendResult } from './chatSend'

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
/**
 * 已经飞过的 id 最多记多少个。
 *
 * 这个集合原来**只增不减** —— 一场开六个小时、聊得热闹的直播就是几万个 id 一直挂在内存里。
 * 修剪是安全的：能被重发的只有服务端重连时那一小批，而 useLiveChat 自己也按 id 去重
 * （它留最近 KEEP 条），所以「记得住最近这些」就够了，再往前的那些本来也回不来。
 */
const SEEN_MAX = 200
/**
 * 「动画结束了」的兜底闹钟：动画时长 + 这么久还没收到 animationend 就自己下场。
 *
 * ⚠️ 没有它的话，`onAnimationEnd` 是唯一的下场途径 —— 而那个事件在几种情况下**不会来**：
 * 用户的系统开了「减少动态效果」（下面 reduced 那一支就把动画整个去掉了）、
 * 浏览器扩展或用户样式表把 animation 关了、标签页在后台被冻住之后回来。
 * 那时弹幕会一动不动地糊在画面上，直到被 FLYING_MAX 挤掉 —— 挤不掉的就是永久的。
 */
const ANIM_GRACE_MS = 1500
/** 「减少动态效果」时一条弹幕停留多久（不飘，就静静待着再消失） */
const STATIC_MS = 6000
/** 「没发出去」那句提示挂多久。够读完，又不至于一直杵在输入框下面 */
const NOTICE_MS = 4000

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
   * 开了「减少动态效果」就不飘 —— 横穿画面的文字对前庭敏感的人是明确的触发源。
   *
   * 这一条不是新规矩：顶栏那条新消息走马灯（.im-marquee）早就为此整条关掉了
   * （见 index.css）。而糊在游戏画面上、同时最多 8 条的弹幕比走马灯强烈得多，
   * 却一直没做 —— 2026-09-11 补上。
   *
   * **不能只在 CSS 里 `animation: none`**：那样 animationend 永远不来，弹幕会永久卡在画面上
   * （见 ANIM_GRACE_MS）。所以这里是一整条分支：不飘、同屏只留 LANES 条（静止的要是重叠就没法读了）、
   * 到点自己消失。
   */
  const reduced = usePrefersReducedMotion()
  /** 每条弹幕的兜底闹钟。卸载时要全部清掉，否则闹钟会对着已经没了的组件 setState */
  const timers = useRef(new Map<string, number>())

  const drop = useCallback((id: string) => {
    const timer = timers.current.get(id)
    if (timer) {
      window.clearTimeout(timer)
      timers.current.delete(id)
    }
    setFlying((prev) => (prev.some((x) => x.id === id) ? prev.filter((x) => x.id !== id) : prev))
  }, [])

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer)
      pending.clear()
    }
  }, [])

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
    // 修剪：只保留「还可能再见到」的那些（手上这一批 + 正在飞的），见 SEEN_MAX
    if (seen.current.size > SEEN_MAX) {
      seen.current = new Set([...messages.map((m) => m.id), ...flying.map((m) => m.id)])
    }
    if (!fresh.length) return
    const cap = reduced ? LANES : FLYING_MAX
    setFlying((prev) => {
      const add = fresh.map((m) => {
        lane.current = (lane.current + 1) % LANES
        /*
          id 是 base64url，取两个字符当种子，够把时长摊开一点。
          ⚠️ `|| 0`：id 只有一个字符时 charCodeAt(1) 是 NaN，算出来的 dur 也是 NaN，
          喂进 --danmaku-dur 就是一个非法值 —— 动画时长退回默认、animationend 什么时候来没准。
          服务端给的 id 是 11 个字符，但这里不该依赖那个约定。
        */
        const seed = ((m.id.charCodeAt(0) || 0) + (m.id.charCodeAt(1) || 0)) % 5
        return { ...m, lane: lane.current, dur: 8 + seed * 0.6 }
      })
      // 兜底闹钟：animationend 不来的时候靠它下场（见 ANIM_GRACE_MS）
      for (const m of add) {
        const ms = reduced ? STATIC_MS : m.dur * 1000 + ANIM_GRACE_MS
        timers.current.set(m.id, window.setTimeout(() => drop(m.id), ms))
      }
      const next = [...prev, ...add]
      return next.length > cap ? next.slice(next.length - cap) : next
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
          onAnimationEnd={() => drop(m.id)}
          style={{ top: `${m.lane * 2 + 0.5}rem`, ['--danmaku-dur' as string]: `${m.dur}s` }}
          className={cx(
            'absolute left-0 whitespace-nowrap px-2 text-sm font-semibold',
            // 不飘那一支：贴着左边静静待着，到点由闹钟撤掉（见 reduced 的注释）
            reduced ? 'max-w-full truncate' : '[animation:var(--animate-danmaku)]',
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
  coop,
  className,
}: {
  /**
   * null = 现在发不了（还没连上 / 已经散场）。这时输入框禁用，而不是让人白打一段字。
   *
   * 返回 Promise 的话，兑现值就是服务端的答复（见 chatSend.ts）：
   * 'too-fast' / 'dropped' 会在这一行下面显示一句提示。
   * **这一条是必须的**：弹幕不做本地回显，被丢掉的那条和「没人说话」长得一模一样。
   */
  onSend: ((text: string) => void | Promise<ChatSendResult>) | null
  /**
   * 主播侧的两个开关：直播、联机。观众传 undefined，按钮就不画。
   *
   * 为什么放在这一行而不是工具栏：工具栏那排图标在 360pt 上已经要折行了，而这两个
   * 是**主播才用**的东西，跟观众无关；弹幕框本来就是主播的手停留的地方。
   */
  live?: ChatBarToggle | null
  match?: ChatBarToggle | null
  /**
   * 「上场当 2P」（见 coopSeat.ts）。**这一颗两边都有**，只是语义相反：
   * 主播那边是「让 TA 上场 / 请 TA 下场」，观众那边是「我要上场 / 我下场」。
   * 文案由上游算好，这里照旧只管画。
   */
  coop?: ChatBarToggle | null
  className?: string
}) {
  const t = useT()
  const tt = t.player.tools
  const [text, setText] = useState('')
  /**
   * 上一条没发出去时的提示。**一定要有** —— 服务端会因为限流 / 房间散了拒收，
   * 而弹幕没有本地回显，不说一声的话用户看到的就是「我发了，但什么都没发生」。
   */
  const [notice, setNotice] = useState<Exclude<ChatSendResult, null>>()
  /** 提示自己消失的闹钟。换一条新的要把旧的撤掉，否则上一条的计时会提前关掉这一条 */
  const noticeTimer = useRef(0)
  /**
   * 组件还在不在。服务端的答复可能在**卸载之后**才回来（换一局、进沉浸模式都会卸掉这一行），
   * 那时再去 setState、再上一个 4 秒的闹钟，纯属对着一个不存在的组件干活。
   */
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      window.clearTimeout(noticeTimer.current)
    }
  }, [])

  const showNotice = (r: Exclude<ChatSendResult, null>) => {
    setNotice(r)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(undefined), NOTICE_MS)
  }

  const send = () => {
    const clean = sanitizeChatText(text)
    if (!clean || !onSend) return
    setNotice(undefined)
    window.clearTimeout(noticeTimer.current)
    /*
      **先清空输入框**（乐观），失败了再把字还回去。反过来（等服务端答复再清空）的话，
      正常那一条要等一个 RTT 才空，手快的人会以为没发出去、再按一次。

      ⚠️ 还字**只在输入框仍然是空的时候**。用户在这几百毫秒里已经开始打下一句了的话，
      拿旧文本盖掉他正在打的字是更糟的一种「帮忙」—— 站内消息那边踩过这个坑
      （见 components/im/ImPanel.tsx 里 send 的注释）。
    */
    setText('')
    const r = onSend(clean)
    if (!r || typeof r.then !== 'function') return
    void r.then((outcome) => {
      if (!outcome || !alive.current) return
      showNotice(outcome)
      setText((cur) => (cur ? cur : clean))
    })
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
          几个开关。摆在「发送」左边：发送是这一行的主动作，留在最右边，
          位置固定，不会因为开关出现 / 消失而左右横跳。
          窄屏只留符号，文字进 title —— 和工具栏那排按钮同一套处理。
        */}
        {live && <ToggleButton icon="📡" t={live} />}
        {match && <ToggleButton icon="🎮" t={match} />}
        {/* 「上场当 2P」。👥 两边都可能出现，见上面 coop 的注释 */}
        {coop && <ToggleButton icon="👥" t={coop} />}

        <button
          type="button"
          onClick={send}
          disabled={!onSend || !sanitizeChatText(text)}
          className="shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-xs font-semibold text-fg transition hover:border-brand hover:text-brand disabled:opacity-40 disabled:hover:border-line disabled:hover:text-fg"
        >
          {tt.chatSend}
        </button>
      </div>

      {/*
        「这条没发出去」。role="status" 而不是 alert：读屏在原地播报，焦点不动
        —— 用户多半正要接着打下一句。
      */}
      {notice && (
        <p role="status" className="px-3 pb-2 text-[11px] leading-relaxed text-live">
          {notice === 'too-fast' ? tt.chatTooFast : tt.chatDropped}
        </p>
      )}
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
