/**
 * 让存 / 读档的快捷键在**游戏正开着的时候**也能按。
 *
 * ── 这件事难在哪 ───────────────────────────────────────────
 * 键盘事件只送给**有焦点的那个文档**。而玩家在玩的时候，焦点恰恰在模拟器那个 iframe 里
 * （EmulatorJS / Ruffle / J2ME / js-dos / html5 全跑在 iframe 里，而且我们还专门
 * 主动把焦点送进去，见 frameFocus.ts）——外层页面上挂 keydown 一个事件都收不到。
 * 也就是说：**只在 document 上监听的快捷键，只有在玩家没在玩的时候才管用**，
 * 这正好是最没用的那一半。
 *
 * 解法：iframe 是同源的（srcdoc / blob），所以从外面拿得到它的 contentDocument，
 * 在**两边**都挂上监听。jsnes 这类直接画在主文档里的运行时不受影响，走 document 那一路。
 *
 * ── 为什么不改各个 adapter ─────────────────────────────────
 * 让每个 adapter 把自己的 iframe 交出来要动六个文件，而 iframe 本来就在
 * mount() 拿到的那个容器里。从容器上找就行，一处代码覆盖所有运行时，
 * 以后新加运行时也自动生效。
 *
 * 「找出所有这些文档、并且跟着 iframe 一起换」那段现在在 frameDocs.ts ——
 * 滚动守卫（scrollGuard.ts）要用一模一样的一份。
 */
import { actionForCombo, comboOf, type HotkeyAction } from '@/services/hotkeys'
import { observeFrameDocs } from './frameDocs'

/** 正在打字的时候不能触发快捷键：玩家在评论框里按 F2 是想打字，不是想存档 */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName.toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
}

/**
 * 在 host 这一块（含它里面的 iframe）和整个页面上装快捷键。
 *
 * @param host 播放器那一块 DOM；iframe 就在它里面
 * @param run  命中某个动作时调这个
 * @returns 卸载函数
 */
export function installHotkeys(
  host: HTMLElement | null,
  run: (action: HotkeyAction) => void,
): () => void {
  let dead = false

  const onKey = (e: KeyboardEvent) => {
    if (dead || e.repeat || isTyping(e.target)) return
    const combo = comboOf({ ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, code: e.code })
    const action = actionForCombo(combo)
    if (!action) return
    // 拦下来：F2 之类在某些浏览器里有默认行为，不拦会一边存档一边触发它
    e.preventDefault()
    e.stopPropagation()
    run(action)
  }

  // 用捕获阶段：模拟器自己也在 document 上收键盘，冒泡阶段轮到我们时它已经处理过了
  const stop = observeFrameDocs(host, (doc) => {
    doc.addEventListener('keydown', onKey, true)
    return () => doc.removeEventListener('keydown', onKey, true)
  })

  return () => {
    dead = true
    stop()
  }
}
