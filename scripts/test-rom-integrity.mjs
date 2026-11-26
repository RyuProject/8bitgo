import assert from 'node:assert/strict'
import {
  ROM_INTEGRITY_BLOCK_BYTES,
  createRomIntegrityManifest,
  isIntegrityKey,
  validateRomIntegrityManifest,
} from '../src/services/romIntegrityData.ts'
import {
  fetchRomIntegrityManifest,
  RomIntegrityError,
  romIntegrityKey,
  verifyRomBlob,
  verifyRomBytes,
  verifyRomResponse,
} from '../src/services/romIntegrity.ts'
import { fetchBlobWithProgress, fetchWithProgress } from '../src/emulator/loadProgress.ts'

function hex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

const originalFetch = globalThis.fetch
const originalLocation = globalThis.location
try {
  globalThis.location = { href: 'https://8bitgo.com/' }

  const content = new Uint8Array(ROM_INTEGRITY_BLOCK_BYTES + 17)
  for (let index = 0; index < content.byteLength; index++) content[index] = index % 251
  const key = 'roms/integrity-test/manifest.rom'
  const manifest = await createRomIntegrityManifest(new Blob([content]), key)
  assert.equal(manifest.blocks.length, 2)
  assert.deepEqual(manifest.blocks, await Promise.all([
    content.subarray(0, ROM_INTEGRITY_BLOCK_BYTES),
    content.subarray(ROM_INTEGRITY_BLOCK_BYTES),
  ].map(async block => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', block))))))

  assert.equal(isIntegrityKey(key), true)
  for (const unsafe of ['roms/covers/a.webp', 'roms/../secret', 'roms/a\\b', 'roms/a\n']) {
    assert.equal(isIntegrityKey(unsafe), false, unsafe)
  }
  assert.equal(validateRomIntegrityManifest({ ...manifest, etag: '"v1"' }, key, '"v1"', content.byteLength)?.etag, '"v1"')
  assert.equal(validateRomIntegrityManifest({ ...manifest, blocks: [...manifest.blocks, 'a'.repeat(64)], etag: '"v1"' }, key, '"v1"', content.byteLength), null)
  assert.equal(romIntegrityKey('https://rom.8bitgo.com/roms/test/game.gba'), 'roms/test/game.gba')
  assert.equal(romIntegrityKey('https://rom.8bitgo.com/roms/covers/cover.webp'), null)

  const etag = '"manifest-shape-v1"'
  const tiny = new Uint8Array([1, 2, 3, 4])
  const tinyHash = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', tiny)))
  const tinyManifest = { v: 1, alg: 'sha256', key: 'roms/integrity-test/game.gba', etag, size: tiny.byteLength,
    blockBytes: ROM_INTEGRITY_BLOCK_BYTES, blocks: [tinyHash] }
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    assert.equal(url.pathname, '/integrity')
    assert.equal(url.searchParams.get('key'), tinyManifest.key)
    return new Response(JSON.stringify({ etag, size: tiny.byteLength, manifest: tinyManifest }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const loadedManifest = await fetchRomIntegrityManifest(`https://rom.8bitgo.com/${tinyManifest.key}?romv=manifest-shape-v1`)
  assert.deepEqual(loadedManifest, tinyManifest, 'frontend accepts the Worker nested manifest response')

  const responseUrl = `https://rom.8bitgo.com/${tinyManifest.key}?romv=manifest-shape-v1`
  let optionalManifestRequested = false
  globalThis.fetch = async () => {
    optionalManifestRequested = true
    throw new Error('legacy objects must not wait for a checksum sidecar')
  }
  const legacyResponse = new Response(tiny)
  assert.equal(await verifyRomResponse(responseUrl, legacyResponse), legacyResponse)
  assert.equal(optionalManifestRequested, false)

  const damaged = new Uint8Array([9, 9, 9, 9])
  let repairRequest
  globalThis.fetch = async (input, init) => {
    repairRequest = { url: String(input), init }
    return new Response(tiny, { status: 206, headers: {
      'Content-Range': `bytes 0-${tiny.byteLength - 1}/${tiny.byteLength}`,
      ETag: etag,
    } })
  }
  const markedResponse = new Response(damaged, { headers: {
    'X-8BitGo-Integrity-Required': 'sha256-v1', ETag: etag, 'Content-Length': String(damaged.byteLength),
  } })
  const repaired = await verifyRomResponse(responseUrl, markedResponse, undefined, Promise.resolve(tinyManifest))
  assert.deepEqual(new Uint8Array(await repaired.arrayBuffer()), tiny)
  assert.equal(repairRequest.init.headers.Range, `bytes=0-${tiny.byteLength - 1}`)
  assert.equal(repairRequest.init.headers['If-Match'], etag)
  assert.equal(repairRequest.init.headers['Cache-Control'], undefined, 'repair request must not trigger an unallowed CORS header')

  let corruptBlob = false
  globalThis.fetch = async (input, init = {}) => {
    const target = new URL(String(input))
    if (target.pathname === '/integrity') {
      return new Response(JSON.stringify({ etag, size: tiny.byteLength, manifest: tinyManifest }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (init.headers?.Range) {
      const start = Number(/^bytes=(\d+)-/.exec(init.headers.Range)?.[1] ?? 0)
      const end = Math.min(tiny.byteLength - 1, Number(/-(\d+)$/.exec(init.headers.Range)?.[1] ?? tiny.byteLength - 1))
      return new Response(tiny.subarray(start, end + 1), { status: 206, headers: {
        'Content-Range': `bytes ${start}-${end}/${tiny.byteLength}`,
        ETag: etag,
        'X-8BitGo-Integrity-Required': 'sha256-v1',
      } })
    }
    return new Response(damaged, { headers: {
      ETag: etag,
      'Content-Length': String(damaged.byteLength),
      'X-8BitGo-Integrity-Required': 'sha256-v1',
    } })
  }
  const centrallyVerified = await fetchWithProgress(responseUrl)
  assert.deepEqual(new Uint8Array(centrallyVerified), tiny, '通用 ArrayBuffer 下载器必须在交付前修复/校验必校验对象')

  globalThis.fetch = async (input, init = {}) => {
    const target = new URL(String(input))
    if (target.pathname === '/integrity') {
      return new Response(JSON.stringify({ etag, size: tiny.byteLength, manifest: tinyManifest }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(init.headers?.Range ?? '')
    assert.ok(range, '大文件 Blob 下载必须使用 Range')
    const bytes = corruptBlob ? damaged : tiny
    return new Response(bytes, { status: 206, headers: {
      'Content-Range': `bytes 0-${bytes.byteLength - 1}/${tiny.byteLength}`,
      ETag: etag,
      'X-8BitGo-Integrity-Required': 'sha256-v1',
    } })
  }
  const verifiedBlob = await fetchBlobWithProgress(responseUrl)
  assert.deepEqual(new Uint8Array(await verifiedBlob.arrayBuffer()), tiny, '通用分片 Blob 下载必须校验后才交付')
  corruptBlob = true
  await assert.rejects(fetchBlobWithProgress(responseUrl), RomIntegrityError,
    '清单标记对象的损坏 Blob 分片必须拒绝交给模拟器')

  const repairableBytes = new Uint8Array(damaged)
  globalThis.fetch = async () => new Response(tiny, { status: 206, headers: {
    'Content-Range': `bytes 0-${tiny.byteLength - 1}/${tiny.byteLength}`,
    ETag: etag,
  } })
  assert.equal(await verifyRomBytes(responseUrl, repairableBytes, tinyManifest), true)
  assert.deepEqual(repairableBytes, tiny, '整份下载的坏块只重取并替换对应校验块')
  await assert.rejects(verifyRomBlob(new Blob([damaged]), tinyManifest), /缓存第 1 块 SHA-256 不匹配/)

  const markedHeaders = {
    'X-8BitGo-Integrity-Required': 'sha256-v1',
    ETag: etag,
    'Content-Length': String(tiny.byteLength),
  }
  const fragmented = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(tiny.subarray(0, 1))
      controller.enqueue(tiny.subarray(1, 3))
      controller.enqueue(tiny.subarray(3))
      controller.close()
    },
  }), { headers: markedHeaders })
  const verifiedStream = await verifyRomResponse(responseUrl, fragmented, undefined, Promise.resolve(tinyManifest))
  assert.deepEqual(new Uint8Array(await verifiedStream.arrayBuffer()), tiny, '任意网络分片都必须组装到校验块后再验证')

  const badResponse = (bytes) => new Response(new ReadableStream({
    start(controller) { controller.enqueue(bytes); controller.close() },
  }), { headers: { ...markedHeaders, 'Content-Length': String(bytes.byteLength) } })
  await assert.rejects(
    async () => {
      const response = await verifyRomResponse(responseUrl, badResponse(new Uint8Array([...tiny, 5])), undefined, Promise.resolve(tinyManifest))
      await response.arrayBuffer()
    },
    /响应长度不符/,
  )
  await assert.rejects(
    async () => {
      const response = await verifyRomResponse(responseUrl, badResponse(tiny.subarray(0, 2)), undefined, Promise.resolve(tinyManifest))
      await response.arrayBuffer()
    },
    RomIntegrityError,
  )

  globalThis.fetch = async () => new Response(new Uint8Array(tiny.byteLength + 1024), { status: 206, headers: {
    'Content-Range': `bytes 0-${tiny.byteLength - 1}/${tiny.byteLength}`,
    ETag: etag,
  } })
  await assert.rejects(
    async () => {
      const response = await verifyRomResponse(responseUrl, new Response(damaged, { headers: {
        'X-8BitGo-Integrity-Required': 'sha256-v1', ETag: etag,
      } }), undefined, Promise.resolve(tinyManifest))
      await response.arrayBuffer()
    },
    /超过声明长度/,
  )

  await assert.rejects(
    verifyRomResponse(responseUrl, new Response(damaged, { headers: { 'X-8BitGo-Integrity-Required': 'sha256-v1' } }), undefined, Promise.resolve(null)),
    RomIntegrityError,
  )
  console.log('ROM 完整性清单生成、Worker 响应解析、范围修复与必校验失败路径均通过')
} finally {
  globalThis.fetch = originalFetch
  if (originalLocation === undefined) delete globalThis.location
  else globalThis.location = originalLocation
}
