/**
 * DOS 屏幕键盘 —— 手机上没有实体键盘，而 DOS 游戏读的是键盘，光靠八颗屏幕按键
 * （方向 + A/B/START/SELECT）覆盖不了打字、数字选单位、F1–F12 这类操作。
 * 这个浮层把常用键画出来，按下就走 RuntimeHandle.sendKey 直接喂给 js-dos 的 GLFW 接口，
 * 和屏幕手柄走的是同一条通路（见 types.ts 的 sendKey）。
 *
 * 只在声明了 sendKey 的运行时（目前只有 DOS）出现，由 TouchPad 的「⌨」按钮打开。
 */
import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { RuntimeHandle } from './types'
import { CODE_TO_GLFW } from './dosPad'
import { cx } from '@/lib/format'
import { useT } from '@/services/i18n'

/** 一颗键：显示字 + KeyboardEvent.code（用来查 GLFW 键码） */
interface KeyDef {
  label: string
  code: string
  /** 相对宽度，默认 1。空格之类占宽一些 */
  span?: number
}

const FN_ROW: KeyDef[] = [
  { label: 'Esc', code: 'Escape' },
  ...Array.from({ length: 12 }, (_, i) => ({ label: `F${i + 1}`, code: `F${i + 1}` })),
]

const ROWS: KeyDef[][] = [
  [
    { label: '`', code: 'Backquote' },
    { label: '1', code: 'Digit1' },
    { label: '2', code: 'Digit2' },
    { label: '3', code: 'Digit3' },
    { label: '4', code: 'Digit4' },
    { label: '5', code: 'Digit5' },
    { label: '6', code: 'Digit6' },
    { label: '7', code: 'Digit7' },
    { label: '8', code: 'Digit8' },
    { label: '9', code: 'Digit9' },
    { label: '0', code: 'Digit0' },
    { label: '-', code: 'Minus' },
    { label: '=', code: 'Equal' },
    { label: '⌫', code: 'Backspace', span: 1.5 },
  ],
  [
    { label: 'Tab', code: 'Tab', span: 1.4 },
    { label: 'Q', code: 'KeyQ' },
    { label: 'W', code: 'KeyW' },
    { label: 'E', code: 'KeyE' },
    { label: 'R', code: 'KeyR' },
    { label: 'T', code: 'KeyT' },
    { label: 'Y', code: 'KeyY' },
    { label: 'U', code: 'KeyU' },
    { label: 'I', code: 'KeyI' },
    { label: 'O', code: 'KeyO' },
    { label: 'P', code: 'KeyP' },
    { label: '[', code: 'BracketLeft' },
    { label: ']', code: 'BracketRight' },
    { label: '\\', code: 'Backslash' },
  ],
  [
    { label: 'Caps', code: 'CapsLock', span: 1.6 },
    { label: 'A', code: 'KeyA' },
    { label: 'S', code: 'KeyS' },
    { label: 'D', code: 'KeyD' },
    { label: 'F', code: 'KeyF' },
    { label: 'G', code: 'KeyG' },
    { label: 'H', code: 'KeyH' },
    { label: 'J', code: 'KeyJ' },
    { label: 'K', code: 'KeyK' },
    { label: 'L', code: 'KeyL' },
    { label: ';', code: 'Semicolon' },
    { label: "'", code: 'Quote' },
    { label: '⏎', code: 'Enter', span: 1.6 },
  ],
  [
    { label: '⇧', code: 'ShiftLeft', span: 2 },
    { label: 'Z', code: 'KeyZ' },
    { label: 'X', code: 'KeyX' },
    { label: 'C', code: 'KeyC' },
    { label: 'V', code: 'KeyV' },
    { label: 'B', code: 'KeyB' },
    { label: 'N', code: 'KeyN' },
    { label: 'M', code: 'KeyM' },
    { label: ',', code: 'Comma' },
    { label: '.', code: 'Period' },
    { label: '/', code: 'Slash' },
  ],
  [
    { label: 'Ctrl', code: 'ControlLeft', span: 1.4 },
    { label: 'Alt', code: 'AltLeft', span: 1.4 },
    { label: 'Space', code: 'Space', span: 4.2 },
    { label: '⇧', code: 'ShiftRight', span: 1.4 },
    { label: '⏎', code: 'Enter', span: 1.6 },
  ],
]

const KEY_STYLE: React.CSSProperties = {
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTouchCallout: 'none',
  WebkitTapHighlightColor: 'transparent',
  touchAction: 'none',
}

interface Props {
  handle: RuntimeHandle
  onClose: () => void
}

export function DosKeyboard({ handle, onClose }: Props) {
  const t = useT()
  const send = handle.sendKey
  const pressed = useRef<Set<string>>(new Set())

  const press = useCallback(
    (code: string, down: boolean) => {
      const glfw = CODE_TO_GLFW[code]
      if (glfw === undefined) return
      if (down === pressed.current.has(code)) return
      if (down) pressed.current.add(code)
      else pressed.current.delete(code)
      try {
        send?.(glfw, down)
      } catch {
        /* 引擎已经拆了就忽略 */
      }
    },
    [send],
  )

  const keyProps = (code: string) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      press(code, true)
    },
    onPointerUp: (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.preventDefault()
      press(code, false)
    },
    onPointerCancel: () => press(code, false),
    onLostPointerCapture: () => press(code, false),
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  })

  if (!send) return null

  return createPortal(
    <div
      className="fixed inset-x-0 bottom-0 z-40 flex flex-col border-t border-white/15 bg-black/85 backdrop-blur-sm"
      style={KEY_STYLE}
    >
      <div className="flex items-center justify-between px-3 py-1.5 text-[11px] text-white/60">
        <span>{t.player.padMap.keyboard}</span>
        <button type="button" onClick={onClose} className="rounded px-2 py-0.5 text-white/70 hover:bg-white/10">
          {t.player.padMap.close}
        </button>
      </div>
      <div className="max-h-[42vh] overflow-y-auto px-1.5 pb-2">
        {/* 功能键单独一行，可横向滚动 */}
        <div className="mb-1 flex gap-1 overflow-x-auto pb-1">
          {FN_ROW.map((k) => (
            <button
              key={k.code}
              type="button"
              {...keyProps(k.code)}
              className={cx(
                'shrink-0 rounded border border-white/20 bg-white/10 px-2 py-1.5 text-[11px] text-white/85 active:bg-brand/70',
              )}
              style={KEY_STYLE}
            >
              {k.label}
            </button>
          ))}
        </div>
        {ROWS.map((row, ri) => (
          <div key={ri} className="mb-1 flex gap-1">
            {row.map((k) => (
              <button
                key={k.code}
                type="button"
                {...keyProps(k.code)}
                className="flex-1 rounded border border-white/20 bg-white/10 py-2 text-[12px] font-medium text-white/85 active:bg-brand/70"
                style={{ ...KEY_STYLE, flexGrow: k.span ?? 1, minWidth: 0 }}
              >
                {k.label}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  )
}
