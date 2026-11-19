/**
 * MAME 麻将机（《龙虎争霸》这批）输入回归：npm run test:mahjong-panel
 *
 * 2026-11-19《龙虎争霸1》lhzb：本站给 EmulatorJS 的键盘默认是「键盘 → RetroPad」，
 * 而 MAME 的麻将键（A–N、吃碰杠听胡、押注 / 得分 / 比倍 / 大小）只认键盘 ——
 * 能投币开局，进了牌局一张牌都打不出去。这里守住：
 *   · 名单只收「麻将键无条件存在」的板子，靠 DIP 切摇杆的不收
 *   · 键盘桥：面板键放行 / 别名换码 / 其余（MAME 的 P 暂停、Tab 菜单、Esc）拦下，站内组合键不碰
 *   · 屏幕面板 / 手柄的短按也能让核心看到（最短按压时间），多来源同按一颗键时最后一个松手才松
 *   · 适配器、播放器、键位表、联机人数推断的接线
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { MAME_MAHJONG_PANEL_SETS, isMahjongPanelRomset, romsetFromKey } = await import('../shared/mahjong-panel-sets.js')
const {
  MAHJONG_GAMEPAD_MAP,
  MAHJONG_KEY_DEFS,
  MAHJONG_MIN_HOLD_MS,
  installMahjongKeyboard,
  isMahjongPanelGame,
  mahjongKeyCodes,
  mahjongKeyForCode,
} = await import('../src/emulator/mahjongPanel.ts')
const { GP } = await import('../src/emulator/gamepad.ts')

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- 名单与识别 ---------------- */

await check('名单：lhzb 一族在内，靠 DIP 切摇杆的 sdmg2 / mgcs / tarzan 不在', () => {
  for (const name of ['lhzb', 'lhzba', 'lhzb2', 'lhzb2a', 'lhzb3', 'lhb', 'xymg', 'lhdmg']) {
    assert.ok(MAME_MAHJONG_PANEL_SETS.includes(name), name)
  }
  for (const name of ['sdmg2', 'mgcs', 'tarzan', 'lhzb3sjb', 'kof97']) assert.equal(isMahjongPanelRomset(name), false, name)
  assert.equal(new Set(MAME_MAHJONG_PANEL_SETS).size, MAME_MAHJONG_PANEL_SETS.length, '名单不该有重复')
})

await check('ROM key / URL → romset：剥目录、.zip、.8bg、查询串', () => {
  assert.equal(romsetFromKey('roms/arcade/lhzb.zip'), 'lhzb')
  assert.equal(romsetFromKey('https://rom.8bitgo.com/roms/arcade/lhzb.zip.8bg?romv=abc#x'), 'lhzb')
  assert.equal(romsetFromKey('roms/LHZB.ZIP'), 'lhzb')
})

await check('只认 mame-current 上的街机', () => {
  assert.equal(isMahjongPanelGame('arcade', 'mame-current', ['roms/arcade/lhzb.zip']), true)
  assert.equal(isMahjongPanelGame('arcade', 'fbneo', ['roms/arcade/lhzb.zip']), false)
  assert.equal(isMahjongPanelGame('arcade', undefined, ['roms/arcade/lhzb.zip']), false)
  assert.equal(isMahjongPanelGame('nes', 'mame-current', ['roms/arcade/lhzb.zip']), false)
  assert.equal(isMahjongPanelGame('arcade', 'mame-current', ['roms/arcade/kof97.zip', undefined]), false)
})

/* ---------------- 键位 ---------------- */

await check('面板键对着 MAME 0.289 inpttype.ipp 的默认键 + libretro-mame 的投币 5 / 开始 1', () => {
  const expected = {
    a: 'KeyA', n: 'KeyN', chi: 'Space', pon: 'AltLeft', kan: 'ControlLeft', reach: 'ShiftLeft', ron: 'KeyZ',
    bet: 'Digit3', score: 'ControlRight', double: 'ShiftRight', big: 'Enter', small: 'Backspace', last: 'AltRight',
    start: 'Digit1', coin: 'Digit5',
  }
  for (const [key, code] of Object.entries(expected)) assert.equal(MAHJONG_KEY_DEFS[key].code, code, key)
  const mame = readFileSync(new URL('../src/emulator/mahjongPanel.ts', import.meta.url), 'utf8')
  assert.match(mame, /inpttype\.ipp/, '注释里要写明出处，改键位前先对源码')
})

await check('别名：V 投币、P 碰、S 得分；MAME 的 UI 键不在面板上', () => {
  assert.equal(mahjongKeyForCode('KeyV'), 'coin')
  assert.equal(mahjongKeyForCode('KeyP'), 'pon')
  assert.equal(mahjongKeyForCode('KeyS'), 'score')
  assert.equal(mahjongKeyForCode('KeyC'), 'c')
  for (const code of ['Tab', 'Escape', 'F2', 'F3', 'F10', 'KeyW', 'KeyQ', 'Digit4', 'Digit0', 'Digit9', 'Backquote', 'Insert', 'PageDown']) {
    assert.equal(mahjongKeyForCode(code), null, code)
  }
  assert.deepEqual(mahjongKeyCodes('pon'), ['AltLeft', 'KeyP'])
  assert.deepEqual(mahjongKeyCodes('big'), ['Enter'], '小键盘 Enter 只是兜底，不往键位表上写')
})

/* ---------------- 键盘桥（假 DOM） ---------------- */

class FakeKeyboardEvent extends Event {
  constructor(type, init = {}) {
    super(type, init)
    this.code = init.code ?? ''
    this.key = init.key ?? ''
    this.keyCode = init.keyCode ?? 0
    this.repeat = Boolean(init.repeat)
    this.metaKey = Boolean(init.metaKey)
    this.ctrlKey = Boolean(init.ctrlKey)
    this.target0 = init.target0
  }
}

function setup(opts = {}) {
  const win = new EventTarget()
  win.KeyboardEvent = FakeKeyboardEvent
  win.setTimeout = (fn, ms) => setTimeout(fn, ms)
  win.clearTimeout = (id) => clearTimeout(id)
  const parent = new EventTarget()
  let clock = 0
  const bridge = installMahjongKeyboard(parent, win, { now: () => clock, ...opts })
  /** 「RetroArch」：bridge 之后注册的普通监听，看到的就是核心收到的 */
  const core = []
  for (const type of ['keydown', 'keyup', 'keypress']) parent.addEventListener(type, (e) => core.push(`${e.type}:${e.code}`))
  const key = (type, code, extra = {}) => {
    const e = new FakeKeyboardEvent(type, { code, cancelable: true, bubbles: true, ...extra })
    parent.dispatchEvent(e)
    return e
  }
  return { win, parent, bridge, core, key, tick: (ms) => { clock += ms } }
}

await check('原生面板键原样放行给核心，并取消浏览器默认行为（空格滚页、Backspace）', () => {
  const { core, key } = setup()
  const e = key('keydown', 'KeyC')
  const s = key('keydown', 'Space')
  assert.deepEqual(core, ['keydown:KeyC', 'keydown:Space'])
  assert.equal(e.defaultPrevented, true)
  assert.equal(s.defaultPrevented, true)
})

await check('别名换成原生键码：核心看见 AltLeft，永远看不见 P（MAME 里 P 是暂停）', () => {
  const { core, key } = setup()
  key('keydown', 'KeyP')
  key('keyup', 'KeyP')
  assert.equal(core[0], 'keydown:AltLeft')
  assert.ok(!core.some((c) => c.endsWith(':KeyP')))
})

await check('面板外的键（Tab / Esc / F3 / W 退分）不进核心，也不拦浏览器默认行为', () => {
  const { core, key } = setup()
  for (const code of ['Tab', 'Escape', 'F3', 'KeyW', 'Digit4']) {
    const e = key('keydown', code)
    assert.equal(e.defaultPrevented, false, code)
  }
  assert.deepEqual(core, [])
})

await check('Cmd / Ctrl 组合键是浏览器的：不进核心、不 preventDefault；单按 Ctrl 仍是杠', () => {
  const { core, key } = setup()
  const reload = key('keydown', 'KeyR', { metaKey: true })
  const copy = key('keydown', 'KeyC', { ctrlKey: true })
  assert.equal(reload.defaultPrevented, false)
  assert.equal(copy.defaultPrevented, false)
  key('keydown', 'ControlLeft', { ctrlKey: true })
  assert.deepEqual(core, ['keydown:ControlLeft'])
})

await check('引擎弹窗 / 输入框开着时完全让开', () => {
  const { core, key } = setup({ passThrough: () => true })
  const e = key('keydown', 'Tab')
  assert.deepEqual(core, ['keydown:Tab'])
  assert.equal(e.defaultPrevented, false)
})

await check('屏幕面板短按也撑够最短按压时间，核心一帧都不会错过', async () => {
  const { core, bridge, tick } = setup()
  bridge.press('coin', true)
  bridge.press('coin', false)
  assert.deepEqual(core, ['keydown:Digit5'], '松开要延后')
  await wait(MAHJONG_MIN_HOLD_MS + 30)
  assert.deepEqual(core, ['keydown:Digit5', 'keyup:Digit5'])
  // 按够了时长就立刻松
  bridge.press('bet', true)
  tick(MAHJONG_MIN_HOLD_MS + 1)
  bridge.press('bet', false)
  assert.deepEqual(core.slice(2), ['keydown:Digit3', 'keyup:Digit3'])
})

await check('多来源同按一颗键：最后一个松手才松开；同一来源重复按下不重发', async () => {
  const { core, bridge, tick } = setup()
  bridge.press('chi', true, 'pad')
  bridge.press('chi', true, 'pad')
  bridge.press('chi', true, 'gamepad')
  tick(500)
  bridge.press('chi', false, 'pad')
  assert.deepEqual(core, ['keydown:Space'])
  bridge.press('chi', false, 'gamepad')
  assert.deepEqual(core, ['keydown:Space', 'keyup:Space'])
})

await check('失焦松开键盘按着的键（浏览器不会补 keyup）', () => {
  const { core, key, win, tick } = setup()
  key('keydown', 'KeyZ')
  key('keydown', 'KeyS')
  tick(500)
  win.dispatchEvent(new Event('blur'))
  assert.ok(core.includes('keyup:KeyZ'), core.join())
  assert.ok(core.includes('keyup:ControlRight'), core.join())
})

await check('dispose 之后不再拦截，也不再派发', () => {
  const { core, key, bridge } = setup()
  bridge.dispose()
  key('keydown', 'KeyP')
  bridge.press('coin', true)
  assert.deepEqual(core, ['keydown:KeyP'], '卸掉后事件原样经过，桥不再换码')
})

/* ---------------- 手柄 ---------------- */

await check('手柄：A 出牌、左右选牌；Start / Select 留给引擎的 RetroPad', () => {
  assert.equal(MAHJONG_GAMEPAD_MAP[GP.A], 'discard')
  assert.equal(MAHJONG_GAMEPAD_MAP[GP.LEFT], 'prev')
  assert.equal(MAHJONG_GAMEPAD_MAP[GP.RIGHT], 'next')
  assert.equal(MAHJONG_GAMEPAD_MAP[GP.START], undefined)
  assert.equal(MAHJONG_GAMEPAD_MAP[GP.SELECT], undefined)
  const tokens = new Set(Object.values(MAHJONG_GAMEPAD_MAP))
  for (const k of ['chi', 'pon', 'kan', 'reach', 'ron', 'bet', 'score', 'double', 'big', 'small']) assert.ok(tokens.has(k), k)
})

/* ---------------- 接线 ---------------- */

const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

await check('适配器：按最终 romset 判、开局后打开键盘直通、收掉引擎手柄、卸载时清理', () => {
  const a = src('../src/emulator/adapters/emulatorjs.ts')
  assert.match(a, /mahjongPanel = options\.platform === 'arcade' && isMahjongPanelRomset\(mameRomset\)/)
  assert.match(a, /changeSettingOption\?\.\('keyboardInput', 'enabled', true\)/, '键盘直通只写 allSettings，不持久化')
  assert.match(a, /changeSettingOption\?\.\('altKeyboardInput', 'enabled', true\)/)
  assert.match(a, /if \(mahjongPanel\) installMahjongInput\(win\)/)
  assert.match(a, /if \(mahjongPanel\) \{\s*emu\.toggleVirtualGamepad\?\.\(false\)/)
  assert.match(a, /caps\.delete\('remapKeys'\)\s*caps\.add\('mahjongPad'\)/)
  assert.match(a, /mahjongKeyboard\?\.dispose\(\)/)
  assert.match(a, /mahjongGamepad\?\.stop\(\)/)
})

await check('开局 / 工具栏操作后焦点交回引擎 parent（键盘监听都挂在那儿，<body> 上谁也收不到）', () => {
  const a = src('../src/emulator/adapters/emulatorjs.ts')
  assert.match(a, /const focusEngine = \(\) => \{\s*focusFrame\(iframe\)\s*try \{\s*emuOf\(\)\?\.elements\?\.parent\?\.focus\(\{ preventScroll: true \}\)/)
  assert.match(a, /focus: \(\) => focusEngine\(\),/)
  assert.match(a, /见 frameFocus\.ts。\s*\*\/\s*focusEngine\(\)/, 'finishStart 里不能再只交给 iframe')
})

await check('播放器：触屏 + mahjongPad 才画麻将面板，懒加载走 importWithRetry', () => {
  const p = src('../src/emulator/EmulatorPlayer.tsx')
  assert.match(p, /const showMahjongPad = status === 'running' && touchDevice && caps\.has\('mahjongPad'\)/)
  assert.match(p, /importWithRetry\(loadMahjongPad, mahjongPadChunk/)
  assert.match(p, /mahjongPanel=\{isMahjongPanelGame\(/, '开局前的按键图也要换成麻将面板')
  const d = src('../src/pages/GameDetailPage.tsx')
  assert.match(d, /mahjongPanel=\{isMahjongPanelGame\(platform\.id, game\.core/)
})

await check('键位表：麻将机不摆 RetroPad 那张表，也不摆 2P', () => {
  const k = src('../src/lib/emulator.ts')
  const from = k.indexOf("if (platform === 'arcade' && mahjongPanel)")
  assert.ok(from > 0)
  const body = k.slice(from, k.indexOf("if (platform === 'arcade') {", from))
  assert.match(body, /rebind: 'none'/)
  assert.doesNotMatch(body, /player2/)
  assert.ok(from < k.indexOf("if (platform === 'arcade') {"), '麻将分支必须排在通用街机前面')
})

await check('联机人数：麻将机推断成 1 人', () => {
  const s = src('../server/src/netplay-auto.js')
  assert.match(s, /isMahjongPanelRomset\(n\)\)\) return 1/)
})

await check('八种语言都有麻将面板的文案', () => {
  for (const lang of ['zh-Hans', 'zh-Hant', 'en', 'ja', 'es', 'fr', 'de', 'it']) {
    const text = src(`../src/locales/${lang}.ts`)
    for (const key of ['mjTiles', 'mjChi', 'mjPon', 'mjKan', 'mjReach', 'mjRon', 'mjBet', 'mjScore', 'mjDouble', 'mjBig', 'mjSmall', 'mjNote', 'mahjongCursor', 'leftAlt', 'space']) {
      assert.match(text, new RegExp(`\\b${key}: '`), `${lang}.${key}`)
    }
  }
})

console.log(`\n麻将面板输入回归：${passed} 项全过`)
