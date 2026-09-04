/**
 * Flash 键位表的回归测试。
 *
 * 盯的是三种**静默**失效 —— 它们在界面上一点痕迹都没有，玩家只会觉得「这按钮是坏的」：
 *   1. 键名拼错（'Arrowleft'、'W'、'Space' 当成 key）→ keyDesc 返回 null，按下去什么都不发生
 *   2. 按钮名拼错（写了 'jump' 而不是 'a'）→ 屏幕手柄上根本不画这颗，也没人报错
 *   3. 同一款游戏两个玩家撞到同一个键 → 同屏双打时两个角色一起动，最难查的一种
 *
 * 另外把「查不到就不给默认键位」这条决定钉住：Flash 里一大半是纯鼠标游戏，
 * 给不认识的游戏发一套方向键，等于在它们身上画一个按了没反应的十字键。
 *
 * 跑：npm run test:flash-keys
 */
import assert from 'node:assert/strict'

const { keyDesc, flashKeysFor, FLASH_KEYS, PRESET } = await import('../src/emulator/flashKeys.ts')

/** TouchPad 认得的全部按钮，和 types.ts 的 PadButton 保持一致 */
const BUTTONS = new Set(['up', 'down', 'left', 'right', 'a', 'b', 'select', 'start'])

/* ---------- 1. keyDesc：三副面孔都得对 ---------- */
assert.deepEqual(keyDesc('ArrowLeft'), { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 })
assert.deepEqual(keyDesc('KeyW'), { key: 'w', code: 'KeyW', keyCode: 87 })
assert.deepEqual(keyDesc('Digit1'), { key: '1', code: 'Digit1', keyCode: 49 })
// 空格的 key 是一个空格字符，不是 'Space' —— 写错了游戏收到的是个不存在的键
assert.equal(keyDesc('Space').key, ' ')
assert.equal(keyDesc('Space').keyCode, 32)

/* ---------- 2. 认不出来的键名必须返回 null，不能瞎猜 ---------- */
for (const bad of ['Arrowleft', 'W', 'space', 'Key1', 'Digit', '', 'ArrowLeftt']) {
  assert.equal(keyDesc(bad), null, `'${bad}' 不该被认出来`)
}

/* ---------- 3. 整张表走一遍：键名、按钮名、两个玩家不撞键 ---------- */
for (const [slug, keys] of Object.entries(FLASH_KEYS)) {
  assert.ok(keys.p1 && Object.keys(keys.p1).length, `${slug}: p1 不能是空的`)
  const used = new Map() // 键名 → 哪个玩家用了
  for (const [seat, pad] of [['p1', keys.p1], ['p2', keys.p2]]) {
    if (!pad) continue
    for (const [button, name] of Object.entries(pad)) {
      assert.ok(BUTTONS.has(button), `${slug}.${seat}: '${button}' 不是 PadButton`)
      assert.ok(keyDesc(name), `${slug}.${seat}.${button}: 认不出键名 '${name}'`)
      const before = used.get(name)
      assert.equal(before, undefined, `${slug}: ${before} 和 ${seat} 撞在同一个键 '${name}' 上，同屏双打会两个角色一起动`)
      used.set(name, seat)
    }
  }
}

/* ---------- 4. 查不到就是 null，绝不发默认键位 ---------- */
assert.equal(flashKeysFor(undefined), null, '没有 slug（玩家自己传的 SWF）不该有手柄')
assert.equal(flashKeysFor('这款不存在'), null, '表里没有的游戏不该有手柄')
assert.equal(flashKeysFor('local:我的游戏.swf'), null, '本地文件不该有手柄')

/* ---------- 5. 预设本身也得是合法键名 ---------- */
for (const [name, pad] of Object.entries(PRESET)) {
  for (const [button, key] of Object.entries(pad)) {
    assert.ok(BUTTONS.has(button), `PRESET.${name}: '${button}' 不是 PadButton`)
    assert.ok(keyDesc(key), `PRESET.${name}.${button}: 认不出键名 '${key}'`)
  }
}

console.log(`✅ Flash 键位表测试通过：keyDesc 三副面孔 / 表里 ${Object.keys(FLASH_KEYS).length} 款游戏的键名与按钮名 / 两个玩家不撞键 / 查不到不发默认键位`)
