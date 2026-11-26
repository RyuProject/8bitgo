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
