import test from 'node:test'
import assert from 'node:assert/strict'
import worker from '../src/index.js'
import { environment, count } from './fixtures.mjs'

// 下载域名转发：只放行明文凭据路径与诊断，其余 /api 一律 404，且不碰 R2 / 边缘缓存。
function proxyEnv() {
  return { ...environment(), PLAIN_PROXY_HOSTS: 'download.8bitgo.com', PLAIN_PROXY_ORIGIN: 'https://8bitgo.com' }
}

async function withFetch(stub, fn) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init = {}) => { calls.push({ url: String(input), init }); return stub(input, init) }
  try { return await fn(calls) } finally { globalThis.fetch = original }
}

const at = (path, init = {}) => new Request(`https://download.8bitgo.com${path}`, init)

test('rom-plain on the download host is forwarded to the origin with Range, without cookies', async () => {
  await withFetch(() => new Response('PLAIN', {
    status: 206,
    headers: { 'Content-Range': 'bytes 0-4/100', 'Cache-Control': 'private, no-store', 'Content-Disposition': 'attachment; filename="a.zip"' },
  }), async (calls) => {
    const e = proxyEnv()
    const r = await worker.fetch(at('/api/open/v1/rom-plain/GRANT?x=1', {
      headers: { Range: 'bytes=0-4', Cookie: 'session=secret', Authorization: 'Bearer t', Origin: 'https://example.app' },
    }), e, { waitUntil() {} })
    assert.equal(r.status, 206)
    assert.equal(await r.text(), 'PLAIN')
    assert.equal(r.headers.get('Content-Range'), 'bytes 0-4/100')
    assert.equal(r.headers.get('Content-Disposition'), 'attachment; filename="a.zip"')
    assert.equal(r.headers.get('Cache-Control'), 'private, no-store')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://8bitgo.com/api/open/v1/rom-plain/GRANT?x=1')
    const sent = calls[0].init.headers
    assert.equal(sent.get('Range'), 'bytes=0-4')
    assert.equal(sent.get('Origin'), 'https://example.app')
    assert.equal(sent.get('Cookie'), null)
    assert.equal(sent.get('Authorization'), null)
    assert.equal(calls[0].init.redirect, 'manual')
    assert.equal(count(e.ROMS, 'get'), 0)
  })
})

test('the real client IP is passed with the shared key only when the secret is set', async () => {
  await withFetch(() => new Response('x'), async (calls) => {
    const headers = { 'CF-Connecting-IP': '203.0.113.9', 'X-8BitGo-Client-IP': '1.1.1.1', 'X-8BitGo-Proxy-Key': 'forged' }
    await worker.fetch(at('/api/open/v1/rom-plain/G', { headers }), proxyEnv())
    assert.equal(calls[0].init.headers.get('X-8BitGo-Client-IP'), null, '没配密钥不能把客户端自带的头转过去')
    assert.equal(calls[0].init.headers.get('X-8BitGo-Proxy-Key'), null)
    await worker.fetch(at('/api/open/v1/rom-plain/G', { headers }), { ...proxyEnv(), PLAIN_PROXY_SECRET: 's'.repeat(40) })
    assert.equal(calls[1].init.headers.get('X-8BitGo-Client-IP'), '203.0.113.9')
    assert.equal(calls[1].init.headers.get('X-8BitGo-Proxy-Key'), 's'.repeat(40))
  })
})

test('bundle-plain nested paths and /api/diag are forwarded; HEAD returns no body', async () => {
  await withFetch(() => new Response('x', { status: 200 }), async (calls) => {
    const e = proxyEnv()
    assert.equal((await worker.fetch(at('/api/open/v1/bundle-plain/G/sound/intro.mp3'), e)).status, 200)
    assert.equal((await worker.fetch(at('/api/diag'), e)).status, 200)
    const head = await worker.fetch(at('/api/open/v1/rom-plain/G', { method: 'HEAD' }), e)
    assert.equal(head.status, 200)
    assert.equal(head.body, null)
    assert.equal(calls.length, 3)
  })
})

test('other /api paths and write methods on the download host never reach the origin', async () => {
  await withFetch(() => { throw new Error('must not fetch') }, async (calls) => {
    const e = proxyEnv()
    for (const path of ['/api/auth/me', '/api/open/v1/rom/G', '/api/open/v1/games/x/rom', '/api/admin/site-notice', '/api/open/v1/rom-plain/']) {
      assert.equal((await worker.fetch(at(path), e)).status, 404, path)
    }
    assert.equal((await worker.fetch(at('/api/open/v1/rom-plain/G', { method: 'POST' }), e)).status, 405)
    assert.equal(calls.length, 0)
  })
})

test('the forwarding only applies to configured hosts; assets keeps serving R2', async () => {
  await withFetch(() => { throw new Error('must not fetch') }, async (calls) => {
    const e = proxyEnv()
    e.ROMS.seed('api/open/v1/rom-plain/G', 'r2')
    const r = await worker.fetch(new Request('https://assets.8bitgo.com/api/open/v1/rom-plain/G'), e)
    assert.notEqual(r.headers.get('X-8BitGo-Plain-Proxy'), '1')
    const off = await worker.fetch(at('/api/open/v1/rom-plain/G'), environment())
    assert.notEqual(off.headers.get('X-8BitGo-Plain-Proxy'), '1')
    assert.equal(calls.length, 0)
  })
})

test('non-/api paths on the download host still serve ROM objects from R2', async () => {
  await withFetch(() => { throw new Error('must not fetch') }, async () => {
    const e = proxyEnv()
    e.ROMS.seed('roms/nes/a.nes.8bg', 'cipher')
    const r = await worker.fetch(at('/roms/nes/a.nes.8bg'), e)
    assert.equal(r.status, 200)
    assert.equal(await r.text(), 'cipher')
  })
})

test('origin failures become a JSON 502', async () => {
  await withFetch(() => { throw new TypeError('connect failed') }, async () => {
    const r = await worker.fetch(at('/api/open/v1/rom-plain/G'), proxyEnv())
    assert.equal(r.status, 502)
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*')
  })
})

test('origin Set-Cookie is never passed through the download host', async () => {
  await withFetch(() => new Response('x', { headers: { 'Set-Cookie': 'sid=secret; Path=/' } }), async () => {
    const r = await worker.fetch(at('/api/open/v1/rom-plain/G'), proxyEnv())
    assert.equal(r.headers.get('Set-Cookie'), null)
  })
})

test('a hung origin becomes a 504 instead of holding the client until the platform limit', async () => {
  await withFetch((_input, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    // 立刻触发超时，而不是在测试里真的等 30 秒
    queueMicrotask(() => init.signal.dispatchEvent?.(new Event('abort')))
  }), async () => {
    const original = globalThis.setTimeout
    globalThis.setTimeout = (fn) => original(fn, 0)
    try {
      const r = await worker.fetch(at('/api/open/v1/rom-plain/G'), proxyEnv())
      assert.equal(r.status, 504)
    } finally {
      globalThis.setTimeout = original
    }
  })
})
