#!/usr/bin/env node
/**
 * 引擎「iframe beforeunload → exit → 1 秒后 Module.abort()」不能把能玩的游戏停掉、也不能记成核心崩溃
 *（2026-11-21 诊断包 #2744，《黄金太阳》mGBA：第 913 秒 `Aborted(undefined)` 被当成运行中崩溃）。
 * 见 src/emulator/ejsUnloadGuard.ts。
 *
 * 运行：node --experimental-strip-types --import ./scripts/helpers/ts-register.mjs scripts/test-ejs-unload-guard.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ENGINE_EXIT_ABORT_WINDOW_MS,
  guardEngineAutoUnload,
  isEngineExitAbortText,
  isPlannedEngineExitAbort,
} from '../src/emulator/ejsUnloadGuard.ts'

const root = new URL('..', import.meta.url)
const engine = readFileSync(new URL('public/emulatorjs/emulator.min.js', root), 'utf8')

// ── 取证：引擎还是这么退出的。引擎升级后这里红了，重新核对 ejsUnloadGuard.ts 的判断 ──
assert.match(
  engine,
  /addEventListener\(window,"beforeunload",t=>\{if\(this\.config\.disableAutoUnload\)[^}]*?;this\.started&&this\.callEvent\("exit"\)\}/,
  '引擎在 iframe window 的 beforeunload 上触发 exit',
)
assert.match(
  engine,
  /this\.EJS\.on\("exit",\(\)=>\{[^]*?toggleMainLoop\(0\),setTimeout\(\(\)=>\{try\{this\.Module\.abort\(\)\}catch\(t\)\{console\.warn\(t\)\}\},1e3\)\}\)/,
  'exit 收尾是 1 秒后不带参数的 Module.abort()，异常被 console.warn 打出来',
)
assert.match(engine, /on\(t,e\)\{this\.functions\|\|\(this\.functions=\{\}\),Array\.isArray\(this\.functions\[t\]\)\|\|\(this\.functions\[t\]=\[\]\),this\.functions\[t\]\.push\(e\)\}/,
  'EJS.on 是追加监听（适配器挂 exit 不会顶掉引擎自己的那条）')
console.log('✓ 引擎退出流程取证')

// ── 文本判定 ──
assert.equal(isEngineExitAbortText('RuntimeError: Aborted(undefined). Build with -sASSERTIONS for more info.'), true)
assert.equal(isEngineExitAbortText('Aborted(undefined)'), true)
// 核心自己的 C abort() 走 __abort_js → abort("")，这类仍是真崩溃 / 内存不足
assert.equal(isEngineExitAbortText('RuntimeError: Aborted(). Build with -sASSERTIONS for more info.'), false)
assert.equal(isEngineExitAbortText('RuntimeError: table index is out of bounds'), false)
const t0 = 1_000_000
assert.equal(isPlannedEngineExitAbort('RuntimeError: Aborted(undefined).', t0, t0 + 1000), true)
assert.equal(isPlannedEngineExitAbort('RuntimeError: Aborted(undefined).', 0, t0), false, '没走过 exit 的 Aborted(undefined) 仍按崩溃报')
assert.equal(isPlannedEngineExitAbort('RuntimeError: Aborted(undefined).', t0, t0 + ENGINE_EXIT_ABORT_WINDOW_MS + 1), false)
assert.equal(isPlannedEngineExitAbort('RuntimeError: Aborted().', t0, t0 + 1000), false)
console.log('✓ 计划内退出的判定')

// ── 拦截：先注册的捕获监听挡住引擎后注册的那条，且不阻止离开页面 ──
{
  const win = new EventTarget()
  let flushed = 0
  let engineExit = 0
  const stop = guardEngineAutoUnload(win, () => { flushed++ })
  win.addEventListener('beforeunload', () => { engineExit++ }) // 引擎（loader.js 之后才注册）
  const ev = new Event('beforeunload', { cancelable: true })
  win.dispatchEvent(ev)
  assert.equal(flushed, 1, '离开前刷一次电池存档')
  assert.equal(engineExit, 0, '引擎的 exit 不被触发')
  assert.equal(ev.defaultPrevented, false, '不弹「确定离开」')
  stop()
  win.dispatchEvent(new Event('beforeunload'))
  assert.equal(engineExit, 1, '卸载后不再拦')
  // 刷存档抛错也不影响离开
  const win2 = new EventTarget()
  guardEngineAutoUnload(win2, () => { throw new Error('boom') })
  win2.dispatchEvent(new Event('beforeunload'))
}
console.log('✓ beforeunload 拦截')

// ── 适配器接线 ──
const adapter = readFileSync(new URL('src/emulator/adapters/emulatorjs.ts', root), 'utf8')
const guardAt = adapter.indexOf('stopUnloadGuard = guardEngineAutoUnload(win,')
assert.ok(guardAt > 0, '适配器装了拦截')
assert.ok(guardAt < adapter.indexOf('errorTap = installErrorTap(win, reportEngineError,'), '拦截装在 loader.js 注入之前（与 errorTap 同一处）')
assert.match(adapter, /guardEngineAutoUnload\(win, \(\) => \{[\s\S]{0,120}flushSaveFiles\(\)/, '拦下后自己刷电池存档')
assert.match(
  adapter,
  /const reportCoreCrash = \(line: string\) => \{\s*if \(destroyed \|\| crashReported \|\| loadFailed\) return\s*if \(isPlannedEngineExitAbort\(line, engineExitAt, Date\.now\(\)\)\)/,
  'reportCoreCrash 先排除计划内退出',
)
assert.match(adapter, /\?\.on\?\.\('exit', \(\) => \{\s*engineExitAt = Date\.now\(\)/, '开局后在 EJS.on("exit") 记时刻')
assert.match(adapter, /stopUnloadGuard\?\.\(\)\s*stopUnloadGuard = null/, '销毁时卸掉拦截')
console.log('✓ 适配器接线')
