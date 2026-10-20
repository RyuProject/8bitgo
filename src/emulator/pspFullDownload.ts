/** PSP 整盘模式：只在浏览器私有磁盘里组装镜像，绝不把 GB 级 ROM 拼进 JS 内存。 */
import type { LoadProgress } from './types'

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
  url: string, start: number, end: number, total: number, signal: AbortSignal,
  validator: { etag?: string; modified?: string },
): Promise<{ bytes: Uint8Array<ArrayBuffer>; etag?: string; modified?: string }> {
  let lastError: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) throw signal.reason ?? new Error('下载已取消')
    const controller = new AbortController()
    const cancel = () => controller.abort(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    const touch = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => controller.abort(new Error('下载连接长时间没有数据')), STALL_MS)
    }
    try {
      touch()
      const headers: Record<string, string> = { Range: `bytes=${start}-${end}`, Accept: 'application/octet-stream' }
      if (validator.etag) headers['If-Match'] = validator.etag
      else if (validator.modified) headers['If-Unmodified-Since'] = validator.modified
      const response = await fetch(url, { headers, signal: controller.signal, cache: 'no-store' })
      if (response.status !== 206 || !exactRange(response.headers.get('content-range'), start, end, total)) {
        void response.body?.cancel().catch(() => {})
        throw new Error(`镜像分片响应无效（HTTP ${response.status}）`)
      }
      const etag = response.headers.get('etag') || undefined
      const modified = response.headers.get('last-modified') || undefined
      if ((validator.etag && etag !== validator.etag) ||
        (!validator.etag && validator.modified && modified !== validator.modified)) {
        void response.body?.cancel().catch(() => {})
        throw new Error('下载期间镜像版本发生变化，请重新开始')
      }
      if (!response.body) throw new Error('浏览器没有提供可逐块读取的响应体')
      const result = new Uint8Array(new ArrayBuffer(end - start + 1))
      const reader = response.body.getReader()
      let offset = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (offset + value.byteLength > result.byteLength) throw new Error('镜像分片超出声明长度')
          result.set(value, offset)
          offset += value.byteLength
          touch()
        }
      } finally {
        if (offset !== result.byteLength) void reader.cancel().catch(() => {})
      }
      if (offset !== result.byteLength) throw new Error('镜像分片未下载完整')
      return { bytes: result, etag, modified }
    } catch (error) {
      lastError = error
      if (signal.aborted) throw signal.reason ?? error
      // 版本变化或不支持 Range 不能靠重试修好；继续只会反复下载错误响应。
      if (error instanceof Error && /版本发生变化|响应无效|超出声明长度/.test(error.message)) throw error
      await new Promise((resolve) => setTimeout(resolve, Math.min(3000, 400 * 2 ** attempt)))
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
  onProgress?: (progress: LoadProgress) => void,
): Promise<File> {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('无法确定 PSP 镜像大小')
  if (!navigator.storage?.getDirectory || !globalThis.crypto?.subtle) {
    throw new PspDiscStorageError('当前浏览器不支持大文件本地存储，请改用流式传输')
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url))
  const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const work = () => downloadPspDiscUnlocked(url, name, size, key, signal, onProgress)
  // 同一镜像被两个标签页同时下载时，不能让第二个标签页删掉第一个正在写的文件。
  // Web Locks 可用时把“查缓存→写盘→落完成标记”整体串起来；不支持时仍靠完成标记防误读。
  return navigator.locks?.request
    ? navigator.locks.request(`8bitgo-psp-disc:${key}`, { signal }, work)
    : work()
}

async function downloadPspDiscUnlocked(
  url: string, name: string, size: number, key: string, signal: AbortSignal,
  onProgress?: (progress: LoadProgress) => void,
): Promise<File> {
  // 空 romv 不是内容版本；若把它当稳定键，源站同路径换盘后会直接复用旧的完整镜像。
  const versioned = Boolean(new URL(url, location.href).searchParams.get('romv')?.trim())
  const root = await navigator.storage.getDirectory()
  const cache = await root.getDirectoryHandle(CACHE_DIR, { create: true })
  const dir = await cache.getDirectoryHandle(key, { create: true })
  const discName = name.split(/[\\/]/).pop() || 'game.iso'
  let disc = await dir.getFileHandle(discName, { create: true })
  if (versioned) {
    try {
      const marker = await dir.getFileHandle('complete')
      if ((await (await marker.getFile()).text()) === String(size)) {
        const file = await disc.getFile()
        if (file.size === size) {
          onProgress?.({ phase: 'rom', loaded: size, total: size, ratio: 1, cached: true })
          return file
        }
      }
    } catch { /* 只有完整写入并落了完成标记的版本化镜像才可复用。 */ }
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
    const first = await downloadPart(url, 0, firstEnd, size, controller.signal, {})
    // 没有 ETag / Last-Modified 的外链无法证明多个 Range 属于同一代内容；带 romv 的
    // 站内链接由 R2 Worker 逐次验证版本，其余链接要拒绝，不能拼出一张隐性损坏的盘。
    if (!versioned && !first.etag && !first.modified) throw new Error('镜像没有版本校验信息，无法安全下载整包')
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
          const part = await downloadPart(url, start, end, size, controller.signal, validator)
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
    const marker = await dir.getFileHandle('complete', { create: true })
    const markWriter = await marker.createWritable()
    await markWriter.write(String(size))
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
