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
assert.match(adapter, /if \(isOutOfMemoryText\(`\$\{line\}\\n\$\{recent\}`\)\) \{[\s\S]{0,300}failLoad\(rt\.ejsOutOfMemory\)/)
// 错误级的内存不足要直接走 onFatal：7z Worker 报 DataCloneError out of memory 后引擎不会再发任何事件
assert.match(adapter, /level === 'error' && isOutOfMemoryText\(text\)\)\)\) \{\n\s*onFatal\(text\.trim\(\)\)/)

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

// 启动看门狗只数前台时间：后台被节流的开机（Win95 客体、CheerpJ）不能记成「超时」
{
  const player = readFileSync(new URL('../src/emulator/EmulatorPlayer.tsx', import.meta.url), 'utf8')
  assert.match(player, /if \(document\.visibilityState === 'hidden'\) return\s*timeoutTimer = window\.setTimeout/)
  assert.match(player, /document\.addEventListener\('visibilitychange', onStartupVisibility\)/)
  assert.match(player, /document\.removeEventListener\('visibilitychange', onStartupVisibility\)/)
}

// 引擎缓存的 IndexedDB 挂死过：3 天内整局关缓存、不清库、不探测（2026-11-11 萨尔瓦多 Safari）
{
  const context = {}
  const src = fnSource('engineCacheStalledRecently')
    .replace('(raw: string | null, now = Date.now()): boolean', '(raw, now = Date.now())')
  vm.runInNewContext(`const EJS_IDB_STALL_TTL_MS = 3 * 24 * 3600_000;${src};globalThis.f=engineCacheStalledRecently`, context)
  const now = 1_800_000_000_000
  assert.equal(context.f(null, now), false)
  assert.equal(context.f('garbage', now), false)
  assert.equal(context.f(String(now - 3600_000), now), true)
  assert.equal(context.f(String(now - 4 * 24 * 3600_000), now), false, '3 天后重新试缓存')
  assert.equal(context.f(String(now + 60_000), now), false, '时钟回拨的未来时间不算')
  assert.match(adapter, /EJS_cacheConfig: \{ enabled: !engineCacheOff,/)
  assert.match(adapter, /assumeUncached: engineCachePurgePending\(\) \|\| engineCacheOff/)
  assert.match(fnSource('purgePoisonedEngineCache'), /if \(readEngineCacheStall\(\)\) return/)
  assert.match(fnSource('purgePoisonedEngineCache'), /indexedDB\.databases\(\), new Promise<never>/, 'databases() 必须有时限')
  const engine = readFileSync(new URL('../public/emulatorjs/emulator.min.js', import.meta.url), 'utf8')
  assert.ok(engine.includes(`localStorage.setItem("${adapter.match(/EJS_IDB_STALL_KEY = '([^']+)'/)[1]}"`), '引擎补丁与适配器用同一个键')
}

console.log('✔ 启动失败原因：跨 realm 错误原文、内存不足、坏核心缓存、联机拒绝原因、CHD 只拦 MAME、缓存挂死后关缓存')

// ── WebGL 建不出来：不重试、不换 ROM（2026-11-11《魂斗罗》Linux Chrome 156 连试 5 遍）──
{
  const context = {}
  vm.runInNewContext(`${stripTypes(fnSource('isWebglUnavailableText'))};globalThis.f=isWebglUnavailableText`, context)
  const f = context.f
  assert.equal(f("Failed to start game TypeError: Cannot read properties of undefined (reading 'GLctx')"), true)
  assert.equal(f('TypeError: GLctx is undefined'), true)
  assert.equal(f('Failed to start game TypeError: can\'t access property "GLctx", e is undefined'), true)
  assert.equal(f("TypeError: undefined is not an object (evaluating 'GL.currentContext.GLctx')"), true)
  assert.equal(f('WebGL not supported'), true)
  assert.equal(f('Failed to start game RuntimeError: unreachable'), false)
  assert.equal(f('Romset is unknown'), false)
  assert.match(adapter, /if \(!webglNow\) return failLoad\(rt\.ejsWebglUnavailable, 'config'\)/)
  // 先判内存、再判 WebGL：内存不足时 GL 也可能建不出，但该给的是内存那句话
  assert.ok(adapter.indexOf(': failLoad(rt.ejsOutOfMemory)') < adapter.indexOf('isWebglUnavailableText(`${line}'))
  // 联机超时要把握手进度写进诊断包
  assert.match(adapter, /联机等了 \$\{waited\}ms 没进房/)
  assert.match(adapter, /netTrace\.ack = error \?/)
  console.log('✓ WebGL 不可用归为 config；联机超时带握手进度')
}

// ── 预下载 ROM 由 Blob 直接交给引擎（2026-11-13 Safari 18 iPad《宝可梦 白 2》fetch(blob:) 报 Load failed）──
{
  const { transformSync } = await import('esbuild')
  const js = transformSync(fnSource('installBlobFetchShortcut'), { loader: 'ts' }).code
  const logs = []
  const context = { diagLog: (...a) => logs.push(a.join(' ')), Promise, URL }
  vm.runInNewContext(`${js};globalThis.install=installBlobFetchShortcut`, context)
  const passthrough = []
  const win = { fetch: async (input) => { passthrough.push(String(input)); return new Response('net') }, Response }
  const blob = new Blob([new Uint8Array([1, 2, 3, 4])])
  context.install(win, 'blob:x/rom', blob)
  const res = await win.fetch('blob:x/rom')
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3, 4], '注册的 blob 地址直接用 Blob 回应')
  assert.equal(passthrough.length, 0, '注册的地址不能再走原生 fetch')
  assert.equal(await (await win.fetch('/emulatorjs/cores/x.data')).text(), 'net', '其它请求原样放行')
  assert.equal((await win.fetch('blob:x/rom', { method: 'HEAD' })).constructor, Response)
  assert.deepEqual(passthrough, ['/emulatorjs/cores/x.data', 'blob:x/rom'], 'HEAD 不拦')
  assert.match(logs[0], /ROM 由 Blob 直接交给引擎/)
  assert.match(adapter, /installBlobFetchShortcut\(win, preparedArcadeBlobUrl, preparedRomBlob\)/)
  assert.equal((adapter.match(/preparedRomBlob = (prepared|extracted)\.blob/g) ?? []).length, 5, '每处预下载 ROM 都要记下 Blob')
  console.log('✓ 预下载 ROM 由 Blob 直接交给引擎，其余请求放行')
}
