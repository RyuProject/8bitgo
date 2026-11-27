/** PSP 整盘模式：只在浏览器私有磁盘里组装镜像，绝不把 GB 级 ROM 拼进 JS 内存。 */
import type { LoadProgress } from './types'
import { abortableDelay } from './loadProgress'
import { canonicalRomUrl } from '@/services/romHosts'
import { fetchRomIntegrityManifest, romIntegrityKey, RomIntegrityError, verifyRomBlob, verifyRomRange } from '@/services/romIntegrity'
import { rankRomRoutes, recordRomRouteFailure, recordRomRouteTransfer } from '@/services/romRouteHealth'

const PART_BYTES = 8 * 1024 * 1024
const STALL_MS = 30_000
const MAX_ATTEMPTS = 4
const CACHE_DIR = '8bitgo-psp-discs'

export class PspDiscStorageError extends Error {}

function exactRange(value: string | null, start: number, end: number, total: number): boolean {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(value ?? '')
  return Boolean(match && Number(match[1]) === start && Number(match[2]) === end && Number(match[3]) === total)
}

async function downloadPart(
  urls: readonly string[], start: number, end: number, total: number, signal: AbortSignal,
  validator: { etag?: string; modified?: string },
): Promise<{ bytes: Uint8Array<ArrayBuffer>; etag?: string; modified?: string; integrityRequired: boolean }> {
  let lastError: unknown
  const attemptedUrls = new Set<string>()
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) throw signal.reason ?? new Error('下载已取消')
    // 每片开始前重新读线路记分；上一片刚测出的慢速或失败会立即影响后续片。
    const rankedUrls = rankRomRoutes(urls)
    let url = rankedUrls.find((candidate) => !attemptedUrls.has(candidate))
    if (!url) {
      attemptedUrls.clear()
      url = rankedUrls[0] ?? urls[0]
    }
    attemptedUrls.add(url)
    const controller = new AbortController()
    const cancel = () => controller.abort(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    let stalled = false
    let failure: 'network' | 'timeout' | 'stall' | 'server' | null = null
    let skipRoutePenalty = false
    const touch = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        stalled = true
        controller.abort(new Error('下载连接长时间没有数据'))
      }, STALL_MS)
    }
    try {
      touch()
      const headers: Record<string, string> = { Range: `bytes=${start}-${end}`, Accept: 'application/octet-stream' }
      // If-Match 只接受强 ETag；把 W/ 标签发过去会被符合规范的服务器永远回 412。
      if (validator.etag && !/^W\//i.test(validator.etag)) headers['If-Match'] = validator.etag
      else if (validator.modified) headers['If-Unmodified-Since'] = validator.modified
      const response = await fetch(url, { headers, signal: controller.signal, cache: 'no-store' })
      if (response.status !== 206 || !exactRange(response.headers.get('content-range'), start, end, total)) {
        void response.body?.cancel().catch(() => {})
        if (response.status === 408) failure = 'timeout'
        else if (response.status === 425 || response.status === 429 || response.status >= 500) failure = 'server'
        else if (response.status === 404 || response.status === 410 || response.status === 412) skipRoutePenalty = true
        else failure = 'server'
        const error = new Error(`镜像分片响应无效（HTTP ${response.status}）`)
        if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
          error.name = 'PspRangeNetworkError'
        } else error.name = 'PspRangeRouteError'
        throw error
      }
      const etag = response.headers.get('etag') || undefined
      const modified = response.headers.get('last-modified') || undefined
      if ((validator.etag && etag !== validator.etag) ||
        (!validator.etag && validator.modified && modified !== validator.modified)) {
        void response.body?.cancel().catch(() => {})
        throw new Error('下载期间镜像版本发生变化，请重新开始')
      }
      if (!response.body) {
        failure = 'server'
        throw new Error('浏览器没有提供可逐块读取的响应体')
      }
      const result = new Uint8Array(new ArrayBuffer(end - start + 1))
      const reader = response.body.getReader()
      let offset = 0
      const bodyStartedAt = performance.now()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (offset + value.byteLength > result.byteLength) {
            failure = 'server'
            throw new Error('镜像分片超出声明长度')
          }
          result.set(value, offset)
          offset += value.byteLength
          touch()
        }
      } finally {
        if (offset !== result.byteLength) void reader.cancel().catch(() => {})
      }
      if (offset !== result.byteLength) throw new Error('镜像分片未下载完整')
      recordRomRouteTransfer(url, offset, performance.now() - bodyStartedAt)
      return {
        bytes: result,
        etag,
        modified,
        integrityRequired: response.headers.get('X-8BitGo-Integrity-Required') === 'sha256-v1',
      }
    } catch (error) {
      lastError = error
      if (signal.aborted) throw signal.reason ?? error
      if (stalled) failure = 'stall'
      else if (!failure && !skipRoutePenalty && !(error instanceof Error && /版本发生变化/.test(error.message))) failure = 'network'
      if (failure) recordRomRouteFailure(url, failure)
      // 版本变化或不支持 Range 不能靠重试修好；继续只会反复下载错误响应。
      if (error instanceof Error && /版本发生变化/.test(error.message)) throw error
      if (error instanceof Error && error.name === 'PspRangeRouteError' && urls.length === 1) throw error
      await abortableDelay(Math.min(3000, 400 * 2 ** attempt), signal)
    } finally {
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      controller.abort()
    }
  }
  throw lastError instanceof Error ? lastError : new Error('镜像分片下载失败')
}

export async function downloadPspDisc(
  url: string, name: string, size: number, signal: AbortSignal,
  onProgress?: (progress: LoadProgress) => void, alternateUrls: readonly string[] = [],
): Promise<File> {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('无法确定 PSP 镜像大小')
  if (!navigator.storage?.getDirectory || !globalThis.crypto?.subtle) {
    throw new PspDiscStorageError('当前浏览器不支持大文件本地存储，请改用流式传输')
  }
  // 同一个 R2 对象在主站 / 镜像 / 下载域只有一个本地盘缓存，换线路也不应再占一份磁盘空间。
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRomUrl(url)))
  const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const urls = [...new Set([url, ...alternateUrls].filter(Boolean))]
  const work = () => downloadPspDiscUnlocked(urls, name, size, key, signal, onProgress)
  // 同一镜像被两个标签页同时下载时，不能让第二个标签页删掉第一个正在写的文件。
  // Web Locks 可用时把“查缓存→写盘→落完成标记”整体串起来；不支持时仍靠完成标记防误读。
  return navigator.locks?.request
    ? navigator.locks.request(`8bitgo-psp-disc:${key}`, { signal }, work)
    : work()
}

async function downloadPspDiscUnlocked(
  urls: readonly string[], name: string, size: number, key: string, signal: AbortSignal,
  onProgress?: (progress: LoadProgress) => void,
): Promise<File> {
  const url = urls[0]
  // 清单请求和磁盘准备并行；后续首段 Range 也会与清单并行，避免弱网下先白等 2.5 秒。
  // 仍须在任何字节写入 OPFS 前拿到清单并完成校验。
  const integrityTask = fetchRomIntegrityManifest(url, signal)
  void integrityTask.catch(() => {})
  let integrity: Awaited<typeof integrityTask> = null
  // 只有本站 ROM Worker 会按 romv 拒绝过期对象；外站可以带同名查询串但不执行版本锁。
  // 不信任外站自称的 romv，否则它无 ETag / Last-Modified 时也会被拼成跨版本整盘。
  const versioned = Boolean(new URL(url, location.href).searchParams.get('romv')?.trim() && romIntegrityKey(url))
  const root = await navigator.storage.getDirectory()
  const cache = await root.getDirectoryHandle(CACHE_DIR, { create: true })
  const dir = await cache.getDirectoryHandle(key, { create: true })
  const discName = name.split(/[\\/]/).pop() || 'game.iso'
  let disc = await dir.getFileHandle(discName, { create: true })
  if (versioned) {
    let cacheVersion: string | null = null
    try {
      const marker = await dir.getFileHandle('complete')
      cacheVersion = await (await marker.getFile()).text()
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error
    }
    if (cacheVersion !== null) {
      // 若清单请求失败，不能把它误当成缓存损坏再降级下载；已标记必校验的对象应失败关闭。
      integrity = await integrityTask
      const expectedCacheVersion = integrity ? `${size}\\n${integrity.etag}` : String(size)
      if (cacheVersion === expectedCacheVersion) {
        try {
          const file = await disc.getFile()
          if (file.size === size) {
            if (integrity) await verifyRomBlob(file, integrity, signal)
            onProgress?.({ phase: 'rom', loaded: size, total: size, ratio: 1, cached: true })
            return file
          }
        } catch (error) {
          if (signal.aborted) throw signal.reason ?? error
          if (error instanceof RomIntegrityError) {
            // 本地完整副本也可能被磁盘损坏；不交给核心，清掉后按网络分片重新取得。
            await dir.removeEntry('complete').catch(() => {})
          }
        }
      }
    }
  }

  // 上次标签页崩溃留下的半成品没有完成标记，不能算作可用缓存，也不能让它
  // 白白占着配额导致本次重试在下载前就被判“空间不足”。
  await dir.removeEntry('complete').catch(() => {})
  await dir.removeEntry(discName).catch(() => {})
  disc = await dir.getFileHandle(discName, { create: true })

  const estimate = await navigator.storage.estimate().catch(() => null)
  if (estimate?.quota && estimate.usage !== undefined && estimate.quota - estimate.usage < size + 64 * 1024 * 1024) {
    throw new PspDiscStorageError('浏览器本地空间不足以保存完整 PSP 镜像，请改用流式传输')
  }
  const writer = await disc.createWritable({ keepExistingData: false })
  const controller = new AbortController()
  const cancel = () => controller.abort(signal.reason)
  if (signal.aborted) cancel()
  else signal.addEventListener('abort', cancel, { once: true })
  let loaded = 0
  let nextPart = 1
  let writeTail = Promise.resolve()
  try {
    onProgress?.({ phase: 'rom', loaded: 0, total: size, ratio: 0 })
    const firstEnd = Math.min(size, PART_BYTES) - 1
    const firstTask = downloadPart(urls, 0, firstEnd, size, controller.signal, {})
    let first: Awaited<typeof firstTask>
    try {
      const [downloadedFirst, downloadedIntegrity] = await Promise.all([firstTask, integrityTask])
      first = downloadedFirst
      integrity = downloadedIntegrity
    } catch (error) {
      // 清单拒绝时停止仍在进行的首段下载，避免后台重试继续占网；这时尚未写入任何镜像字节。
      controller.abort(error)
      await firstTask.catch(() => {})
      throw error
    }
    if (first.integrityRequired && !integrity) throw new RomIntegrityError('本站要求校验此 PSP 镜像，但 SHA-256 清单不可用')
    if (integrity) {
      if (first.etag !== integrity.etag || size !== integrity.size) throw new RomIntegrityError('PSP 镜像响应版本与 SHA-256 清单不匹配')
      await verifyRomRange(url, first.bytes, 0, integrity, controller.signal)
    }
    // 没有 ETag / Last-Modified 的外链无法证明多个 Range 属于同一代内容；带 romv 的
    // 站内链接由 R2 Worker 逐次验证版本，其余链接要拒绝，不能拼出一张隐性损坏的盘。
    const hasStrongEtag = first.etag && !/^W\//i.test(first.etag)
    if (!versioned && !hasStrongEtag && !first.modified) throw new Error('镜像没有可安全使用的版本校验信息，无法安全下载整包')
    const validator = { etag: first.etag, modified: first.modified }
    await writer.write({ type: 'write', position: 0, data: first.bytes })
    loaded = first.bytes.byteLength
    onProgress?.({ phase: 'rom', loaded, total: size, ratio: loaded / size })
    const count = Math.ceil(size / PART_BYTES)
    const workers = Array.from({ length: Math.min(3, Math.max(0, count - 1)) }, async () => {
      while (nextPart < count && !controller.signal.aborted) {
        const index = nextPart++
        const start = index * PART_BYTES
        const end = Math.min(size, start + PART_BYTES) - 1
        try {
          const part = await downloadPart(urls, start, end, size, controller.signal, validator)
          if (part.integrityRequired && !integrity) throw new RomIntegrityError('本站要求校验此 PSP 镜像，但 SHA-256 清单不可用')
          if (integrity) {
            if (part.etag !== integrity.etag || size !== integrity.size) throw new RomIntegrityError('PSP 镜像分片版本与 SHA-256 清单不匹配')
            await verifyRomRange(url, part.bytes, start, integrity, controller.signal)
          }
          // OPFS 单个 writer 的写操作必须串行；网络并发不代表可以同时改写文件游标。
          writeTail = writeTail.then(() => writer.write({ type: 'write', position: start, data: part.bytes }))
          await writeTail
          loaded += part.bytes.byteLength
          onProgress?.({ phase: 'rom', loaded, total: size, ratio: loaded / size })
        } catch (error) {
          controller.abort(error)
          throw error
        }
      }
    })
    const results = await Promise.allSettled(workers)
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
    if (controller.signal.aborted) throw controller.signal.reason ?? new Error('下载已取消')
    if (loaded !== size) throw new Error('镜像下载未完成')
    await writer.close()
    const file = await disc.getFile()
    if (file.size !== size) throw new Error('本地镜像长度校验失败')
    // 有 SHA-256 清单时，每个网络分片都已在写入前校验；再从 OPFS 读回整张盘哈希会重复扫过数 GB。
    const marker = await dir.getFileHandle('complete', { create: true })
    const markWriter = await marker.createWritable()
    await markWriter.write(integrity ? `${size}\\n${integrity.etag}` : String(size))
    await markWriter.close()
    onProgress?.({ phase: 'rom', loaded: size, total: size, ratio: 1 })
    return file
  } catch (error) {
    controller.abort(error)
    await writer.abort().catch(() => {})
    await dir.removeEntry('complete').catch(() => {})
    await dir.removeEntry(discName).catch(() => {})
    throw error
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
