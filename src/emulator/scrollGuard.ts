import { observeFrameDocs } from './frameDocs'
import { isTyping } from './hotkeyBridge'

/**
 * 玩着游戏按方向键，**页面自己往下滚**。
 *
 * ── 为什么会这样（2026-09-06 用 Playwright 在真 Chromium 上量的）─────────
 * 一直以为「焦点在 iframe 里，滚的就是 iframe」——不是。iframe 里的文档滚不动时，
 * 滚动会**跨 iframe 边界冒到父页面**去。实测（长页面 + 同源 srcdoc iframe，
 * 里面一个 canvas 拿着焦点、只监听 keydown 不拦默认行为）：
 *
 * | 场景 | iframe 收到键 | 父页面 scrollY |
 * |---|---|---|
 * | 焦点在 iframe 内的 canvas，按两下 ArrowDown | 收到 | **80**（每下 40px） |
 * | 同上，但 iframe 内 capture 阶段 preventDefault | 收到 | 0 |
 * | 焦点在外层工具栏按钮上，按一下 ArrowDown | — | 40 |
 *
 * 所以玩家看到的是「游戏有反应，页面也跟着滚」——引擎收到了键，只是没人拦默认行为。
 * 站上九个运行时里，只有红白机那条路（padKeyboard.ts，命中映射就 preventDefault）
 * 是拦了的，其余全漏；而且没映射到的键（比如 2P 的小键盘）连它也不拦。
 *
 * ── 为什么装在这里而不是各个 adapter 里 ────────────────────────────
 * 和 hotkeyBridge.ts 同一个道理：一处代码覆盖所有运行时，以后新加运行时自动生效。
 * 两边共用 frameDocs.ts 的扫描（外层 document + host 里所有 iframe 的文档）。
 *
 * ── 只 preventDefault，绝不 stopPropagation ─────────────────────────
 * 这里唯一的目的是掐掉浏览器的默认滚动。事件本身照常往下传：引擎要收、
 * 存读档快捷键要收、改键界面要收 —— 拦传播会把它们一起弄坏。
 */

/** 按下去会让页面滚的键。Space 在很多游戏里是跳/确认，恰恰也是最常按的那个 */
export const SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'Space',
])

export type ScrollKeyContext = {
  code: string
  ctrl?: boolean
  alt?: boolean
  meta?: boolean
  /** 事件落点是输入框 / 文本域 / 可编辑区 —— 玩家在打字 */
  editable?: boolean
  /** 事件落点是按钮、链接这类「空格 = 激活」的元素 */
  activatable?: boolean
  /** 页面上开着模态框（存读档、分享、登录…） */
  dialogOpen?: boolean
}

/**
 * 这一下该不该拦。抽成纯函数是为了能不开浏览器就测（scripts/test-scroll-guard.mjs）。
 *
 * 四种放行，每一种都是踩过的地方或者会踩的地方：
 *
 *  - **带 Ctrl / Alt / Cmd**：那是浏览器和系统的快捷键（Cmd+↓ 跳到底、Alt+← 后退），
 *    不是我们该管的。Shift 不在此列 —— 它在游戏里就是个普通键（连发/加速），
 *    而 Shift+Space 往上翻页恰恰要拦。
 *  - **玩家在打字**：评论框里按方向键是移光标，拦了就成了「输入框里光标动不了」。
 *  - **开着模态框**：存读档那张列表自己要能用方向键翻。
 *  - **焦点在按钮 / 链接上时的空格**：空格是它的激活键，拦了等于这颗按钮按不动
 *    （键盘操作的玩家会当场卡住）。方向键在按钮上没有激活语义，照拦不误 ——
 *    「点完工具栏按钮，焦点留在按钮上，方向键开始滚页面」正是最常见的那一种。
 */
export function blocksScroll(ctx: ScrollKeyContext): boolean {
  if (!SCROLL_KEYS.has(ctx.code)) return false
  if (ctx.ctrl || ctx.alt || ctx.meta) return false
  if (ctx.editable) return false
  if (ctx.dialogOpen) return false
  if (ctx.activatable && ctx.code === 'Space') return false
  return true
}

/** 空格会「按下去」的东西。用 closest：玩家点的往往是按钮里的那个图标 */
const ACTIVATABLE = 'button, a[href], summary, [role="button"], [role="link"], [role="menuitem"]'

function isActivatable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  return el.closest(ACTIVATABLE) !== null
}

/**
 * 页面上是不是开着模态框。
 *
 * 一律查**最外层** document：模态框（SaveLoadModal / ShareDialog / AuthModal）都画在页面上，
 * 而这个守卫可能是替 iframe 里的一次按键在做判断。
 */
function dialogOpen(): boolean {
  if (typeof document === 'undefined') return false
  return document.querySelector('[role="dialog"]') !== null
}

/**
 * 装上滚动守卫。游戏跑着的时候才装（见 EmulatorPlayer.tsx）——
 * 没在玩的时候方向键本来就该滚页面。
 *
 * @param host 播放器那一块 DOM；iframe 就在它里面
 * @returns 卸载函数
 */
export function installScrollGuard(host: HTMLElement | null | undefined): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    // 已经有人拦过了（红白机那条路、快捷键）就不重复插手
    if (e.defaultPrevented) return
    const target = e.target
    if (
      !blocksScroll({
        code: e.code,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        meta: e.metaKey,
        editable: isTyping(target),
        activatable: isActivatable(target),
        dialogOpen: dialogOpen(),
      })
    )
      return
    e.preventDefault()
  }

  /*
    捕获阶段：引擎自己也在文档上收键盘，冒泡阶段轮到我们时默认行为早就定了。
    （hotkeyBridge 也是捕获，它命中 F2 那类组合键时会 stopPropagation ——
    那些键不在 SCROLL_KEYS 里，两边不打架。）
  */
  return observeFrameDocs(host, (doc) => {
    doc.addEventListener('keydown', onKeyDown, true)
    return () => doc.removeEventListener('keydown', onKeyDown, true)
  })
}
