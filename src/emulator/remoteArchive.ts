/** 外站 ZIP 只在玩家浏览器里下载、解出单个成员并缓存；本站服务端不接触文件字节。 */
import { assertRomArchiveRef, romArchiveRef } from '@/lib/romArchiveUrl'
import { assertValidZip, crc32, extractZipEntry } from '@/lib/unzip'
import { assertNotHtml } from '@/lib/romValidation'
import { fetchWithProgress } from './loadProgress'
import { romCacheGetBlob, romCacheKey, romCachePutBlob } from './romCache'
import type { LoadProgress } from './types'

/** 整块 ZIP 解析有内存成本；光盘镜像等更大的包应先在源站提供可直接读取的 ROM。 */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
const MAX_ROM_BYTES = 512 * 1024 * 1024

export async function loadRemoteArchiveRom(
  url: string,
  onProgress?: (progress: LoadProgress) => void,
  signal?: AbortSignal,
): Promise<{ name: string; blob: Blob; bytes: number; fromCache: boolean }> {
  const ref = romArchiveRef(url)
  if (!ref) throw new Error('ROM 地址缺少 ZIP 内文件标记')
  assertRomArchiveRef(ref)
  const cacheKey = romCacheKey(url)
  if (cacheKey) {
    const cached = await romCacheGetBlob(cacheKey)
    if (cached) {
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
      onProgress?.({ phase: 'rom', loaded: cached.size, total: cached.size, ratio: 1, cached: true })
      return { name: ref.name, blob: cached, bytes: cached.size, fromCache: true }
    }
  }

  let archive: ArrayBuffer
  try {
    archive = await fetchWithProgress(ref.sourceUrl, {
      phase: 'rom', onProgress, signal, maxBytes: MAX_ARCHIVE_BYTES, cache: 'no-store',
      check: (res) => {
        if (/text\/html|application\/xhtml/i.test(res.headers.get('content-type') ?? '')) {
          throw new Error('ZIP 地址返回了网页，不是压缩包')
        }
      },
    })
  } catch (error) {
    if (signal?.aborted) throw error
    if (error instanceof TypeError) throw new Error('无法读取外站 ZIP：请确认链接可直接下载，且源站允许本站跨域 GET')
    throw error
  }
  const entries = assertValidZip(archive, '远程 ROM')
  // 自动模式只看外层 `.nds.zip` 暗示的后缀；ZIP 内有多个同类 ROM 时拒绝猜测。
  const ext = ref.auto ? ref.name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() : undefined
  const matches = ref.auto
    ? entries.filter((entry) => entry.name.toLowerCase().endsWith(`.${ext}`))
    : entries.filter((entry) => entry.name === ref.entry)
  if (matches.length !== 1) {
    if (ref.auto) throw new Error(matches.length
      ? `ZIP 内有多个 .${ext} 文件，请改为指定包内文件名`
      : `ZIP 内找不到 .${ext} ROM`)
    throw new Error(matches.length ? `ZIP 内有重复文件：${ref.entry}` : `ZIP 内找不到 ROM：${ref.entry}`)
  }
  const entry = matches[0]
  const data = await extractZipEntry(archive, entry, MAX_ROM_BYTES)
  if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
  if (data.byteLength !== entry.uncompressedSize || crc32(data) !== entry.crc32) {
    throw new Error(`ZIP 内 ROM 校验失败：${entry.name}`)
  }
  // deflate 分支已有一块独立缓冲，别再复制 512MB；stored 分支才需要裁出成员范围。
  const rom = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
    ? data.buffer as ArrayBuffer
    : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  assertNotHtml(rom)
  const blob = new Blob([rom], { type: 'application/octet-stream' })
  // 无 ETag 且没指定手工 v 时不缓存：远端同名覆盖后无法判断旧数据是否过期。
  if (cacheKey) void romCachePutBlob(cacheKey, blob).catch(() => {})
  return { name: ref.name, blob, bytes: blob.size, fromCache: false }
}
