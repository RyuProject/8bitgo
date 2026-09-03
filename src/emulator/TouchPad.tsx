/**
 * 触屏手柄浮层 —— 手机上玩 jsnes / js-dos / Ruffle 这类「引擎自己不带屏幕按键」的运行时。
 *
 * 为什么不合成键盘事件：那些引擎读的是 e.keyCode，合成 KeyboardEvent 各浏览器行为不一致，
 * 而且会被页面上别的监听（搜索框、滚动）撞上。这里走 RuntimeHandle.sendButton，
 * 由适配器直接喂给核心，见 types.ts 的说明。
 *
 * EmulatorJS 不用这套：它自带虚拟手柄，只是以前被 EJS_startOnLoaded 关坏了，
 * 已在 adapters/emulatorjs.ts 的 showVirtualGamepad 里修好。所以这个浮层只对
 * 声明了 'touchpad' 能力的运行时出现，两套不会同时冒出来。
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react'
import type { PadButton, RuntimeHandle } from './types'
import { cx } from '@/lib/format'

/** 十字键中心这一圈不算方向；太小会误触，太大会「顶不动」 */
const DEADZONE = 0.22

/** 八个扇区各自按住哪些方向。斜角那四份同时按两个键 —— 马里奥跳斜跳全靠它 */
const SECTORS: PadButton[][] = [
  ['right'],
  ['right', 'down'],
  ['down'],
  ['down', 'left'],
  ['left'],
  ['left', 'up'],
  ['up'],
  ['up', 'right'],
]

/** 手指落点（相对十字键中心，已归一化到 ±1）对应按住哪些方向 */
function dirsFor(nx: number, ny: number): PadButton[] {
  if (Math.hypot(nx, ny) < DEADZONE) return []
  // +22.5° 是为了让「正右」落在第 0 扇区的正中间，而不是骑在两个扇区的边界上
  const deg = ((Math.atan2(ny, nx) * 180) / Math.PI + 382.5) % 360
  return SECTORS[Math.floor(deg / 45)]
}

const HIDDEN_KEY = '8bitgo.touchpad.hidden'

interface Props {
  handle: RuntimeHandle | null
  /**
   * 手柄摆哪儿。
   *
   * `overlay`（默认）—— 浮在画面上，绝对定位。全屏、以及桌面触屏机走这个：
   * 那两种情形画面本来就大，浮层压掉一角无所谓，换来的是画面不被挤小。
   *
   * `inline` —— 画面**下面**单独一条。手机竖屏必须走这个：390pt 宽的屏幕上画面框
   * 只有 291pt 高，而十字键是 min(30vw, 9rem) = 117pt，浮上去要压掉画面下半部分
   * 将近四成 —— 玩超级玛丽时脚下的地面和敌人正好在那一块。
   */
  layout?: 'overlay' | 'inline'
  className?: string
}

export function TouchPad({ handle, layout = 'overlay', className }: Props) {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(HIDDEN_KEY) === '1'
    } catch {
      return false
    }
  })

  /** 当前按住的键。松手要按这份精确松开 —— 不能一把 release 全部，A 和方向常常同时按着 */
  const held = useRef<Set<PadButton>>(new Set())
  const send = handle?.sendButton

  const set = useCallback(
    (button: PadButton, down: boolean) => {
      if (down === held.current.has(button)) return
      if (down) held.current.add(button)
      else held.current.delete(button)
      send?.(button, down)
    },
    [send],
  )

  /** 换游戏、退出全屏、组件卸载：手上按着的键必须松开，否则角色会一直往一个方向跑 */
  const releaseAll = useCallback(() => {
    for (const b of [...held.current]) set(b, false)
  }, [set])

  useEffect(() => releaseAll, [releaseAll])

  useEffect(() => {
    try {
      localStorage.setItem(HIDDEN_KEY, hidden ? '1' : '0')
    } catch {
      /* 隐私模式下写不了就算了 */
    }
    if (hidden) releaseAll()
  }, [hidden, releaseAll])

  if (!send) return null

  const onDpad = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1
    const ny = ((e.clientY - r.top) / r.height) * 2 - 1
    const next = dirsFor(nx, ny)
    for (const d of ['up', 'down', 'left', 'right'] as PadButton[]) set(d, next.includes(d))
  }

  const clearDpad = () => {
    for (const d of ['up', 'down', 'left', 'right'] as PadButton[]) set(d, false)
  }

  /** 圆按钮（A / B）与胶囊按钮（SELECT / START）共用的按下 / 松开处理 */
  const btnProps = (button: PadButton) => ({
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      e.preventDefault()
      // 抓住这个 pointer：手指从按钮上滑出去也照样收得到 up，不会卡住不放
      e.currentTarget.setPointerCapture(e.pointerId)
      set(button, true)
    },
    onPointerUp: () => set(button, false),
    onPointerCancel: () => set(button, false),
    onLostPointerCapture: () => set(button, false),
    onContextMenu: (e: MouseEvent) => e.preventDefault(),
  })

  const face =
    'pointer-events-auto select-none touch-none flex items-center justify-center ' +
    'border border-white/25 bg-white/10 text-white/85 backdrop-blur-sm ' +
    'active:bg-brand/70 active:border-brand'

  const inline = layout === 'inline'
  /**
   * 键位尺寸用 vw 而不是固定 px：手机宽度从 320 到 430 都有，按屏幕比例给才不会
   * 在小屏上顶满、在大屏上小得点不准。上限（9rem / 4.5rem）是为平板和桌面触屏机兜的。
   */
  const DPAD = inline ? 'min(32vw, 9rem)' : 'min(30vw, 9rem)'
  const FACE = inline ? 'min(16vw, 4.5rem)' : 'min(15vw, 4.5rem)'

  /** 十字键：整块都是感应区，按角度算方向 —— 这样斜方向和「滑着换方向」才顺 */
  const dpad = (
    <div
      role="group"
      aria-label="Direction pad"
      className={cx(
        'pointer-events-auto touch-none rounded-full border border-white/20 backdrop-blur-sm',
        inline ? 'relative bg-white/5' : 'absolute bottom-[8%] left-[4%] bg-black/30',
      )}
      style={{ width: DPAD, height: DPAD, touchAction: 'none' }}
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        onDpad(e)
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) onDpad(e)
      }}
      onPointerUp={clearDpad}
      onPointerCancel={clearDpad}
      onLostPointerCapture={clearDpad}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 只是画给人看的箭头，事件都在外层那一块上 */}
      <div className="pointer-events-none absolute inset-0 text-white/60">
        <span className="absolute left-1/2 top-[6%] -translate-x-1/2 text-sm">▲</span>
        <span className="absolute bottom-[6%] left-1/2 -translate-x-1/2 text-sm">▼</span>
        <span className="absolute left-[6%] top-1/2 -translate-y-1/2 text-sm">◀</span>
        <span className="absolute right-[6%] top-1/2 -translate-y-1/2 text-sm">▶</span>
      </div>
    </div>
  )

  /** A / B。B 在左下、A 在右上，和实机手柄的斜排一致，拇指压着更顺 */
  const faceButton = (button: 'a' | 'b', cls: string) => (
    <button
      type="button"
      aria-label={`Button ${button.toUpperCase()}`}
      {...btnProps(button)}
      className={cx(face, 'rounded-full font-bold', cls)}
      style={{ width: FACE, height: FACE, touchAction: 'none' }}
    >
      {button.toUpperCase()}
    </button>
  )

  /** SELECT / START：玩的时候基本不碰，做小一点，别抢地方 */
  const sysButton = (button: 'select' | 'start', cls: string) => (
    <button
      type="button"
      aria-label={button === 'select' ? 'Select' : 'Start'}
      {...btnProps(button)}
      className={cx(face, 'rounded-full px-3 py-1 text-[10px] tracking-wider', cls)}
      style={{ touchAction: 'none' }}
    >
      {button === 'select' ? 'SELECT' : 'START'}
    </button>
  )

  /** 显示 / 隐藏。浮层压着画面、行内一条也占高度，都得给玩家一个收起来的办法（选择记在本地） */
  const toggle = (
    <button
      type="button"
      aria-label={hidden ? 'Show on-screen controls' : 'Hide on-screen controls'}
      onClick={() => setHidden((v) => !v)}
      className={cx(
        'pointer-events-auto absolute rounded-md px-2 py-0.5 text-[11px]',
        'border border-white/20 bg-black/40 text-white/70 backdrop-blur-sm',
        inline ? 'right-1 top-1' : 'bottom-1 left-1/2 -translate-x-1/2',
      )}
    >
      {hidden ? '🎮' : '▾'}
    </button>
  )

  /*
    行内一条（手机竖屏）。

    整条自己带边框和底色 —— 收起来的时候这一条只剩那颗 🎮 的高度，
    而不是留一个空的黑带在画面下面。三段用 justify-between 摊开：
    十字键 / SELECT·START / B·A，和实机手柄的排布一致。
  */
  if (inline) {
    return (
      <div
        data-testid="touchpad"
        className={cx('relative z-20 shrink-0 touch-none border-t border-line bg-black/40', className)}
        style={{ touchAction: 'none' }}
      >
        {toggle}
        {hidden ? (
          <div className="h-7" />
        ) : (
          <div className="flex w-full items-center justify-between gap-2 px-3 py-2">
            {dpad}
            <div className="flex flex-col items-center gap-1.5 pt-4">
              {sysButton('select', '')}
              {sysButton('start', '')}
            </div>
            {/* 斜排：容器给够高度，B 落左下、A 落右上 */}
            <div className="relative" style={{ width: `calc(${FACE} * 2 + 0.5rem)`, height: `calc(${FACE} * 1.45)` }}>
              {faceButton('b', 'absolute bottom-0 left-0')}
              {faceButton('a', 'absolute right-0 top-0')}
            </div>
          </div>
        )}
      </div>
    )
  }

  /* 浮层（全屏 / 桌面触屏机）：压在画面上，用百分比定位贴着四角 */
  return (
    <div
      data-testid="touchpad"
      className={cx('pointer-events-none absolute inset-0 z-20 touch-none', className)}
      style={{ touchAction: 'none' }}
    >
      {toggle}
      {hidden ? null : (
        <>
          {dpad}
          {faceButton('b', 'absolute bottom-[10%] right-[26%]')}
          {faceButton('a', 'absolute bottom-[24%] right-[5%]')}
          {sysButton('select', 'absolute bottom-[8%] left-1/2 -translate-x-[115%]')}
          {sysButton('start', 'absolute bottom-[8%] left-1/2 translate-x-[15%]')}
        </>
      )}
    </div>
  )
}
