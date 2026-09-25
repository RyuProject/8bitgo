/** GBA 整数缩放、三档 shader 与工具栏接线的回归守卫。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  GBA_ADDITIONAL_SHADERS,
  GBA_DEFAULT_VIDEO_MODE,
  GBA_LCD_SHADER_NAME,
  configureGbaVideo,
  gbaShaderForMode,
  gbaVideoStorageKey,
  readGbaVideoMode,
  writeGbaVideoMode,
} from '../src/emulator/gbaVideo.ts'

let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ❌ ${name}\n     ${e.message}`)
  }
}

check('默认档是零额外 GPU 成本的清晰像素', () => {
  assert.equal(GBA_DEFAULT_VIDEO_MODE, 'pixel')
  assert.equal(gbaShaderForMode('pixel'), 'disabled')
  assert.equal(gbaShaderForMode('smooth'), '2xScaleHQ.glslp')
  assert.equal(gbaShaderForMode('lcd'), GBA_LCD_SHADER_NAME)
})

check('整数缩放和禁双线性会覆盖旧值、去重并保持幂等', () => {
  const before = [
    'video_vsync = true',
    'video_smooth = true',
    'video_scale_integer = false',
    'video_scale_integer = false',
    '',
  ].join('\n')
  const once = configureGbaVideo(before)
  const twice = configureGbaVideo(once)
  assert.equal(once, [
    'video_vsync = true',
    'video_smooth = false',
    'video_scale_integer = true',
    '',
  ].join('\n'))
  assert.equal(twice, once)
})

check('缺少配置项时会补齐且不破坏原内容', () => {
  assert.equal(
    configureGbaVideo('audio_latency = 64\n'),
    'audio_latency = 64\nvideo_smooth = false\nvideo_scale_integer = true\n',
  )
})

check('画质选择按游戏隔离，坏值和存储异常安全退回默认', () => {
  const data = new Map()
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  }
  writeGbaVideoMode(storage, 'pokemon emerald', 'lcd')
  writeGbaVideoMode(storage, 'metroid-fusion', 'smooth')
  assert.equal(readGbaVideoMode(storage, 'pokemon emerald'), 'lcd')
  assert.equal(readGbaVideoMode(storage, 'metroid-fusion'), 'smooth')
  assert.notEqual(gbaVideoStorageKey('pokemon emerald'), gbaVideoStorageKey('metroid-fusion'))
  data.set(gbaVideoStorageKey('bad'), '4x-heavy')
  assert.equal(readGbaVideoMode(storage, 'bad'), 'pixel')
  assert.equal(readGbaVideoMode({ getItem: () => { throw new Error('denied') } }, 'x'), 'pixel')
  assert.doesNotThrow(() => writeGbaVideoMode({ setItem: () => { throw new Error('denied') } }, 'x', 'lcd'))
})

check('LCD shader 是单 pass、最近邻、资源自包含', () => {
  const entry = GBA_ADDITIONAL_SHADERS[GBA_LCD_SHADER_NAME]
  assert.match(entry.shader.value, /shaders = 1/)
  assert.match(entry.shader.value, /filter_linear0 = false/)
  assert.equal(entry.resources.length, 1)
  assert.equal(entry.resources[0].name, '8bitgo-gba-lcd.glsl')
  assert.match(entry.resources[0].value, /defined\(VERTEX\)/)
  assert.match(entry.resources[0].value, /defined\(FRAGMENT\)/)
  assert.match(entry.resources[0].value, /COMPAT_TEXTURE\(Texture, TEX0\.xy\)/)
})

const adapter = readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
const tools = readFileSync(new URL('../src/emulator/EmulatorTools.tsx', import.meta.url), 'utf8')
const engine = readFileSync(new URL('../public/emulatorjs/emulator.min.js', import.meta.url), 'utf8')

check('适配器只在 GBA 注入默认 shader、自定义 LCD 与整数缩放', () => {
  assert.match(adapter, /options\.platform === 'gba'[\s\S]{0,240}EJS_defaultOptions/)
  assert.match(adapter, /EJS_shaders: GBA_ADDITIONAL_SHADERS/)
  assert.match(adapter, /configureGbaScaling[\s\S]{0,2000}configureGbaVideo\(before\)/)
  assert.match(adapter, /configureGbaScaling\?\.\(emu\)/)
})

check('工具栏三档会即时写回运行时，不是只画了静态按钮', () => {
  assert.match(tools, /handle\.setGbaVideoMode\?\.\(item\.mode\)/)
  assert.match(tools, /mode: 'pixel'/)
  assert.match(tools, /mode: 'smooth'/)
  assert.match(tools, /mode: 'lcd'/)
})

check('当前自托管引擎确实带 2xScaleHQ，升级引擎不能静默丢掉', () => {
  assert.match(engine, /2xScaleHQ\.glslp/)
  assert.match(engine, /2xScaleHQ\.glsl/)
})

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
