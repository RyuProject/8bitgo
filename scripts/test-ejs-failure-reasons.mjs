#!/usr/bin/env node
/**
 * 启动失败原因必须如实交到玩家和后台手里（2026-11-10 体检）：
 *   - iframe 里抛的 Error 跨 realm，不能靠 instanceof，否则只剩「Failed to start game {}」；
 *   - 浏览器分配不出内存时给「内存不足」而不是一串英文；
 *   - 「Error loading EmulatorJS runtime」= 引擎缓存里有坏核心，下次开局前强制清缓存；
 *   - 联机房间被服务端拒绝时立刻说清原因，不再干等 20 秒报「信令服务器没有回应」，也不触发换 ROM；
 *   - CHD 缺盘拦截只在真用 MAME 时生效。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const adapter = readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
const fnSource = (name) => {
  const start = adapter.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `找不到 ${name}`)
  let depth = 0
  // 跳过返回类型里的对象字面量：函数体从 `) {` / `): T {` 之后的那个大括号开始
  const bodyStart = adapter.indexOf(' {\n', start)
  for (let i = bodyStart + 1; i < adapter.length; i++) {
    if (adapter[i] === '{') depth++
    else if (adapter[i] === '}' && --depth === 0) return adapter.slice(start, i + 1)
  }
  throw new Error(name)
}
const stripTypes = (code) => code
  .replace(/\(v: unknown\): string/, '(v)')
  .replace(/\(text: string\): boolean/, '(text)')
  .replace(/ as \{[^}]*\}/g, '')

// safeStr：跨 realm 的 Error 也要带出 name + message
{
  const context = {}
  vm.runInNewContext(`${stripTypes(fnSource('safeStr'))};globalThis.safeStr=safeStr`, context)
  const foreign = vm.runInNewContext('new RangeError("WebAssembly.Memory(): could not allocate memory")')
  assert.equal(foreign instanceof Error, false, '测试前提：确实是另一个 realm 的 Error')
  assert.equal(context.safeStr(foreign), 'RangeError: WebAssembly.Memory(): could not allocate memory')
  assert.equal(context.safeStr({ name: 'ExitStatus', message: 'Program terminated with exit(1)', status: 1 }), 'ExitStatus: Program terminated with exit(1) (status 1)')
  assert.equal(context.safeStr({ a: 1 }), '{"a":1}')
  assert.doesNotMatch(fnSource('safeStr'), /if \(v instanceof Error\)/)
}

// 内存不足的几种说法
{
  const context = {}
  vm.runInNewContext(`${stripTypes(fnSource('isOutOfMemoryText'))};globalThis.f=isOutOfMemoryText`, context)
  for (const text of [
    'RangeError: WebAssembly.Memory(): could not allocate memory',
    'RangeError: Out of memory: Cannot allocate Wasm memory for new instance',
    'RangeError: Array buffer allocation failed',
    'Aborted(Out of memory)',
  ]) assert.equal(context.f(text), true, text)
  assert.equal(context.f('Failed to start game'), false)
}

// 坏核心缓存：下次开局前强制清
assert.match(adapter, /error loading emulatorjs runtime\/i\.test\(line\)\) \{\s*try \{ localStorage\.removeItem\(EJS_CACHE_PURGED_KEY\)/)
assert.match(adapter, /if \(isOutOfMemoryText\(`\$\{line\}\\n\$\{recent\}`\)\) return failLoad\(rt\.ejsOutOfMemory\)/)

// 联机拒绝
assert.match(adapter, /roomAckError = typeof error === 'string' \? error : safeStr\(error\)/)
assert.match(adapter, /if \(!reportedRoom && roomAckError\) \{/)
assert.match(adapter, /failNetplay\(rejection\.message, rejection\.final \? 'config' : undefined\)/, '房间被拒不能用 deterministic（会换备用 ROM）')
for (const reason of ['room not found', 'room is full', 'game does not support multiplayer', 'wrong password']) {
  assert.ok(fnSource('netplayRejection').includes(`'${reason}'`), reason)
}
const server = readFileSync(new URL('../server/src/netplay.js', import.meta.url), 'utf8')
for (const reason of ['room not found', 'room is full', 'game does not support multiplayer', 'wrong password']) {
  assert.ok(server.includes(`ack?.('${reason}')`), `服务端仍用「${reason}」拒绝；改了措辞要同步 netplayRejection`)
}

// CHD 拦截只在 MAME
assert.match(adapter, /if \(detectedMameMedia && isMameCurrentCore\(core\)\)/)

// 八种语言都有新文案
for (const lang of ['zh-Hans', 'zh-Hant', 'en', 'es', 'fr', 'de', 'it', 'ja']) {
  const locale = readFileSync(new URL(`../src/locales/${lang}.ts`, import.meta.url), 'utf8')
  for (const key of ['ejsOutOfMemory', 'netplayRoomGone', 'netplayRoomFull', 'netplayNoMultiplayer', 'netplayWrongPassword', 'netplayRoomRejected']) {
    assert.match(locale, new RegExp(`\\b${key}: '`), `${lang} 缺 ${key}`)
  }
}

console.log('✔ 启动失败原因：跨 realm 错误原文、内存不足、坏核心缓存、联机拒绝原因、CHD 只拦 MAME')
