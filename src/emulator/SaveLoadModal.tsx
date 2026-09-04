/**
 * 保存 / 加载存档的面板。
 *
 * ── 为什么是一个弹窗而不是工具栏上的小气泡 ─────────────────
 * 存档有**三个去处**（云端 / 这个浏览器 / 文件），每个去处都既能存又能读 ——
 * 六个动作塞进工具栏的一个下拉里，玩家得先猜哪个按钮对应哪儿。摆成三张卡、
 * 每张卡自己带「加载」和「保存」，看一眼就知道东西在哪儿、能对它做什么。
 *
 * ── 顺序是有意的 ───────────────────────────────────────────
 * 云存档排第一：它是唯一「换台设备还在」的选项，也是大多数人真正想要的。
 * 但**没登录时它是灰的**，并且直接在标题旁边写「需要登录」——
 * 灰一个按钮却不说为什么，玩家只会以为坏了。
 *
 * 这里不替玩家做默认选择：哪一张卡都不预选、不加粗。原来的行为是
 * 「登录了就自动上云」，玩家从没被问过，而存档是他自己的东西。
 */
import { useEffect, useRef, useState } from 'react'
import { cx } from '@/lib/format'
import { useT, fmt } from '@/services/i18n'
import type { SaveTarget } from '@/services/saveTarget'
import {
  comboLabel,
  comboOf,
  getHotkeys,
  isBindable,
  resetHotkeys,
  setHotkey,
  type HotkeyAction,
} from '@/services/hotkeys'

export interface SaveLoadCard {
  id: SaveTarget
  title: string
  desc: string
  /** 能不能用；不能用时给一句为什么（画在标题旁边的小牌子上） */
  disabled?: boolean
  disabledNote?: string
  /** 这张卡有没有可读的东西。云端 / 本地没有存档时「加载」就该是灰的 */
  canLoad?: boolean
  /** 这张卡对应的两个快捷键动作 */
  saveKey: HotkeyAction
  loadKey: HotkeyAction
  onSave: () => void
  onLoad: () => void
}

interface Props {
  cards: SaveLoadCard[]
  onClose: () => void
  /** 正在存 / 正在读，按钮上要有反馈，也要防连点 */
  busy?: boolean
}

type ToolsT = ReturnType<typeof useT>['player']['tools']

/** 动作的中文名，只用在「你把 X 的快捷键抢走了」那句话里 */
function actionLabel(a: HotkeyAction, tt: ToolsT): string {
  const [what, where] = a.split(':')
  const place = where === 'cloud' ? tt.saveCardCloud : where === 'local' ? tt.saveCardLocal : tt.saveCardFile
  return `${place} · ${what === 'save' ? tt.save : tt.load}`
}

/** 一个快捷键小牌子。点它就开始等下一个按键 */
function KeyChip({
  combo,
  active,
  label,
  onPick,
}: {
  combo: string
  active: boolean
  label: string
  onPick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      title={label}
      className={cx(
        'rounded-full border px-2.5 py-1 font-mono text-[11px] font-semibold transition-colors',
        active
          ? 'animate-pulse border-brand bg-brand-soft text-brand-hover'
          : combo
            ? 'border-line text-muted hover:border-brand hover:text-fg'
            : 'border-dashed border-line-strong text-dim hover:border-brand hover:text-fg',
      )}
    >
      {combo ? comboLabel(combo) : '—'}
    </button>
  )
}

export function SaveLoadModal({ cards, onClose, busy }: Props) {
  const t = useT()
  const tt = t.player.tools
  const boxRef = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(false)
  const [keys, setKeys] = useState(() => getHotkeys())
  /** 正在等玩家按键的那个动作（null = 没在改键） */
  const [binding, setBinding] = useState<HotkeyAction | null>(null)
  const [note, setNote] = useState('')

  /**
   * 改键：按下的下一个键就是新键位。
   *
   * 挂在 window 的**捕获**阶段并且 stopPropagation —— 改键的时候这一下不能漏给别人：
   * 漏给快捷键系统就会一边改键一边把档存了，漏给模拟器就是往游戏里发了个按键。
   */
  useEffect(() => {
    if (!binding) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') return setBinding(null)
      // Backspace / Delete = 解绑，给一条「我不要快捷键」的路
      if (e.key === 'Backspace' || e.key === 'Delete') {
        setHotkey(binding, '')
        setKeys(getHotkeys())
        setBinding(null)
        setNote('')
        return
      }
      const combo = comboOf({ ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, code: e.code })
      // 只按住修饰键不算 —— 等他把真正的键按下去
      if (!combo || !isBindable(combo)) return
      const stolen = setHotkey(binding, combo)
      setKeys(getHotkeys())
      setBinding(null)
      // 抢了别人的键位就说一声：不说的话另一个动作会莫名其妙地没了快捷键
      setNote(stolen ? fmt(tt.hotkeyStolen, { action: actionLabel(stolen, tt) }) : '')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [binding, tt])

  // Esc 关掉。弹窗盖在游戏画面上，玩家的手本来就在键盘上，这是他第一个会按的键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // 打开时把焦点收进来：不收的话键盘还在模拟器身上，按方向键是在玩游戏而不是在选按钮
  useEffect(() => {
    setMounted(true)
    boxRef.current?.focus()
  }, [])

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm"
      // 点遮罩关掉；点卡片内部不该关，所以只认落在遮罩自己身上的那一下
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label={tt.saveLoadTitle}
    >
      <div
        ref={boxRef}
        tabIndex={-1}
        className={cx(
          'w-full max-w-lg rounded-2xl border border-line bg-surface p-5 shadow-2xl outline-none transition duration-150 sm:p-6',
          mounted ? 'scale-100 opacity-100' : 'scale-95 opacity-0',
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-xl font-extrabold tracking-tight">{tt.saveLoadTitle}</h2>
          <button
            type="button"
            onClick={onClose}
            className="-m-1 rounded-lg p-1 text-muted transition-colors hover:bg-black/5 hover:text-fg"
            aria-label={tt.saveLoadClose}
          >
            ✕
          </button>
        </div>

        <div className="mt-5 space-y-3">
          {cards.map((c) => (
            <div
              key={c.id}
              className={cx(
                'rounded-xl border p-4 transition-colors',
                // 不可用的那张压暗，但**留在原位**：把它藏掉玩家就不知道有云存档这回事
                c.disabled ? 'border-line bg-surface-2/60' : 'border-line bg-surface hover:border-brand/50',
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <h3 className={cx('text-base font-bold', c.disabled && 'text-muted')}>{c.title}</h3>
                {c.disabled && c.disabledNote && (
                  <span className="rounded-full border border-line px-2 py-0.5 text-[11px] font-semibold text-muted">
                    {c.disabledNote}
                  </span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-0">
                  <p className={cx('max-w-[22rem] text-sm leading-relaxed', c.disabled ? 'text-dim' : 'text-muted')}>
                    {c.desc}
                  </p>
                  {/*
                    快捷键。两个牌子分别对应这张卡的「读」和「存」，点一下就等下一个按键。
                    摆在卡里而不是收进设置页：玩家想改键的那一刻正好就在这儿。
                  */}
                  <div className="mt-2 flex items-center gap-1.5 text-[11px] text-dim">
                    <span>{tt.hotkey}</span>
                    <KeyChip
                      combo={keys[c.loadKey]}
                      active={binding === c.loadKey}
                      label={`${tt.load} · ${tt.hotkeyEdit}`}
                      onPick={() => {
                        setNote('')
                        setBinding(binding === c.loadKey ? null : c.loadKey)
                      }}
                    />
                    <KeyChip
                      combo={keys[c.saveKey]}
                      active={binding === c.saveKey}
                      label={`${tt.save} · ${tt.hotkeyEdit}`}
                      onPick={() => {
                        setNote('')
                        setBinding(binding === c.saveKey ? null : c.saveKey)
                      }}
                    />
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    disabled={c.disabled || busy || c.canLoad === false}
                    onClick={c.onLoad}
                    title={c.canLoad === false && !c.disabled ? tt.saveLoadNothing : undefined}
                    className="h-9 rounded-full border border-line px-4 text-sm font-semibold transition-colors hover:border-brand hover:text-brand-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line disabled:hover:text-fg"
                  >
                    {tt.load}
                  </button>
                  <button
                    type="button"
                    disabled={c.disabled || busy}
                    onClick={c.onSave}
                    className="h-9 rounded-full bg-brand px-5 text-sm font-semibold text-white transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:bg-line disabled:text-dim"
                  >
                    {tt.save}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-[11px]">
          {/* 正在改键时把「怎么取消 / 怎么解绑」说出来，别让玩家对着一个闪烁的牌子发愣 */}
          <span className={cx(binding ? 'text-brand-hover' : note ? 'text-muted' : 'text-dim')}>
            {binding ? tt.hotkeyPress : note || tt.hotkeyTip}
          </span>
          <button
            type="button"
            className="text-muted underline underline-offset-2 transition-colors hover:text-fg"
            onClick={() => {
              resetHotkeys()
              setKeys(getHotkeys())
              setBinding(null)
              setNote('')
            }}
          >
            {tt.hotkeyReset}
          </button>
        </div>
      </div>
    </div>
  )
}
