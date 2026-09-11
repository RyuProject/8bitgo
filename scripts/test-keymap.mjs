/**
 * 「操作说明」那张键位表对不对 —— 直接拿引擎自己的源码来核（src/lib/keymapData.ts）。
 *
 * 这张表是从别人的代码里抄出来的常量：抄错了 tsc 不响、页面照样渲染，
 * 只有玩家按下去才发现按错键，升级 EmulatorJS 的时候尤其容易悄悄失效。
 * 所以这个测试不写死期望值，而是**每次都去解析 emulator.min.js** 再比对。
 *
 * 核三件事：
 *   1. 默认键（`this.defaultControllers[0]`）—— libretro 下标 → 键名
 *   2. **每个平台有哪几颗键**（`createControlSettingMenu` 里各控制方案的按钮表）。
 *      这一条最要命：不在本方案里的下标会被引擎从映射表里整个删掉（那个函数结尾的
 *      `for(let t=0;t<30;t++)` 循环），摆出来就是**按了没反应的死键**。
 *      踩过的：N64 抄成 A=8 / B=0（引擎是 A=0 / B=1，8 在 N64 方案里根本不存在）、
 *      WonderSwan 摆了一颗 Select（那台机器没有 Select，下标 2 同样被删）。
 *   3. 快速存 / 读档名单（QUICK_SAVE_RUNTIMES）和各 adapter 的 caps 对不对得上 ——
 *      对不上的后果是「操作说明」摆出一对按了没用的 F2 / F4。
 *
 * ⚠️ 红白机（jsnes）那一半在 scripts/test-pad-keys.mjs。
 * ⚠️ 街机那两套（ARCADE_*）是**核心**决定的，不是引擎，这里只能核「键存在」；
 *    映射本身的出处见 keymapData.ts 里那段注释（FBNeo 的 retro_input.{cpp,h}）。
 *
 * 用法：npm run test:keymap
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const {
  EJS_KEY_BY_ID,
  EJS_INDEX,
  EJS_SCHEME,
  EJS_PLATFORM_BUTTONS,
  ARCADE_GENERIC_BUTTONS,
  ARCADE_FIGHTER_BUTTONS,
  QUICK_SAVE_RUNTIMES,
} = await import('../src/lib/keymapData.ts')

let n = 0
const ok = (cond, msg) => { assert.ok(cond, msg); n++; console.log('✅ ' + msg) }

const ejsSrc = readFileSync(new URL('../public/emulatorjs/emulator.min.js', import.meta.url), 'utf8')

/* ── 1. 默认键 ──────────────────────────────────────────────
 * 打包后长这样：this.defaultControllers={0:{0:{value:"x",value2:"BUTTON_2"},1:{...},...},1:{},...}
 * 只取玩家 0 的那一段，按 `<下标>:{value:"<键>"` 抓出来。 */
const at = ejsSrc.indexOf('this.defaultControllers={')
assert.ok(at > 0, '在 emulator.min.js 里找不到 defaultControllers —— 打包格式变了，这个测试要跟着改')
const defaults = {}
for (const m of ejsSrc.slice(at, at + 1800).matchAll(/(\d+):\{value:"([^"]*)"/g)) {
  if (!(m[1] in defaults)) defaults[m[1]] = m[2]
}
ok(Object.keys(defaults).length >= 14, `解析出 ${Object.keys(defaults).length} 个默认键位`)

// 引擎存的是 "x" / "enter" / "up arrow" 这种小写名，我们表里是给人看的 'X' / 'Enter' / '↑'
const ARROWS = { 'up arrow': '↑', 'down arrow': '↓', 'left arrow': '←', 'right arrow': '→' }
const norm = (s) => (ARROWS[s] ?? s).toLowerCase()

console.log('\n── 1. EmulatorJS 的默认键位 ──')
for (const [id, key] of Object.entries(EJS_KEY_BY_ID)) {
  const actual = defaults[id]
  ok(
    actual !== undefined && norm(actual) === norm(key),
    `libretro ${id} = ${key}${actual !== undefined && norm(actual) === norm(key) ? '' : `，引擎里其实是 ${JSON.stringify(actual)}`}`,
  )
}
ok(EJS_INDEX.a === 8 && EJS_INDEX.b === 0, 'libretro 的 0 是 B、8 才是 A（别抄反）')

/* ── 2. 各平台有哪几颗键 ────────────────────────────────────
 * createControlSettingMenu 里是一长串三元表达式：
 *   "gb"===this.getControlScheme()?i=[{id:8,label:...},...]:"nes"===...?(i=[...],...):i="snes"===...?[...]:...
 * 最后一个 `:` 后面那张是**通用方案**（街机走的就是它，只把下标 2 的标签换成 INSERT COIN）。
 * 办法：找到每个 `"名字"===this.getControlScheme()`，从它后面第一个 `[` 起做括号配对。 */
const menuAt = ejsSrc.indexOf('createControlSettingMenu(){let t=[]')
assert.ok(menuAt > 0, '找不到 createControlSettingMenu —— 打包格式变了，这个测试要跟着改')
const menu = ejsSrc.slice(menuAt, menuAt + 20000)

/** 从 from 起找第一个 `[`，做括号配对，返回 [数组文本, 结束下标] */
function readArray(src, from) {
  const start = src.indexOf('[', from)
  assert.ok(start > 0, '解析控制方案时找不到数组起点')
  let depth = 0
  for (let i = start; i < src.length; i++) {
    if (src[i] === '[') depth++
    else if (src[i] === ']' && --depth === 0) return [src.slice(start, i + 1), i + 1]
  }
  throw new Error('解析控制方案时括号没配上')
}

/** 数组文本 → { 下标: 标签 } */
const idsOf = (text) => {
  const out = {}
  for (const m of text.matchAll(/\{id:(\d+),label:this\.localization\("([^"]*)"\)/g)) out[m[1]] = m[2]
  return out
}

const schemes = {}
const tokens = [
  ...menu.matchAll(/"(\w+)"===this\.getControlScheme\(\)/g),
  ...menu.matchAll(/\[((?:"\w+",?)+)\]\.includes\(this\.getControlScheme\(\)\)/g),
].sort((a, b) => a.index - b.index)
let lastEnd = 0
for (const tok of tokens) {
  const names = tok[1].includes('"') ? tok[1].match(/"(\w+)"/g).map((s) => s.slice(1, -1)) : [tok[1]]
  const [text, end] = readArray(menu, tok.index + tok[0].length)
  // ["arcade","mame"] 那一条不带自己的数组（只是把通用表里下标 2 的标签换掉），跳过
  if (names.includes('arcade')) continue
  for (const name of names) schemes[name] = idsOf(text)
  lastEnd = end
}
// 最后一个方案后面紧跟着的 `:[...]` 就是通用方案
const [genericText] = readArray(menu, lastEnd)
schemes.__generic__ = idsOf(genericText)

ok(Object.keys(schemes).length > 10, `解析出 ${Object.keys(schemes).length - 1} 套控制方案 + 通用方案`)
ok(schemes.gba?.['8'] === 'A' && schemes.gba?.['0'] === 'B', 'gba 方案：8=A、0=B（解析结果说得通）')
ok(schemes.n64?.['0'] === 'A' && schemes.n64?.['8'] === undefined, 'n64 方案：0 才是 A，8 根本不存在')

/** 我们给玩家看的名字 vs 引擎的标签。差别只在大小写 / 全半角 / 说法的，列在这里 */
const ALIAS = {
  '✕': 'ｘ',
  MODE: 'MODE',
}
const sameLabel = (mine, theirs) =>
  theirs !== undefined &&
  (mine.toLowerCase() === theirs.toLowerCase() || (ALIAS[mine] ?? '').toLowerCase() === theirs.toLowerCase())

console.log('\n── 2. 各平台的按钮表 ──')
for (const [platform, buttons] of Object.entries(EJS_PLATFORM_BUTTONS)) {
  const schemeName = EJS_SCHEME[platform]
  ok(Boolean(schemeName), `${platform} 在 EJS_SCHEME 里写了控制方案名`)
  const scheme = schemes[schemeName]
  ok(Boolean(scheme), `${platform} → 引擎的 "${schemeName}" 方案解析到了`)
  for (const [label, id] of buttons) {
    const ids = Array.isArray(id) ? id : [id]
    for (const one of ids) {
      ok(
        scheme[String(one)] !== undefined,
        `${platform} 的「${label}」用了下标 ${one}，它在 ${schemeName} 方案里${scheme[String(one)] !== undefined ? `（引擎叫 ${scheme[String(one)]}）` : ' —— 不存在！引擎会把它删掉，摆出来就是死键'}`,
      )
      ok(EJS_KEY_BY_ID[one] !== undefined, `${platform} 的下标 ${one} 有默认键（${EJS_KEY_BY_ID[one]}）`)
    }
    // 名字不是 `#xxx`（要翻译的行名）、也不是方向组的，就顺手核一下叫得对不对
    if (!label.startsWith('#') && !Array.isArray(id)) {
      ok(
        sameLabel(label, scheme[String(id)]),
        `${platform} 的「${label}」和引擎的「${scheme[String(id)]}」是同一颗（下标 ${id}）`,
      )
    }
  }
}

console.log('\n── 3. 街机 ──')
for (const id of ARCADE_GENERIC_BUTTONS) {
  ok(schemes.__generic__[String(id)] !== undefined, `街机「按键」用的下标 ${id} 在通用方案里（引擎叫 ${schemes.__generic__[String(id)]}）`)
  ok(EJS_KEY_BY_ID[id] !== undefined, `街机下标 ${id} 有默认键（${EJS_KEY_BY_ID[id]}）`)
}
ok(new Set(ARCADE_GENERIC_BUTTONS).size === 6, '街机通用表正好六个按键，且不重复')
const fighterIds = Object.values(ARCADE_FIGHTER_BUTTONS)
ok(new Set(fighterIds).size === 6, '三拳三脚正好六个按键，且不重复')
for (const id of fighterIds) {
  ok(schemes.__generic__[String(id)] !== undefined, `三拳三脚用的下标 ${id} 在通用方案里`)
}
ok(
  new Set([...ARCADE_GENERIC_BUTTONS, ...fighterIds]).size === 6,
  '两套街机映射用的是同六颗键，只是分工不同（FBNeo 的 FIRE01..06 和 COL_TOP/BOTTOM 都落在这六颗上）',
)
ok(schemes.__generic__['2'] !== undefined, '投币用的下标 2 在通用方案里（引擎会把它的标签换成 INSERT COIN）')

/* ── 4. 快速存 / 读档名单 ────────────────────────────────── */
console.log('\n── 4. 快速存 / 读档（F2 / F4）装不装得上 ──')
const ADAPTERS = ['emulatorjs', 'ruffle', 'html5', 'jsnes', 'j2me', 'jsdos', 'webretro', 'play', 'cloudgame', 'liveview']
for (const id of ADAPTERS) {
  const src = readFileSync(new URL(`../src/emulator/adapters/${id}.ts`, import.meta.url), 'utf8')
  // caps 里出现 saveState 的两种写法：初始化时列进 new Set，或后来 caps.add
  const has =
    /caps\.add\('saveState'\)/.test(src) ||
    /new Set<Capability>\(\[[^\]]*'saveState'/.test(src)
  const listed = QUICK_SAVE_RUNTIMES.includes(id)
  ok(
    has === listed,
    `${id}：adapter ${has ? '有' : '没有'} saveState，名单里${listed ? '有' : '没有'}它`,
  )
}

/* ── 5. 行名有没有对应的文案 ────────────────────────────────
 * 表里 `#xxx` 那种名字是运行时去 t.keymap 里取的（见 lib/emulator.ts 的 label()），
 * 取不到会**原样显示成 "stick"**，tsc 查不出来。zh-Hans 是文案的唯一事实来源，
 * 其余语言的键集由 tsc 保证和它一致。 */
console.log('\n── 5. 行名对得上文案吗 ──')
const { zhHans } = await import('../src/locales/zh-Hans.ts')
const needed = new Set()
for (const buttons of Object.values(EJS_PLATFORM_BUTTONS)) {
  for (const [label] of buttons) if (label.startsWith('#')) needed.add(label.slice(1))
}
for (const key of [...needed].sort()) {
  ok(typeof zhHans.keymap[key] === 'string', `t.keymap.${key} 有文案（${zhHans.keymap[key]}）`)
}

/* ---------------- 街机的屏幕手柄 ---------------- */
{
  console.log('\n── 街机屏幕手柄（EJS_VirtualGamepadSettings）──')
  /*
    为什么要钉这条：引擎的 setVirtualGamepad() 按 getControlScheme() 分支，
    而那张表里**根本没有 arcade / mame** —— 街机会落进最后那个 else，拿到一套 SNES 布局。后果：
      · 按键 5/6（libretro R=11、L=10）屏幕上不存在 → 手机上六键格斗的重拳重脚永远出不来
        （拳皇是四键，刚好够用，所以只测拳皇发现不了）
      · zone 摇杆用 30ms 定时器松方向、且从不 clearTimeout → 握住对角线会被松掉，波动拳搓不出
      · 投币键标成 localization("Select") =「选择」→ 街机不投币按 Start 没反应，新手直接劝退
    所以适配器必须自带一份。这里核它和 keymapData 那张表对得上。
  */
  const adapter = readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
  const code = adapter.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

  ok(/EJS_VirtualGamepadSettings:\s*ARCADE_VIRTUAL_PAD/.test(code), '街机注入了自己的屏幕手柄布局')
  ok(/options\.platform === 'arcade' \?/.test(code), '只给街机注入，别的平台仍用引擎默认')

  const from = code.indexOf('const ARCADE_VIRTUAL_PAD')
  const body = code.slice(from, code.indexOf('\n]', from) + 2)

  const inputs = [...body.matchAll(/input_value:\s*(\d+)/g)].map((m) => Number(m[1]))
  const want = [...ARCADE_GENERIC_BUTTONS, EJS_INDEX.select, EJS_INDEX.start]
  const sorted = (a) => JSON.stringify([...a].sort((x, y) => x - y))
  ok(sorted(inputs) === sorted(want), `六颗动作键 + 投币 + Start，一个不多一个不少（${inputs.join(',')}）`)
  for (const id of ARCADE_GENERIC_BUTTONS) ok(inputs.includes(id), `键位表里的 libretro ${id} 屏幕上有对应按钮`)

  ok(/type: 'dpad'/.test(body), '方向走 dpad —— zone 那条会把对角线松掉')
  ok(!/type: 'zone'/.test(body), '没有用 zone')
  ok(/inputValues: \[4, 5, 6, 7\]/.test(body), 'dpad 的四个方向是 4/5/6/7')
  ok(/text: 'INSERT COIN'/.test(body), "投币键的 text 是 'INSERT COIN'（引擎过 localization() → 中文「投币」）")
  ok(ejsSrc.includes('INSERT COIN'), '引擎侧确实认 INSERT COIN 这个词条')

  // 摆位：上排三拳、下排三脚 —— 六键格斗的拳脚各占一排，和真机一致
  const top = [...body.matchAll(/top: 0,[^}]*input_value:\s*(\d+)/g)].map((m) => Number(m[1]))
  const bottom = [...body.matchAll(/top: 70,[^}]*input_value:\s*(\d+)/g)].map((m) => Number(m[1]))
  const f = ARCADE_FIGHTER_BUTTONS
  ok(JSON.stringify(top) === JSON.stringify([f.punchL, f.punchM, f.punchH]), `上排从左到右 = 轻拳 中拳 重拳（${top.join(',')}）`)
  ok(JSON.stringify(bottom) === JSON.stringify([f.kickL, f.kickM, f.kickH]), `下排从左到右 = 轻脚 中脚 重脚（${bottom.join(',')}）`)
}

/* ---------------- 开局前那行键位摘要 ---------------- */
{
  console.log('\n── 键位摘要不能把投币和 Start 切掉 ──')
  const player = readFileSync(new URL('../src/emulator/EmulatorPlayer.tsx', import.meta.url), 'utf8')
  ok(
    !/\.rows\.slice\(0,\s*5\)/.test(player),
    '⭐ 不许再用 slice(0,5) —— 街机 9 行表正好只留下方向键+按键1~4，把唯一「不知道就开不了始」的投币和 Start 切掉',
  )
  ok(/rows\.slice\(-2\)/.test(player), '摘要保留末两行（各平台都是 Start/Select 在末尾）')
}

console.log(`\n全部通过 ✅  共 ${n} 项`)
