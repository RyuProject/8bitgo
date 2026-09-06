/**
 * 「把监听装到播放器涉及的**每一个**文档上」这件事。
 *
 * 播放器里的运行时大多跑在 iframe 里（EmulatorJS / Ruffle / html5 / J2ME / webretro），
 * 而键盘事件只送给**有焦点的那个文档** —— 只在外层 document 上挂监听，玩家真正在玩的时候
 * 一个事件都收不到（原委见 hotkeyBridge.ts 开头）。iframe 是同源的（srcdoc / blob），
 * 从外面拿得到 contentDocument，所以两边一起挂。
 *
 * 还得盯着它变：引擎在挂载过程中会换 src，甚至整个换掉 iframe 元素。
 * `load` 管「同一个 iframe 换了文档」，MutationObserver 管「换了 iframe 元素」。
 *
 * 这段本来长在 hotkeyBridge.ts 里，scrollGuard.ts 需要一模一样的一份 —— 各写各的
 * 以后新加运行时只改一处就会漏，所以抽出来。
 *
 * 抽的时候顺手修了一处：原来用 `iframe.dataset.hotkeyWatched` 标记「这个 iframe 挂过了」，
 * 卸载时只摘监听、没清标记，同一个 iframe 元素再装一次就会被跳过。现在改成每次安装
 * 自己的 WeakSet —— 也因此两个使用者不会互相顶掉对方的 load 监听。
 */

/**
 * 在 host 里里外外所有文档上装点东西。
 *
 * @param host 播放器那一块 DOM；iframe 就在它里面。为 null 时只装外层 document
 * @param wire 每发现一个文档调一次，返回卸载函数
 * @returns 卸载函数（把所有文档上的都摘掉）
 */
export function observeFrameDocs(
  host: HTMLElement | null | undefined,
  wire: (doc: Document) => (() => void) | void,
): () => void {
  /** 已经装过的文档。iframe 换了要重装，同一个别装两遍 */
  const wiredDocs = new WeakSet<Document>()
  /** 已经盯上的 iframe 元素（盯的是它换文档） */
  const watchedFrames = new WeakSet<HTMLIFrameElement>()
  const cleanups: Array<() => void> = []
  let dead = false

  const add = (doc: Document | null | undefined) => {
    if (dead || !doc || wiredDocs.has(doc)) return
    wiredDocs.add(doc)
    const off = wire(doc)
    if (off) cleanups.push(off)
  }

  add(typeof document === 'undefined' ? null : document)

  const scan = () => {
    if (dead || !host) return
    for (const frame of Array.from(host.querySelectorAll('iframe'))) {
      try {
        add(frame.contentDocument)
      } catch {
        /* 跨源（目前没有这种运行时）：那一侧装不上，外层照常 */
      }
      if (watchedFrames.has(frame)) continue
      watchedFrames.add(frame)
      const onLoad = () => {
        try {
          add(frame.contentDocument)
        } catch {
          /* 同上 */
        }
      }
      frame.addEventListener('load', onLoad)
      cleanups.push(() => frame.removeEventListener('load', onLoad))
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
