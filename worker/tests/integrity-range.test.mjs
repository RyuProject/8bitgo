import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import worker, { edgeCacheEligible } from '../src/index.js'
import standaloneWorker from '../standalone/rom-worker.js'
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

test('J2ME full JAR verification streams only ETag-bound SHA-256 blocks and bypasses edge cache', async () => {
  const e = environment()
  const jarKey = 'roms/java/integrity-full-jar-test.jar'
  const object = await seedRequired(e, content, jarKey)
  const path = `/${jarKey}?romv=${object.etag}`
  const request = req(path, 'GET', undefined, { 'X-8BG-Verify-Full': 'sha256-v1' })
  assert.equal(edgeCacheEligible(request, new URL(request.url), { 'Access-Control-Allow-Origin': '*' }), false)

  const response = await worker.fetch(request, e, { waitUntil() { throw new Error('full JAR verification must not use edge cache') } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('X-8BG-Integrity-Verified'), 'sha256-v1')
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), content)
})

test('J2ME full JAR verification fails closed when the sidecar is missing or does not match source bytes', async () => {
  const e = environment()
  const missingKey = 'roms/java/integrity-full-jar-missing.jar'
  const missing = e.ROMS.seed(missingKey, content)
  const missingResponse = await worker.fetch(req(`/${missingKey}?romv=${missing.etag}`, 'GET', undefined,
    { 'X-8BG-Verify-Full': 'sha256-v1' }), e)
  assert.equal(missingResponse.status, 503)
  assert.equal((await missingResponse.json()).code, 'integrity_manifest_missing')

  const corruptKey = 'roms/java/integrity-full-jar-corrupt.jar'
  const corrupt = e.ROMS.seed(corruptKey, content)
  const wrong = payload(content, corruptKey)
  wrong.blocks[0] = '0'.repeat(64)
  const published = await worker.fetch(req(`/integrity?key=${encodeURIComponent(corruptKey)}`, 'POST', {
    key: corruptKey, etag: corrupt.httpEtag, size: corrupt.size, manifest: wrong,
  }, {}, true), e)
  assert.equal(published.status, 200)
  const response = await worker.fetch(req(`/${corruptKey}?romv=${corrupt.etag}`, 'GET', undefined,
    { 'X-8BG-Verify-Full': 'sha256-v1' }), e)
  assert.equal(response.status, 200, '校验在流结束时完成，不能先把未经校验的内容交给代理')
  await assert.rejects(response.arrayBuffer(), /SHA-256 不符/)
})

test('J2ME Range reads require an ETag-bound manifest even while global legacy mode is enabled', async () => {
  const e = environment()
  const jarKey = 'roms/java/integrity-range-jar-test.jar'
  const object = e.ROMS.seed(jarKey, content)
  const path = `/${jarKey}?romv=${object.etag}`
  const headers = { Range: 'bytes=3-20', 'X-8BG-Require-Integrity': 'sha256-v1' }

  const missing = await worker.fetch(req(path, 'GET', undefined, headers), e)
  assert.equal(missing.status, 503)
  assert.equal((await missing.json()).code, 'integrity_manifest_missing')

  const published = await worker.fetch(req(`/integrity?key=${encodeURIComponent(jarKey)}`, 'POST', {
    key: jarKey, etag: object.httpEtag, size: object.size, manifest: payload(content, jarKey),
  }, {}, true), e)
  assert.equal(published.status, 200)
  const verifiedRequest = req(path, 'GET', undefined, headers)
  const response = await worker.fetch(verifiedRequest, e)
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('X-8BitGo-Integrity-Required'), 'sha256-v1')
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), content.subarray(3, 21))

  const standalone = await standaloneWorker.fetch(verifiedRequest, e)
  assert.equal(standalone.status, 206)
  assert.deepEqual(new Uint8Array(await standalone.arrayBuffer()), content.subarray(3, 21))
})

test('J2ME full JAR verification handles block boundaries and standalone Worker uses the same guard', async () => {
  const bytes = new Uint8Array(blockBytes + 17)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 29 + 11) & 0xff
  const jarKey = 'roms/java/integrity-full-jar-blocks.jar'
  const e = environment()
  const object = e.ROMS.seed(jarKey, bytes, { customMetadata: { '8bitgo-integrity-required': 'sha256-v1' } })
  const manifest = { v: 1, alg: 'sha256', key: jarKey, size: bytes.length, blockBytes,
    blocks: [sha256(bytes.subarray(0, blockBytes)), sha256(bytes.subarray(blockBytes))] }
  const published = await worker.fetch(req(`/integrity?key=${encodeURIComponent(jarKey)}`, 'POST', {
    key: jarKey, etag: object.httpEtag, size: object.size, manifest,
  }, {}, true), e)
  assert.equal(published.status, 200)
  const request = req(`/${jarKey}?romv=${object.etag}`, 'GET', undefined, { 'X-8BG-Verify-Full': 'sha256-v1' })
  const modular = await worker.fetch(request, e)
  assert.equal(modular.headers.get('X-8BG-Integrity-Verified'), 'sha256-v1')
  assert.deepEqual(new Uint8Array(await modular.arrayBuffer()), bytes)

  const standalone = await standaloneWorker.fetch(request, e)
  assert.equal(standalone.headers.get('X-8BG-Integrity-Verified'), 'sha256-v1')
  assert.deepEqual(new Uint8Array(await standalone.arrayBuffer()), bytes)
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

test('global strict mode blocks missing sidecars on Range requests without delaying verified reads', async () => {
  const e = environment()
  e.REQUIRE_ALL_ROM_INTEGRITY = 'true'
  const strictKey = 'roms/psx/integrity-strict-range.chd'
  const object = e.ROMS.seed(strictKey, content)
  const path = `/${strictKey}?romv=${object.etag}`
  const range = { Range: 'bytes=3-20' }

  const missing = await worker.fetch(req(path, 'GET', undefined, range), e)
  assert.equal(missing.status, 503)
  assert.equal((await missing.json()).code, 'integrity_manifest_missing')

  const manifest = { ...payload(content, strictKey), etag: object.httpEtag }
  const published = await worker.fetch(req(`/integrity?key=${encodeURIComponent(strictKey)}`, 'POST', {
    key: strictKey, size: content.byteLength, etag: object.httpEtag, manifest,
  }, {}, true), e)
  assert.equal(published.status, 200)
  const verified = await worker.fetch(req(path, 'GET', undefined, range), e)
  assert.equal(verified.status, 206)
  assert.equal(verified.headers.get('X-8BitGo-Integrity-Required'), 'sha256-v1')
  assert.deepEqual(new Uint8Array(await verified.arrayBuffer()), content.subarray(3, 21))
})

test('backfilled manifests mark old edge-cache hits for browser verification in global strict mode', async () => {
  const previous = globalThis.caches
  try {
    const e = environment()
    e.REQUIRE_ALL_ROM_INTEGRITY = 'true'
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

test('global strict mode also blocks stale edge-cache hits without a manifest', async () => {
  const previous = globalThis.caches
  try {
    const e = environment()
    e.REQUIRE_ALL_ROM_INTEGRITY = 'true'
    const strictKey = 'roms/nes/integrity-strict-cached-legacy.nes'
    const object = e.ROMS.seed(strictKey, content)
    const path = `/${strictKey}?romv=${object.etag}`
    globalThis.caches = { default: { async match(request) {
      // Cache API 返回独立响应；不要用 Response.clone() 模拟，tee 流只取消一支会等待另一支。
      return request.url.endsWith(path)
        ? new Response(content, { headers: { ETag: object.httpEtag, 'Content-Length': String(content.byteLength) } })
        : null
    } } }
    const response = await worker.fetch(req(path), e, { waitUntil() {} })
    assert.equal(response.status, 503)
    assert.equal((await response.json()).code, 'integrity_manifest_missing')
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
