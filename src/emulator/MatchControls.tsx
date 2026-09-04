/**
 * 联机匹配：把正在玩的这一局开放给别人加入。
 *
 * 位置上它接替了原来的「开播」按钮 —— 开播已经变成自动的（见 LiveControls），
 * 这个位置留给「让别人进来一起玩」这件真正需要玩家点头的事。
 *
 * 关键约束：**不重开游戏**。玩家是玩到一半才想联机的，重新挂载引擎意味着这一局白打。
 * 所以走的是 RuntimeHandle.openNetplay()（见 adapters/emulatorjs.ts），
 * 在正在跑的实例上直接开房。引擎不支持就不显示这个按钮，而不是给一个点了会重开的假入口。
 */
import type { RuntimeHandle } from './types'
import { useT, fmt } from '@/services/i18n'
import { cx } from '@/lib/format'

interface Props {
  handle: RuntimeHandle | null
  /** 这款游戏最多几个人玩；1 就没有联机可言 */
  maxPlayers: number
  /** 平台 + 信令是否具备 P2P 条件（见 p2pPlayable） */
  canPlayOnline: boolean
  /** 已经开着房了 —— 按钮变成「结束联机」 */
  open: boolean
  /** 正在开房的那一小会儿 */
  busy?: boolean
  onOpen: () => void
  onClose: () => void
  className?: string
}

const BTN =
  'inline-flex h-7 items-center justify-center gap-1 rounded-md border border-line px-2 text-muted transition-colors hover:border-brand hover:text-fg disabled:opacity-40'

export function MatchControls({
  handle,
  maxPlayers,
  canPlayOnline,
  open,
  busy,
  onOpen,
  onClose,
  className,
}: Props) {
  const t = useT()
  const tp = t.player

  // 引擎得能在运行中开房。做不到就干脆不显示：给一个点了会把游戏重开的按钮更糟
  if (!handle?.openNetplay || !canPlayOnline || maxPlayers <= 1) return null

  return (
    <div className={cx('flex flex-wrap items-center gap-1.5', className)}>
      <button
        type="button"
        className={cx(BTN, open && 'border-brand bg-brand-soft text-brand-hover')}
        onClick={open ? onClose : onOpen}
        disabled={busy}
        title={open ? tp.matchStopHint : fmt(tp.matchHint, { max: String(maxPlayers) })}
        aria-label={busy ? tp.matchOpening : open ? tp.matchStop : tp.match}
        aria-pressed={open}
      >
        {/*
          手机上只留 🎮 这个符号，文字进 title / aria-label。
          工具栏在 360pt 的屏幕上要收在一行里，「🎮 联机匹配」四个字就是让它折成两行的那根稻草，
          而折出来的那一行是从画面高度里扣的。开房中的那一小会儿照样显示文字 —— 是在变的状态，
          光一个符号说不清。
        */}
        <span aria-hidden>🎮</span>
        <span className={busy ? undefined : 'hidden sm:inline'}>
          {busy ? tp.matchOpening : open ? tp.matchStop : tp.match}
        </span>
      </button>
    </div>
  )
}
