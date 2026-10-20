/** NDS WASM 崩溃回退回归：只认确定的陷阱，且只从新核心切换一次。 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isNdsWasmCrash, ndsCrashFallbackCore } from '../src/emulator/ndsCrash.ts'
import { NDS_MODERN_CORE_BUILD, ndsRomIdentity, rememberNdsCoreFailure, rememberedNdsCore } from '../src/emulator/ndsCorePreference.ts'
import { emulatorJsCoreForGame, NDS_COMPAT_CORE } from '../src/emulator/paths.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const cores = join(root, 'public/emulatorjs/cores')
const modernReport = JSON.parse(readFileSync(join(cores, 'reports/melondsds.json'), 'utf8'))
assert.ok(modernReport.sha256.startsWith(NDS_MODERN_CORE_BUILD), '新版核心改变时必须让旧失败记录失效')

assert.equal(isNdsWasmCrash('Uncaught RuntimeError: unreachable at wasm-function[2361]:0x1a46fb'), true)
assert.equal(isNdsWasmCrash('RuntimeError: memory access out of bounds'), true)
assert.equal(isNdsWasmCrash('unreachable', { name: 'RuntimeError', message: 'unreachable' }), true)
assert.equal(isNdsWasmCrash('unreachable', { name: 'TypeError', message: 'unreachable' }), false)
assert.equal(isNdsWasmCrash('Failed to load state'), false)
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
assert.match(adapter, /installErrorTap\(win, reportEngineError, options\.platform === 'nds' \? reportCoreCrash : undefined\)/)
assert.match(player, /onCoreCrash: \(crashedCore: string, reason: string\)/)
assert.match(player, /coreOverride: nextCore/)
assert.match(player, /Boolean\(session\.coreOverride\)/)
assert.match(player, /\$\{baseSaveSlug\}:melonds-compat/)
assert.match(player, /countedPlayAttemptRef\.current === session\.startupAttemptId/)
assert.match(player, /playableTimer = window\.setTimeout\(confirmPlayable, 5_000\)/)
assert.match(player, /window\.clearTimeout\(playableTimer\)/)
assert.match(player, /rememberNdsCoreFailure\(session\.game\)/)
assert.match(player, /rememberedNdsCore\(romUrl\)/)
assert.match(player, /const saveSlug = coreOverride === NDS_COMPAT_CORE/)
assert.match(copier, /PRESERVED_CORES = new Set\(\[\.\.\.SELF_BUILT_CORES, 'melonds'\]\)/)
assert.match(copier, /for \(const c of PRESERVED_CORES\)/)

console.log('NDS WASM 崩溃检测、一次性兼容核心回退与发布产物均通过')
