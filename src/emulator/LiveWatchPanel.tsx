import { useEffect, useState } from 'react'
import { cx } from '@/lib/format'
import { useT } from '@/services/i18n'
import type { LiveChatMessage, LiveViewerEntry } from '@/services/live'
import { watchNetplayRoom, type NetplayRoom } from '@/services/netplay'
import { LiveChatBar, LiveChatHistory } from './LiveChat'
import type { ChatBarToggle } from './LiveChat'
import type { ChatSendResult } from './chatSend'

/**
 * 观众看直播时右栏那块面板（2026-09-11，站长指定的观看 UI）。
 *
 * 三段，自上而下：**谁在这儿 → 发弹幕 → 弹幕记录**。
 *
 * ── 为什么它不在 EmulatorPlayer 的画面下方 ────────────────
 * 观众端整页走的是 8/4 两栏（见 GameDetailPage 的 watchLayout）：播放器在左 8 列、
 * 这块面板在右 4 列、和播放器顶边齐。站长的原话是「观众端清除最右侧的内容
 * （平台卡 / 评分 / 评论），然后右侧放现在观看的联机+观众，下面放弹幕，
 * 然后弹幕历史记录」。
 *
 * ⚠️ 这个组件由 **EmulatorPlayer 通过 portal** 渲染进右栏，而不是由 GameDetailPage 自己画。
 * 原因是它要的四样东西（名单、人数、消息、发送句柄）全在 EmulatorPlayer 的 state 里，
 * 而把那些 state 提上去意味着重构整个播放器。portal 只搬 DOM 位置、不动组件树，
 * 播放器一个像素都不会被卸载重建 —— 这一点在直播场景下是硬要求（重建 = 断流）。
 *
 * ⚠️ 主播端**不画这块**。主播要的是画面，不是聊天室；他的输入框仍在画面下方。
 */

/** 联机名单最多列几个。房间上限本来就不大，这只是防一手异常数据把面板撑爆 */
const MATCH_MAX = 12

/**
 * 一行「谁」。名字拿不到时（服务端还在异步解析，见 live.js 的 resolveViewerName）
 * 退回「观众」这个占位 —— **不要画成空白行**，那看着像掉了数据。
 */
function Who({ label, tone }: { label: string; tone?: 'host' | 'player' }) {
  return (
    <li className="flex items-center gap-1.5 truncate text-sm">
      <span
        aria-hidden
        className={cx('h-1.5 w-1.5 shrink-0 rounded-full', tone === 'host' ? 'bg-live' : tone === 'player' ? 'bg-brand' : 'bg-line')}
      />
      <span className={cx('truncate', tone ? 'font-semibold text-fg' : 'text-muted')}>{label}</span>
    </li>
  )
}

export function LiveWatchPanel({
  hostName,
  viewers,
  roster,
  netplayRoomId,
  messages,
  onSend,
  coop,
  className,
}: {
  hostName?: string | null
  viewers: number
  /** 观众名单。服务端派生的署名，可能还没解析完（空对象），见 services/live 的 LiveViewerEntry */
  roster: LiveViewerEntry[]
  /** 主播同时开着的联机房号。null = 这一局没有联机，那一段整块不画 */
  netplayRoomId: string | null
  messages: LiveChatMessage[]
  /** null = 现在发不了（还没连上 / 已经散场）。LiveChatBar 据此禁用输入框 */
  onSend: ((text: string) => void | Promise<ChatSendResult>) | null
  /** 「我要上场当 2P」。没有 2P 位时上游传 null，按钮就不画 */
  coop?: ChatBarToggle | null
  className?: string
}) {
  const t = useT()
  const tt = t.player.tools
  const [match, setMatch] = useState<NetplayRoom | null>(null)

  /*
    联机名单。**只在主播真的开了联机房时才订阅** —— 绝大多数直播没有联机房，
    无条件订阅等于给每个观众页多开一条 SSE（每 IP 的并发流是有上限的，见 sseGuard）。
  */
  useEffect(() => {
    setMatch(null)
    if (!netplayRoomId) return
    return watchNetplayRoom(netplayRoomId, {
      onRoom: setMatch,
      onGone: () => setMatch(null),
    })
  }, [netplayRoomId])

  const players = (match?.members ?? []).filter((m) => m.role !== 'spectator').slice(0, MATCH_MAX)

  return (
    <div className={cx('flex flex-col gap-4', className)}>
      {/* 一、谁在这儿 */}
      <div className="rounded-2xl border border-line bg-surface p-4">
        <ul className="space-y-1.5">
          {hostName && <Who label={`${hostName} · ${tt.watchHost}`} tone="host" />}
          {players.map((m, i) => (
            <Who key={`p${i}-${m.nickname}`} label={`${m.nickname} · ${tt.watchMatch}`} tone="player" />
          ))}
        </ul>

        <p className="mt-3 mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-dim">
          {tt.watchViewers} · {viewers}
        </p>
        <ul className="space-y-1">
          {roster.map((v, i) => (
            /*
              key 用 index：名单是**全量重发**的（每次 viewers 事件整份换掉），
              而且服务端刻意不发 socket.id（发了等于把「谁是谁」的句柄散给房间里所有人，
              见 live.js 的 viewerList）。没有稳定 id 可用，也不需要 —— 这是一段纯展示的短列表。
            */
            <Who key={i} label={v.name || (v.guest ? `${tt.chatGuest} ${v.guest}` : tt.watchAnon)} />
          ))}
        </ul>
      </div>

      {/* 二、发弹幕 */}
      <LiveChatBar onSend={onSend} coop={coop} />

      {/*
        三、弹幕记录。

        高度写死在**这一段自己身上**（max-h），不靠 flex-1 从父级分：
        这块面板的父级是详情页的右栏，它的高度由页面内容决定、不是一个定高容器 ——
        靠 flex-1 的话在 lg 以下会一路长到没有上限，弹幕多了整页被它撑爆。
      */}
      <LiveChatHistory messages={messages} className="max-h-[28rem] min-h-[12rem]" />
    </div>
  )
}
