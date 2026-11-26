/**
 * 运行时加速入口自适应换线 + 运行时模块按进展计时。跑：npm run test:runtime-edge-route
 *
 * 现场：2026-11-21 #2756 / #2758（《暴力摩托》，QQ 浏览器 22，大陆 EdgeOne 约 6KB/s）——
 * 适配器 chunk 还在陆续到齐就被 60 秒墙钟判死；js-dos.js 41 秒、DOSBox-X 30 秒零字节，
 * 自动重试又走同一条 EdgeOne 线。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createEdgeRouteMonitor,
  EDGE_SLOW_MAX_BYTES_PER_SEC,
  EDGE_SLOW_MIN_ELAPSED_MS,
  onRuntimeEdgeBad,
  notifyRuntimeEdgeBad,
  persistEdgeBad,
  persistedEdgeBad,
  RUNTIME_EDGE_BAD_KEY,
  RUNTIME_EDGE_BAD_TTL_MS,
} from '@/emulator/runtimeEdgeRoute'
import {
  isModuleProgressEntry,
  isRuntimeModuleTimeout,
  raceModuleLoad,
} from '@/emulator/moduleLoadDeadline'
import { cancelHttpWarms, subscribeHttpWarmEvents, warmHttpCache } from '@/emulator/httpWarm'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => readFileSync(path.join(root, file), 'utf8')

let pass = 0
const fails = []
async function check(name, fn) {
  try {
    await fn()
    pass++
    console.log('✓ ' + name)
  } catch (e) {
    fails.push({ name, e })
  }
}

function memoryStorage() {
  const map = new Map()
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map }
}

await check('#2756 的现场吞吐（约 6KB/s，20 秒以上）判慢', () => {
  let t = 0
  const bad = []
  const m = createEdgeRouteMonitor((v, d) => bad.push([v, d]), () => t)
  for (const f of ['js-dos.js', 'js-dos.css', 'emulators.js', 'wdosbox-x.wasm']) m.start(f)
  for (let s = 1; s <= 25; s++) {
    t = s * 1000
    m.bytes('js-dos.js', 6 * 1024)
    m.check(true)
  }
  assert.equal(bad.length, 1)
  assert.equal(bad[0][0], 'slow')
  assert.ok(t >= EDGE_SLOW_MIN_ELAPSED_MS)
})

await check('正常 EdgeOne（几百 KB/s 并发）不判慢；20 秒内不判', () => {
  let t = 0
  const bad = []
  const m = createEdgeRouteMonitor((v) => bad.push(v), () => t)
  m.start('a'); m.start('b')
  for (let s = 1; s <= 60; s++) {
    t = s * 1000
    m.bytes('a', 150 * 1024); m.bytes('b', 150 * 1024)
    m.check(true)
  }
  assert.deepEqual(bad, [])
  // 极慢但不到 20 秒：不判
  let t2 = 0
  const m2 = createEdgeRouteMonitor((v) => bad.push(v), () => t2)
  m2.start('x'); t2 = EDGE_SLOW_MIN_ELAPSED_MS - 1; m2.check(true)
  assert.deepEqual(bad, [])
  assert.ok(EDGE_SLOW_MAX_BYTES_PER_SEC <= 32 * 1024)
})

await check('悬停预热与几十秒后的开局不算同一段；后台时间不算', () => {
  let t = 0
  const bad = []
  const m = createEdgeRouteMonitor((v) => bad.push(v), () => t)
  m.start('js-dos.js'); t = 500; m.bytes('js-dos.js', 300 * 1024); m.end('js-dos.js', 'done')
  t = 60_000
  m.start('core.wasm'); t = 61_000; m.bytes('core.wasm', 500 * 1024); m.check(true)
  t = 85_000; m.bytes('core.wasm', 4 * 1024 * 1024); m.check(true)
  assert.deepEqual(bad, [])
  // 后台节流：隐藏时重置，回来重新计时
  let t2 = 0
  const m2 = createEdgeRouteMonitor((v) => bad.push(v), () => t2)
  m2.start('x'); t2 = 30_000; m2.check(false); t2 = 40_000; m2.check(true)
  assert.deepEqual(bad, [])
})

await check('失速（30 秒零字节）立即判坏，回调能拿到包括失速那份在内的未完成清单', () => {
  const seen = []
  const m = createEdgeRouteMonitor((v) => seen.push([v, m.openUrls().sort()]))
  m.start('wdosbox-x.js'); m.start('wdosbox-x.wasm')
  m.end('wdosbox-x.js', 'stalled')
  assert.deepEqual(seen, [['stalled', ['wdosbox-x.js', 'wdosbox-x.wasm']]])
  // 普通失败（HTTP 错误）不算硬证据
  const m2 = createEdgeRouteMonitor(() => assert.fail('不该判坏'))
  m2.start('a'); m2.end('a', 'failed')
  // 只判一次
  m.end('wdosbox-x.wasm', 'stalled')
  assert.equal(seen.length, 1)
})

await check('判坏结论按运行时持久化 2 小时，过期 / 超长 / 损坏都不算', () => {
  const s = memoryStorage()
  assert.equal(persistedEdgeBad('jsdos', 0, s), false)
  persistEdgeBad('jsdos', 1000, s)
  assert.equal(persistedEdgeBad('jsdos', 1000 + RUNTIME_EDGE_BAD_TTL_MS - 1, s), true)
  assert.equal(persistedEdgeBad('ejs', 1000, s), false, 'js-dos 的证据不连带 EmulatorJS')
  assert.equal(persistedEdgeBad('jsdos', 1000 + RUNTIME_EDGE_BAD_TTL_MS, s), false)
  s.setItem(RUNTIME_EDGE_BAD_KEY, JSON.stringify({ jsdos: 1e15 }))
  assert.equal(persistedEdgeBad('jsdos', 1000, s), false, '时钟被改过的超长期限不信')
  s.setItem(RUNTIME_EDGE_BAD_KEY, '{oops')
  assert.equal(persistedEdgeBad('jsdos', 1000, s), false)
  persistEdgeBad('ruffle', 5000, s)
  assert.equal(persistedEdgeBad('ruffle', 5000, s), true)
  assert.equal(persistedEdgeBad('jsdos', 5000, null), false)
})

await check('判坏通知只发给订阅的运行时，可取消', () => {
  let n = 0
  const off = onRuntimeEdgeBad('jsdos', () => n++)
  notifyRuntimeEdgeBad('ejs'); notifyRuntimeEdgeBad('jsdos')
  off(); notifyRuntimeEdgeBad('jsdos')
  assert.equal(n, 1)
})

await check('模块加载：持续有进展就不判超时；真挂死按 idle 失败；总上限兜底', async () => {
  let progress
  const ok = raceModuleLoad(new Promise((r) => setTimeout(() => r('mounted'), 200)), {
    idleMs: 80, maxMs: 1000,
    watchProgress: (fn) => { progress = setInterval(fn, 30); return () => clearInterval(progress) },
    message: (r) => r,
  })
  assert.equal(await ok, 'mounted')

  const hung = raceModuleLoad(new Promise(() => {}), { idleMs: 50, maxMs: 1000, message: (r) => `超时 ${r}` })
  const e1 = await hung.catch((e) => e)
  assert.ok(isRuntimeModuleTimeout(e1))
  assert.equal(e1.reason, 'idle')

  let tick
  const slowForever = raceModuleLoad(new Promise(() => {}), {
    idleMs: 60, maxMs: 200,
    watchProgress: (fn) => { tick = setInterval(fn, 20); return () => clearInterval(tick) },
    message: (r) => r,
  })
  const e2 = await slowForever.catch((e) => e)
  assert.equal(e2.reason, 'max')
  assert.ok(e2.progressCount > 0)
})

await check('进展只认同目录、拿到内容的 JS / CSS', () => {
  const dir = 'https://cn.8bitgo.com/_cn/assets/'
  assert.ok(isModuleProgressEntry({ name: `${dir}jsdos-C8MYLN3n.js`, transferSize: 29079, decodedBodySize: 83563, responseStatus: 200 }, dir))
  assert.ok(isModuleProgressEntry({ name: `${dir}x.js?chunk-retry=1`, decodedBodySize: 10 }, dir))
  assert.ok(!isModuleProgressEntry({ name: `${dir}x.js`, responseStatus: 0 }, dir), '失败的请求不算')
  assert.ok(!isModuleProgressEntry({ name: `${dir}x.js`, responseStatus: 404, decodedBodySize: 100 }, dir))
  assert.ok(!isModuleProgressEntry({ name: 'https://cn.8bitgo.com/_cn/jsdos/v1/js-dos.js', decodedBodySize: 1 }, dir), '运行时文件不算模块进展')
  assert.ok(!isModuleProgressEntry({ name: 'https://cn.8bitgo.com/api/rooms', decodedBodySize: 1 }, dir))
})

await check('预热事件：开始 / 字节 / 结束；可中止坏线上的在途预热', async () => {
  const events = []
  const off = subscribeHttpWarmEvents((e) => events.push(e.type === 'end' ? `end:${e.outcome}` : e.type))
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('ok')) return new Response(new Uint8Array(16))
    return new Response(new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(8))
        init.signal.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')))
      },
    }))
  }
  try {
    assert.equal(await warmHttpCache('https://edge/_cn/jsdos/ok.js'), true)
    const hanging = warmHttpCache('https://edge/_cn/jsdos/hang.wasm')
    await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(cancelHttpWarms((u) => u.startsWith('https://edge/_cn/jsdos/')), ['https://edge/_cn/jsdos/hang.wasm'])
    assert.equal(await hanging, false)
  } finally {
    globalThis.fetch = realFetch
    off()
  }
  assert.deepEqual(events, ['start', 'bytes', 'end:done', 'start', 'bytes', 'end:cancelled'])
})

await check('只合并在途预热；完成后重新让浏览器检查 HTTP 缓存', async () => {
  const realFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    return new Response(new Uint8Array([1, 2, 3]))
  }
  try {
    const url = 'https://edge/_cn/jsdos/cache-eviction-check.js'
    const first = warmHttpCache(url)
    const concurrent = warmHttpCache(url)
    assert.equal(first, concurrent, '并发调用应共用同一条预热请求')
    assert.equal(await first, true)
    assert.equal(await warmHttpCache(url), true)
    assert.equal(requests, 2, '完成后应重新询问浏览器缓存；缓存淘汰时才能再次下载')
  } finally {
    globalThis.fetch = realFetch
  }
})

await check('接线：runtimeBase 读持久化结论；loadMountOf 按进展计时并在加速入口超时时记 js-dos 判坏', () => {
  const paths = read('src/emulator/paths.ts')
  assert.match(paths, /if \(typeof window !== 'undefined' && persistedEdgeBad\(kind\)\) runtimeEdgeFailed\.add\(kind\)/)
  assert.match(paths, /export function markRuntimeEdgeBad\(kind: RuntimeEdgeKind\)/)
  const runtimes = read('src/emulator/runtimes.ts')
  assert.match(runtimes, /const load = LOADERS\[id\]/)
  assert.match(runtimes, /raceModuleLoad\(importWithRetry\(load, lazyChunkFile\(load\), import\.meta\.url\), \{\n\s*watchProgress: watchModuleResources\(dir\)/)
  assert.doesNotMatch(runtimes, /RUNTIME_MODULE_TIMEOUT_MS/)
  assert.match(runtimes, /if \(onEdge && kind\) markRuntimeEdgeBad\(kind\)/)
  const watch = read('src/emulator/runtimeEdgeWatch.ts')
  assert.match(watch, /markRuntimeEdgeBad\(kind\)\n[\s\S]*cancelHttpWarms\(\(url\) => url\.startsWith\(edgePrefix\)\)/)
  // 模块在加速入口上超时：整页带 __assets=origin 重开一次；已在主站资源页就不再跳（防循环）
  const player = read('src/emulator/EmulatorPlayer.tsx')
  assert.match(player, /isRuntimeModuleTimeout\(error\) && \(error as \{ assetsOnCnEdge\?: boolean \}\)\.assetsOnCnEdge && !onOriginAssetsPage\(\)/)
  assert.match(player, /location\.replace\(originAssetsUrl\(window\.location\)\)/)
})

console.log('')
if (fails.length) {
  for (const f of fails) console.error('✗ ' + f.name + '\n' + (f.e?.stack ?? f.e))
  console.error(`\n❌ ${fails.length} 条失败 / 共 ${pass + fails.length} 条`)
  process.exit(1)
}
console.log(`✅ 运行时线路自适应：${pass} 条全过`)
