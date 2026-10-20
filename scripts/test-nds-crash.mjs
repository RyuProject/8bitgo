/** NDS WASM 崩溃回退回归：只认确定的陷阱，且只从新核心切换一次。 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isNdsWasmCrash, ndsCrashFallbackCore } from '../src/emulator/ndsCrash.ts'
import { emulatorJsCoreForGame, NDS_COMPAT_CORE } from '../src/emulator/paths.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const cores = join(root, 'public/emulatorjs/cores')

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
assert.match(copier, /PRESERVED_CORES = new Set\(\[\.\.\.SELF_BUILT_CORES, 'melonds'\]\)/)
assert.match(copier, /for \(const c of PRESERVED_CORES\)/)

console.log('NDS WASM 崩溃检测、一次性兼容核心回退与发布产物均通过')
