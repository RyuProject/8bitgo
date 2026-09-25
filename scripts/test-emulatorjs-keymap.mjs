/**
 * EmulatorJS 真实键位回传 / 版本迁移回归。
 * 不启动 WASM，只测最容易静默出错的存储决策与键名转换。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const memory = new Map()
const events = new EventTarget()
const localStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
  clear: () => memory.clear(),
}

if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, init = {}) {
      super(type)
      this.detail = init.detail
    }
  }
}

globalThis.window = {
  localStorage,
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
}

const {
  emulatorJsKeyLabel,
  emulatorJsRelevantKeyIds,
  getEmulatorJsKeymap,
  onEmulatorJsKeymapChange,
  publishEmulatorJsKeymap,
  shouldMigrateEmulatorJsDefaults,
} = await import('../src/services/emulatorjsKeymap.ts')

const STORE_KEY = '8bitgo.emulatorjs.keymaps'
let passed = 0
const test = (name, fn) => {
  try {
    fn()
    passed++
    console.log(`  ✅ ${name}`)
  } catch (error) {
    console.log(`  ❌ ${name}`)
    throw error
  }
}

console.log('\nEmulatorJS 键位联动体检')

test('引擎键名会转成开始页可读的键帽', () => {
  assert.equal(emulatorJsKeyLabel('v'), 'V')
  assert.equal(emulatorJsKeyLabel('shift'), 'Shift')
  assert.equal(emulatorJsKeyLabel('left arrow'), '←')
  assert.equal(emulatorJsKeyLabel('numpad 3'), 'Num 3')
  assert.equal(emulatorJsKeyLabel('f10'), 'F10')
})

test('街机只同步真正会展示的按钮，包含投币和 Start', () => {
  const ids = emulatorJsRelevantKeyIds('arcade')
  assert.deepEqual(ids, [4, 5, 6, 7, 0, 8, 1, 9, 11, 10, 2, 3])
})

test('默认 V 回传后能被下次开始页读到', () => {
  memory.clear()
  publishEmulatorJsKeymap('kof97', 'arcade', { 2: 'V', 3: 'Enter', 4: 'W' })
  assert.equal(getEmulatorJsKeymap('kof97', 'arcade')?.[2], 'V')
  const entry = JSON.parse(memory.get(STORE_KEY)).entries['game:arcade:kof97']
  assert.equal(entry.customized, false)
  assert.equal(entry.defaultVersion, 1)
})

test('玩家把投币改成 Shift 会被标记为自定义并原样显示', () => {
  publishEmulatorJsKeymap('kof98', 'arcade', { 2: 'Shift', 3: 'Enter', 4: 'W' })
  assert.equal(getEmulatorJsKeymap('kof98', 'arcade')?.[2], 'Shift')
  const entry = JSON.parse(memory.get(STORE_KEY)).entries['game:arcade:kof98']
  assert.equal(entry.customized, true)
})

test('默认键位换代只迁移未自定义记录', () => {
  const store = JSON.parse(memory.get(STORE_KEY))
  store.entries['game:arcade:kof97'].defaultVersion = 0
  store.entries['game:arcade:kof98'].defaultVersion = 0
  memory.set(STORE_KEY, JSON.stringify(store))
  assert.equal(shouldMigrateEmulatorJsDefaults('kof97', 'arcade'), true)
  assert.equal(getEmulatorJsKeymap('kof97', 'arcade'), null)
  assert.equal(shouldMigrateEmulatorJsDefaults('kof98', 'arcade'), false)
  assert.equal(getEmulatorJsKeymap('kof98', 'arcade')?.[2], 'Shift')
})

test('键位变化会通知 React 组件立即重画', () => {
  let hits = 0
  const off = onEmulatorJsKeymapChange(() => hits++)
  publishEmulatorJsKeymap('mslug', 'arcade', { 2: 'V', 3: 'Enter' })
  off()
  assert.equal(hits, 1)
})

test('损坏的本地数据只退回默认键位，不抛错', () => {
  memory.set(STORE_KEY, '{bad json')
  assert.equal(getEmulatorJsKeymap('kof97', 'arcade'), null)
  assert.equal(shouldMigrateEmulatorJsDefaults('kof97', 'arcade'), false)
})

test('适配器在真实引擎读完设置后回传，改键保存也会再同步', () => {
  const adapter = readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
  assert.match(adapter, /if \(emuForKeys\) hookControlPersistence\(emuForKeys\)/)
  assert.match(adapter, /publishEmulatorJsKeymap\(options\.gameSlug, options\.platform, keys\)/)
  assert.match(adapter, /emu\.saveSettings = function \(\)/)
  assert.match(adapter, /scheduleKeyboardMapSync\(\)/)
})

test('自动迁移只替换键盘 value，不会清空手柄 value2 和连发设置', () => {
  const adapter = readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
  assert.match(adapter, /controls\[id\] = \{ \.\.\.controls\[id\], value: next \}/)
  const migration = adapter.slice(adapter.indexOf('const migrateDefaultKeyboard'), adapter.indexOf('const hookControlPersistence'))
  assert.doesNotMatch(migration, /value2\s*:/)
  assert.doesNotMatch(migration, /controls\s*=\s*JSON/)
})

test('开始页、详情页和工具栏都接上了实时键位链路', () => {
  const diagram = readFileSync(new URL('../src/emulator/PadDiagram.tsx', import.meta.url), 'utf8')
  const cards = readFileSync(new URL('../src/components/game/KeymapCards.tsx', import.meta.url), 'utf8')
  const tools = readFileSync(new URL('../src/emulator/EmulatorTools.tsx', import.meta.url), 'utf8')
  assert.match(diagram, /getEmulatorJsKeymap\(gameSlug, platform\)/)
  assert.match(diagram, /onEmulatorJsKeymapChange/)
  assert.match(cards, /getDefaultKeymap\(runtimeId, platform, effectiveKeys\)/)
  assert.match(tools, /handle\.resetControls/)
})

console.log(`\nEmulatorJS 键位联动体检通过：${passed} 项`)
