import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import worker from '../src/index.js'
import { environment, req } from './fixtures.mjs'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const key = 'roms/nes/integrity-test.nes'
const bytes = new TextEncoder().encode('verified ROM bytes')
const blockBytes = 2 * 1024 * 1024
const payload = () => ({ v: 1, alg: 'sha256', key, size: bytes.length, blockBytes, blocks: [hash(bytes)] })
const endpoint = `/integrity?key=${encodeURIComponent(key)}`

test('new ROM objects stay unavailable until an ETag-bound SHA-256 manifest is published', async () => {
  const env = environment()
  const object = env.ROMS.seed(key, bytes, { customMetadata: { '8bitgo-integrity-required': 'sha256-v1' } })
  const blocked = await worker.fetch(req(`/${key}?romv=${object.etag}`), env)
  assert.equal(blocked.status, 503)
  assert.equal((await blocked.json()).code, 'integrity_manifest_missing')

  const body = { key, size: bytes.length, etag: object.httpEtag, manifest: payload() }
  const published = await worker.fetch(req(endpoint, 'POST', body, {}, true), env)
  assert.equal(published.status, 200)
  assert.deepEqual(await published.json(), { ok: true, key, size: bytes.length, etag: object.httpEtag })

  const manifest = await worker.fetch(req(`${endpoint}&romv=${object.etag}`), env)
  assert.equal(manifest.status, 200)
  const record = await manifest.json()
  assert.equal(record.manifest.blocks[0], hash(bytes))
  assert.equal(record.manifest.etag, object.httpEtag)
  const unversionedManifest = await worker.fetch(req(endpoint), env)
  assert.equal(unversionedManifest.status, 200)
  assert.equal(unversionedManifest.headers.get('Cache-Control'), 'no-store', '可变 key 的摘要不能在对象覆盖后继续命中边缘缓存')

  const loaded = await worker.fetch(req(`/${key}?romv=${object.etag}`), env)
  assert.equal(loaded.status, 200)
  assert.equal(loaded.headers.get('X-8BitGo-Integrity-Required'), 'sha256-v1')
  assert.deepEqual(new Uint8Array(await loaded.arrayBuffer()), bytes)
})

test('integrity publication requires admin auth, valid ROM keys, exact ETag and size', async () => {
  const env = environment()
  const object = env.ROMS.seed(key, bytes)
  const body = { key, size: bytes.length, etag: object.httpEtag, manifest: payload() }
  assert.equal((await worker.fetch(req(endpoint, 'POST', body), env)).status, 401)
  assert.equal((await worker.fetch(req(`/integrity?key=${encodeURIComponent('roms/covers/x.webp')}`, 'POST', body, {}, true), env)).status, 400)
  assert.equal((await worker.fetch(req(endpoint, 'POST', { ...body, etag: '"stale"' }, {}, true), env)).status, 412)
  assert.equal((await worker.fetch(req(endpoint, 'POST', { ...body, size: bytes.length + 1 }, {}, true), env)).status, 400)
  assert.equal(env.ROMS.objects.has('_integrity/'), false)
})

test('legacy ROM integrity hashes are computed from ETag-bound R2 ranges in bounded batches', async () => {
  const env = environment()
  const backfillKey = 'roms/psx/integrity-backfill-test.chd'
  const data = Uint8Array.from({ length: blockBytes + 13 }, (_, index) => (index * 29) & 0xff)
  const object = env.ROMS.seed(backfillKey, data)
  const body = (startIndex, etag = object.httpEtag) => ({
    action: 'hash-blocks', key: backfillKey, size: data.byteLength, etag, startIndex, batchBlocks: 1,
  })
  const path = `/integrity?key=${encodeURIComponent(backfillKey)}`

  assert.equal((await worker.fetch(req(path, 'POST', body(0), {}, false), env)).status, 401)
  const first = await worker.fetch(req(path, 'POST', body(0), {}, true), env)
  assert.equal(first.status, 200)
  const firstResult = await first.json()
  assert.deepEqual(firstResult.blocks, [hash(data.subarray(0, blockBytes))])
  assert.equal(firstResult.nextIndex, 1)

  const last = await worker.fetch(req(path, 'POST', body(1), {}, true), env)
  assert.equal(last.status, 200)
  const lastResult = await last.json()
  assert.deepEqual(lastResult.blocks, [hash(data.subarray(blockBytes))])
  assert.equal(lastResult.nextIndex, 2)
  assert.equal(env.ROMS.objects.has('_integrity/'), false, '哈希阶段只读 R2，不提前发布清单')

  assert.equal((await worker.fetch(req(path, 'POST', body(0, '"stale"'), {}, true), env)).status, 412)
  assert.equal((await worker.fetch(req(path, 'POST', body(2), {}, true), env)).status, 400)
})

test('required marker uploads are restricted to ROM keys and sidecars stay private', async () => {
  const env = environment()
  const bad = await worker.fetch(req('/games/not-a-rom.bin', 'PUT', bytes, { 'X-8BG-Integrity-Required': 'sha256-v1' }, true), env)
  assert.equal(bad.status, 400)
  const put = await worker.fetch(req(`/${key}`, 'PUT', bytes, { 'X-8BG-Integrity-Required': 'sha256-v1' }, true), env)
  assert.equal(put.status, 200)
  assert.equal((await worker.fetch(req('/_integrity/anything.json'), env)).status, 404)
})

test('single PUT publishes its ETag-bound manifest in the same Worker request', async () => {
  const env = environment()
  const atomicKey = 'roms/nes/integrity-atomic-put.nes'
  const manifest = { ...payload(), key: atomicKey }
  const header = Buffer.from(JSON.stringify(manifest)).toString('base64url')
  const put = await worker.fetch(req(`/${atomicKey}`, 'PUT', bytes, {
    'X-8BG-Integrity-Required': 'sha256-v1',
    'X-8BG-Integrity-Manifest': header,
  }, true), env)
  assert.equal(put.status, 200)
  assert.equal((await put.json()).integrityPublished, true)
  const object = await env.ROMS.head(atomicKey)
  const loaded = await worker.fetch(req(`/integrity?key=${encodeURIComponent(atomicKey)}&romv=${object.etag}`), env)
  assert.equal(loaded.status, 200)
  assert.equal((await loaded.json()).manifest.blocks[0], hash(bytes))
  const sidecar = `_integrity/${hash(new TextEncoder().encode(`${atomicKey}\n${object.httpEtag}`))}.json`
  assert.equal(env.ROMS.objects.has(sidecar), true)
  assert.equal((await worker.fetch(req(`/${sidecar}`), env)).status, 404, '内部 sidecar 不能通过公开对象路由读取')
})

test('multipart completion validates and publishes its manifest before acknowledging the commit', async () => {
  const env = environment()
  const atomicKey = 'roms/nes/integrity-atomic-multipart.nes'
  const requestId = 'atomic-multipart-upload-123'
  const create = await worker.fetch(req(`/${atomicKey}?uploads`, 'POST', {
    contentType: 'application/octet-stream', size: bytes.length, requestId, integrityRequired: true,
  }, {}, true), env)
  const session = await create.json()
  const part = await worker.fetch(req(`/${atomicKey}?uploadId=${session.uploadId}`, 'PUT', bytes, {
    'X-8BG-Part-Number': '1',
  }, true), env)
  const partInfo = await part.json()
  const complete = await worker.fetch(req(`/${atomicKey}?uploadId=${session.uploadId}`, 'POST', {
    parts: [{ partNumber: 1, etag: partInfo.etag }], marker: session.marker,
    requestId, requestSignature: session.requestSignature, size: bytes.length,
    integrityRequired: true, integrityManifest: { ...payload(), key: atomicKey },
  }, {}, true), env)
  assert.equal(complete.status, 200)
  assert.equal((await complete.json()).integrityPublished, true)
  assert.equal((await worker.fetch(req(`/${atomicKey}`), env)).status, 200)
})

test('aligned and unaligned optical-disc Range responses are checked before reaching the core', async () => {
  const env = environment()
  const discKey = 'roms/psx/integrity-test.chd'
  const data = new TextEncoder().encode('disc block data')
  const blockHash = hash(data)
  const object = env.ROMS.seed(discKey, data, { customMetadata: { '8bitgo-integrity-required': 'sha256-v1' } })
  const manifest = { v: 1, alg: 'sha256', key: discKey, etag: object.httpEtag, size: data.length, blockBytes, blocks: [blockHash] }
  const sidecarKey = `_integrity/${hash(new TextEncoder().encode(`${discKey}\n${object.httpEtag}`))}.json`
  env.ROMS.seed(sidecarKey, JSON.stringify(manifest))

  for (const [start, end] of [[0, data.length - 1], [3, data.length - 4]]) {
    const response = await worker.fetch(req(`/${discKey}?romv=${object.etag}`, 'GET', undefined,
      { Range: `bytes=${start}-${end}` }), env)
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('Content-Range'), `bytes ${start}-${end}/${data.length}`)
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), data.subarray(start, end + 1))
  }
})

test('integrity capability is advertised and legacy objects remain readable during backfill', async () => {
  const env = environment()
  const ping = await worker.fetch(req('/ping'), env)
  const features = (await ping.json()).features
  assert.equal(features.integrityManifest, true)
  assert.equal(features.requireAllRomIntegrity, false, '默认保留旧资源兼容，不能在未盘点时意外锁死游戏')
  const legacyKey = 'roms/nes/integrity-legacy-test.nes'
  env.ROMS.seed(legacyKey, bytes)
  assert.equal((await worker.fetch(req(`/${legacyKey}`), env)).status, 200)
  assert.equal((await worker.fetch(req(`/integrity?key=${encodeURIComponent(legacyKey)}`), env)).status, 404)
})

test('global strict mode fails closed for unbackfilled ROMs and allows verified legacy objects', async () => {
  const env = environment()
  env.REQUIRE_ALL_ROM_INTEGRITY = 'true'
  const ping = await worker.fetch(req('/ping'), env)
  assert.equal((await ping.json()).features.requireAllRomIntegrity, true)
  const strictKey = 'roms/nes/integrity-strict-legacy.nes'
  const object = env.ROMS.seed(strictKey, bytes)
  const path = `/${strictKey}?romv=${object.etag}`

  const blocked = await worker.fetch(req(path), env)
  assert.equal(blocked.status, 503)
  assert.equal((await blocked.json()).code, 'integrity_manifest_missing')
  const manifestBlocked = await worker.fetch(req(`/integrity?key=${encodeURIComponent(strictKey)}`), env)
  assert.equal(manifestBlocked.status, 503)
  assert.equal((await manifestBlocked.json()).code, 'integrity_manifest_missing')

  const published = await worker.fetch(req(`/integrity?key=${encodeURIComponent(strictKey)}`, 'POST', {
    key: strictKey, size: bytes.length, etag: object.httpEtag, manifest: { ...payload(), key: strictKey },
  }, {}, true), env)
  assert.equal(published.status, 200)
  const loaded = await worker.fetch(req(path), env)
  assert.equal(loaded.status, 200)
  assert.equal(loaded.headers.get('X-8BitGo-Integrity-Required'), 'sha256-v1')
  assert.deepEqual(new Uint8Array(await loaded.arrayBuffer()), bytes)

  const coversObject = env.ROMS.seed('roms/covers/test.webp', bytes)
  const covers = await worker.fetch(req(`/roms/covers/test.webp?romv=${coversObject.etag}`), env)
  assert.equal(covers.status, 200, '全局模式只强制 ROM / BIOS，不拦封面')
})
