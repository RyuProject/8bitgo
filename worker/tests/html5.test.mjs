import test from 'node:test'
import assert from 'node:assert/strict'
import worker from '../src/index.js'
import { html5OriginAllowed } from '../src/html5.js'
import { Bucket, environment, count, TOKEN } from './fixtures.mjs'

// html5.8bitgo.com 复刻 R2 自定义域：只读 WEBGAMES、按白名单反射 CORS、不碰管理接口。
function html5Env() {
  const e = { ...environment(), WEBGAMES: new Bucket('webgames'),
    HTML5_HOSTS: 'html5.8bitgo.com', HTML5_ALLOWED_ORIGINS: 'https://8bitgo.com,https://*.8bitgo.com' }
  e.WEBGAMES.seed('undertale/a.ogg', 'OGGDATA', { httpMetadata: { contentType: 'audio/ogg' } })
  e.WEBGAMES.seed('PvZ/properties/packs/r.pvzpack.gz', 'PACK', {
    httpMetadata: { contentType: 'application/gzip', cacheControl: 'public, max-age=31536000, immutable' } })
  return e
}
const at = (path, init = {}) => new Request(`https://html5.8bitgo.com${path}`, init)
const ctx = { waitUntil() {} }

test('origin matching follows the R2 CORS rule (exact or any subdomain)', () => {
  const env = { HTML5_ALLOWED_ORIGINS: 'https://8bitgo.com,https://*.8bitgo.com' }
  assert.equal(html5OriginAllowed('https://8bitgo.com', env), true)
  assert.equal(html5OriginAllowed('https://undertale.8bitgo.com', env), true)
  assert.equal(html5OriginAllowed('https://a.b.8bitgo.com', env), true)
  assert.equal(html5OriginAllowed('https://evil8bitgo.com', env), false)
  assert.equal(html5OriginAllowed('https://8bitgo.com.evil.com', env), false)
  assert.equal(html5OriginAllowed('http://undertale.8bitgo.com', env), false)
  assert.equal(html5OriginAllowed('https://x.8bitgo.com:8443', env), false)
  assert.equal(html5OriginAllowed('null', env), false)
  assert.equal(html5OriginAllowed('', env), false)
})

test('allowed origin gets reflected ACAO, object metadata and body from WEBGAMES', async () => {
  const e = html5Env()
  const r = await worker.fetch(at('/undertale/a.ogg', { headers: { Origin: 'https://undertale.8bitgo.com' } }), e, ctx)
  assert.equal(r.status, 200)
  assert.equal(await r.text(), 'OGGDATA')
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://undertale.8bitgo.com')
  assert.match(r.headers.get('Vary'), /Origin/)
  assert.equal(r.headers.get('Content-Type'), 'audio/ogg')
  assert.equal(r.headers.get('Cache-Control'), 'public, max-age=300, s-maxage=600, must-revalidate')
  assert.equal(count(e.ROMS, 'get') + count(e.ROMS, 'head'), 0)
})

test('object Cache-Control metadata is kept (immutable packs)', async () => {
  const r = await worker.fetch(at('/PvZ/properties/packs/r.pvzpack.gz'), html5Env(), ctx)
  assert.equal(r.headers.get('Cache-Control'), 'public, max-age=31536000, immutable')
})

test('foreign origin gets no ACAO; preflight is 403 for it and 204 for allowed', async () => {
  const e = html5Env()
  const r = await worker.fetch(at('/undertale/a.ogg', { headers: { Origin: 'https://evil.com' } }), e, ctx)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null)
  const bad = await worker.fetch(at('/undertale/a.ogg', { method: 'OPTIONS',
    headers: { Origin: 'https://evil.com', 'Access-Control-Request-Method': 'GET' } }), e, ctx)
  assert.equal(bad.status, 403)
  const good = await worker.fetch(at('/undertale/a.ogg', { method: 'OPTIONS',
    headers: { Origin: 'https://8bitgo.com', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range' } }), e, ctx)
  assert.equal(good.status, 204)
  assert.equal(good.headers.get('Access-Control-Allow-Origin'), 'https://8bitgo.com')
  assert.equal(good.headers.get('Access-Control-Allow-Methods'), 'GET, HEAD')
  assert.equal(good.headers.get('Access-Control-Allow-Headers'), 'range')
  const put = await worker.fetch(at('/x', { method: 'OPTIONS',
    headers: { Origin: 'https://8bitgo.com', 'Access-Control-Request-Method': 'PUT' } }), e, ctx)
  assert.equal(put.status, 403)
})

test('Range and HEAD behave like the R2 custom domain', async () => {
  const e = html5Env()
  const r = await worker.fetch(at('/undertale/a.ogg', { headers: { Range: 'bytes=0-2' } }), e, ctx)
  assert.equal(r.status, 206)
  assert.equal(r.headers.get('Content-Range'), 'bytes 0-2/7')
  assert.equal(await r.text(), 'OGG')
  const h = await worker.fetch(at('/undertale/a.ogg', { method: 'HEAD' }), e, ctx)
  assert.equal(h.status, 200)
  assert.equal(h.headers.get('Content-Length'), '7')
  assert.equal(h.body, null)
})

test('writes and admin endpoints are refused even with the admin token', async () => {
  const e = html5Env()
  const auth = { Authorization: `Bearer ${TOKEN}` }
  for (const [path, method] of [['/undertale/a.ogg', 'PUT'], ['/undertale/a.ogg', 'DELETE'], ['/bulk', 'POST'], ['/x?uploads', 'POST']]) {
    const r = await worker.fetch(at(path, { method, headers: auth, body: method === 'DELETE' ? undefined : 'x' }), e, ctx)
    assert.equal(r.status, 405, `${method} ${path}`)
  }
  for (const path of ['/list', '/multipart', '/', '/ping', '/a/../b', '/dir/']) {
    const r = await worker.fetch(at(path, { headers: auth }), e, ctx)
    assert.equal(r.status, 404, path)
  }
  assert.equal(e.WEBGAMES.objects.get('undertale/a.ogg') !== undefined, true)
  assert.equal(count(e.WEBGAMES, 'put') + count(e.WEBGAMES, 'delete') + count(e.ROMS, 'list'), 0)
})

test('the fixed HTML5 host remains read-only when its host allowlist variable is missing', async () => {
  const e = html5Env()
  delete e.HTML5_HOSTS
  const root = await worker.fetch(at('/'), e, ctx)
  assert.equal(root.status, 404, 'root request must not fall through to the ROM Worker health/admin route')
  const put = await worker.fetch(at('/undertale/a.ogg', { method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}` }, body: 'x' }), e, ctx)
  assert.equal(put.status, 405, 'valid admin token must not expose the write API on the HTML5 host')
  assert.equal(count(e.WEBGAMES, 'put') + count(e.ROMS, 'put') + count(e.ROMS, 'list'), 0)
})

test('missing object is 404 and does not fall back to other buckets', async () => {
  const e = html5Env()
  e.ROMS.seed('only-in-roms.bin', 'R')
  const r = await worker.fetch(at('/only-in-roms.bin'), e, ctx)
  assert.equal(r.status, 404)
})

test('cached copy carries no CORS; each hit gets the caller\'s own ACAO', async () => {
  const previous = globalThis.caches
  let stored
  const waits = []
  globalThis.caches = { default: {
    async match() { return stored?.clone() },
    async put(_request, response) { stored = response.clone(); await response.arrayBuffer() },
  } }
  const context = { waitUntil(promise) { waits.push(promise) } }
  try {
    const e = html5Env()
    const first = await worker.fetch(at('/undertale/a.ogg', { headers: { Origin: 'https://undertale.8bitgo.com' } }), e, context)
    assert.equal(first.headers.get('X-8BitGo-Edge-Cache'), 'MISS')
    await first.text(); await Promise.all(waits)
    assert.equal(stored.headers.get('Access-Control-Allow-Origin'), null)
    const second = await worker.fetch(at('/undertale/a.ogg', { headers: { Origin: 'https://8bitgo.com' } }), e, context)
    assert.equal(second.headers.get('X-8BitGo-Edge-Cache'), 'HIT')
    assert.equal(second.headers.get('Access-Control-Allow-Origin'), 'https://8bitgo.com')
    assert.equal(await second.text(), 'OGGDATA')
    const third = await worker.fetch(at('/undertale/a.ogg', { headers: { Origin: 'https://evil.com' } }), e, context)
    assert.equal(third.headers.get('Access-Control-Allow-Origin'), null)
    assert.equal(count(e.WEBGAMES, 'get'), 1)
  } finally {
    if (previous === undefined) delete globalThis.caches
    else globalThis.caches = previous
  }
})

test('other hosts keep the existing behaviour', async () => {
  const e = html5Env()
  e.ROMS.seed('roms/a.zip', 'Z')
  const r = await new Promise((resolve) => resolve(worker.fetch(new Request('https://assets.8bitgo.com/roms/a.zip'), e, ctx)))
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*')
})

function memoryCache() {
  const store = new Map()
  const waits = []
  const keys = []
  return {
    store, waits, keys,
    context: { waitUntil(p) { waits.push(p) } },
    install() {
      const previous = globalThis.caches
      globalThis.caches = { default: {
        async match(request) { keys.push(request.url); return store.get(request.url)?.clone() },
        async put(request, response) { keys.push(request.url); store.set(request.url, response.clone()); await response.arrayBuffer() },
      } }
      return () => { if (previous === undefined) delete globalThis.caches; else globalThis.caches = previous }
    },
  }
}

test('cache hit answers If-None-Match / If-Modified-Since with 304 and the caller\'s CORS', async () => {
  const mem = memoryCache(); const restore = mem.install()
  try {
    const e = html5Env()
    const first = await worker.fetch(at('/undertale/a.ogg'), e, mem.context)
    const etag = first.headers.get('ETag'); const lastModified = first.headers.get('Last-Modified')
    await first.text(); await Promise.all(mem.waits)
    const inm = await worker.fetch(at('/undertale/a.ogg', { headers: { 'If-None-Match': etag, Origin: 'https://8bitgo.com' } }), e, mem.context)
    assert.equal(inm.status, 304)
    assert.equal(inm.body, null)
    assert.equal(inm.headers.get('ETag'), etag)
    assert.equal(inm.headers.get('Access-Control-Allow-Origin'), 'https://8bitgo.com')
    assert.equal(inm.headers.get('X-8BitGo-Edge-Cache'), 'HIT')
    const ims = await worker.fetch(at('/undertale/a.ogg', { headers: { 'If-Modified-Since': lastModified } }), e, mem.context)
    assert.equal(ims.status, 304)
    const changed = await worker.fetch(at('/undertale/a.ogg', { headers: { 'If-None-Match': '"other"' } }), e, mem.context)
    assert.equal(changed.status, 200)
    assert.equal(await changed.text(), 'OGGDATA')
    assert.equal(count(e.WEBGAMES, 'get') + count(e.WEBGAMES, 'head'), 1)
  } finally { restore() }
})

test('cache key drops the query string so random ?x= cannot multiply R2 reads and cache entries', async () => {
  const mem = memoryCache(); const restore = mem.install()
  try {
    const e = html5Env()
    for (const q of ['', '?a=1', '?v=2&b=3', '?cachebust=xyz']) {
      const r = await worker.fetch(at(`/undertale/a.ogg${q}`), e, mem.context)
      assert.equal(await r.text(), 'OGGDATA')
      await Promise.all(mem.waits)
    }
    assert.deepEqual([...mem.store.keys()], ['https://html5.8bitgo.com/undertale/a.ogg'])
    assert.ok(mem.keys.every((k) => !k.includes('?')))
    assert.equal(count(e.WEBGAMES, 'get'), 1)
  } finally { restore() }
})

test('R2 private/no-store/no-cache/Vary objects never enter Cache API', async () => {
  const previous = globalThis.caches
  let puts = 0
  globalThis.caches = { default: {
    async match() { return undefined },
    async put() { puts += 1 },
  } }
  try {
    const e = html5Env()
    for (const [name, directive] of [['private', 'private, max-age=600'], ['no-store', 'public, no-store'], ['no-cache', 'public, no-cache']]) {
      e.WEBGAMES.seed(`${name}.bin`, name, { httpMetadata: { cacheControl: directive } })
      const response = await worker.fetch(at(`/${name}.bin`), e, ctx)
      assert.equal(await response.text(), name)
      assert.equal(response.headers.get('Cache-Control'), directive)
    }
    e.WEBGAMES.seed('vary.bin', 'VARIANT', { httpMetadata: { vary: 'Accept-Language' } })
    assert.equal(await (await worker.fetch(at('/vary.bin'), e, ctx)).text(), 'VARIANT')
    assert.equal(puts, 0)
  } finally {
    if (previous === undefined) delete globalThis.caches
    else globalThis.caches = previous
  }
})

test('no thumbnail fallback and no synthesized Content-Disposition on html5', async () => {
  const e = html5Env()
  e.WEBGAMES.seed('PvZ/icon.png', 'PNG', { httpMetadata: { contentType: 'image/png' } })
  const missing = await worker.fetch(at('/PvZ/icon-96.png'), e, ctx)
  assert.equal(missing.status, 404)
  const ranged = await worker.fetch(at('/PvZ/icon-96.png', { headers: { Range: 'bytes=0-1' } }), e, ctx)
  assert.equal(ranged.status, 404)
  const real = await worker.fetch(at('/PvZ/icon.png'), e, ctx)
  assert.equal(real.status, 200)
  assert.equal(real.headers.get('Content-Disposition'), null)
  e.WEBGAMES.seed('dl.zip', 'Z', { httpMetadata: { contentDisposition: 'attachment; filename="dl.zip"' } })
  const own = await worker.fetch(at('/dl.zip'), e, ctx)
  assert.equal(own.headers.get('Content-Disposition'), 'attachment; filename="dl.zip"')
})

test('storage failure is a 503 that allowed origins can read', async () => {
  const e = html5Env()
  e.WEBGAMES.get = async () => { throw new Error('R2 down') }
  const r = await worker.fetch(at('/undertale/a.ogg', { headers: { Origin: 'https://8bitgo.com' } }), e, ctx)
  assert.equal(r.status, 503)
  assert.equal(r.headers.get('Retry-After'), '2')
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://8bitgo.com')
  assert.match(r.headers.get('Access-Control-Expose-Headers') || '', /Content-Length/)
  assert.match(r.headers.get('Vary'), /Origin/)
})
