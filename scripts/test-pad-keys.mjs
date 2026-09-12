// 红白机键盘键位（services/padKeys.ts）的单元测试。跑：npm run test:padkeys
//
// 最要紧的一条不是那些增删改，而是**默认表和 jsnes 自己的默认表语义一致** ——
// 我们把 jsnes 自带的键盘控制器停掉了、自己按 KeyboardEvent.code 重做了一份，
// 所以两边一旦漂移（升级 jsnes 时它挪了键），页面上写的和按下去的就不是一回事，
// 而 tsc 不会响、页面照样渲染。所以这里每次都去解析 jsnes 的源码再比对。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/** padKeys.ts 直接用 localStorage，node 里给个最小替身 */
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
  clear: () => store.clear(),
}

const {
  DEFAULT_PAD_KEYS,
  PAD_ACTIONS,
  bindingOf,
  getPadKeys,
  isPadBindable,
  padKeyFor,
  padKeyLabel,
  padKeysCustomized,
  parseBinding,
  resetPadKeys,
  setPadKey,
} = await import('../src/services/padKeys.ts')
const { DEFAULT_HOTKEYS } = await import('../src/services/hotkeys.ts')

let passed = 0
function check(name, fn) {
  store.clear()
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

/* ── 和 jsnes 的默认表对齐 ──────────────────────────────── */

/**
 * jsnes 用的是 e.keyCode，我们用的是 e.code。这张翻译表只覆盖它默认表里出现的那些键。
 *
 * ⚠️ keyCode 17 是 Ctrl，**左右不分** —— jsnes 把它标成 "Right Ctrl"，实际上按左 Ctrl
 * 一样会当 SELECT。我们绑的是 ControlRight，只认右边那颗：左 Ctrl 是浏览器一堆快捷键的
 * 前缀（Ctrl+W 关标签），让它同时是游戏键是个隐患。这算修掉了一个默认表的历史遗留，
 * 所以这一条要单独钉住，别哪天被"对齐 jsnes"给改回去。
 */
const KEYCODE_TO_CODE = {
  88: 'KeyX', 90: 'KeyZ', 89: 'KeyY', 13: 'Enter', 83: 'KeyS', 65: 'KeyA',
  38: 'ArrowUp', 40: 'ArrowDown', 37: 'ArrowLeft', 39: 'ArrowRight',
  97: 'Numpad1', 98: 'Numpad2', 99: 'Numpad3', 100: 'Numpad4',
  102: 'Numpad6', 103: 'Numpad7', 104: 'Numpad8', 105: 'Numpad9',
}
const BUTTON_TO_ACTION = {
  BUTTON_A: 'a', BUTTON_B: 'b', BUTTON_SELECT: 'select', BUTTON_START: 'start',
  BUTTON_UP: 'up', BUTTON_DOWN: 'down', BUTTON_LEFT: 'left', BUTTON_RIGHT: 'right',
  BUTTON_TURBO_A: 'turboA', BUTTON_TURBO_B: 'turboB',
}

const jsnesSrc = readFileSync(new URL('../node_modules/jsnes/src/browser/keyboard.js', import.meta.url), 'utf8')
const jsnesEntries = []
for (const m of jsnesSrc.matchAll(/(\d+):\s*\[(\d+),\s*Controller\.(\w+),\s*"([^"]*)"\]/g)) {
  jsnesEntries.push({ keyCode: Number(m[1]), player: Number(m[2]), button: m[3], label: m[4] })
}

check('jsnes 的默认表解析出来了', () => {
  assert.ok(jsnesEntries.length >= 19, `只解析到 ${jsnesEntries.length} 条，jsnes 的写法变了`)
})

/*
  ⚠️ 2026-09-12 起 **1P 不再照抄 jsnes 的键**：站里统一成左手 WASD + 右手 UIJK
  （和 EmulatorJS 那边的 EJS_KEY_OVERRIDE 同一套）。红白机按一套、别的平台按另一套，
  是最容易让人骂街的那种不一致。

  所以这里守的东西换了：不再逐个键比对，而是守**语义一致** ——
  jsnes 定义的每一个动作，在我们表里都还得有键绑着，一个都不能漏。
  漏掉的表现是那颗按钮**静默失灵**（页面照常渲染、tsc 不响），正是这份测试存在的理由。
  2P 那一组仍然逐条照抄 jsnes（小键盘，没跟着改）。
*/
check('jsnes 定义的每个动作，我们表里都有键绑着（1P 换了键，但一个动作都没丢）', () => {
  const bound = new Set(Object.values(DEFAULT_PAD_KEYS))
  for (const e of jsnesEntries) {
    const action = BUTTON_TO_ACTION[e.button]
    assert.ok(action, `不认识的按钮 ${e.button}`)
    const binding = bindingOf(e.player === 2 ? 1 : 0, action)
    assert.ok(bound.has(binding), `${binding}（jsnes: ${e.button}，${e.player}P）在默认表里没有键绑着`)
  }
})

check('2P 那一组仍然逐条照抄 jsnes（小键盘，这次没动）', () => {
  for (const e of jsnesEntries) {
    if (e.player !== 2) continue
    const code = KEYCODE_TO_CODE[e.keyCode]
    assert.ok(code, `keyCode ${e.keyCode}（${e.label}）没在翻译表里 —— jsnes 加了新键`)
    const expected = bindingOf(1, BUTTON_TO_ACTION[e.button])
    assert.equal(DEFAULT_PAD_KEYS[code], expected, `${code} 应当是 ${expected}`)
  }
})

check('⭐ 1P 就是参考图那一套：WASD 方向、K/J 动作、Shift 投币、Enter 开始', () => {
  const want = {
    KeyW: '0:up', KeyS: '0:down', KeyA: '0:left', KeyD: '0:right',
    KeyK: '0:a', KeyJ: '0:b', ShiftLeft: '0:select', Enter: '0:start',
    KeyI: '0:turboA', KeyU: '0:turboB',
  }
  for (const [code, binding] of Object.entries(want)) {
    assert.equal(DEFAULT_PAD_KEYS[code], binding, `${code} 应当是 ${binding}`)
  }
  // 老的那几颗必须真的让出来，否则一颗键绑两个动作，按一下同时触发两件事
  for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyX', 'KeyZ', 'KeyY', 'ControlRight']) {
    assert.equal(DEFAULT_PAD_KEYS[code], undefined, `${code} 还绑着 ${DEFAULT_PAD_KEYS[code]} —— 老键位没让干净`)
  }
})

check('⭐ 默认表里没有一颗键绑了两个动作', () => {
  const seen = new Map()
  for (const [code, binding] of Object.entries(DEFAULT_PAD_KEYS)) {
    assert.ok(!seen.has(code), `${code} 重复`)
    seen.set(code, binding)
  }
  // 反过来也查一遍：同一个动作被两颗键绑着是允许的（后路），但 1P 这次没有后路了
  const p1 = Object.entries(DEFAULT_PAD_KEYS).filter(([, b]) => b.startsWith('0:'))
  const actions = p1.map(([, b]) => b)
  assert.equal(new Set(actions).size, actions.length, `1P 有动作被两颗键绑着：${actions.join(', ')}`)
})

check('小键盘那八个键不再依赖 NumLock（用的是物理位置 code）', () => {
  for (const code of ['Numpad8', 'Numpad2', 'Numpad4', 'Numpad6', 'Numpad7', 'Numpad9', 'Numpad1', 'Numpad3']) {
    assert.match(DEFAULT_PAD_KEYS[code] ?? '', /^1:/, `${code} 应当归 2P`)
  }
})

check('B 只有一颗默认键（那条 QWERTZ 后路已经没有存在的理由了）', () => {
  /*
    以前 B 绑了两颗：KeyZ，外加 KeyY —— QWERTZ 键盘上印着 Z 的物理键报的是 KeyY，
    不补这一条，德国人按印着 Z 的键是没反应的。
    现在 B 是 J，而 J 在 QWERTZ 上**不挪位置**，这条后路就没有意义了。
    ⚠️ 哪天又把 B 挪回 Z / Y 这一带，记得把 KeyY 那条一起加回来。
  */
  const codes = Object.keys(DEFAULT_PAD_KEYS).filter((c) => DEFAULT_PAD_KEYS[c] === '0:b')
  assert.deepEqual(codes, ['KeyJ'])
  assert.equal(padKeyFor('0:b'), 'KeyJ')
})

check('1P 和 2P 的键没有重叠', () => {
  const seats = new Map()
  for (const [code, b] of Object.entries(DEFAULT_PAD_KEYS)) {
    const seat = b.split(':')[0]
    assert.ok(!seats.has(code) || seats.get(code) === seat, `${code} 被两个座位共用`)
    seats.set(code, seat)
  }
})

check('默认键位不和存读档快捷键的默认值撞', () => {
  const taken = new Set(Object.values(DEFAULT_HOTKEYS))
  for (const code of Object.keys(DEFAULT_PAD_KEYS)) {
    assert.ok(!taken.has(code), `${code} 同时是游戏键和存读档快捷键`)
  }
})

/* ── 可绑性 ─────────────────────────────────────────────── */

check('浏览器和系统抢走的键不给绑', () => {
  for (const code of ['F1', 'F5', 'F11', 'F12', 'Tab', 'Escape', 'MetaLeft', 'MetaRight', '']) {
    assert.equal(isPadBindable(code), false, `${code} 不该可绑`)
  }
})

check('修饰键本身可以当游戏按键（这点和 hotkeys.isBindable 不同）', () => {
  for (const code of ['ControlRight', 'ControlLeft', 'ShiftRight', 'AltRight', 'KeyQ', 'Numpad0', 'F2']) {
    assert.equal(isPadBindable(code), true, `${code} 该可绑`)
  }
})

check('牌子上的显示名', () => {
  assert.equal(padKeyLabel('KeyX'), 'X')
  assert.equal(padKeyLabel('Digit1'), '1')
  assert.equal(padKeyLabel('Numpad7'), 'Num 7')
  assert.equal(padKeyLabel('ArrowUp'), '↑')
  assert.equal(padKeyLabel('ControlRight'), 'R Ctrl')
  assert.equal(padKeyLabel('ShiftLeft'), 'L Shift')
  assert.equal(padKeyLabel('Enter'), 'Enter')
  assert.equal(padKeyLabel(''), '')
})

/* ── 改键 ───────────────────────────────────────────────── */

check('改一个键：新键生效，旧键让位', () => {
  assert.equal(setPadKey('0:a', 'KeyQ'), null)
  assert.equal(padKeyFor('0:a'), 'KeyQ')
  assert.equal(getPadKeys().KeyK, undefined, 'A 原来的 K 该让位了')
})

check('一个动作原有多个默认键时，改绑会把它们一起摘掉', () => {
  /*
    ⚠️ 这条测的是「一个动作绑了多颗键，改绑时要一起摘」的逻辑本身。
    1P 现在**没有**这种情况了（以前 B 有 Z 和 Y 两颗，见上面那条），
    所以拿 2P 的来测 —— 那一组仍然照抄 jsnes，而且逻辑是同一份代码。
  */
  setPadKey('0:b', 'KeyQ')
  const map = getPadKeys()
  assert.equal(map.KeyJ, undefined, 'B 原来的 J 该让位了')
  assert.equal(map.KeyQ, '0:b')
})

check('抢别人的键：返回被抢的那条，对方就此没键', () => {
  /*
    ⚠️ 以前 B 挂着 Z / Y 两颗，被抢走一颗还剩一颗，所以这条断言的是「还剩 Y」。
    现在 1P 每个动作只有一颗键（那条 QWERTZ 后路删了），抢走就是真没了。
  */
  const stolen = setPadKey('0:a', 'KeyJ')
  assert.equal(stolen, '0:b')
  assert.equal(padKeyFor('0:a'), 'KeyJ')
  assert.equal(padKeyFor('0:b'), '')
})

check('抢走对方唯一的那个键，对方就真没键了', () => {
  const stolen = setPadKey('0:b', 'Enter')
  assert.equal(stolen, '0:start')
  assert.equal(padKeyFor('0:start'), '')
})

check('反复改同一条，最后那次说了算（不能被更早存的那条抢回去）', () => {
  setPadKey('0:a', 'KeyQ')
  setPadKey('0:b', 'KeyP')
  setPadKey('0:a', 'KeyP')
  assert.equal(padKeyFor('0:a'), 'KeyP', '最后改的是 A，P 就该归 A')
  assert.equal(padKeyFor('0:b'), '')
})

check('把抢来的键还回去，被抢的那条自己回来（不用点恢复默认）', () => {
  setPadKey('0:b', 'Enter') // 从 Start 手里抢走 Enter
  assert.equal(padKeyFor('0:start'), '')
  setPadKey('0:b', 'KeyJ') // 还回默认
  assert.equal(padKeyFor('0:start'), 'Enter', 'Start 应当自己回到 Enter')
  assert.equal(padKeysCustomized(), false, '全回默认了就不该再留差量')
})

check('解绑：传空串', () => {
  setPadKey('0:turboA', '')
  assert.equal(padKeyFor('0:turboA'), '')
  assert.equal(padKeysCustomized(), true)
})

check('存的是差量，不是整张表', () => {
  setPadKey('0:a', 'KeyQ')
  const saved = JSON.parse(store.get('8bitgo.nes.keys'))
  assert.deepEqual(saved, { '0:a': 'KeyQ' }, '只该存改过的那一条')
})

check('改回默认值就把那条记录清掉', () => {
  setPadKey('0:a', 'KeyQ')
  assert.equal(padKeysCustomized(), true)
  setPadKey('0:a', 'KeyK') // A 的默认键
  assert.equal(padKeysCustomized(), false)
  assert.equal(store.get('8bitgo.nes.keys'), undefined)
})

check('恢复默认', () => {
  setPadKey('0:a', 'KeyQ')
  setPadKey('1:up', 'KeyI')
  resetPadKeys()
  assert.deepEqual(getPadKeys(), { ...DEFAULT_PAD_KEYS })
  assert.equal(padKeysCustomized(), false)
})

check('不给绑的键、不认识的绑定，一律拒绝且不写盘', () => {
  assert.equal(setPadKey('0:a', 'F5'), null)
  assert.equal(setPadKey('9:a', 'KeyQ'), null)
  assert.equal(setPadKey('0:nope', 'KeyQ'), null)
  assert.equal(padKeyFor('0:a'), 'KeyK')
  assert.equal(padKeysCustomized(), false)
})

check('存的是坏东西时逐条忽略，不整份丢掉', () => {
  store.set('8bitgo.nes.keys', JSON.stringify({ '0:a': 'KeyQ', '0:b': 42, 'bad:key': 'KeyP', '0:start': 'F11' }))
  assert.equal(padKeyFor('0:a'), 'KeyQ', '好的那条要生效')
  assert.equal(padKeyFor('0:b'), 'KeyJ', '值不是字符串的忽略')
  assert.equal(padKeyFor('0:start'), 'Enter', '不可绑的键忽略')
  assert.equal(getPadKeys().KeyP, undefined, '认不出的绑定忽略')
})

check('存的是坏 JSON 时退回默认，不抛异常', () => {
  store.set('8bitgo.nes.keys', '{not json')
  assert.deepEqual(getPadKeys(), { ...DEFAULT_PAD_KEYS })
})

check('parseBinding 认座位也认动作', () => {
  assert.deepEqual(parseBinding('1:up'), { seat: 1, action: 'up' })
  assert.equal(parseBinding('2:up'), null)
  assert.equal(parseBinding('0:jump'), null)
  assert.equal(parseBinding('nonsense'), null)
})

check('十个动作都在（连发别哪天被删了）', () => {
  assert.deepEqual([...PAD_ACTIONS].sort(), ['a', 'b', 'down', 'left', 'right', 'select', 'start', 'turboA', 'turboB', 'up'])
})

console.log(`\n✅ 红白机键位：${passed} 项检查通过`)
