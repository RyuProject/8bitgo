/** NDS WASM 崩溃回退回归：只认确定的陷阱，且只从新核心切换一次。 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isNdsWasmCrash, ndsCrashFallbackCore } from '../src/emulator/ndsCrash.ts'
import { NDS_MODERN_CORE_BUILD, ndsRomIdentity, rememberNdsCoreFailure, rememberedNdsCore } from '../src/emulator/ndsCorePreference.ts'
import { EJS_WEBGL2_ONLY_CORES, ejsCoreNeedsWebgl2, emulatorJsCoreForGame, NDS_COMPAT_CORE, ndsCoreForWebgl2 } from '../src/emulator/paths.ts'
import { readdirSync } from 'node:fs'

const root = fileURLToPath(new URL('../', import.meta.url))
const cores = join(root, 'public/emulatorjs/cores')
const modernReport = JSON.parse(readFileSync(join(cores, 'reports/melondsds.json'), 'utf8'))
assert.ok(modernReport.sha256.startsWith(NDS_MODERN_CORE_BUILD), '新版核心改变时必须让旧失败记录失效')

assert.equal(isNdsWasmCrash('Uncaught RuntimeError: unreachable at wasm-function[2361]:0x1a46fb'), true)
assert.equal(isNdsWasmCrash('RuntimeError: memory access out of bounds'), true)
assert.equal(isNdsWasmCrash('unreachable', { name: 'RuntimeError', message: 'unreachable' }), true)
assert.equal(isNdsWasmCrash('unreachable', { name: 'TypeError', message: 'unreachable' }), false)
assert.equal(isNdsWasmCrash('Failed to load state'), false)
// 新核心启动时的空函数指针崩溃：以前漏接，播放器会重试并挨个换语言 ROM，始终不切旧 melonDS。
for (const message of [
  'null function',
  'null function or function signature mismatch',
  'function signature mismatch',
  'table index is out of bounds',
  'indirect call to null', // Firefox
  'indirect call signature mismatch', // Firefox
  'unreachable executed', // Firefox
  'index out of bounds', // Firefox
  'call_indirect to a null table entry', // Safari
  'Unreachable code should not be executed', // Safari
  'Out of bounds memory access', // Safari
  'divide by zero',
  'integer overflow',
  'Aborted(OOM)',
]) {
  assert.equal(isNdsWasmCrash('', { name: 'RuntimeError', message }), true, `RuntimeError: ${message} 必须触发兼容核心回退`)
  assert.equal(isNdsWasmCrash(`Uncaught RuntimeError: ${message}\n    at wasm://wasm/0123:wasm-function[42]:0x1`), true, `控制台文本里的 ${message} 也要认`)
}
assert.equal(isNdsWasmCrash('Uncaught RuntimeError: null function\n    at wasm://wasm/010ade7a:wasm-function[7]:0x1'), true)
assert.equal(isNdsWasmCrash('', { name: 'TypeError', message: 'null function' }), false, 'JS 层 TypeError 不是 WASM 陷阱')
assert.equal(isNdsWasmCrash('', { name: 'RuntimeError', message: 'something unrelated' }), false)
assert.equal(isNdsWasmCrash('RuntimeError: game log says hello'), false)
assert.equal(isNdsWasmCrash('Warning: RuntimeError was mentioned in a log'), false)

assert.equal(ndsCrashFallbackCore('melondsds', true, false), NDS_COMPAT_CORE)
assert.equal(ndsCrashFallbackCore('melondsds', false, false), null)
assert.equal(ndsCrashFallbackCore('melondsds', true, true), null)
assert.equal(ndsCrashFallbackCore('melonds', true, false), null)
assert.equal(ndsCrashFallbackCore('desmume', true, false), null)

const values = new Map()
const storage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => { values.set(key, value) },
}
const rom = 'https://assets.8bitgo.com/roms/nds/pokemon-white.nds?romv=abc'
assert.equal(rememberedNdsCore(rom, storage, 1000), null)
rememberNdsCoreFailure(rom, storage, 1000)
assert.equal(rememberedNdsCore(rom, storage, 1001), NDS_COMPAT_CORE)
assert.equal(rememberedNdsCore(rom.replace('abc', 'def'), storage, 1001), null)
assert.equal(rememberedNdsCore(rom, storage, 1000 + 31 * 24 * 60 * 60 * 1000), null)
assert.equal(ndsRomIdentity('https://assets.8bitgo.com/roms/nds/pokemon-white.nds'), null)
rememberNdsCoreFailure('https://assets.8bitgo.com/roms/nds/pokemon-white.nds', storage, 1000)
assert.equal(rememberedNdsCore('https://assets.8bitgo.com/roms/nds/pokemon-white.nds', storage, 1001), null)
const localRom = { name: 'pokemon-white.nds', size: 268_435_456, lastModified: 1234 }
rememberNdsCoreFailure(localRom, storage, 1000)
assert.equal(rememberedNdsCore(localRom, storage, 1001), NDS_COMPAT_CORE)
assert.equal(rememberedNdsCore({ ...localRom, lastModified: 1235 }, storage, 1001), null)

// 重复失败与大量不同 ROM 不应无限扩张 localStorage；页面从禁用存储中也能正常开局。
for (let i = 0; i < 40; i++) rememberNdsCoreFailure(`${rom}&variant=${i}`, storage, 1000 + i)
assert.equal(JSON.parse([...values.values()][0]).length, 32)
rememberNdsCoreFailure(rom, null, 1000)
assert.equal(rememberedNdsCore(rom, null, 1000), null)

// 历史数据库值不应因为新增兜底而悄悄从新核心退回旧核心。
assert.equal(emulatorJsCoreForGame('nds', 'melonds'), 'melondsds')
assert.equal(emulatorJsCoreForGame('nds', NDS_COMPAT_CORE), 'melonds')
for (const name of ['melonds-wasm.data', 'melonds-legacy-wasm.data', 'reports/melonds.json', 'metadata/melonds.json']) {
  assert.ok(existsSync(join(cores, name)), `缺少 ${name}`)
}
assert.deepEqual(readFileSync(join(cores, 'reports/melonds.json')), readFileSync(join(cores, 'metadata/melonds.json')))

const adapter = readFileSync(join(root, 'src/emulator/adapters/emulatorjs.ts'), 'utf8')
const player = readFileSync(join(root, 'src/emulator/EmulatorPlayer.tsx'), 'utf8')
const copier = readFileSync(join(root, 'scripts/copy-ejs-cores.mjs'), 'utf8')
assert.match(adapter, /installErrorTap\(win, reportEngineError,[\s\S]{0,160}options\.platform === 'nds' \|\| \(options\.platform === 'gba' && isRomPackUrl\(remoteGameUrl\)\)/)
for (const label of ['probeSaveState', 'saveFiles', 'saveState']) {
  assert.match(adapter, new RegExp(`\\[${label}\\][\\s\\S]{0,260}isNdsWasmCrash\\('', e\\)\\) reportCoreCrash`),
    `${label} 主动调用核心时的 WASM 陷阱不能躲过 console 探针`)
}
assert.match(adapter, /gm\.loadState\(new Uint8Array\(data\)\)[\s\S]{0,180}isNdsWasmCrash\('', e\)\) reportCoreCrash/)
assert.match(adapter, /refineCaps\(\)\s*if \(crashReported\) return/, '存档探测触发崩溃后不能继续布置触控与定时器')
// 开局 trap 被引擎 catch 后是 console.warn('Failed to start game', e)：warn 级的真 RuntimeError 也要走换核心。
assert.match(adapter, /const trap = level === 'error'[\s\S]{0,100}isWasmRuntimeCrash\(text, error\)[\s\S]{0,100}isWasmRuntimeCrash\('', error\)/)
assert.match(adapter, /if \(destroyed \|\| started \|\| loadFailed \|\| crashReported\) return/, '已换核心的崩溃不能再走 onError 重试')
assert.equal(isNdsWasmCrash('', { name: 'RuntimeError', message: 'null function' }), true)
assert.match(player, /onCoreCrash: \(crashedCore: string, reason: string\)/)
assert.match(player, /coreOverride: nextCore/)
assert.match(player, /Boolean\(session\.coreOverride\)/)
assert.match(player, /\$\{coreSaveSlug\}:melonds-compat/)
assert.match(player, /countedPlayAttemptRef\.current === session\.startupAttemptId/)
assert.match(player, /playableTimer = window\.setTimeout\(confirmPlayable, 5_000\)/)
assert.match(player, /window\.clearTimeout\(playableTimer\)/)
assert.match(player, /rememberNdsCoreFailure\(session\.game\)/)
assert.match(player, /rememberedNdsCore\(romUrl\)/)
assert.match(player, /const saveSlug = coreOverride === NDS_COMPAT_CORE/)
assert.match(copier, /PRESERVED_CORES = new Set\(\[\.\.\.SELF_BUILT_CORES, 'melonds'\]\)/)
assert.match(copier, /for \(const c of PRESERVED_CORES\)/)

// 只有 WebGL1 的浏览器：新核心没有 legacy 构建，开局前就换旧 melonDS（2026-11-14 Chrome 149「显卡驱动已过时」）
{
  const files = new Set(readdirSync(cores))
  const noLegacy = [...files].filter((f) => f.endsWith('-wasm.data') && !f.endsWith('-legacy-wasm.data'))
    .map((f) => f.slice(0, -'-wasm.data'.length)).filter((c) => !files.has(`${c}-legacy-wasm.data`)).sort()
  assert.deepEqual(noLegacy, [...EJS_WEBGL2_ONLY_CORES].sort(), 'EJS_WEBGL2_ONLY_CORES 必须与 cores/ 里缺 legacy 构建的核心一致')
  assert.ok(files.has('melonds-legacy-wasm.data'), '兼容核心必须有 WebGL1 构建')
  for (const core of [undefined, null, 'nds', 'melonds', 'melondsds']) {
    assert.equal(ndsCoreForWebgl2(core, false), NDS_COMPAT_CORE, `${core} 无 WebGL2 时换兼容核心`)
    assert.equal(ndsCoreForWebgl2(core, true), null, `${core} 有 WebGL2 时不换`)
  }
  assert.equal(ndsCoreForWebgl2('desmume', false), null, '后台固定的有 legacy 构建的核心不动')
  assert.equal(ejsCoreNeedsWebgl2('melondsds'), true)
  assert.equal(ejsCoreNeedsWebgl2('melonds-compat'), false)
  assert.match(player, /ndsCoreForWebgl2\(coreRef\.current, canCreateWebgl2\(\)\)/)
  assert.match(player, /ndsCoreForWebgl2\(prewarmCore, canCreateWebgl2\(\)\)/)
  const adapter = readFileSync(join(root, 'src/emulator/adapters/emulatorjs.ts'), 'utf8')
  assert.match(adapter, /ejsCoreNeedsWebgl2\(core\) && !canCreateWebgl2\(\)/)
  assert.match(adapter, /isOutdatedGraphicsDriverText\(line\)[\s\S]{0,200}failLoad\(rt\.ejsWebglUnavailable, 'config'\)/)
  // 适配器在 node 里 import 不进来（依赖浏览器模块），只取这一句正则来测
  const re = adapter.match(/function isOutdatedGraphicsDriverText\(text: string\): boolean \{\s*return (\/.+\/i)\.test\(text\)/)
  assert.ok(re, '找不到 isOutdatedGraphicsDriverText')
  const outdated = (0, eval)(re[1])
  for (const lang of ['zh', 'en', 'fr', 'es']) {
    const text = JSON.parse(readFileSync(join(root, `public/emulatorjs/localization/${lang}.json`), 'utf8'))['Outdated graphics driver']
    assert.ok(outdated.test(text), `${lang} 语言包的「显卡驱动过时」要能认出来`)
  }
  for (const lang of ['de', 'it', 'ja']) {
    const text = JSON.parse(readFileSync(join(root, `public/emulatorjs/localization/${lang}.json`), 'utf8'))['Outdated graphics driver']
    assert.ok(text === undefined || outdated.test(text), `${lang} 语言包新翻了这句，要补进正则`)
  }
  assert.equal(outdated.test('Network Error'), false)
}

console.log('NDS WASM 崩溃检测、一次性兼容核心回退与发布产物均通过')
