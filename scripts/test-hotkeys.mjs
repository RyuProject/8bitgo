/**
 * 存 / 读档快捷键的自检（src/services/hotkeys.ts）。
 *
 * 快捷键最容易坏在两处，都是纯逻辑，值得钉死：
 *   · **同一个键被绑了两次** —— 按下去哪个动作赢全看遍历顺序，玩家看到的是「时灵时不灵」
 *   · **认不出按键** —— 用 key 而不是 code 的话，换个键盘布局或者开着输入法就对不上
 *
 * 用法：npm run test:hotkeys
 */
import assert from 'node:assert/strict'

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}

const {
  DEFAULT_HOTKEYS, HOTKEY_ACTIONS,
  actionForCombo, comboLabel, comboOf, getHotkeys, isBindable, onHotkeysChange, resetHotkeys, setHotkey,
} = await import('../src/services/hotkeys.ts')

let n = 0
const ok = (cond, msg) => { assert.ok(cond, msg); n++; console.log('✅ ' + msg) }
const reset = () => { store.clear() }

console.log('── 默认键位 ──')
ok(DEFAULT_HOTKEYS['save:local'] === 'F2' && DEFAULT_HOTKEYS['load:local'] === 'F4', '本地是老规矩 F2 存 / F4 读')
const used = HOTKEY_ACTIONS.map((a) => DEFAULT_HOTKEYS[a])
ok(new Set(used).size === used.length, `六个默认键位互不相同（${used.join(', ')}）`)
ok(!used.some((c) => /^(F1|F5|F11|F12)$/.test(c.split('+').pop())), '没有占用 F1/F5/F11/F12 这些浏览器抢走的键')

console.log('\n── 组合的规范化 ──')
ok(comboOf({ shift: true, code: 'F2' }) === 'Shift+F2', '修饰键在前')
ok(
  comboOf({ shift: true, ctrl: true, code: 'KeyS' }) === comboOf({ ctrl: true, shift: true, code: 'KeyS' }),
  '修饰键顺序固定（Ctrl+Shift 和 Shift+Ctrl 是同一个键）',
)
ok(comboOf({ code: '' }) === '', '没有键码就不是一个组合')

console.log('\n── 什么不能绑 ──')
ok(!isBindable('ShiftLeft') && !isBindable('Ctrl+ControlLeft'), '光按修饰键不算')
ok(!isBindable('F5') && !isBindable('F12') && !isBindable('Escape'), '浏览器抢走的键不收（绑了就是个按下去刷新页面的"快捷键"）')
ok(isBindable('Shift+F2') && isBindable('Ctrl+Alt+KeyS'), '正常组合可以绑')

console.log('\n── 显示成人看的样子 ──')
ok(comboLabel('KeyS') === 'S' && comboLabel('Digit1') === '1', 'KeyS → S、Digit1 → 1')
ok(comboLabel('Shift+F2') === 'Shift + F2', '组合用空格分开，好读')
ok(comboLabel('ArrowUp') === '↑', '方向键用箭头')

console.log('\n── 冲突：抢过来并说一声 ──')
reset()
const stolen = setHotkey('save:cloud', 'F2') // F2 默认是 save:local 的
ok(stolen === 'save:local', `抢了谁要报出来（实际 ${stolen}）`)
const after = getHotkeys()
ok(after['save:cloud'] === 'F2' && after['save:local'] === '', '被抢的那个变成未绑定，不是两个动作共用一个键')
ok(actionForCombo('F2') === 'save:cloud', '按 F2 现在只对应一个动作')
ok(setHotkey('load:file', 'Shift+F1') === null, '没冲突时返回 null')

console.log('\n── 解绑与恢复 ──')
reset()
setHotkey('save:local', '')
ok(getHotkeys()['save:local'] === '' && actionForCombo('F2') === null, '解绑之后这个键不再触发任何东西')
ok(setHotkey('save:local', 'F5') === null && getHotkeys()['save:local'] === '', '绑一个不能绑的键会被拒，原状不变')
resetHotkeys()
ok(getHotkeys()['save:local'] === 'F2', '恢复默认')

console.log('\n── 存的是差量 ──')
// 存整张表的话，以后改默认键位 / 加新动作，老玩家会被一张旧表钉死
reset()
setHotkey('save:file', 'Ctrl+KeyS')
const raw = JSON.parse(store.get('8bitgo.hotkeys'))
ok(Object.keys(raw).length === 1 && raw['save:file'] === 'Ctrl+KeyS', '只存改过的那一条')
setHotkey('save:file', DEFAULT_HOTKEYS['save:file'])
ok(!store.has('8bitgo.hotkeys'), '改回默认值之后那条记录也清掉')

console.log('\n── 脏数据 ──')
reset()
store.set('8bitgo.hotkeys', '{ 坏 JSON')
ok(getHotkeys()['save:local'] === 'F2', '坏 JSON 不炸，退回默认')
store.set('8bitgo.hotkeys', JSON.stringify({ 'save:local': 'F12', 'nope:x': 'F3' }))
const g = getHotkeys()
ok(g['save:local'] === 'F2', '存着一个不能绑的键 → 忽略，用默认')
ok(!('nope:x' in g), '不认识的动作名忽略')

console.log('\n── 改键要通知出去 ──')
// 游戏详情页那张「操作说明」表也在读这份绑定；不通知的话玩家改完键，表上还写着旧的
reset()
let hits = 0
const off = onHotkeysChange(() => { hits++ })
setHotkey('save:file', 'Ctrl+KeyS')
ok(hits === 1, '绑一个键 → 通知一次')
resetHotkeys()
ok(hits === 2, '恢复默认 → 也通知')
off()
setHotkey('save:file', 'Ctrl+KeyS')
ok(hits === 2, '退订之后不再收到')

// 一个监听者抛异常不该拖垮别的（React 里常见：组件已卸载但 cleanup 还没跑）
reset()
let good = 0
const offBad = onHotkeysChange(() => { throw new Error('boom') })
const offGood = onHotkeysChange(() => { good++ })
setHotkey('save:file', 'Ctrl+KeyD')
ok(good === 1, '一个监听者炸了，后面的照样收到')
offBad()
offGood()

console.log(`\n全部通过 ✅  共 ${n} 项`)
