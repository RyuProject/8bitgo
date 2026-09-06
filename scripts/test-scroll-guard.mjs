/**
 * 滚动守卫的自检（src/emulator/scrollGuard.ts）。
 *
 * 要钉死的是「什么时候**不**拦」——拦过头比漏拦更糟：
 *   · 评论框里按方向键移光标
 *   · 存读档那张列表用方向键翻
 *   · 焦点在按钮上时空格要能把按钮按下去
 * 还有一条容易反向写错的：Shift+Space 是往上翻页，**要拦**（Shift 在游戏里就是个普通键）。
 *
 * 用法：npm run test:scroll
 */
import assert from 'node:assert/strict'

/* services/hotkeys 在导入时就会读 localStorage（scrollGuard → hotkeyBridge → 它） */
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}

/** 假 document：只够 observeFrameDocs 挂监听、够守卫查模态框 */
let handlers = []
let dialog = null
globalThis.document = {
  addEventListener: (type, fn, capture) => handlers.push({ type, fn, capture }),
  removeEventListener: (_type, fn) => (handlers = handlers.filter((h) => h.fn !== fn)),
  querySelector: (sel) => (sel === '[role="dialog"]' ? dialog : null),
}

const { SCROLL_KEYS, blocksScroll, installScrollGuard } = await import('../src/emulator/scrollGuard.ts')

let n = 0
const ok = (cond, msg) => {
  assert.ok(cond, msg)
  n++
  console.log('✅ ' + msg)
}

console.log('── 该拦的 ──')
for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space']) {
  ok(blocksScroll({ code }), `${code} 会滚页面，拦`)
}
ok(SCROLL_KEYS.has('Space'), 'Space 在名单里（跳跃键，最常按）')
ok(blocksScroll({ code: 'Space', ctrl: false }) === true, 'Shift 不是放行条件：Shift+Space 往上翻页照拦')

console.log('── 不该拦的 ──')
ok(!blocksScroll({ code: 'KeyZ' }), '普通字母键不关我们的事')
ok(!blocksScroll({ code: 'F2' }), '快捷键交给 hotkeyBridge')
ok(!blocksScroll({ code: 'Enter' }), 'Enter 不滚页面，别插手')
for (const mod of ['ctrl', 'alt', 'meta']) {
  ok(!blocksScroll({ code: 'ArrowDown', [mod]: true }), `带 ${mod} 的是浏览器/系统快捷键，放行`)
}
ok(!blocksScroll({ code: 'ArrowDown', editable: true }), '玩家在打字：方向键移光标，放行')
ok(!blocksScroll({ code: 'ArrowDown', dialogOpen: true }), '开着模态框：存读档列表要能翻，放行')
ok(!blocksScroll({ code: 'Space', activatable: true }), '焦点在按钮上：空格是激活键，放行')
ok(blocksScroll({ code: 'ArrowDown', activatable: true }), '焦点在按钮上：方向键没有激活语义，照拦（点完工具栏就是这种）')

console.log('── 装上之后 ──')
const el = (tag, opts = {}) => ({
  tagName: tag,
  isContentEditable: false,
  closest: (sel) => (opts.inButton && sel.includes('button') ? { tagName: 'BUTTON' } : null),
})
const fire = (code, target, extra = {}) => {
  let prevented = false
  const e = {
    code,
    target,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    defaultPrevented: false,
    preventDefault: () => (prevented = true),
    stopPropagation: () => assert.fail('守卫不能拦传播：引擎和快捷键还等着这个键'),
    ...extra,
  }
  for (const h of handlers) if (h.type === 'keydown') h.fn(e)
  return prevented
}

const stop = installScrollGuard(null)
ok(handlers.length === 1 && handlers[0].capture === true, '挂在外层文档的捕获阶段')
ok(fire('ArrowDown', el('CANVAS')), '画面上按方向键：拦')
ok(!fire('ArrowDown', el('INPUT')), '输入框里按方向键：放行')
ok(!fire('ArrowDown', el('CANVAS'), { defaultPrevented: true }), '已经有人拦过了（红白机那条路）：不重复插手')
ok(!fire('Space', el('SPAN', { inButton: true })), '按钮里的图标上按空格：放行（closest 找得到按钮）')
dialog = { tagName: 'DIV' }
ok(!fire('ArrowDown', el('CANVAS')), '模态框开着：放行')
dialog = null
stop()
ok(handlers.length === 0, '卸载后一个监听都不剩')

console.log(`\n🎉 ${n} 项全过`)
