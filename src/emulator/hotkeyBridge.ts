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
 */
import { actionForCombo, comboOf, type HotkeyAction } from '@/services/hotkeys'

/** 正在打字的时候不能触发快捷键：玩家在评论框里按 F2 是想打字，不是想存档 */
function isTyping(target: EventTarget | null): boolean {
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
  /** 已经挂过监听的文档。iframe 换了要重挂，同一个别挂两遍 */
  const wired = new WeakSet<Document>()
  const cleanups: Array<() => void> = []
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

  const wire = (doc: Document | null | undefined) => {
    if (!doc || wired.has(doc)) return
    wired.add(doc)
    // 用捕获阶段：模拟器自己也在 document 上收键盘，冒泡阶段轮到我们时它已经处理过了
    doc.addEventListener('keydown', onKey, true)
    cleanups.push(() => doc.removeEventListener('keydown', onKey, true))
  }

  wire(typeof document === 'undefined' ? null : document)

  /**
   * iframe 那一侧。
   *
   * 要盯着它变：引擎会在挂载过程中换 src（甚至整个换掉 iframe 元素），
   * 只在装的时候挂一次，玩家真正开始玩之后那个文档往往已经是新的了。
   * load 事件负责「同一个 iframe 换了文档」，MutationObserver 负责「换了 iframe 元素」。
   */
  const scan = () => {
    if (dead || !host) return
    for (const frame of Array.from(host.querySelectorAll('iframe'))) {
      try {
        wire(frame.contentDocument)
      } catch {
        /* 跨源（目前没有这种运行时）：那一侧就没有快捷键，页面这一侧照常 */
      }
      if (!frame.dataset.hotkeyWatched) {
        frame.dataset.hotkeyWatched = '1'
        const onLoad = () => {
          try {
            wire(frame.contentDocument)
          } catch {
            /* 同上 */
          }
        }
        frame.addEventListener('load', onLoad)
        cleanups.push(() => frame.removeEventListener('load', onLoad))
      }
    }
  }

  scan()
  let observer: MutationObserver | null = null
  if (host && typeof MutationObserver === 'function') {
    observer = new MutationObserver(scan)
    observer.observe(host, { childList: true, subtree: true })
  }

  return () => {
    dead = true
    observer?.disconnect()
    for (const off of cleanups) off()
    cleanups.length = 0
  }
}
