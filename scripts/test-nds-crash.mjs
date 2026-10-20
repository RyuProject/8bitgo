/** NDS WASM 崩溃回归：陷阱才触发、有界换核心、产物完整且存档隔离。 */
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

// 历史记录的 melonds 仍默认使用新版；只有内部键才启用旧版。
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

console.log('NDS WASM 崩溃检测、一次性旧核心回退与发布产物均通过')
