/**
 * DOS 触屏鼠标 —— 手机没有鼠标，而大批 DOS 游戏（点选经营、冒险，以及 FPS 的瞄准）都靠鼠标。
 *
 * 两种模式，一颗开关切换：
 *   · 移动（绝对坐标）：在触控板上拖动 = 把光标放到屏幕对应位置。点一下 = 左键。
 *     给《主题医院》这类「点哪儿光标去哪儿」的游戏用。
 *   · 瞄准（相对位移）：在触控板上拖动 = 发相对位移，不开火时也能转视角。给毁灭战士这类 FPS 用，
 *     配合屏幕手柄的 A 键（Ctrl=开火）就能「左摇杆走、右手拖着看、A 开火」。
 *
 * 走 RuntimeHandle 的 sendMouseMove / sendMouseRelative / sendMouseButton，直接喂 js-dos，
 * 不合成鼠标事件。由 TouchPad 的「🖱」按钮打开，只在声明了 sendMouseMove 的运行时出现。
 */
import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { RuntimeHandle } from './types'
import { cx } from '@/lib/format'
import { useT } from '@/services/i18n'

const PAD_STYLE: CSSProperties = {
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTouchCallout: 'none',
  WebkitTapHighlightColor: 'transparent',
  touchAction: 'none',
}
/** 判定「点一下」还是「拖动」的位移阈值（像素） */
const TAP_SLOP = 6
/** 相对模式灵敏度：手指每移 1px 当作多少鼠标位移 */
const RELATIVE_SCALE = 1.4

type Mode = 'absolute' | 'relative'

interface Props {
  handle: RuntimeHandle
  onClose: () => void
}

export function DosMousePad({ handle, onClose }: Props) {
  const t = useT()
  const move = handle.sendMouseMove
  const rel = handle.sendMouseRelative
  const btn = handle.sendMouseButton
  const [mode, setMode] = useState<Mode>('absolute')

  const pointerId = useRef<number | null>(null)
  const last = useRef({ x: 0, y: 0 })
  const moved = useRef(0)

  const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    pointerId.current = e.pointerId
    e.currentTarget.setPointerCapture(e.pointerId)
    last.current = { x: e.clientX, y: e.clientY }
    moved.current = 0
    if (mode === 'absolute') {
      const r = e.currentTarget.getBoundingClientRect()
      move?.(clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height))
    }
  }

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== pointerId.current) return
    const dx = e.clientX - last.current.x
    const dy = e.clientY - last.current.y
    last.current = { x: e.clientX, y: e.clientY }
    moved.current += Math.abs(dx) + Math.abs(dy)
    if (mode === 'absolute') {
      const r = e.currentTarget.getBoundingClientRect()
      move?.(clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height))
    } else {
      rel?.(dx * RELATIVE_SCALE, dy * RELATIVE_SCALE)
    }
  }

  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== pointerId.current) return
    pointerId.current = null
    // 没怎么动 = 当成一次左键点击（按下 + 很快松开）
    if (moved.current < TAP_SLOP) {
      try {
        btn?.(0, true)
        window.setTimeout(() => btn?.(0, false), 60)
      } catch {
        /* 引擎已拆 */
      }
    }
  }

  /** 左 / 右键的按住式按钮 */
  const mouseBtn = (button: 0 | 1, label: string) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      try {
        btn?.(button, true)
      } catch {
        /* ignore */
      }
    },
    onPointerUp: (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.preventDefault()
      try {
        btn?.(button, false)
      } catch {
        /* ignore */
      }
    },
    onPointerCancel: () => {
      try {
        btn?.(button, false)
      } catch {
        /* ignore */
      }
    },
    onLostPointerCapture: () => {
      try {
        btn?.(button, false)
      } catch {
        /* ignore */
      }
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    children: label,
  })

  if (!move) return null

  return createPortal(
    <div
      className="fixed inset-x-0 bottom-0 z-40 flex flex-col gap-2 border-t border-white/15 bg-black/85 px-3 pb-3 pt-2 backdrop-blur-sm"
      style={PAD_STYLE}
    >
      <div className="flex items-center justify-between">
        <div className="flex overflow-hidden rounded-md border border-white/20 text-[11px]">
          <button
            type="button"
            onClick={() => setMode('absolute')}
            className={cx('px-2.5 py-1', mode === 'absolute' ? 'bg-brand text-brand-hover' : 'text-white/70')}
          >
            {t.player.padMap.mouseMove}
          </button>
          <button
            type="button"
            onClick={() => setMode('relative')}
            className={cx('px-2.5 py-1', mode === 'relative' ? 'bg-brand text-brand-hover' : 'text-white/70')}
          >
            {t.player.padMap.mouseAim}
          </button>
        </div>
        <button type="button" onClick={onClose} className="rounded px-2 py-0.5 text-[11px] text-white/70 hover:bg-white/10">
          {t.player.padMap.close}
        </button>
      </div>

      {/* 触控板：拖动 = 移动光标（绝对）或转视角（相对），轻点 = 左键 */}
      <div
        className="relative h-32 w-full rounded-lg border border-white/20 bg-white/5"
        style={PAD_STYLE}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onLostPointerCapture={onUp}
      >
        <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[11px] text-white/40">
          {mode === 'absolute' ? t.player.padMap.mouseMove : t.player.padMap.mouseAim}
        </span>
      </div>

      <div className="flex items-center justify-center gap-3">
        <button
          type="button"
          {...mouseBtn(0, t.player.padMap.mouseLeft)}
          className="min-h-11 min-w-20 rounded-md border border-white/25 bg-white/10 text-sm text-white/85 active:bg-brand/70"
          style={PAD_STYLE}
        />
        <button
          type="button"
          {...mouseBtn(1, t.player.padMap.mouseRight)}
          className="min-h-11 min-w-20 rounded-md border border-white/25 bg-white/10 text-sm text-white/85 active:bg-brand/70"
          style={PAD_STYLE}
        />
      </div>
    </div>,
    document.body,
  )
}
