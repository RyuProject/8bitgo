import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { encodeRomPackPrefix, romPackAad, romPackIv } from '../shared/rom-pack-format.js'

globalThis.__viteEnv = { VITE_API_URL: 'https://api.example.test' }
const oldCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true })
const { romPackDecodeConcurrency, unpackRomPack, unpackRomPackBlob, verifyRomPackBlob, packRomForUpload, releasePackedRomUpload } = await import('../src/services/romPack.ts')
const { loadGameBytes } = await import('../src/emulator/romLoader.ts')

const digest = async (bytes) => Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex')
const source = new Uint8Array(64 * 1024)
for (let i = 0; i < source.length; i++) source[i] = (i * 17) % 251
const rawKey = webcrypto.getRandomValues(new Uint8Array(32))
const keyForEncryption = await webcrypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt'])
const header = {
  version: 1,
  packageId: '0123456789abcdef0123456789abcdef',
  keyId: 'v1',
  codec: 'store',
  codecVersion: 1,
  codecOptions: {},
  cipher: 'aes-256-gcm',
  originalName: 'synthetic.nes',
  originalSize: source.byteLength,
  originalSha256: await digest(source),
  chunkSize: source.byteLength,
  noncePrefix: Buffer.alloc(8, 0x5a).toString('base64url'),
  chunks: [{ sourceSize: source.byteLength, encodedSize: source.byteLength, cipherSize: source.byteLength + 16, sha256: await digest(source) }],
  payloadSize: source.byteLength + 16,
  createdAt: '2026-11-27T00:00:00.000Z',
}
const prefix = encodeRomPackPrefix(header)
const encrypted = await webcrypto.subtle.encrypt(
  { name: 'AES-GCM', iv: romPackIv(header, 0), additionalData: romPackAad(header, 0), tagLength: 128 },
  keyForEncryption,
  source,
)
const container = new Uint8Array(prefix.byteLength + encrypted.byteLength)
container.set(prefix)
container.set(new Uint8Array(encrypted), prefix.byteLength)

const oldFetch = globalThis.fetch
const oldFileReader = globalThis.FileReader
const key = Buffer.from(rawKey).toString('base64url')
const assetPath = '/roms/test/synthetic.nes.8bg'
let keyResponseDelayMs = 0
let keyRequests = 0
globalThis.fetch = async (url, init = {}) => {
  const target = new URL(String(url))
  if (target.pathname.endsWith('/api/rom-pack/key')) {
    keyRequests++
    const delay = keyResponseDelayMs
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    return Response.json({ packageId: target.searchParams.get('packageId'), keyId: target.searchParams.get('keyId') ?? 'v1', key })
  }
  if (target.pathname === '/integrity') return new Response('', { status: 404 })
  if (target.pathname === assetPath) {
    const range = /^bytes=(\d+)-(\d+)$/.exec(init.headers?.Range ?? '')
    if (range) {
      const start = Number(range[1])
      const end = Math.min(Number(range[2]), container.byteLength - 1)
      const bytes = container.subarray(start, end + 1)
      return new Response(bytes, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${container.byteLength}`,
          'Content-Length': String(bytes.byteLength),
        },
      })
    }
    return new Response(container, { headers: { 'Content-Length': String(container.byteLength) } })
  }
  throw new Error(`意外的测试请求：${target.pathname}`)
}

let decryptInput
let decryptCalls = 0
let digestCalls = 0
let activeDecrypts = 0
let maxConcurrentDecrypts = 0
let decryptDelayMs = 0
let trackedDecryptOffsets = new Map()
let trackedDecryptEvents = []
let decryptDelayByChunk = null
const subtle = new Proxy(webcrypto.subtle, {
  get(target, property) {
    if (property === 'decrypt') {
      return async (...args) => {
        decryptCalls++
        decryptInput = args[2]
        const chunkIndex = args[2] instanceof Uint8Array ? trackedDecryptOffsets.get(args[2].byteOffset) : undefined
        if (chunkIndex !== undefined) trackedDecryptEvents.push(`start:${chunkIndex}`)
        activeDecrypts++
        maxConcurrentDecrypts = Math.max(maxConcurrentDecrypts, activeDecrypts)
        try {
          const delay = chunkIndex === undefined ? decryptDelayMs : decryptDelayByChunk?.[chunkIndex] ?? decryptDelayMs
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
          return await target.decrypt(...args)
        } finally {
          if (chunkIndex !== undefined) trackedDecryptEvents.push(`end:${chunkIndex}`)
          activeDecrypts--
        }
      }
    }
    if (property === 'digest') {
      return async (...args) => {
        digestCalls++
        return target.digest(...args)
      }
    }
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  },
})
globalThis.crypto = new Proxy(webcrypto, {
  get(target, property) {
    if (property === 'subtle') return subtle
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  },
})

try {
  const keyAbort = new AbortController()
  const priorKeyRequests = keyRequests
  keyResponseDelayMs = 250
  const waitingForKey = unpackRomPack(container.buffer, undefined, keyAbort.signal)
  while (keyRequests === priorKeyRequests) await new Promise((resolve) => setTimeout(resolve, 0))
  keyAbort.abort(new DOMException('player changed games', 'AbortError'))
  const keyAbortOutcome = await Promise.race([
    waitingForKey.then(() => 'resolved', (error) => error?.name),
    new Promise((resolve) => setTimeout(() => resolve('late'), 80)),
  ])
  assert.equal(keyAbortOutcome, 'AbortError', '共享密钥请求仍在后台时，已取消会话应立即释放 ROM 解包等待')
  keyResponseDelayMs = 0

  const unpackProgress = []
  const unpacked = await unpackRomPack(container.buffer, (loaded, total) => unpackProgress.push([loaded, total]))
  assert.deepEqual(new Uint8Array(unpacked.data), source)
  assert.deepEqual(unpackProgress, [[0, source.byteLength], [source.byteLength, source.byteLength]])
  assert.ok(decryptInput instanceof Uint8Array, 'Web Crypto 应直接接收原容器的密文视图')
  assert.equal(decryptInput.buffer, container.buffer, '解包不能先复制当前密文块')
  assert.equal(decryptInput.byteOffset, prefix.byteLength)

  const chunkBytes = 64 * 1024
  const multiSource = new Uint8Array(chunkBytes * 3 + 1)
  const multiHeader = {
    ...header,
    packageId: 'abcdef0123456789abcdef0123456789',
    originalName: 'synthetic-multichunk.nes',
    originalSize: multiSource.byteLength,
    chunkSize: chunkBytes,
    noncePrefix: Buffer.alloc(8, 0x61).toString('base64url'),
    originalSha256: await digest(multiSource),
    chunks: [],
    payloadSize: 0,
  }
  const multiEncrypted = []
  for (let index = 0; index < Math.ceil(multiSource.byteLength / chunkBytes); index++) {
    const start = index * chunkBytes
    const part = multiSource.subarray(start, Math.min(multiSource.byteLength, start + chunkBytes))
    multiHeader.chunks.push({
      sourceSize: part.byteLength,
      encodedSize: part.byteLength,
      cipherSize: part.byteLength + 16,
      sha256: await digest(part),
    })
    const encryptedPart = await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv: romPackIv(multiHeader, index), additionalData: romPackAad(multiHeader, index), tagLength: 128 },
      keyForEncryption,
      part,
    )
    multiEncrypted.push(new Uint8Array(encryptedPart))
    assert.equal(encryptedPart.byteLength, multiHeader.chunks[index].cipherSize)
  }
  multiHeader.payloadSize = multiHeader.chunks.reduce((sum, part) => sum + part.cipherSize, 0)
  const multiPrefix = encodeRomPackPrefix(multiHeader)
  const multiContainer = new Uint8Array(multiPrefix.byteLength + multiHeader.payloadSize)
  multiContainer.set(multiPrefix)
  let multiCipherAt = multiPrefix.byteLength
  const multiChunkOffsets = new Map()
  const multiChunkStartOffsets = []
  for (const [index, part] of multiEncrypted.entries()) {
    multiChunkOffsets.set(multiCipherAt, index)
    multiChunkStartOffsets[index] = multiCipherAt
    multiContainer.set(part, multiCipherAt)
    multiCipherAt += part.byteLength
  }

  const oldNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: { hardwareConcurrency: 4, deviceMemory: 4 }, configurable: true,
  })
  try {
    assert.equal(romPackDecodeConcurrency(32 * 1024 * 1024, { hardwareConcurrency: 8, deviceMemory: 2 }), 1,
      '低内存设备必须逐块解包')
    assert.equal(romPackDecodeConcurrency(32 * 1024 * 1024, { hardwareConcurrency: 8, deviceMemory: 4 }), 2,
      '中等内存设备最多两路解包')
    assert.equal(romPackDecodeConcurrency(32 * 1024 * 1024, { hardwareConcurrency: 8, deviceMemory: 8 }), 4,
      '高内存设备可以使用四路解包')
    assert.equal(romPackDecodeConcurrency(32 * 1024 * 1024, { hardwareConcurrency: 8 }), 2,
      '浏览器不报告内存档位时采用保守并行度')
    assert.equal(romPackDecodeConcurrency(32 * 1024 * 1024, { hardwareConcurrency: 2, deviceMemory: 8 }), 1,
      '解包给至少一个逻辑核心留给页面')
    assert.equal(romPackDecodeConcurrency(multiSource.byteLength, { hardwareConcurrency: 4, deviceMemory: 4 }, multiHeader.chunks.length), 2,
      '解包并行度应按容器真实分块数计算，而不是假定每块固定 8 MiB')

    trackedDecryptOffsets = multiChunkOffsets
    trackedDecryptEvents = []
    decryptDelayByChunk = [10, 120, 0, 0]
    maxConcurrentDecrypts = 0
    const multiUnpacked = await unpackRomPack(multiContainer.buffer)
    assert.equal(await digest(multiUnpacked.data), multiHeader.originalSha256)
    assert.equal(maxConcurrentDecrypts, 2, '多块 8BG ROM 应按设备上限并行解密')
    assert.ok(
      trackedDecryptEvents.indexOf('start:2') < trackedDecryptEvents.indexOf('end:1'),
      '前一块解完后应立即补入新块，不等最慢任务完成',
    )

    const corruptContainer = multiContainer.slice()
    corruptContainer[multiChunkStartOffsets[2]] ^= 1
    trackedDecryptEvents = []
    decryptDelayByChunk = [60, 10, 0, 0]
    await assert.rejects(unpackRomPack(corruptContainer.buffer), /第 3 块解密失败/)
    assert.ok(!trackedDecryptEvents.includes('start:3'), '在途块解密失败后不应继续派发窗口外的块')

    decryptDelayByChunk = null
    decryptDelayMs = 15
    const multiBlob = new Blob([multiContainer])
    maxConcurrentDecrypts = 0
    const unpackedBlob = await unpackRomPackBlob(multiBlob)
    assert.equal(unpackedBlob.blob.size, multiSource.byteLength)
    assert.equal(await digest(await unpackedBlob.blob.arrayBuffer()), multiHeader.originalSha256,
      '并行完成的 Blob 分块仍须按 ROM 原顺序组装')
    assert.equal(maxConcurrentDecrypts, 2, '后台导入与大 ROM 解包也应使用自适应并行度')
    await assert.rejects(
      unpackRomPackBlob(multiBlob, undefined, undefined, multiSource.byteLength - 1),
      (error) => error?.name === 'RomPackSizeLimitError',
      '8BG 明文长度超过设备预算时必须在解密与分配 Blob 之前拒绝',
    )

    const configuredNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', {
      value: { hardwareConcurrency: 2, deviceMemory: 2 }, configurable: true,
    })
    const unpackAbort = new AbortController()
    let abortedProgress = 0
    decryptCalls = 0
    try {
      await assert.rejects(
        unpackRomPackBlob(multiBlob, () => {
          abortedProgress++
          unpackAbort.abort(new DOMException('player changed games', 'AbortError'))
        }, unpackAbort.signal),
        (error) => error?.name === 'AbortError',
      )
    } finally {
      if (configuredNavigator) Object.defineProperty(globalThis, 'navigator', configuredNavigator)
      else delete globalThis.navigator
    }
    assert.equal(abortedProgress, 1, '取消后不应继续解包或汇报后续块')
    assert.equal(decryptCalls, 1, '串行低内存路径收到取消后不得再派发下一块')

    const arrayAbort = new AbortController()
    decryptCalls = 0
    digestCalls = 0
    decryptDelayMs = 30
    const pendingArrayUnpack = unpackRomPack(multiContainer.buffer, undefined, arrayAbort.signal)
    while (decryptCalls === 0) await new Promise((resolve) => setTimeout(resolve, 0))
    arrayAbort.abort(new DOMException('player changed games', 'AbortError'))
    await assert.rejects(pendingArrayUnpack, (error) => error?.name === 'AbortError')
    assert.equal(digestCalls, 0, 'Web Crypto 解密结束时已取消，应跳过后续分块 SHA 和整包 SHA')
    assert.ok(decryptCalls <= 2, '低内存 8BG 解包取消后不能继续派发滑动窗口外的块')
    decryptDelayMs = 15

    maxConcurrentDecrypts = 0
    const verified = await verifyRomPackBlob(multiBlob)
    assert.equal(verified.packageId, multiHeader.packageId)
    assert.equal(maxConcurrentDecrypts, 2, '完整性验证应与客户端解包共用有界并行策略')
  } finally {
    decryptDelayMs = 0
    decryptDelayByChunk = null
    trackedDecryptOffsets = new Map()
    if (oldNavigatorDescriptor) Object.defineProperty(globalThis, 'navigator', oldNavigatorDescriptor)
    else delete globalThis.navigator
  }

  globalThis.FileReader = class {
    result = null
    error = null
    onload = null
    onerror = null
    onabort = null
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((result) => {
        this.result = result
        this.onload?.({ target: this })
      }, (error) => {
        this.error = error
        this.onerror?.({ target: this })
      })
    }
    abort() { this.onabort?.({ target: this }) }
  }
  const blob = new Blob([container])
  Object.defineProperty(blob, 'name', { value: 'synthetic.nes.8bg' })
  const loadProgress = []
  const loaded = await loadGameBytes(blob, (progress) => loadProgress.push(progress))
  assert.deepEqual(new Uint8Array(loaded.data), source)
  assert.ok(loadProgress.length >= 3, '通用加载器应在进入解包和每个分块完成时续报活动')
  assert.ok(loadProgress.every((progress) => progress.detail === 'rom-pack'),
    '8BG 原始字节到齐后不能先报 ROM 阶段完成')

  const remoteProgress = []
  const remote = await loadGameBytes(`https://assets.example.test${assetPath}`,
    (progress) => remoteProgress.push(progress))
  assert.deepEqual(new Uint8Array(remote.data), source)
  assert.ok(remoteProgress.some((progress) => progress.detail === 'rom-pack'),
    '远端 .8bg 下载完成时要抑制误报 ROM 完成，并切换到解包活动')

  const oldWorkerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker')
  const oldWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const expiryCallbacks = []
  const clearedTimers = []
  let nextTimer = 1
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    value: class {
      onmessage = null
      onerror = null
      postMessage(message) {
        if (message.type === 'init') {
          queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } }))
          return
        }
        void message.source.arrayBuffer().then(async (buffer) => {
          const bytes = new Uint8Array(buffer)
          const sha256 = Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex')
          const cipher = new Uint8Array(bytes.byteLength + 16)
          cipher.set(bytes)
          this.onmessage?.({ data: {
            type: 'chunk', index: message.index, cipher: cipher.buffer,
            chunk: { sourceSize: bytes.byteLength, encodedSize: bytes.byteLength, cipherSize: cipher.byteLength, sha256 },
          } })
        })
      }
      terminate() {}
    },
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout(callback, delayMs) {
        assert.equal(delayMs, 2 * 60 * 60 * 1000, '打包重试缓存应沿用两小时恢复窗口')
        expiryCallbacks.push(callback)
        return nextTimer++
      },
      clearTimeout(timer) { clearedTimers.push(timer) },
    },
  })
  try {
    const uploadSource = new Blob([source.subarray(0, 1024)])
    Object.defineProperties(uploadSource, {
      name: { value: 'retry.nes' },
      lastModified: { value: 123 },
    })
    const firstPack = await packRomForUpload(uploadSource, 'retry.nes', undefined, 'store')
    assert.equal(firstPack.reused, false)
    assert.equal(expiryCallbacks.length, 1, '新打包结果必须安排自动过期清理')
    const immediateRetry = await packRomForUpload(uploadSource, 'retry.nes', undefined, 'store')
    assert.equal(immediateRetry.reused, true, '失败后两小时内仍可复用相同密文续传')

    expiryCallbacks[0]()
    const afterExpiry = await packRomForUpload(uploadSource, 'retry.nes', undefined, 'store')
    assert.equal(afterExpiry.reused, false, '缓存到期后必须重新打包，旧 Blob 不得继续被引用')
    assert.equal(expiryCallbacks.length, 2)
    releasePackedRomUpload(afterExpiry.blob)
    assert.ok(clearedTimers.includes(2), '上传确认成功后应同时清除过期计时器')
    const afterRelease = await packRomForUpload(uploadSource, 'retry.nes', undefined, 'store')
    assert.equal(afterRelease.reused, false, '成功释放的密文不能被后续开局再次复用')
    releasePackedRomUpload(afterRelease.blob)
  } finally {
    if (oldWorkerDescriptor) Object.defineProperty(globalThis, 'Worker', oldWorkerDescriptor)
    else delete globalThis.Worker
    if (oldWindowDescriptor) Object.defineProperty(globalThis, 'window', oldWindowDescriptor)
    else delete globalThis.window
  }
} finally {
  globalThis.fetch = oldFetch
  globalThis.FileReader = oldFileReader
  if (oldCryptoDescriptor) Object.defineProperty(globalThis, 'crypto', oldCryptoDescriptor)
}

console.log('✓ 客户端 8BG 解密直接使用原容器视图，并在解包期间持续报告活动')
