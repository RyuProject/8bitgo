import assert from 'node:assert/strict'
import {
  ROM_INTEGRITY_BLOCK_BYTES,
  createRomIntegrityManifest,
  isIntegrityKey,
  validateRomIntegrityManifest,
} from '../src/services/romIntegrityData.ts'
import {
  fetchRomIntegrityManifest,
  romBlobIntegrityTag,
  RomIntegrityError,
  romIntegrityManifestTag,
  romIntegrityManifestUrl,
  romIntegrityKey,
  verifyRomBlob,
  verifyRomBlobRange,
  verifyRomBytes,
  verifyRomResponse,
} from '../src/services/romIntegrity.ts'
import { fetchBlobWithProgress, fetchWithProgress } from '../src/emulator/loadProgress.ts'

function hex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

const originalFetch = globalThis.fetch
const originalLocation = globalThis.location
const originalLocalStorage = globalThis.localStorage
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
  assert.equal(romIntegrityManifestUrl('https://rom.8bitgo.com/roms/test/game.gba?romv=version-1'),
    'https://rom.8bitgo.com/integrity?key=roms%2Ftest%2Fgame.gba&romv=version-1',
    'standalone same-origin runtime receives the same key and version used by the normal ROM loader')
  assert.equal(romIntegrityManifestUrl('https://example.org/roms/test/game.gba'), null,
    'external BIOS URLs do not get assigned a fabricated trusted manifest')

  // 单个 8 MiB 下载分片的四个 2 MiB 摘要应分两路计算，限制额外瞬时内存。
  const rangeContent = new Uint8Array(ROM_INTEGRITY_BLOCK_BYTES * 4)
  for (let index = 0; index < rangeContent.byteLength; index++) rangeContent[index] = (index * 17) % 251
  const rangeKey = 'roms/integrity-test/parallel-range.gba'
  const rangeManifest = await createRomIntegrityManifest(new Blob([rangeContent]), rangeKey)
  const originalDigest = crypto.subtle.digest.bind(crypto.subtle)
  let activeDigests = 0
  let maximumActiveDigests = 0
  let rangeDigestCalls = 0
  crypto.subtle.digest = async (...args) => {
    activeDigests++
    rangeDigestCalls++
    maximumActiveDigests = Math.max(maximumActiveDigests, activeDigests)
    try {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return await originalDigest(...args)
    } finally { activeDigests-- }
  }
  try {
    const rangeBlob = new Blob([rangeContent])
    assert.equal(await verifyRomBlobRange(`https://rom.8bitgo.com/${rangeKey}`, rangeBlob, 0, rangeManifest), rangeBlob,
      '全部完整性块正确时保留原 Blob，避免额外合并复制')
    assert.equal(rangeDigestCalls, 4, '每个 2 MiB 块恰好散列一次')
    assert.equal(maximumActiveDigests, 2, '分片校验最多并行两个 SHA-256，控制瞬时内存')
  } finally { crypto.subtle.digest = originalDigest }

  const etag = '"manifest-shape-v1"'
  const tiny = new Uint8Array([1, 2, 3, 4])
  const tinyHash = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', tiny)))
  const tinyManifest = { v: 1, alg: 'sha256', key: 'roms/integrity-test/game.gba', etag, size: tiny.byteLength,
    blockBytes: ROM_INTEGRITY_BLOCK_BYTES, blocks: [tinyHash] }
  const manifestTag = await romIntegrityManifestTag(tinyManifest)
  assert.match(manifestTag, /^sha256:[a-f0-9]{64}$/)
  assert.equal(await romIntegrityManifestTag({ ...tinyManifest }), manifestTag,
    '同一份清单应产生稳定缓存校验标签')
  assert.notEqual(await romIntegrityManifestTag({ ...tinyManifest, blocks: ['0'.repeat(64)] }), manifestTag,
    '清单块哈希变化必须让旧缓存印记失效')
  assert.notEqual(await romIntegrityManifestTag({ ...tinyManifest, etag: '"manifest-shape-v2"' }), manifestTag,
    'ROM 对象版本变化必须让旧缓存印记失效')
  if (typeof SharedArrayBuffer === 'function') {
    const shared = new Uint8Array(new SharedArrayBuffer(tiny.byteLength))
    shared.set(tiny)
    assert.equal(await verifyRomBytes(`https://rom.8bitgo.com/${tinyManifest.key}`, shared, tinyManifest), false,
      'WebCrypto digest must safely handle SharedArrayBuffer-backed input by snapshotting the current ROM block')
  }
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

  // Worker API 主域偶发不可达时，改从同一对象的 ROM 读取域取清单，不把一次故障变成启动失败。
  globalThis.localStorage = { getItem: (key) => key === '8bitgo.rom.api' ? 'https://roms.8bitgo.com' : null }
  const fallbackKey = 'roms/integrity-test/manifest-fallback.gba'
  const fallbackManifest = { ...tinyManifest, key: fallbackKey }
  const manifestOrigins = []
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    manifestOrigins.push(url.origin)
    if (url.origin === 'https://roms.8bitgo.com') throw new TypeError('API host unavailable')
    assert.equal(url.origin, 'https://rom.8bitgo.com', 'fallback only targets the trusted object origin')
    assert.equal(url.searchParams.get('key'), fallbackKey)
    return new Response(JSON.stringify({ etag, size: tiny.byteLength, manifest: fallbackManifest }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
  assert.deepEqual(
    await fetchRomIntegrityManifest(`https://rom.8bitgo.com/${fallbackKey}?romv=manifest-shape-v1`),
    fallbackManifest,
  )
  assert.deepEqual(manifestOrigins, ['https://roms.8bitgo.com', 'https://rom.8bitgo.com'],
    '专用 API 主机失败后，应在同一 ROM Worker 读取域成功取得清单')

  // 主域卡住时，首个可信同桶备用域应以一次受限的延迟竞速缩短必校验对象的等待。
  const hedgeKey = 'roms/integrity-test/manifest-hedge.gba'
  const hedgeEtag = '"manifest-hedge-v1"'
  const hedgeManifest = { ...tinyManifest, key: hedgeKey, etag: hedgeEtag }
  const hedgeOrigins = []
  let primaryHedgeAborted = false
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    hedgeOrigins.push(url.origin)
    if (url.origin === 'https://roms.8bitgo.com') {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          primaryHedgeAborted = true
          reject(new DOMException('hedged request canceled', 'AbortError'))
        }, { once: true })
      })
    }
    assert.equal(url.origin, 'https://rom.8bitgo.com')
    return new Response(JSON.stringify({ etag: hedgeEtag, size: tiny.byteLength, manifest: hedgeManifest }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const hedgeStartedAt = Date.now()
  assert.deepEqual(
    await fetchRomIntegrityManifest(`https://rom.8bitgo.com/${hedgeKey}?romv=manifest-hedge-v1`),
    hedgeManifest,
  )
  assert.ok(Date.now() - hedgeStartedAt < 1_000, '备用域应在 150ms 延迟竞速后快速返回，不等主域 2.5 秒超时')
  assert.equal(primaryHedgeAborted, true, '备用域胜出后立即取消仍未返回的主域请求')
  assert.deepEqual(hedgeOrigins, ['https://roms.8bitgo.com', 'https://rom.8bitgo.com'])

  // 只有一个可信清单地址时仍须等它的有效响应，不能把 150ms 竞速窗口误当总超时。
  globalThis.localStorage = { getItem: (key) => key === '8bitgo.rom.api' ? 'https://rom.8bitgo.com' : null }
  const singleRouteKey = 'roms/integrity-test/manifest-single-route.gba'
  const singleRouteEtag = '"manifest-single-route-v1"'
  const singleRouteManifest = { ...tinyManifest, key: singleRouteKey, etag: singleRouteEtag }
  globalThis.fetch = async () => {
    await new Promise((resolve) => setTimeout(resolve, 220))
    return new Response(JSON.stringify({ etag: singleRouteEtag, size: tiny.byteLength, manifest: singleRouteManifest }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
  assert.deepEqual(
    await fetchRomIntegrityManifest(`https://rom.8bitgo.com/${singleRouteKey}?romv=manifest-single-route-v1`),
    singleRouteManifest,
    '无可信备用域时仍等待唯一主域的有效清单，不可在 hedge delay 后过早退回 null',
  )

  // 版本化地址只永久缓存有效清单；临时网络失败的 null 结果到期后必须重新请求。
  globalThis.localStorage = { getItem: (key) => key === '8bitgo.rom.api' ? 'https://roms.8bitgo.com' : null }
  const originalNow = Date.now
  let fakeNow = originalNow()
  let transientFetches = 0
  Date.now = () => fakeNow
  try {
    const transientKey = 'roms/integrity-test/manifest-transient.gba'
    const transientEtag = '"manifest-transient-v1"'
    globalThis.fetch = async (input) => {
      transientFetches++
      if (transientFetches <= 2) throw new TypeError('temporary network outage')
      const url = new URL(String(input))
      assert.equal(url.searchParams.get('key'), transientKey)
      return new Response(JSON.stringify({ etag: transientEtag, size: tiny.byteLength,
        manifest: { ...tinyManifest, key: transientKey, etag: transientEtag } }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const transientUrl = `https://rom.8bitgo.com/${transientKey}?romv=manifest-transient-v1`
    assert.equal(await fetchRomIntegrityManifest(transientUrl), null, '双线路临时失败保留兼容回退结果')
    fakeNow += 30_001
    assert.equal((await fetchRomIntegrityManifest(transientUrl))?.key, transientKey,
      '短暂网络故障的版本化清单缓存到期后会重新获取')
    assert.equal(transientFetches, 3)
  } finally { Date.now = originalNow }

  const responseUrl = `https://rom.8bitgo.com/${tinyManifest.key}?romv=manifest-shape-v1`
  let optionalManifestRequested = false
  globalThis.fetch = async () => {
    optionalManifestRequested = true
    throw new Error('legacy objects must not wait for a checksum sidecar')
  }
  const legacyResponse = new Response(tiny)
  assert.equal(await verifyRomResponse(responseUrl, legacyResponse), legacyResponse)
  assert.equal(optionalManifestRequested, false)

  // 旧版兼容对象的可选清单若慢于 ROM，不应在传完后再让小游戏多等数秒。
  const optionalWaitKey = 'roms/integrity-test/optional-wait.gba'
  const optionalWaitEtag = '"optional-wait-v1"'
  const optionalWaitManifest = { ...tinyManifest, key: optionalWaitKey, etag: optionalWaitEtag }
  const optionalWaitUrl = `https://rom.8bitgo.com/${optionalWaitKey}?romv=optional-wait-v1`
  const optionalUnverified = new Uint8Array([9, 9, 9, 9])
  let releaseOptionalManifest
  globalThis.fetch = () => new Promise((resolve) => { releaseOptionalManifest = resolve })
  const optionalWaitBlobTask = fetchBlobWithProgress(optionalWaitUrl, {
    chunkBytes: tiny.byteLength,
    retries: 0,
    fetchImpl: async () => new Response(optionalUnverified, { headers: { ETag: optionalWaitEtag } }),
  })
  let optionalWaitTimer
  const completedBeforeManifest = await Promise.race([
    optionalWaitBlobTask.then(() => true),
    new Promise((resolve) => { optionalWaitTimer = setTimeout(() => resolve(false), 1_000) }),
  ])
  clearTimeout(optionalWaitTimer)
  assert.equal(completedBeforeManifest, true, 'ROM 已到手时不应继续等未标记必校验的慢清单')
  const optionalWaitBlob = await optionalWaitBlobTask
  assert.deepEqual(new Uint8Array(await optionalWaitBlob.arrayBuffer()), optionalUnverified,
    '可选清单超时仍保持兼容，不阻塞当前 ROM 交付')
  releaseOptionalManifest(new Response(JSON.stringify({ etag: optionalWaitEtag, size: tiny.byteLength,
    manifest: optionalWaitManifest }), { headers: { 'Content-Type': 'application/json' } }))
  assert.deepEqual(await fetchRomIntegrityManifest(optionalWaitUrl), optionalWaitManifest,
    '超时旁路的清单请求仍在后台完成并进入同页缓存')
  assert.equal(romBlobIntegrityTag(optionalWaitBlob), undefined,
    '清单迟到时绝不能把未校验、甚至已损坏的 ROM 标成可信缓存')

  // 短窗口内已到的可选清单仍要校验，并能从同版本 R2 修复被污染的内容。
  const optionalRepairKey = 'roms/integrity-test/optional-repair.gba'
  const optionalRepairEtag = '"optional-repair-v1"'
  const optionalRepairManifest = { ...tinyManifest, key: optionalRepairKey, etag: optionalRepairEtag }
  const optionalRepairUrl = `https://rom.8bitgo.com/${optionalRepairKey}?romv=optional-repair-v1`
  const optionalCorrupt = new Uint8Array([9, 9, 9, 9])
  let optionalRepairRequests = 0
  globalThis.fetch = async (input, init = {}) => {
    if (init.headers?.Range) {
      optionalRepairRequests++
      return new Response(tiny, { status: 206, headers: {
        'Content-Range': `bytes 0-${tiny.byteLength - 1}/${tiny.byteLength}`,
        ETag: optionalRepairEtag,
      } })
    }
    return new Response(JSON.stringify({ etag: optionalRepairEtag, size: tiny.byteLength,
      manifest: optionalRepairManifest }), { headers: { 'Content-Type': 'application/json' } })
  }
  const repairedOptionalBlob = await fetchBlobWithProgress(optionalRepairUrl, {
    chunkBytes: tiny.byteLength,
    retries: 0,
    fetchImpl: async () => new Response(optionalCorrupt, { headers: { ETag: optionalRepairEtag } }),
  })
  assert.deepEqual(new Uint8Array(await repairedOptionalBlob.arrayBuffer()), tiny,
    '可选清单及时到达时仍须验证并修复 ROM')
  assert.equal(optionalRepairRequests, 1)
  assert.equal(romBlobIntegrityTag(repairedOptionalBlob), await romIntegrityManifestTag(optionalRepairManifest),
    '只有按及时到达的清单校验并修复后才记录可信印记')

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
  let failRepair = false
  const blobProgress = []
  globalThis.fetch = async (input, init = {}) => {
    const target = new URL(String(input))
    if (target.pathname === '/integrity') {
      return new Response(JSON.stringify({ etag, size: tiny.byteLength, manifest: tinyManifest }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (init.headers?.Range) {
      if (target.searchParams.has('__8bg_integrity_retry') && failRepair) {
        return new Response(damaged, { status: 206, headers: {
          'Content-Range': `bytes 0-${tiny.byteLength - 1}/${tiny.byteLength}`,
          ETag: etag,
        } })
      }
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
    if (target.searchParams.has('__8bg_integrity_retry') && failRepair) {
      return new Response(damaged, { status: 206, headers: {
        'Content-Range': `bytes 0-${tiny.byteLength - 1}/${tiny.byteLength}`,
        ETag: etag,
      } })
    }
    const bytes = target.searchParams.has('__8bg_integrity_retry') ? tiny : (corruptBlob ? damaged : tiny)
    return new Response(bytes, { status: 206, headers: {
      'Content-Range': `bytes 0-${bytes.byteLength - 1}/${tiny.byteLength}`,
      ETag: etag,
      'X-8BitGo-Integrity-Required': 'sha256-v1',
    } })
  }
  const verifiedBlob = await fetchBlobWithProgress(responseUrl)
  assert.deepEqual(new Uint8Array(await verifiedBlob.arrayBuffer()), tiny, '通用分片 Blob 下载必须校验后才交付')
  assert.equal(romBlobIntegrityTag(verifiedBlob), await romIntegrityManifestTag(tinyManifest),
    'Worker 强制校验的完整分片也应携带已验证清单印记')
  corruptBlob = true
  const repairedBlob = await fetchBlobWithProgress(responseUrl, { onProgress: (progress) => blobProgress.push(progress.ratio) })
  assert.deepEqual(new Uint8Array(await repairedBlob.arrayBuffer()), tiny,
    '坏网络分片必须在交给模拟器前从同一 ETag 的 R2 对象修复')
  assert.equal(blobProgress.at(-1), 1, 'SHA-256 校验和坏块修复完成后才允许报告 100%')
  assert.ok(blobProgress.slice(0, -1).every((ratio) => ratio === undefined || ratio < 1),
    '校验未完成时不可提前显示 100%')
  failRepair = true
  await assert.rejects(fetchBlobWithProgress(responseUrl), RomIntegrityError,
    '坏块无法从可信同版本对象修复时必须拒绝交给模拟器')

  failRepair = false
  const cachedBadPart = {
    async load(_key, chunkBytes) {
      return { total: tiny.byteLength, chunkBytes, parts: new Map([[0, new Blob([damaged])]]) }
    },
    async put() {},
    async clear() {},
  }
  const cachedBlob = await fetchBlobWithProgress(responseUrl, {
    chunkBytes: tiny.byteLength,
    resumeKey: 'https://rom.8bitgo.com/roms/integrity-test/cache?romv=manifest-shape-v1',
    resumeStore: cachedBadPart,
  })
  assert.deepEqual(new Uint8Array(await cachedBlob.arrayBuffer()), tiny,
    '完整命中续传缓存且本次没有 ROM 网络响应头时也必须校验并修复')

  // 外层失速重试会重新从断点库读已完成分片；上一轮的“已校验 index”不能替代新读出的 Blob 校验。
  const retryContent = new Uint8Array(ROM_INTEGRITY_BLOCK_BYTES + 17)
  for (let index = 0; index < retryContent.byteLength; index++) retryContent[index] = (index * 13) % 251
  const retryKey = 'roms/integrity-test/retry-resume-corruption.gba'
  const retryEtag = '"retry-resume-v1"'
  const retryPayload = await createRomIntegrityManifest(new Blob([retryContent]), retryKey)
  const retryManifest = { ...retryPayload, etag: retryEtag }
  const retryUrl = `https://rom.8bitgo.com/${retryKey}?romv=retry-resume-v1`
  let retryManifestRequests = 0
  globalThis.fetch = async (input, init = {}) => {
    const target = new URL(String(input))
    if (target.pathname === '/integrity') {
      retryManifestRequests++
      return new Response(JSON.stringify({ etag: retryEtag, size: retryContent.byteLength, manifest: retryManifest }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(init.headers?.Range ?? '')
    assert.ok(range, '损坏续传片修复必须带精确 Range')
    const start = Number(range[1])
    const end = Number(range[2])
    return new Response(retryContent.slice(start, end + 1), { status: 206, headers: {
      'Content-Range': `bytes ${start}-${end}/${retryContent.byteLength}`,
      'Content-Length': String(end - start + 1),
      ETag: retryEtag,
    } })
  }
  let resumeLoads = 0
  const retryParts = new Map()
  const retryResumeStore = {
    async load(_key, chunkBytes) {
      resumeLoads++
      if (resumeLoads === 1 || !retryParts.size) return null
      // 模拟浏览器断点库在两次尝试之间读出了等长但内容受损的 Blob。
      const corrupted = new Uint8Array(retryContent.slice(0, ROM_INTEGRITY_BLOCK_BYTES))
      corrupted[0] ^= 0xff
      return { total: retryContent.byteLength, chunkBytes, parts: new Map([[0, new Blob([corrupted])]]) }
    },
    async put(_key, _total, _chunkBytes, index, blob) { retryParts.set(index, blob) },
    async clear() { retryParts.clear() },
  }
  let rangeOneAttempts = 0
  const retryFetchImpl = async (_input, init = {}) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(init.headers?.Range ?? '')
    assert.ok(range)
    const start = Number(range[1])
    const end = Number(range[2])
    if (start === 0) return new Response(retryContent.slice(start, end + 1), { status: 206, headers: {
      'Content-Range': `bytes ${start}-${end}/${retryContent.byteLength}`,
      'Content-Length': String(end - start + 1),
      ETag: retryEtag,
      'X-8BitGo-Integrity-Required': 'sha256-v1',
    } })
    rangeOneAttempts++
    if (rangeOneAttempts === 1) {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('stalled request aborted', 'AbortError')), { once: true })
      })
    }
    return new Response(retryContent.slice(start, end + 1), { status: 206, headers: {
      'Content-Range': `bytes ${start}-${end}/${retryContent.byteLength}`,
      'Content-Length': String(end - start + 1),
      ETag: retryEtag,
      'X-8BitGo-Integrity-Required': 'sha256-v1',
    } })
  }
  const resumedAfterStall = await fetchBlobWithProgress(retryUrl, {
    chunkBytes: ROM_INTEGRITY_BLOCK_BYTES,
    retries: 1,
    stallMs: 200,
    resumeKey: retryUrl,
    resumeStore: retryResumeStore,
    fetchImpl: retryFetchImpl,
  })
  assert.deepEqual(new Uint8Array(await resumedAfterStall.arrayBuffer()), retryContent,
    '卡死重试重新读取的续传分片必须重新做 SHA-256 校验并修复')
  assert.equal(romBlobIntegrityTag(resumedAfterStall), await romIntegrityManifestTag(retryManifest),
    '重试完成的 ROM 只有全部新读分片通过校验后才能带可信缓存印记')
  assert.equal(resumeLoads, 2, '用例必须真实经过外层失速重试并第二次读取断点库')
  assert.ok(retryManifestRequests >= 1)

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
  if (originalLocalStorage === undefined) delete globalThis.localStorage
  else globalThis.localStorage = originalLocalStorage
}
