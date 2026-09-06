import { useEffect, useState } from 'react'
import { cx } from '@/lib/format'
import { fmt, useT } from '@/services/i18n'
import { actionForCombo } from '@/services/hotkeys'
import {
  bindingOf,
  getPadKeys,
  isPadBindable,
  onPadKeysChange,
  padKeyFor,
  padKeyLabel,
  padKeysCustomized,
  resetPadKeys,
  setPadKey,
  type PadAction,
  type PadBinding,
  type Seat,
} from '@/services/padKeys'
import { actionLabel } from './SaveLoadModal'

/**
 * 红白机（jsnes）的改键面板。挂在播放器工具条 🎮 那个面板里。
 *
 * 只有 jsnes 这一路有 —— 别的运行时里键盘要么是引擎自己管的（EmulatorJS 有它自带的
 * 设置菜单），要么是直通给游戏的（DOS / Flash / J2ME），我们改不了。
 *
 * 交互照搬存档面板那一套（SaveLoadModal）：点牌子 → 按下一个键就是新键位，
 * Esc 取消、Backspace 解绑。玩家在一个地方学会，另一个地方不用重新学。
 */

/** 面板上一格的标签。方向和 A/B/Start/Select 是通用符号，不用翻译 */
function actionRows(t: ReturnType<typeof useT>): Array<[PadAction, string]> {
  return [
    ['up', '↑'],
    ['down', '↓'],
    ['left', '←'],
    ['right', '→'],
    ['a', 'A'],
    ['b', 'B'],
    ['start', 'Start'],
    ['select', 'Select'],
    ['turboA', t.keymap.turboA],
    ['turboB', t.keymap.turboB],
  ]
}

/** 一个键位小牌子。点它就开始等下一个按键 */
function Chip({ code, active, onPick }: { code: string; active: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={cx(
        'min-w-12 shrink-0 rounded-full border px-2 py-0.5 font-mono text-[11px] font-semibold transition-colors',
        active
          ? 'animate-pulse border-brand bg-brand-soft text-brand-hover'
          : code
            ? 'border-line text-muted hover:border-brand hover:text-fg'
            : 'border-dashed border-line-strong text-dim hover:border-brand hover:text-fg',
      )}
    >
      {code ? padKeyLabel(code) : '—'}
    </button>
  )
}

export function NesKeyBinder() {
  const t = useT()
  const tt = t.player.tools
  const [, bump] = useState(0)
  /** 正在等玩家按键的那一格（null = 没在改键） */
  const [binding, setBinding] = useState<PadBinding | null>(null)
  const [note, setNote] = useState('')
  const [showP2, setShowP2] = useState(false)

  useEffect(() => onPadKeysChange(() => bump((n) => n + 1)), [])

  /**
   * 录键位。挂在 window 的**捕获**阶段并且 stopPropagation —— 这一下不能漏给任何人：
   * 漏给存读档快捷键就会一边改键一边把档存了，漏给我们自己的键盘输入
   * （padKeyboard.ts，document 冒泡）就是往游戏里发了个按键。
   */
  useEffect(() => {
    if (!binding) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setBinding(null)
        return
      }
      // Backspace / Delete = 解绑，给一条「这颗键我不要」的路
      if (e.key === 'Backspace' || e.key === 'Delete') {
        setPadKey(binding, '')
        setBinding(null)
        setNote('')
        return
      }
      if (!isPadBindable(e.code)) return

      /*
        和存读档快捷键撞了就**拒绝**，这里不能学「抢过来」那一套。
        理由是它们不在一个层级上：hotkeyBridge 走捕获阶段并 stopPropagation，
        它认领的键根本到不了游戏这边。真让玩家绑上去，得到的是一颗按下去
        只会存档、永远不会让马力欧跳的死键 —— 那比拒绝更难懂。
      */
      const owner = actionForCombo(e.code)
      if (owner) {
        setNote(fmt(tt.padHotkeyTaken, { key: padKeyLabel(e.code), action: actionLabel(owner, tt) }))
        setBinding(null)
        return
      }

      const stolen = setPadKey(binding, e.code)
      setBinding(null)
      // 抢了别的动作的键就说一声：不说的话那个动作会莫名其妙地没了键位
      setNote(stolen ? fmt(tt.padStolen, { action: labelOf(stolen, t) }) : '')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [binding, t, tt])

  const map = getPadKeys()
  const rows = actionRows(t)

  const seatGrid = (seat: Seat) => (
    <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-1">
      {rows.map(([action, label]) => {
        const b = bindingOf(seat, action)
        return (
          <div key={b} className="flex items-center justify-between gap-1">
            <span className="truncate text-muted">{label}</span>
            <Chip code={padKeyFor(b, map)} active={binding === b} onPick={() => setBinding(binding === b ? null : b)} />
          </div>
        )
      })}
    </div>
  )

  return (
    <div className="mt-2 border-t border-line pt-2">
      <p className="font-semibold text-fg">{tt.padRebind}</p>
      <p className="mt-0.5 leading-relaxed text-muted">{tt.padRebindHint}</p>

      <p className="mt-2 font-semibold text-muted">1P</p>
      {seatGrid(0)}

      <button
        type="button"
        onClick={() => setShowP2((v) => !v)}
        className="mt-2 font-semibold text-muted hover:text-brand"
        aria-expanded={showP2}
      >
        2P {showP2 ? '▾' : '▸'}
      </button>
      {showP2 && (
        <>
          {seatGrid(1)}
          <p className="mt-1 leading-relaxed text-muted">{t.keymap.player2Note}</p>
        </>
      )}

      {note && <p className="mt-2 leading-relaxed text-brand-hover">{note}</p>}

      {padKeysCustomized() && (
        <button
          type="button"
          onClick={() => {
            resetPadKeys()
            setBinding(null)
            setNote('')
          }}
          className="mt-2 rounded-md border border-line px-2 py-0.5 font-semibold text-fg hover:border-brand hover:text-brand"
        >
          {tt.padReset}
        </button>
      )}
    </div>
  )
}

/** 「你把 X 的键位抢走了」那句话里的 X。座位 + 动作 */
function labelOf(b: PadBinding, t: ReturnType<typeof useT>): string {
  const [seat, action] = b.split(':')
  const label = actionRows(t).find(([a]) => a === action)?.[1] ?? action
  return `${seat === '1' ? '2P' : '1P'} ${label}`
}
