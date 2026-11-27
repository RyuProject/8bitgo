import assert from 'node:assert/strict'
import { createRomIntegrityManifest } from '../src/services/romIntegrityData.ts'
import { downloadPspDisc } from '../src/emulator/pspFullDownload.ts'
import { isRomNetworkFailure } from '../src/emulator/loadProgress.ts'
import { rankRomRoutes, resetRomRouteHealth, romRouteRate } from '../src/services/romRouteHealth.ts'

let manifestReleased = true
let manifestGateActive = false
let firstRangeBeforeManifest = false
let writeBeforeManifest = false
let fileReadbacks = 0

class TrackedFile extends File {
  slice(start, end, contentType) {
    fileReadbacks++
    return super.slice(start, end, contentType)
  }
}

class MemoryDirectory {
  constructor() {
    this.files = new Map()
    this.directories = new Map()
  }
  async getDirectoryHandle(name, options = {}) {
    if (!this.directories.has(name) && options.create) this.directories.set(name, new MemoryDirectory())
    const value = this.directories.get(name)
    if (!value) throw new Error('NotFoundError')
    return value
  }
  async getFileHandle(name, options = {}) {
    if (!this.files.has(name) && options.create) this.files.set(name, new Uint8Array())
    if (!this.files.has(name)) throw new Error('NotFoundError')
    return {
      getFile: async () => new TrackedFile([this.files.get(name)], name),
      createWritable: async () => {
        let bytes = new Uint8Array()
        return {
          write: async (input) => {
            if (manifestGateActive && !manifestReleased) writeBeforeManifest = true
            if (typeof input === 'string') {
              bytes = new TextEncoder().encode(input)
              return
            }
            const data = input.data
            const next = new Uint8Array(Math.max(bytes.byteLength, input.position + data.byteLength))
            next.set(bytes)
            next.set(data, input.position)
            bytes = next
          },
          close: async () => { this.files.set(name, bytes) },
          abort: async () => {},
        }
      },
    }
  }
  async removeEntry(name) { this.files.delete(name) }
}

const root = new MemoryDirectory()
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { storage: { getDirectory: async () => root, estimate: async () => ({ quota: 100_000_000, usage: 0 }) } },
})
globalThis.location = { href: 'https://8bitgo.test/games/test' }
const size = 17 * 1024 * 1024
const discBytes = new Uint8Array(size)
for (let offset = 0; offset < size; offset += 4096) discBytes[offset] = offset / 4096 % 251
const integrityPayload = await createRomIntegrityManifest(new Blob([discBytes]), 'roms/psp/test.chd')
const integrity = { ...integrityPayload, etag: '"rom-v1"' }
const integrityManifests = new Map([[integrity.key, integrity]])
let requests = []
const successfulFetch = async (rawUrl, init) => {
  const requestUrl = new URL(String(rawUrl))
  if (requestUrl.pathname === '/integrity') {
    const manifest = integrityManifests.get(requestUrl.searchParams.get('key'))
    return manifest
      ? new Response(JSON.stringify({ etag: manifest.etag, size: manifest.size, manifest }), {
          headers: { 'Content-Type': 'application/json' },
        })
      : new Response('', { status: 404 })
  }
  const match = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range)
  assert.ok(match, '整包只能用有界 Range 请求')
  const start = Number(match[1])
  const end = Number(match[2])
  requests.push([start, end])
  assert.ok(end - start + 1 <= 8 * 1024 * 1024, '任何请求都不能把整张盘读进内存')
  const manifest = integrityManifests.get(requestUrl.pathname.slice(1))
  const headers = {
    'Content-Range': `bytes ${start}-${end}/${size}`,
    ETag: manifest?.etag ?? '"rom-v1"',
  }
  if (manifest) headers['X-8BitGo-Integrity-Required'] = 'sha256-v1'
  return new Response(discBytes.subarray(start, end + 1), {
    status: 206,
    headers,
  })
}
globalThis.fetch = successfulFetch

const progress = []
const url = 'https://assets.8bitgo.com/roms/psp/test.chd?romv=rom-v1'
fileReadbacks = 0
const file = await downloadPspDisc(url, 'test.chd', size, new AbortController().signal, (p) => progress.push(p))
assert.equal(file.name, 'test.chd', '本地盘必须保留 PSP 可识别的扩展名')
assert.equal(file.size, size)
assert.equal(fileReadbacks, 0, '刚完成的下载不能为了二次哈希再从 OPFS 读整张盘')
assert.deepEqual(requests, [[0, 8 * 1024 * 1024 - 1], [8 * 1024 * 1024, 16 * 1024 * 1024 - 1], [16 * 1024 * 1024, size - 1]])
assert.equal(progress.at(-1).ratio, 1)
const sample = new Uint8Array(await file.slice(0, 4097).arrayBuffer())
assert.equal(sample[4096], 1, '随机写入后的本地镜像字节不能错位')
requests = []

const gatedKey = 'roms/psp/gated.chd'
const gatedPayload = await createRomIntegrityManifest(new Blob([discBytes]), gatedKey)
integrityManifests.set(gatedKey, { ...gatedPayload, etag: '"rom-v1"' })
let releaseManifest
const gatedManifest = new Promise((resolve) => { releaseManifest = resolve })
manifestReleased = false
manifestGateActive = true
writeBeforeManifest = false
globalThis.fetch = async (rawUrl, init) => {
  if (new URL(String(rawUrl)).pathname === '/integrity') {
    setTimeout(() => {
      manifestReleased = true
      releaseManifest(makeManifestResponse())
    }, 40)
    return gatedManifest
  }
  if (!manifestReleased) firstRangeBeforeManifest = true
  return successfulFetch(rawUrl, init)
}
function makeManifestResponse() {
  const manifest = integrityManifests.get(gatedKey)
  return new Response(JSON.stringify({ etag: manifest.etag, size: manifest.size, manifest }), {
    headers: { 'Content-Type': 'application/json' },
  })
}
const gatedUrl = 'https://assets.8bitgo.com/roms/psp/gated.chd?romv=rom-v1'
const gatedFile = await downloadPspDisc(gatedUrl, 'gated.chd', size, new AbortController().signal)
manifestGateActive = false
assert.equal(gatedFile.size, size)
assert.equal(firstRangeBeforeManifest, true, 'PSP 首段 Range 必须与慢清单请求并行开始')
assert.equal(writeBeforeManifest, false, '完整性清单返回前不能把首段写入本地磁盘')
globalThis.fetch = successfulFetch

resetRomRouteHealth()
const adaptiveKey = 'roms/psp/route-adaptive.chd'
const adaptivePayload = await createRomIntegrityManifest(new Blob([discBytes]), adaptiveKey)
integrityManifests.set(adaptiveKey, { ...adaptivePayload, etag: '"rom-v1"' })
const adaptiveUrl = `https://assets.8bitgo.com/${adaptiveKey}?romv=rom-v1`
const adaptiveAlternate = `https://download.8bitgo.com/${adaptiveKey}?romv=rom-v1`
const routeSequence = []
let failPrimaryOnce = true
globalThis.fetch = async (rawUrl, init) => {
  const requestUrl = new URL(String(rawUrl))
  if (requestUrl.pathname === '/integrity') {
    const manifest = integrityManifests.get(requestUrl.searchParams.get('key'))
    return new Response(JSON.stringify({ etag: manifest.etag, size: manifest.size, manifest }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
  routeSequence.push(requestUrl.host)
  if (requestUrl.host === 'assets.8bitgo.com' && failPrimaryOnce) {
    failPrimaryOnce = false
    return new Response('busy', { status: 503 })
  }
  const response = await successfulFetch(rawUrl, init)
  if (requestUrl.host !== 'download.8bitgo.com') return response
  const bytes = new Uint8Array(await response.arrayBuffer())
  return new Response(new ReadableStream({
    start(controller) {
      setTimeout(() => {
        controller.enqueue(bytes)
        controller.close()
      }, 25)
    },
  }), { status: response.status, headers: response.headers })
}
const adaptiveFile = await downloadPspDisc(
  adaptiveUrl, 'route-adaptive.chd', size, new AbortController().signal, undefined, [adaptiveAlternate],
)
assert.equal(adaptiveFile.size, size)
assert.deepEqual(
  routeSequence,
  ['assets.8bitgo.com', 'download.8bitgo.com', 'download.8bitgo.com', 'download.8bitgo.com'],
  '当前分片的 503 应立即切到备用域，成功测得的线路还应接管后续分片',
)
assert.equal(rankRomRoutes([adaptiveUrl, adaptiveAlternate])[0], adaptiveAlternate,
  'PSP 全盘下载实测吞吐应写回共享线路记分板供后续开局复用')
assert.ok((romRouteRate(adaptiveAlternate) ?? 0) > 0, 'PSP 成功 Range 的正文吞吐必须写入线路记分板')
resetRomRouteHealth()
globalThis.fetch = successfulFetch

globalThis.fetch = async (rawUrl, init) => {
  if (new URL(String(rawUrl)).pathname === '/integrity') {
    return new Response(JSON.stringify({ code: 'integrity_manifest_missing' }), { status: 503 })
  }
  const match = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range)
  const start = Number(match[1])
  const end = Number(match[2])
  return new Response(discBytes.subarray(start, end + 1), {
    status: 206,
    headers: {
      'Content-Range': `bytes ${start}-${end}/${size}`,
      ETag: '"rom-v1"',
      'X-8BitGo-Integrity-Required': 'sha256-v1',
    },
  })
}
await assert.rejects(
  downloadPspDisc('https://assets.8bitgo.com/roms/psp/required-missing.chd?romv=rom-v1',
    'required-missing.chd', size, new AbortController().signal),
  /Worker 拒绝使用不完整或版本不符的 ROM \/ BIOS 校验清单/,
)
const discCache = await root.getDirectoryHandle('8bitgo-psp-discs')
assert.equal([...discCache.directories.values()].some((dir) => dir.files.has('required-missing.chd')), false,
  'Worker 标记必校验却没有清单时，PSP 不能留下可复用的磁盘副本')
globalThis.fetch = successfulFetch

assert.equal(isRomNetworkFailure(new Error('镜像分片响应无效（HTTP 503）')), true,
  '整包 PSP 读盘遇临时 503 应归为网络故障，播放器才能停止错误内容回退')
assert.equal(isRomNetworkFailure(new Error('镜像分片响应无效（HTTP 404）')), false,
  '整包 PSP 读盘遇 404 应保留为内容缺失')
assert.equal(isRomNetworkFailure(new Error('下载连接长时间没有数据')), true,
  '整包 PSP Range 分片停滞超时应归为网络故障')

requests = []
fileReadbacks = 0
const cached = await downloadPspDisc(url, 'test.chd', size, new AbortController().signal)
assert.equal(cached.size, size)
assert.ok(fileReadbacks > 0, '复用已有镜像时仍要完整复验本地内容')
assert.equal(requests.length, 0, '同一版本的完整镜像必须直接复用浏览器本地副本')

requests = []
const unversionedUrl = 'https://assets.8bitgo.test/roms/psp/unversioned.chd'
await downloadPspDisc(unversionedUrl, 'unversioned.chd', size, new AbortController().signal)
requests = []
await downloadPspDisc(unversionedUrl, 'unversioned.chd', size, new AbortController().signal)
assert.equal(requests.length, 3, '没有版本键的外链不能仅凭旧文件大小复用缓存')

const weakLastModified = new Date('2024-01-02T03:04:05Z').toUTCString()
const weakValidatorHeaders = []
globalThis.fetch = async (_rawUrl, init) => {
  const headers = init.headers
  weakValidatorHeaders.push(headers)
  if (headers['If-Match']) return new Response('', { status: 412 })
  const match = /^bytes=(\d+)-(\d+)$/.exec(headers.Range)
  const start = Number(match[1])
  const end = Number(match[2])
  return new Response(discBytes.subarray(start, end + 1), {
    status: 206,
    headers: {
      'Content-Range': `bytes ${start}-${end}/${size}`,
      ETag: 'W/"weak-v1"',
      'Last-Modified': weakLastModified,
    },
  })
}
await downloadPspDisc(
  'https://cdn.example.net/roms/psp/weak-etag.chd', 'weak-etag.chd', size, new AbortController().signal,
)
assert.equal(weakValidatorHeaders.length, 3, '弱 ETag + Last-Modified 的 PSP 镜像应完成全部 Range')
assert.ok(weakValidatorHeaders.slice(1).every((headers) => !headers['If-Match'] && headers['If-Unmodified-Since'] === weakLastModified),
  '弱 ETag 不能用于 If-Match，应以 Last-Modified 保护后续 Range')
let weakOnlyRequests = 0
globalThis.fetch = async (_rawUrl, init) => {
  weakOnlyRequests++
  const match = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range)
  const start = Number(match[1])
  const end = Number(match[2])
  return new Response(discBytes.subarray(start, end + 1), {
    status: 206,
    headers: { 'Content-Range': `bytes ${start}-${end}/${size}`, ETag: 'W/"weak-only"' },
  })
}
await assert.rejects(
  downloadPspDisc('https://cdn.example.net/roms/psp/weak-only.chd', 'weak-only.chd', size, new AbortController().signal),
  /没有可安全使用的版本校验信息/,
)
assert.equal(weakOnlyRequests, 1, '只有弱 ETag 的外链不能继续拼接多段磁盘')

let externalRomvRequests = 0
globalThis.fetch = async (_rawUrl, init) => {
  externalRomvRequests++
  const match = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range)
  const start = Number(match[1])
  const end = Number(match[2])
  return new Response(discBytes.subarray(start, end + 1), {
    status: 206,
    headers: { 'Content-Range': `bytes ${start}-${end}/${size}` },
  })
}
await assert.rejects(
  downloadPspDisc('https://cdn.example.net/roms/psp/fake-romv.iso?romv=1',
    'fake-romv.iso', size, new AbortController().signal),
  /没有可安全使用的版本校验信息/,
)
assert.equal(externalRomvRequests, 1, '外站自带 romv 参数也不能绕过 ETag / Last-Modified 版本锁')
const externalCache = await root.getDirectoryHandle('8bitgo-psp-discs')
assert.equal([...externalCache.directories.values()].some((dir) => dir.files.has('fake-romv.iso')), false,
  '拒绝无版本锁的外站 ROM 后必须清理半成品')

resetRomRouteHealth()
globalThis.fetch = successfulFetch

requests = []
const emptyVersionUrl = 'https://assets.8bitgo.test/roms/psp/empty-version.chd?romv='
await downloadPspDisc(emptyVersionUrl, 'empty-version.chd', size, new AbortController().signal)
requests = []
await downloadPspDisc(emptyVersionUrl, 'empty-version.chd', size, new AbortController().signal)
assert.equal(requests.length, 3, '空 romv 不能冒充内容版本并复用旧镜像')

globalThis.fetch = async (target, init) => {
  if (new URL(String(target)).pathname === '/integrity') return successfulFetch(target, init)
  if (init.headers.Range.startsWith('bytes=0-')) return successfulFetch(target, init)
  const match = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range)
  return new Response(discBytes.subarray(Number(match[1]), Number(match[2]) + 1), {
    status: 206,
    headers: { 'Content-Range': `bytes ${match[1]}-${match[2]}/${size}`, ETag: '"rom-v2"' },
  })
}
await assert.rejects(downloadPspDisc(`${url}-changed`, 'changed.chd', size, new AbortController().signal), /版本发生变化|清单版本与 ROM 地址不一致/)

let retryRequests = 0
const cancelRetry = new AbortController()
globalThis.fetch = async (target) => {
  if (new URL(String(target)).pathname === '/integrity') return new Response('', { status: 404 })
  retryRequests += 1
  if (retryRequests === 1) setTimeout(() => cancelRetry.abort(), 10)
  return new Response('busy', { status: 503 })
}
await assert.rejects(
  downloadPspDisc(`${url}-cancel-retry`, 'cancel-retry.iso', size, cancelRetry.signal),
  (error) => error?.name === 'AbortError',
)
assert.equal(retryRequests, 1, '玩家在 PSP 网络退避时取消后不能再发下一次 Range')

globalThis.fetch = async (target) => new URL(String(target)).pathname === '/integrity'
  ? new Response('', { status: 404 })
  : new Response('bad', { status: 200 })
await assert.rejects(downloadPspDisc(`${url}-bad`, 'bad.chd', size, new AbortController().signal), /响应无效/)
const cache = await root.getDirectoryHandle('8bitgo-psp-discs')
assert.equal([...cache.directories.values()].filter((dir) => dir.files.has('bad.chd')).length, 0,
  '错误的 Range 响应不能留下可误用的半张盘')

console.log('✔ PSP 整包下载：有界 Range、版本校验、本地复用和失败清理通过')
