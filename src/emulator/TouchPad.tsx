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
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import type { PadButton, PadKeyPress, RuntimeHandle } from './types'
import { cx } from '@/lib/format'
import { Modal } from '@/components/ui/Modal'
import { fmt, useT } from '@/services/i18n'

/**
 * 手柄整块的触摸样式。
 *
 * 长按会选中字符 —— iOS Safari 把「按住不动」当成开始选字，安卓 Chrome 也会弹出选区手柄，
 * 手指压着 A 键连发时屏幕上就冒出一片蓝色选区、还带放大镜。pointerdown 里的 preventDefault
 * 拦不住它（选字是触摸手势层面的，不归 pointer 事件管），只能用 CSS 关掉：
 *   user-select: none         —— 设在根上就够了：子元素的 auto 会跟着父级算成 none
 *   -webkit-touch-callout     —— iOS 长按弹出的那条「拷贝 / 查询」菜单
 *   -webkit-tap-highlight     —— 安卓点一下闪一层灰
 *   touch-action: none        —— 别把按住当成滚动 / 缩放
 */
const PAD_STYLE: CSSProperties = {
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTouchCallout: 'none',
  WebkitTapHighlightColor: 'transparent',
  touchAction: 'none',
}

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

/** 手柄角上那两颗小按钮（显示 / 隐藏、按键映射）共用的样式 */
const MINI_BTN =
  'pointer-events-auto rounded-md px-2 py-0.5 text-[11px] ' +
  'border border-white/20 bg-black/40 text-white/70 backdrop-blur-sm'

/**
 * 改键面板的八行，顺序和手柄上的排布一致（方向上、Buttons 下）。
 * 方向和 A/B/Start/Select 是通用符号，八种语言都不用翻。
 */
const PAD_ROWS: ReadonlyArray<readonly [PadButton, string]> = [
  ['up', '↑'],
  ['down', '↓'],
  ['left', '←'],
  ['right', '→'],
  ['a', 'A'],
  ['b', 'B'],
  ['select', 'Select'],
  ['start', 'Start'],
]

/**
 * 改键面板下面那排「常用键」，填的是 KeyboardEvent.code。
 *
 * 挑的正是**手机键盘上打不出来**的那些：方向键、修饰键、回车 / Esc / Tab。
 * 玩家真正会用键盘打的是字母和数字（WASD 那类），那些走输入框就行 ——
 * 所以这排按钮不是「快捷方式」，是手机上唯一能给方向键的办法。
 */
const QUICK_CODES: readonly string[] = [
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ControlLeft',
  'AltLeft',
  'ShiftLeft',
  'Space',
  'Enter',
  'Escape',
  'Tab',
]

/** 一份草稿里哪几个标签被占用了两次以上（用于把冲突的那两格标出来） */
function duplicateLabels(labels: readonly string[]): Set<string> {
  const count = new Map<string, number>()
  for (const l of labels) if (l) count.set(l, (count.get(l) ?? 0) + 1)
  const dupes = new Set<string>()
  for (const [l, n] of count) if (n > 1) dupes.add(l)
  return dupes
}

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
  /**
   * 玩家第一次真的按下某个键时调一次。
   * 播放器拿它来撤掉「手柄在这儿」的开局提示 —— 手都摸到了，就不用再教了。
   * 收起 / 展开那颗按钮也算：他能点到它，就说明已经看见这一条了。
   */
  onInput?: () => void
  /**
   * 描一圈会呼吸的绿边，把玩家的视线引到按键上。
   * 开局提示显示期间为 true —— 提示说「手柄在下面」，下面同时亮起来，
   * 光靠一句话玩家未必往下看。
   */
  highlight?: boolean
  className?: string
}

export function TouchPad({ handle, layout = 'overlay', onInput, highlight, className }: Props) {
  const t = useT()
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(HIDDEN_KEY) === '1'
    } catch {
      return false
    }
  })
  /**
   * 改键面板开着没有。只有适配器给了 padRemap 才有意义（目前只有 DOS）。
   *
   * ⚠️ 下面这几个 hook 必须在 `if (!send …) return null` **之前**，理由见文件里
   * 那段「hook 数量从 7 变 9」的注释 —— 少一个都会让播放器子树整棵垮掉。
   */
  const [remapOpen, setRemapOpen] = useState(false)
  /**
   * 面板里的草稿：按了就写进这里，**点了「保存」才真正生效**。
   * 玩家一次要改四五个键，改到一半就该能退出来，中途那半套键位不该已经在跑。
   */
  const [draft, setDraft] = useState<Partial<Record<PadButton, { press: PadKeyPress | null; label: string }>>>({})
  /**
   * 当前选中哪一行。下面那排「常用键」就是给这一行用的。
   * 点整行（不是输入框）只选中、**不聚焦输入框** —— 手机上这一下不会弹键盘，
   * 于是「点行 → 点常用键」是一条完全不用键盘的路径。
   */
  const [active, setActive] = useState<PadButton | null>(null)
  /** 「这个键不支持」「改动没保存」那类提示 */
  const [note, setNote] = useState('')

  /** 当前按住的键。松手要按这份精确松开 —— 不能一把 release 全部，A 和方向常常同时按着 */
  const held = useRef<Set<PadButton>>(new Set())
  const send = handle?.sendButton
  /**
   * 键位可改的运行时（目前只有 DOS）。有它才画那颗「按键映射」，
   * 换算 / 存储都在适配器那一侧，这里只交换标签和原始按键。
   */
  const remap = handle?.padRemap
  /**
   * 这一局用得上的按钮。适配器不给就是八个键全有 —— 主机模拟器都是这样，
   * 只有 Flash 这种「每款游戏读的键都不一样」的才会缩到几颗（见 flashKeys.ts）。
   */
  const only = handle?.padButtons
  const has = (button: PadButton) => !only || only.includes(button)
  /** 这游戏只用方向键（森林冰火人这类）。行内那一条的排布要跟着变 */
  const dpadOnly = !has('a') && !has('b') && !has('select') && !has('start')
  /** 一个方向都不读的游戏（真有，比如只按空格的）就别画十字键 */
  const hasDirs = has('up') || has('down') || has('left') || has('right')

  /**
   * onInput 只报第一次。
   *
   * 契约写的是「第一次按下时调一次」，实现却是每次按下都调 —— 而消费端在里面做
   * **同步的 localStorage.setItem**（收起那条上手提示）。按住十字键滑一圈，
   * onDpad 每个 pointermove 都跑，一秒几十次同步存储写砸在主线程上，
   * 而模拟器同一帧还要抢那 16ms：搓十字键时掉帧、音频爆音。
   */
  const inputFired = useRef(false)
  const set = useCallback(
    (button: PadButton, down: boolean) => {
      if (down === held.current.has(button)) return
      if (down) held.current.add(button)
      else held.current.delete(button)
      send?.(button, down)
      if (down && !inputFired.current) {
        inputFired.current = true
        onInput?.()
      }
    },
    [send, onInput],
  )

  /** 换游戏、退出全屏、组件卸载：手上按着的键必须松开，否则角色会一直往一个方向跑 */
  const releaseAll = useCallback(() => {
    // 归属记录也要一起清，否则下次按下会因为「集合里还留着上一轮的手指」而不触发按下
    dpadPointer.current = null
    btnPointers.current.clear()
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

  /**
   * ⚠️ 下面两个 useRef **必须待在所有提前 return 之前**（hooks 规则）。
   *
   * 它们原来在 `if (!send || …) return null` 之后，两个后果：
   *   · 同一个实例先以空 padButtons 渲染、之后变非空 → hook 数量从 7 变 9 →
   *     React 抛「Rendered more hooks than during the previous render」，整个播放器子树垮掉；
   *   · 走提前返回那一支时，`releaseAll` 的闭包在 effect 清理里引用它们会命中 TDZ
   *     （Cannot access 'dpadPointer' before initialization）。
   * 现在恰好踩不到，是因为唯一给空 padButtons 的 liveview 座位同时也摘掉了 touchpad 能力 ——
   * 那是巧合保护，不是设计。
   */

  /**
   * 十字键的**归属手指**。
   *
   * 没有它的话：一根拇指压着十字键跑图，另一只手的手指（或握持时的掌根）蹭到这块
   * 125px 的区域 —— 第二根手指的坐标会被当成新方向，角色当场掉头；它一抬起来
   * clearDpad 又把四个方向全松开，而拇指还压着且不动，于是「十字键忽然死了，
   * 要抬起来重按一次才活」。只认第一根手指，其余一律不理。
   */
  const dpadPointer = useRef<number | null>(null)

  /**
   * 每颗按键上**压着哪几根手指**。
   *
   * 双指交替猛点 A 连发是标准打法：两次点按只要有几毫秒重叠，第二根的按下就会被
   * `down === held.has(button)` 挡掉，而第一根一抬就把键松了 —— 一对交替只产生
   * **一次**按下，连发速率直接减半，玩家感觉「点得越快反而越不出招」。
   * 记住每颗键上的手指集合，空→非空才按下，非空→空才松开。
   */
  const btnPointers = useRef(new Map<PadButton, Set<number>>())

  // 送不出去、或者适配器明说「这局一颗键都用不上」，整条就别画了 —— 画一个空壳更糟
  if (!send || (only && only.length === 0)) return null

  const onDpad = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1
    const ny = ((e.clientY - r.top) / r.height) * 2 - 1
    const next = dirsFor(nx, ny)
    for (const d of ['up', 'down', 'left', 'right'] as PadButton[]) set(d, next.includes(d))
  }

  const clearDpad = () => {
    dpadPointer.current = null
    for (const d of ['up', 'down', 'left', 'right'] as PadButton[]) set(d, false)
  }

  const dpadProps = {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      // 已经有手指在管方向了，后来的一律不理（见 dpadPointer）
      if (dpadPointer.current !== null) return
      dpadPointer.current = e.pointerId
      e.currentTarget.setPointerCapture(e.pointerId)
      onDpad(e)
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      if (e.pointerId !== dpadPointer.current) return
      if (e.currentTarget.hasPointerCapture(e.pointerId)) onDpad(e)
    },
    onPointerUp: (e: PointerEvent<HTMLDivElement>) => {
      if (e.pointerId !== dpadPointer.current) return
      clearDpad()
    },
    onPointerCancel: (e: PointerEvent<HTMLDivElement>) => {
      if (e.pointerId !== dpadPointer.current) return
      clearDpad()
    },
    onLostPointerCapture: (e: PointerEvent<HTMLDivElement>) => {
      if (e.pointerId !== dpadPointer.current) return
      clearDpad()
    },
    onContextMenu: (e: MouseEvent) => e.preventDefault(),
  }

  /** 按下：这颗键上的手指集合从空变非空，才算真的按下一次（理由见 btnPointers） */
  const pressBtn = (button: PadButton, id: number) => {
    let ids = btnPointers.current.get(button)
    if (!ids) btnPointers.current.set(button, (ids = new Set()))
    const wasEmpty = ids.size === 0
    ids.add(id)
    if (wasEmpty) set(button, true)
  }
  const releaseBtn = (button: PadButton, id: number) => {
    const ids = btnPointers.current.get(button)
    if (!ids || !ids.delete(id) || ids.size) return
    set(button, false)
  }

  /** 圆按钮（A / B）与胶囊按钮（SELECT / START）共用的按下 / 松开处理 */
  const btnProps = (button: PadButton) => ({
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      e.preventDefault()
      // 抓住这个 pointer：手指从按钮上滑出去也照样收得到 up，不会卡住不放
      e.currentTarget.setPointerCapture(e.pointerId)
      pressBtn(button, e.pointerId)
    },
    onPointerUp: (e: PointerEvent<HTMLButtonElement>) => releaseBtn(button, e.pointerId),
    onPointerCancel: (e: PointerEvent<HTMLButtonElement>) => releaseBtn(button, e.pointerId),
    onLostPointerCapture: (e: PointerEvent<HTMLButtonElement>) => releaseBtn(button, e.pointerId),
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
        // 行内那一条是整条一起亮（见下面 inline 的容器），这里只管浮层
        !inline && highlight && 'animate-pad-pulse',
      )}
      style={{ ...PAD_STYLE, width: DPAD, height: DPAD }}
      {...dpadProps}
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
  const faceButton = (button: 'a' | 'b', cls: string) =>
    !has(button) ? null : (
    <button
      type="button"
      aria-label={`Button ${button.toUpperCase()}`}
      {...btnProps(button)}
      className={cx(face, 'rounded-full font-bold', !inline && highlight && 'animate-pad-pulse', cls)}
      style={{ ...PAD_STYLE, width: FACE, height: FACE }}
    >
      {button.toUpperCase()}
    </button>
  )

  /** SELECT / START：玩的时候基本不碰，做小一点，别抢地方 */
  const sysButton = (button: 'select' | 'start', cls: string) =>
    !has(button) ? null : (
    <button
      type="button"
      aria-label={button === 'select' ? 'Select' : 'Start'}
      {...btnProps(button)}
      className={cx(face, 'rounded-full px-3 py-1 text-[10px] tracking-wider', cls)}
      style={PAD_STYLE}
    >
      {button === 'select' ? 'SELECT' : 'START'}
    </button>
  )

  /* ---------------- 改键面板（只有给了 padRemap 的运行时才有） ---------------- */

  /**
   * 草稿里被两颗以上按钮占了的标签。输入框标黄、下面给一句提示。
   *
   * 不拦着不让存：极少情况下玩家真的想让两颗键发同一个键（比如 A 和 B 都想当开火）。
   * 但绝大多数「按 A 和按 B 一个样」就是这么来的，所以必须让他看见。
   */
  const dupeLabels = duplicateLabels(PAD_ROWS.map(([b]) => draft[b]?.label ?? ''))

  /** 这一局有没有未保存的改动。只有动过的格子才有 press（见 draftFromLabels） */
  const dirty = PAD_ROWS.some(([b]) => Boolean(draft[b]?.press))

  /**
   * 「常用键」那排小按钮。
   *
   * 标签一律问适配器要（remap.preview），不在这一层写死 —— 换算表的唯一出处是
   * dosPad.ts，两处各写一份迟早会飘。顺带自动过滤掉不支持的键。
   */
  const quickKeys = remap
    ? QUICK_CODES.flatMap((code) => {
        const label = remap.preview({ code, key: '' })
        return label ? [[code, label] as const] : []
      })
    : []

  /** 选中行的显示名，给「给「↑」选一个键」那句话用 */
  const activeLabel = PAD_ROWS.find(([b]) => b === active)?.[1] ?? ''

  /**
   * 面板里的那一格。**用真的 input**，不是 div —— 手机上只有可编辑的输入框
   * 才会弹出系统键盘，而玩家要的就是「点一下 → 弹键盘 → 按一个键」。
   * 输入内容一律 preventDefault 掉，所以框里显示的永远是当前绑定的标签。
   */
  const captureKey = (button: PadButton, e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!remap) return
    // 这一下不能漏出去：漏给快捷键就是「一边改键一边把档存了」，漏给播放器就是触发了别的按钮
    e.preventDefault()
    e.stopPropagation()
    const press: PadKeyPress = { code: e.code, key: e.key }
    const label = remap.preview(press)
    if (!label) {
      setNote(t.player.padMap.unsupported)
      return
    }
    setNote('')
    setDraft((d) => ({ ...d, [button]: { press, label } }))
  }

  /** 点「常用键」：直接绑到当前选中那一行，不用弹键盘。手机上的方向键 / Ctrl 只能这么给 */
  const pickQuick = (code: string) => {
    if (!remap || !active) return
    const press: PadKeyPress = { code, key: '' }
    const label = remap.preview(press)
    if (!label) {
      setNote(t.player.padMap.unsupported)
      return
    }
    setNote('')
    setDraft((d) => ({ ...d, [active]: { press, label } }))
  }

  const draftFromLabels = () => {
    if (!remap) return {}
    const labels = remap.labels()
    const next: Partial<Record<PadButton, { press: PadKeyPress | null; label: string }>> = {}
    for (const [button] of PAD_ROWS) next[button] = { press: null, label: labels[button] ?? '' }
    return next
  }

  const openRemap = () => {
    if (!remap) return
    setDraft(draftFromLabels())
    setActive(null)
    setNote('')
    setRemapOpen(true)
    // 能点到这颗按钮，说明这一条他已经看见了，开局提示可以收
    onInput?.()
  }

  /**
   * 关面板。**有没保存的改动就先不关**，只提示一句。
   *
   * 遮罩点击和 Esc 走的都是这里 —— 玩家绑了五个键、手一滑点到旁边的黑边，
   * 整份改动就没了，而且他根本不知道刚才丢了什么。要放弃得自己点「取消」。
   */
  const closeRemap = () => {
    if (dirty) {
      setNote(t.player.padMap.unsaved)
      return
    }
    setRemapOpen(false)
  }

  /** 明确放弃这一份草稿 */
  const cancelRemap = () => {
    setRemapOpen(false)
    setNote('')
  }

  const saveRemap = () => {
    if (!remap) return
    // 只写真正动过的那些：没碰过的格子 press 是 null，不重复写一遍存储
    for (const [button] of PAD_ROWS) {
      const d = draft[button]
      if (d?.press) remap.bind(button, d.press)
    }
    setRemapOpen(false)
    setNote('')
  }

  const resetRemap = () => {
    if (!remap) return
    remap.reset()
    setDraft(draftFromLabels())
    setActive(null)
    setNote('')
  }

  /**
   * 面板走 portal 挂到 body。
   *
   * 两个原因，都不能省：
   *   1. 手柄根节点的 z-index 是 20，而弹幕层是 40 —— 留在原地会被弹幕糊在下面；
   *   2. 播放器里有些祖先带 backdrop-blur（= 会变成 fixed 定位的包含块），
   *      不 portal 的话 Modal 那个 `fixed inset-0` 会被算成「相对那块元素」。
   */
  const remapPanel =
    remap && remapOpen && typeof document !== 'undefined'
      ? createPortal(
          <Modal
            open
            onClose={closeRemap}
            title={t.player.padMap.title}
            size="sm"
            closeLabel={t.player.padMap.close}
          >
            <p className="text-xs leading-relaxed text-muted">{t.player.padMap.hint}</p>

            <div className="mt-3 grid grid-cols-2 gap-x-2 gap-y-1">
              {PAD_ROWS.map(([button, label]) => {
                const current = draft[button]?.label ?? ''
                const clash = current !== '' && dupeLabels.has(current)
                return (
                  <div
                    key={button}
                    /*
                      点整行 = 选中它。手指点**不聚焦输入框**（所以不弹键盘）——
                      键盘一弹起来正好盖住下面那排常用键，那条路就废了。
                      鼠标点则顺手把光标送进输入框，桌面上少点一次。
                    */
                    onPointerDown={(e) => {
                      setActive(button)
                      if (e.pointerType === 'touch') return
                      e.currentTarget.querySelector('input')?.focus()
                    }}
                    className={cx(
                      'flex items-center justify-between gap-2 rounded-md px-2 py-1 transition-colors',
                      active === button ? 'bg-brand-soft ring-1 ring-brand/40' : 'hover:bg-black/5',
                    )}
                  >
                    <span className="shrink-0 text-xs text-muted">{label}</span>
                    <input
                      value={current}
                      onChange={() => {}}
                      onKeyDown={(e) => captureKey(button, e)}
                      // 进焦点就全选：玩家再点一下是想换键，不是想在旧值上编辑
                      onFocus={(e) => {
                        setActive(button)
                        e.currentTarget.select()
                      }}
                      inputMode="text"
                      autoComplete="off"
                      autoCorrect="off"
                      spellCheck={false}
                      className={cx(
                        'w-20 min-w-0 rounded-md border bg-bg px-2 py-1 text-center font-mono text-[11px]',
                        clash ? 'border-coin text-coin' : 'border-line text-fg',
                      )}
                    />
                  </div>
                )
              })}
            </div>

            {dupeLabels.size > 0 && (
              <p className="mt-2 text-xs leading-relaxed text-coin">{t.player.padMap.conflict}</p>
            )}

            {/*
              常用键。手机上系统键盘给不出方向键和 Ctrl，这一排是唯一的办法；
              桌面上它也是个比「点框再按键」少一步的快捷方式。
            */}
            <p className="mt-3 text-xs leading-relaxed text-muted">
              {active ? fmt(t.player.padMap.pickFor, { row: activeLabel }) : t.player.padMap.pickHint}
            </p>
            <div className="mt-1 flex flex-wrap gap-1">
              {quickKeys.map(([code, label]) => (
                <button
                  key={code}
                  type="button"
                  disabled={!active}
                  onClick={() => pickQuick(code)}
                  className={cx(
                    'rounded-md border px-2 py-1 font-mono text-[11px] font-semibold transition-colors',
                    active
                      ? 'border-line text-fg hover:border-brand hover:text-brand'
                      : 'border-dashed border-line-strong text-dim',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {note && <p className="mt-2 text-xs leading-relaxed text-brand-hover">{note}</p>}

            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              {/* 没改过的局不显示「恢复默认」——按钮点了什么都不会变，只会让人以为坏了 */}
              {remap.customized() && (
                <button
                  type="button"
                  onClick={resetRemap}
                  className="rounded-md border border-line px-3 py-1.5 text-xs font-semibold text-fg hover:border-brand hover:text-brand"
                >
                  {t.player.padMap.reset}
                </button>
              )}
              {/* 有改动才给「取消」：没有改动时它和右上角那个叉没区别 */}
              {dirty && (
                <button
                  type="button"
                  onClick={cancelRemap}
                  className="rounded-md border border-line px-3 py-1.5 text-xs font-semibold text-muted hover:text-fg"
                >
                  {t.player.padMap.cancel}
                </button>
              )}
              <button
                type="button"
                onClick={saveRemap}
                className="rounded-md border border-brand bg-brand-soft px-4 py-1.5 text-xs font-bold text-brand-hover"
              >
                {t.player.padMap.save}
              </button>
            </div>
          </Modal>,
          document.body,
        )
      : null

  /**
   * 手柄角上那两颗小按钮：按键映射（只有 padRemap 存在时）+ 显示 / 隐藏。
   * 位置和以前那颗「▾」完全一致，只是多了一颗 —— 它们是同一个层级的东西，
   * 分成两个绝对定位会随长度错位。
   */
  const controls = (
    <div
      className={cx(
        'absolute flex items-center gap-1',
        inline ? 'right-1 top-1' : 'bottom-1 left-1/2 -translate-x-1/2',
      )}
    >
      {remap && (
        <button
          type="button"
          aria-label={t.player.padMap.title}
          onClick={openRemap}
          /*
            改过键位的局把这颗按钮点亮 —— 玩家下次进来一眼就知道「这局我调过键」，
            不用点开面板确认。（customized() 是一次同步的 localStorage 读，很便宜）
          */
          className={cx(MINI_BTN, remap.customized() && 'border-brand/60 text-brand-hover')}
        >
          {t.player.padMap.open}
        </button>
      )}
      <button
        type="button"
        aria-label={hidden ? t.player.padMap.show : t.player.padMap.hide}
        onClick={() => {
          // 点得到这颗按钮就说明他已经看见这一条了，开局提示可以收了
          onInput?.()
          setHidden((v) => !v)
        }}
        className={MINI_BTN}
      >
        {hidden ? '🎮' : '▾'}
      </button>
    </div>
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
        className={cx(
          'relative z-20 shrink-0 touch-none border-t border-line bg-black/40',
          highlight && 'animate-pad-pulse',
          className,
        )}
        style={PAD_STYLE}
      >
        {controls}
        {hidden ? (
          <div className="h-7" />
        ) : (
          <div
            className={cx(
              'flex w-full items-center gap-2 px-3 py-2',
              // 只有十字键的游戏（森林冰火人这类）把它摆中间，别孤零零贴在左边
              dpadOnly ? 'justify-center' : 'justify-between',
            )}
          >
            {hasDirs && dpad}
            {(has('select') || has('start')) && (
              <div className="flex flex-col items-center gap-1.5 pt-4">
                {sysButton('select', '')}
                {sysButton('start', '')}
              </div>
            )}
            {/* 斜排：容器给够高度，B 落左下、A 落右上。一颗都没有就别占这块宽度 */}
            {(has('a') || has('b')) && (
              <div className="relative" style={{ width: `calc(${FACE} * 2 + 0.5rem)`, height: `calc(${FACE} * 1.45)` }}>
                {faceButton('b', 'absolute bottom-0 left-0')}
                {faceButton('a', 'absolute right-0 top-0')}
              </div>
            )}
          </div>
        )}
        {remapPanel}
      </div>
    )
  }

  /* 浮层（全屏 / 桌面触屏机）：压在画面上，用百分比定位贴着四角 */
  return (
    <div
      data-testid="touchpad"
      className={cx('pointer-events-none absolute inset-0 z-20 touch-none', className)}
      style={PAD_STYLE}
    >
      {controls}
      {hidden ? null : (
        <>
          {hasDirs && dpad}
          {faceButton('b', 'absolute bottom-[10%] right-[26%]')}
          {faceButton('a', 'absolute bottom-[24%] right-[5%]')}
          {sysButton('select', 'absolute bottom-[8%] left-1/2 -translate-x-[115%]')}
          {sysButton('start', 'absolute bottom-[8%] left-1/2 translate-x-[15%]')}
        </>
      )}
      {remapPanel}
    </div>
  )
}
