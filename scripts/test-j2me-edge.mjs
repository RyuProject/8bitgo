/**
 * J2ME 大文件走大陆加速入口（scripts/j2me-web/edge-sw.js + server/src/cn-edge.js 的 j2me 前缀）。
 * 运行：node scripts/test-j2me-edge.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const swSource = readFileSync(new URL('../scripts/j2me-web/edge-sw.js', import.meta.url), 'utf8')

function loadSw({ clientUrl, fetchImpl }) {
  const handlers = {}
  const self = {
    location: new URL('https://8bitgo.com/j2me/edge-sw.js'),
    registration: { scope: 'https://8bitgo.com/j2me/' },
    addEventListener: (type, fn) => { handlers[type] = fn },
    skipWaiting: () => {},
    clients: { claim: async () => {}, get: async () => (clientUrl ? { url: clientUrl } : undefined) },
  }
  vm.runInNewContext(swSource, { self, fetch: fetchImpl, Headers, URL, Response, console })
  return async (url, { range, referrer = '' } = {}) => {
    const headers = new Headers()
    if (range) headers.set('Range', range)
    let responded = null
    handlers.fetch({
      request: { url, method: 'GET', mode: 'cors', headers, referrer },
      clientId: 'c1',
      respondWith: (p) => { responded = p },
    })
    return responded ? await responded : 'passthrough'
  }
}

const calls = []
const okFetch = async (target, init) => {
  calls.push({ target: typeof target === 'string' ? target : target.url, range: init?.headers?.get?.('Range') ?? null })
  return new Response('x', { status: init?.headers?.get?.('Range') ? 206 : 200 })
}

console.log('── 只转三类大文件，且只在 edge=cn 的 run.html 里 ──')
{
  const handle = loadSw({ clientUrl: 'https://8bitgo.com/j2me/run.html?jar=a.8bg.jar&edge=cn', fetchImpl: okFetch })
  await handle('https://8bitgo.com/j2me/jar/a.8bg.jar', { range: 'bytes=0-99' })
  assert.deepEqual(calls.pop(), { target: 'https://cn.8bitgo.com/_cn/j2me/jar/a.8bg.jar', range: 'bytes=0-99' }, 'Range 原样带过去')
  await handle('https://8bitgo.com/j2me/freej2me-web.jar', { range: 'bytes=0-1' })
  assert.equal(calls.pop().target, 'https://cn.8bitgo.com/_cn/j2me/freej2me-web.jar')
  await handle('https://8bitgo.com/j2me/libmidi/libmidi.wasm')
  assert.equal(calls.pop().target, 'https://cn.8bitgo.com/_cn/j2me/libmidi/libmidi.wasm')
  assert.equal(await handle('https://8bitgo.com/j2me/run.html'), 'passthrough')
  assert.equal(await handle('https://8bitgo.com/j2me/src/main.js'), 'passthrough')
  assert.equal(await handle('https://8bitgo.com/api/rooms'), 'passthrough')
  assert.equal(await handle('https://evil.example/j2me/jar/a.jar'), 'passthrough')
}

console.log('── 没带 edge=cn 的页面照旧同源 ──')
{
  calls.length = 0
  const handle = loadSw({ clientUrl: 'https://8bitgo.com/j2me/run.html?jar=a.jar', fetchImpl: okFetch })
  await handle('https://8bitgo.com/j2me/jar/a.jar', { range: 'bytes=0-9' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].target, 'https://8bitgo.com/j2me/jar/a.jar', '原请求直接发同源')
}

console.log('── 加速入口出错 / Range 被回成 200：退回同源 ──')
for (const edge of ['throw', 200, 503]) {
  const seen = []
  const fetchImpl = async (target, init) => {
    const url = typeof target === 'string' ? target : target.url
    seen.push(url)
    if (url.startsWith('https://cn.')) {
      if (edge === 'throw') throw new TypeError('Failed to fetch')
      return new Response('full', { status: edge })
    }
    return new Response('x', { status: 206 })
  }
  const handle = loadSw({ clientUrl: 'https://8bitgo.com/j2me/run.html?jar=a.jar&edge=cn', fetchImpl })
  const res = await handle('https://8bitgo.com/j2me/jar/a.jar', { range: 'bytes=0-9' })
  assert.equal(res.status, 206, `边缘 ${edge} 时要拿到同源的 206`)
  assert.equal(seen.at(-1), 'https://8bitgo.com/j2me/jar/a.jar')
}

console.log('── 加速域名只从 SW 自己的地址推，不接受参数 ──')
assert.match(swSource, /const EDGE_ORIGIN = `https:\/\/cn\.\$\{self\.location\.hostname/)
assert.doesNotMatch(swSource, /searchParams\.get\(['"]edge/)

console.log('── 服务端放行 /_cn/j2me/ 并暴露 Range 相关响应头 ──')
const cnEdge = readFileSync(new URL('../server/src/cn-edge.js', import.meta.url), 'utf8')
assert.match(cnEdge, /\(assets\|fonts\|api\|emulatorjs\|ruffle\|jsdos\|j2me\)/)
assert.match(cnEdge, /Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges/)

console.log('── 适配器：SW 没激活就不带 edge=cn；开局失败让重试走同源 ──')
const adapter = readFileSync(new URL('../src/emulator/adapters/j2me.ts', import.meta.url), 'utf8')
assert.match(adapter, /edgeOn = await edgeReady[\s\S]{0,300}edge: edgeOn \}\)/)
assert.equal((adapter.match(/if \(edgeOn && !fallbackActive\) markJ2meEdgeFailed\(\)/g) ?? []).length, 2)
assert.match(readFileSync(new URL('../scripts/patch-j2me-runtime.mjs', import.meta.url), 'utf8'), /scripts\/j2me-web\/edge-sw\.js/)

console.log('✅ J2ME 加速入口回归通过')
