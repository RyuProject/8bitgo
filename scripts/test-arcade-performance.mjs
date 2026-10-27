/** 街机稳帧策略回归：不启动 WASM，钉住最容易被“全平台优化”误伤的适用边界。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const {
  arcadePerformanceDefaultOptions,
  effectiveArcadeButtons,
  FBNEO_ARCADE_AUDIO_BUFFER_BYTES_48K,
  FBNEO_ARCADE_AUDIO_LATENCY_MS,
  isLightArcadeCore,
} = await import('../src/emulator/arcadePerformance.ts')
const { repairLegacyArcadeKeyCollisions } = await import('../src/services/emulatorjsKeymap.ts')

let passed = 0
const test = (name, fn) => {
  fn()
  passed++
  console.log(`  ✅ ${name}`)
}

console.log('\n街机性能与输入体检')

test('Metal Slug X 在强机上使用重度去降速档，同时保持帧跳关闭', () => {
  const options = arcadePerformanceDefaultOptions('arcade', 'fbneo', 'metal-slug-x-super-vehicle-001', 8)
  assert.equal(options['fbneo-cpu-speed-adjust'], '150%')
  assert.equal(options['fbneo-frameskip-type'], 'disabled')
  assert.equal(options['fbneo-samplerate'], '44100')
  assert.equal(options['fbneo-sample-interpolation'], '2-point 1st order')
  assert.equal(options['fbneo-allow-depth-32'], 'disabled')
})

test('低端双线程设备只做保守去降速，避免优化反而压垮宿主', () => {
  const options = arcadePerformanceDefaultOptions('arcade', 'fbneo', 'metal-slug-x-super-vehicle-001', 2)
  assert.equal(options['fbneo-cpu-speed-adjust'], '110%')
})

test('普通 FBNeo 街机也启用全站去降速，但不冒险关闭 32 位色深', () => {
  const options = arcadePerformanceDefaultOptions('arcade', 'fbneo', 'kof97', 8)
  assert.equal(options['fbneo-cpu-speed-adjust'], '130%')
  assert.equal(options['fbneo-samplerate'], '44100')
  assert.equal(options['fbneo-allow-depth-32'], undefined)
})

test('玩家本地 ROM 没有 slug 时仍得到全站 FBNeo 优化', () => {
  const options = arcadePerformanceDefaultOptions('arcade', 'fbneo', undefined, 4)
  assert.equal(options['fbneo-cpu-speed-adjust'], '120%')
})

test('MAME 2003 系只启用安全的宿主加速，不伪造全局 CPU 超频', () => {
  assert.deepEqual(arcadePerformanceDefaultOptions('arcade', 'mame2003_plus', 'mk', 8), {
    'mame2003-plus_frameskip': '0',
    'mame2003-plus_sample_rate': '44100',
  })
  assert.deepEqual(arcadePerformanceDefaultOptions('arcade', 'mame2003', 'mk', 8), {
    mame2003_dcs_speedhack: 'enabled',
    mame2003_frameskip: '0',
    mame2003_sample_rate: '44100',
  })
  assert.deepEqual(arcadePerformanceDefaultOptions('arcade', 'mame-current', 'mk', 8), {})
  // 触屏设备：线程数不可信（千元机也报 8 线程），只给轻微超频余量
  assert.equal(arcadePerformanceDefaultOptions('arcade', 'fbneo', 'kof97', 8, true)['fbneo-cpu-speed-adjust'], '100%')
  assert.equal(arcadePerformanceDefaultOptions('arcade', 'fbneo', 'metal-slug-x-super-vehicle-001', 8, true)['fbneo-cpu-speed-adjust'], '110%')
  assert.deepEqual(arcadePerformanceDefaultOptions('gba', 'fbneo', 'kof97', 8), {})
})

test('80ms 音频窗口覆盖全部轻量街机核心，mame-current 继续单独走 128ms', () => {
  assert.equal(isLightArcadeCore('arcade', 'fbneo'), true)
  assert.equal(isLightArcadeCore('arcade', 'mame2003'), true)
  assert.equal(isLightArcadeCore('arcade', 'mame2003_plus'), true)
  assert.equal(isLightArcadeCore('arcade', 'mame-current'), false)
})

test('Neo Geo 缺少后台按钮数时按四键推断，明确配置仍优先', () => {
  assert.equal(effectiveArcadeButtons(undefined, 'NeoGeo'), 4)
  assert.equal(effectiveArcadeButtons(2, 'neogeo'), 2)
  assert.equal(effectiveArcadeButtons(undefined, 'pgm'), 6)
})

test('旧 J/K/I 右摇杆撞键会迁移，玩家其它自定义保持不动', () => {
  const controls = {
    0: { value: 74, value2: 'BUTTON_2' },
    8: { value: 75 },
    9: { value: 73 },
    20: { value: 76 },
    21: { value: 74, value2: 'AXIS_0_NEG' },
    22: { value: 75 },
    23: { value: 73 },
  }
  const defaults = {
    20: { value: 39 },
    21: { value: 37 },
    22: { value: 40 },
    23: { value: 38 },
  }
  assert.deepEqual(repairLegacyArcadeKeyCollisions(controls, defaults), [21, 22, 23])
  assert.equal(controls[21].value, 37)
  assert.equal(controls[21].value2, 'AXIS_0_NEG')
  assert.equal(controls[20].value, 76)
})

test('没有撞键的自定义右摇杆不会被覆盖', () => {
  const controls = { 0: { value: 74 }, 21: { value: 65 } }
  assert.deepEqual(repairLegacyArcadeKeyCollisions(controls, { 21: { value: 37 } }), [])
  assert.equal(controls[21].value, 65)
})

test('FBNeo 音频窗口只增加一帧左右，48kHz 日志字节数可核对', () => {
  assert.equal(FBNEO_ARCADE_AUDIO_LATENCY_MS, 80)
  assert.equal(FBNEO_ARCADE_AUDIO_BUFFER_BYTES_48K, 30_720)
})

test('适配器、开局键位图和操作说明共用四键推断', () => {
  const src = readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
  const keymap = readFileSync(new URL('../src/lib/emulator.ts', import.meta.url), 'utf8')
  const cards = readFileSync(new URL('../src/components/game/KeymapCards.tsx', import.meta.url), 'utf8')
  const diagram = readFileSync(new URL('../src/emulator/PadDiagram.tsx', import.meta.url), 'utf8')
  assert.match(src, /EJS_defaultOptions: defaults/)
  // 改版包指纹会把核心纠正成 fbneo：默认值必须按最终核心重算，不能沿用挂载时旧核心那份
  assert.match(src, /core === coreDefaultOptionsCore \? coreDefaultOptions : coreDefaultOptionsFor\(core\)/)
  assert.match(src, /effectiveArcadeButtons\(options\.arcadeButtons(?: \?\? namcoSet\?\.buttons)?, options\.biosSet\?\.name\)/)
  assert.match(src, /repairLegacyArcadeKeyCollisions\(emu\.controls\?\.\[0\]/)
  assert.match(src, /FBNEO_ARCADE_AUDIO_LATENCY_MS/)
  assert.match(keymap, /arcadeButtonIdsFor\(arcadeCore\)\.slice\(0, arcadeButtons \?\? 6\)/)
  assert.match(cards, /effectiveArcadeButtons\(arcadeButtons, arcadeBios\) : undefined,\s*\n\s*core,/)
  assert.match(diagram, /effectiveArcadeButtons\(arcadeButtons, arcadeBios\) : undefined,\s*\n\s*core,/)
})

console.log(`\n街机性能与输入体检通过：${passed} 项`)
