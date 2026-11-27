import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import worker, { edgeCacheEligible } from '../src/index.js'
import { environment, req } from './fixtures.mjs'

const blockBytes = 2 * 1024 * 1024
const sha256 = value => createHash('sha256').update(value).digest('hex')
const key = 'roms/psx/integrity-range-test.chd'
const content = Uint8Array.from({ length: 96 }, (_, index) => (index * 17) & 0xff)
const sidecarKey = async (romKey, etag) => `_integrity/${createHash('sha256').update(`${romKey}\n${etag}`).digest('hex')}.json`
function payload(bytes = content, romKey = key) {
  return { v: 1, alg: 'sha256', key: romKey, size: bytes.byteLength, blockBytes,
    blocks: [sha256(bytes)] }
}
async function seedRequired(e, bytes = content, romKey = key) {
  const object = e.ROMS.seed(romKey, bytes, { customMetadata: { '8bitgo-integrity-required': 'sha256-v1' } })
  const published = await worker.fetch(req(`/integrity?key=${encodeURIComponent(romKey)}`, 'POST', {
    key: romKey, etag: object.httpEtag, size: object.size, manifest: payload(bytes, romKey),
  }, {}, true), e)
  assert.equal(published.status, 200)
  return object
}

test('required PSX range reads return only the requested, ETag-bound verified bytes', async () => {
  const e = environment()
  const object = await seedRequired(e)
  const response = await worker.fetch(req(`/${key}?romv=${object.etag}`, 'GET', undefined, {
    Range: 'bytes=7-31',
  }), e)
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('Content-Range'), `bytes 7-31/${content.byteLength}`)
  assert.equal(response.headers.get('ETag'), object.httpEtag)
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), content.subarray(7, 32))
})

test('backfilled sidecars verify legacy Range reads and expose the browser verification marker', async () => {
  const e = environment()
  const legacyKey = 'roms/psx/integrity-backfilled-legacy.chd'
  const object = e.ROMS.seed(legacyKey, content)
  const path = `/${legacyKey}?romv=${object.etag}`

  const before = await worker.fetch(req(path, 'GET', undefined, { Range: 'bytes=3-20' }), e)
  assert.equal(before.status, 206)
  assert.equal(before.headers.get('X-8BitGo-Integrity-Required'), null)
  assert.deepEqual(new Uint8Array(await before.arrayBuffer()), content.subarray(3, 21))

  const manifest = { ...payload(content, legacyKey), etag: object.httpEtag }
  const published = await worker.fetch(req(`/integrity?key=${encodeURIComponent(legacyKey)}`, 'POST', {
    key: legacyKey, size: content.byteLength, etag: object.httpEtag, manifest,
  }, {}, true), e)
  assert.equal(published.status, 200)

  const full = await worker.fetch(req(path), e)
  assert.equal(full.status, 200)
  assert.equal(full.headers.get('X-8BitGo-Integrity-Required'), 'sha256-v1',
    '整份回填对象也必须触发浏览器在交给模拟器前验 SHA-256')
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), content)

  const after = await worker.fetch(req(path, 'GET', undefined, { Range: 'bytes=3-20' }), e)
  assert.equal(after.status, 206)
  assert.equal(after.headers.get('X-8BitGo-Integrity-Required'), 'sha256-v1')
  assert.deepEqual(new Uint8Array(await after.arrayBuffer()), content.subarray(3, 21))
})

test('a backfilled manifest marks an older full-object edge-cache hit for browser verification', async () => {
  const previous = globalThis.caches
  try {
    const e = environment()
    const legacyKey = 'roms/nes/integrity-cached-legacy.nes'
    const object = e.ROMS.seed(legacyKey, content)
    const path = `/${legacyKey}?romv=${object.etag}`
    const manifest = { ...payload(content, legacyKey), etag: object.httpEtag }
    const published = await worker.fetch(req(`/integrity?key=${encodeURIComponent(legacyKey)}`, 'POST', {
      key: legacyKey, size: content.byteLength, etag: object.httpEtag, manifest,
    }, {}, true), e)
    assert.equal(published.status, 200)

    const cached = new Response(content, { headers: { ETag: object.httpEtag, 'Content-Length': String(content.byteLength) } })
    globalThis.caches = { default: { async match(request) { return request.url.endsWith(path) ? cached.clone() : null } } }
    const response = await worker.fetch(req(path), e, { waitUntil() {} })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('X-8BitGo-Integrity-Required'), 'sha256-v1')
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), content)
  } finally {
    if (previous === undefined) delete globalThis.caches
    else globalThis.caches = previous
  }
})

test('a validated integrity sidecar is read from R2 once per Worker isolate and object version', async () => {
  const e = environment()
  const cacheKey = 'roms/psx/integrity-cache-test.chd'
  const object = await seedRequired(e, content, cacheKey)
  const sidecar = await sidecarKey(cacheKey, object.httpEtag)
  const responses = await Promise.all([[0, 31], [32, 63], [64, 95]].map(([start, end]) =>
    worker.fetch(req(`/${cacheKey}?romv=${object.etag}`, 'GET', undefined, {
      Range: `bytes=${start}-${end}`,
    }), e)))
  for (const [index, response] of responses.entries()) {
    const [start, end] = [[0, 31], [32, 63], [64, 95]][index]
    assert.equal(response.status, 206)
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), content.subarray(start, end + 1))
  }
  assert.equal(e.ROMS.calls.filter(call => call.method === 'get' && call.args.key === sidecar).length, 1)
})

test('required ranges fail closed when the published SHA-256 does not match the source object', async () => {
  const e = environment()
  const corruptKey = 'roms/psx/integrity-corrupt-test.chd'
  const object = e.ROMS.seed(corruptKey, content, { customMetadata: { '8bitgo-integrity-required': 'sha256-v1' } })
  const wrong = payload(content, corruptKey)
  wrong.blocks[0] = '0'.repeat(64)
  const publish = await worker.fetch(req(`/integrity?key=${encodeURIComponent(corruptKey)}`, 'POST', {
    key: corruptKey, etag: object.httpEtag, size: object.size, manifest: wrong,
  }, {}, true), e)
  assert.equal(publish.status, 200)
  const response = await worker.fetch(req(`/${corruptKey}?romv=${object.etag}`, 'GET', undefined, {
    Range: 'bytes=0-15',
  }), e)
  assert.equal(response.status, 502)
  assert.equal((await response.json()).code, 'integrity_source_corrupt')
})

test('integrity retry ranges bypass both ordinary and range edge caches', async () => {
  const e = environment()
  const object = await seedRequired(e)
  const request = req(`/${key}?romv=${object.etag}&__8bg_integrity_retry=0-1`, 'GET', undefined, {
    Range: 'bytes=0-31',
  })
  assert.equal(edgeCacheEligible(request, new URL(request.url), { 'Access-Control-Allow-Origin': '*' }), false)
  const response = await worker.fetch(request, e)
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('X-8BitGo-Edge-Cache'), null)
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), content.subarray(0, 32))
  assert.equal(e.ROMS.objects.has(await sidecarKey(key, object.httpEtag)), true)
})
