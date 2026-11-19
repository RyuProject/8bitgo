/**
 * 麻将机的屏幕面板 —— 手机上玩 MAME 麻将机（mahjongPanel.ts）用。
 *
 * 引擎自带的街机虚拟手柄只有摇杆和按键 1–6，麻将机一颗都用不上（MAME 的麻将键只认键盘），
 * 所以适配器在这种会话里把那套收掉、声明 'mahjongPad'，播放器改画这一块。
 * 按下走 handle.mahjongPress，最终和键盘、手柄汇到同一座键盘桥上。
 *
 * 排布照实机面板：手牌 A–N（手机竖屏分两行，每颗仍有 44px 以上的命中区），
 * 下面一行吃碰杠听胡，再下面一行投币 / 开始 / 押注 / 得分 / 比倍 / 大 / 小。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from 'react'
import type { RuntimeHandle } from './types'
import { MAHJONG_ACTION_KEYS, MAHJONG_FLOW_KEYS, MAHJONG_TILE_KEYS, type MahjongKey } from './mahjongPanel'
import { useT } from '@/services/i18n'
import { cx } from '@/lib/format'

/** 同 TouchPad：关掉长按选字、iOS 拷贝菜单、点按高亮，按住不当成滚动 */
const PAD_STYLE: CSSProperties = {
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTouchCallout: 'none',
  WebkitTapHighlightColor: 'transparent',
  touchAction: 'none',
}

const HIDDEN_KEY = '8bitgo.mahjongpad.hidden'

interface Props {
  handle: RuntimeHandle | null
  /** 同 TouchPad：竖屏手机画在画面下面（inline），其余浮在画面底部（overlay） */
  layout?: 'overlay' | 'inline'
  /** 第一次真的按下某个键时调一次（撤开局提示） */
  onInput?: () => void
  highlight?: boolean
}

export function MahjongPad({ handle, layout = 'overlay', onInput, highlight }: Props) {
  const t = useT()
  const inline = layout === 'inline'
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(HIDDEN_KEY) === '1'
    } catch {
      return false
    }
  })
  /** 每根手指按着哪颗键：多指同时按（吃 + 牌）时各松各的 */
  const pointers = useRef(new Map<number, MahjongKey>())
  const press = handle?.mahjongPress
  const inputFired = useRef(false)

  const release = useCallback((pointerId: number) => {
    const key = pointers.current.get(pointerId)
    if (!key) return
    pointers.current.delete(pointerId)
    // 另一根手指还按着同一颗就不松
    if (![...pointers.current.values()].includes(key)) press?.(key, false)
  }, [press])

  // 换局 / 卸载 / 收起时，手上按着的全部松开，否则「吃」会一直按着
  useEffect(() => {
    const held = pointers.current
    return () => {
      for (const key of new Set(held.values())) press?.(key, false)
      held.clear()
    }
  }, [press, hidden])

  if (!press) return null

  const toggle = () => {
    const next = !hidden
    setHidden(next)
    try {
      localStorage.setItem(HIDDEN_KEY, next ? '1' : '0')
    } catch {
      /* 隐私模式写不进去就只管这一局 */
    }
    onInput?.()
  }

  const btnProps = (key: MahjongKey) => ({
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      e.preventDefault()
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        /* 部分 WebView 不支持捕获，松手照样走 pointerup */
      }
      const already = [...pointers.current.values()].includes(key)
      pointers.current.set(e.pointerId, key)
      if (!already) press(key, true)
      if (!inputFired.current) {
        inputFired.current = true
        onInput?.()
      }
    },
    onPointerUp: (e: PointerEvent<HTMLButtonElement>) => release(e.pointerId),
    onPointerCancel: (e: PointerEvent<HTMLButtonElement>) => release(e.pointerId),
    onLostPointerCapture: (e: PointerEvent<HTMLButtonElement>) => release(e.pointerId),
    onContextMenu: (e: MouseEvent) => e.preventDefault(),
  })

  const actionLabel: Record<(typeof MAHJONG_ACTION_KEYS)[number], string> = {
    chi: t.keymap.mjChi,
    pon: t.keymap.mjPon,
    kan: t.keymap.mjKan,
    reach: t.keymap.mjReach,
    ron: t.keymap.mjRon,
  }
  const flowLabel: Record<(typeof MAHJONG_FLOW_KEYS)[number], string> = {
    coin: t.keymap.coin,
    start: 'Start',
    bet: t.keymap.mjBet,
    score: t.keymap.mjScore,
    double: t.keymap.mjDouble,
    big: t.keymap.mjBig,
    small: t.keymap.mjSmall,
  }

  const key =
    'pointer-events-auto select-none touch-none flex min-h-11 items-center justify-center rounded-lg ' +
    'border border-white/25 bg-white/10 px-1 font-semibold text-white/90 active:border-brand active:bg-brand/70'

  const tiles = (keys: readonly MahjongKey[]) => (
    <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${keys.length}, minmax(0, 1fr))` }}>
      {keys.map((k) => (
        <button key={k} type="button" aria-label={`${t.keymap.mjTiles} ${k.toUpperCase()}`} className={cx(key, 'font-mono text-base')} style={PAD_STYLE} {...btnProps(k)}>
          {k.toUpperCase()}
        </button>
      ))}
    </div>
  )

  return (
    <div
      role="group"
      aria-label={t.keymap.mjTiles}
      className={cx(
        'pointer-events-none z-20 w-full',
        inline ? 'relative border-t border-white/10 bg-black px-2 pb-2 pt-1.5' : 'absolute inset-x-0 bottom-0 bg-black/70 px-2 pb-2 pt-1.5 backdrop-blur-sm',
        highlight && 'animate-pad-pulse',
      )}
      style={{ ...PAD_STYLE, paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
    >
      <div className="flex justify-end">
        <button
          type="button"
          onClick={toggle}
          className="pointer-events-auto min-h-8 rounded-full border border-white/20 bg-white/10 px-3 text-[11px] text-white/80"
          style={PAD_STYLE}
          aria-expanded={!hidden}
        >
          🀄 {hidden ? t.player.padMap.show : t.player.padMap.hide}
        </button>
      </div>
      {!hidden && (
        <div className="mt-1.5 flex flex-col gap-1">
          {inline ? (
            <>
              {tiles(MAHJONG_TILE_KEYS.slice(0, 7))}
              {tiles(MAHJONG_TILE_KEYS.slice(7))}
            </>
          ) : (
            tiles(MAHJONG_TILE_KEYS)
          )}
          <div className="grid grid-cols-5 gap-1">
            {MAHJONG_ACTION_KEYS.map((k) => (
              <button
                key={k}
                type="button"
                className={cx(key, 'text-base', k === 'ron' && 'border-red-300/50 bg-red-500/25')}
                style={PAD_STYLE}
                {...btnProps(k)}
              >
                {actionLabel[k]}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {MAHJONG_FLOW_KEYS.map((k) => (
              <button
                key={k}
                type="button"
                className={cx(key, 'text-[11px] leading-tight', (k === 'coin' || k === 'start') && 'border-brand/50')}
                style={PAD_STYLE}
                {...btnProps(k)}
              >
                {flowLabel[k]}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
