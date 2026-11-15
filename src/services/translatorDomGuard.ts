/**
 * 浏览器整页翻译（Edge / Chrome 自带翻译、各种翻译插件）与 React 的 DOM 冲突兜底。
 *
 * ## 为什么要这个（2026-11-15，大陆 Edge 157 / Windows 两份现场）
 *
 * 翻译器会把文本节点**挪进**它自己插的 `<font>` 包装里。React 不知道，之后要删 / 插这个
 * 文本节点时仍以原父元素调用 `removeChild` / `insertBefore`，浏览器抛
 * `NotFoundError: The node to be removed is not a child of this node`，整页崩到兜底页。
 * 现场是侧栏房间数徽标（SidebarCounts）在「0」和「• N」两种形态之间切换时撞上的，
 * 但任何会增删文本节点的组件都可能撞（facebook/react#11538，React 官方不打算修）。
 *
 * 做法：只在「节点已不是直接子节点」这一异常分支里纠正，正常路径一字不改：
 * - removeChild：节点还在本元素子树里（被包了一层）就从它真正的父节点上删；已经不在就当删过了。
 * - insertBefore：参照节点被包了一层，就改用它在本元素下的那层祖先当参照；找不到则追加到末尾。
 */
let installed = false
let warned = false

function warnOnce(op: string) {
  if (warned) return
  warned = true
  // 用 warn 而不是 error：这是已被纠正的情况，不该进启动诊断的错误日志
  console.warn(`[8bitgo] ${op}: DOM 被页面翻译等外部脚本改过，已自动纠正`)
}

export function installTranslatorDomGuard(proto: typeof Node.prototype | undefined = globalThis.Node?.prototype) {
  if (installed || !proto) return
  installed = true

  const origRemove = proto.removeChild
  proto.removeChild = function <T extends Node>(this: Node, child: T): T {
    if (child && child.parentNode !== this) {
      warnOnce('removeChild')
      const parent = child.parentNode
      if (parent && this.contains(child)) return origRemove.call(parent, child) as T
      return child
    }
    return origRemove.call(this, child) as T
  }

  const origInsert = proto.insertBefore
  proto.insertBefore = function <T extends Node>(this: Node, node: T, ref: Node | null): T {
    if (ref && ref.parentNode !== this) {
      warnOnce('insertBefore')
      let anchor: Node | null = ref
      while (anchor && anchor.parentNode !== this) anchor = anchor.parentNode
      return origInsert.call(this, node, anchor) as T
    }
    return origInsert.call(this, node, ref) as T
  }
}
