/** 各轻量运行时共用的 ROM 读取入口：有内容版本的地址可跨刷新补缺片，无版本地址保持单次直取。 */
import { fetchBlobWithProgress, fetchWithProgress } from './loadProgress'
import { downloadResumeStore } from './downloadResume'
import { romCacheGet, romCacheGetBlob, romCacheKey, romCachePut } from './romCache'
import type { LoadProgress } from './types'
import { assertNotHtml } from '@/lib/romValidation'
import { romCacheDelete } from './romCache'
import { romArchiveRef } from '@/lib/romArchiveUrl'
import { loadRemoteArchiveRom } from './remoteArchive'
import { isRomPackBytes, unpackRomPack } from '@/services/romPack'
import { parseRomPackHeader } from '../../shared/rom-pack-format.js'

export interface GameBytesLimits {
  /** 下载/本地容器原始字节上限。设置后读取本地 File 前先检查 size。 */
  maxBytes?: number
  /** 8BG 解包后的文件上限；必须在分配输出缓冲前检查容器头。 */
  maxUnpackedBytes?: number
}

function assertSizeLimit(size: number, limit: number | undefined, label: string): void {
  if (limit !== undefined && size > limit) {
    const mib = Math.floor(limit / 1024 / 1024)
    throw new RangeError(`${label}超过 ${mib} MiB 浏览器安全上限，已停止加载以避免内存耗尽`)
  }
}

function assertUnpackedSize(data: ArrayBuffer, limit: number | undefined): void {
  if (limit === undefined) return
  const size = isRomPackBytes(data)
    ? parseRomPackHeader(new Uint8Array(data)).header.originalSize
    : data.byteLength
  assertSizeLimit(size, limit, '游戏文件')
}

async function unpackIfNeeded(data: ArrayBuffer, limits: GameBytesLimits): Promise<{ name?: string; data: ArrayBuffer }> {
  assertUnpackedSize(data, limits.maxUnpackedBytes)
  if (!isRomPackBytes(data)) return { data }
  const unpacked = await unpackRomPack(data)
  assertSizeLimit(unpacked.data.byteLength, limits.maxUnpackedBytes, '游戏文件')
  return unpacked
}

export interface LoadedGameBytes {
  name: string
  data: ArrayBuffer
  remoteUrl?: string
  /** 这一份是从本地缓存拿的，没走网络。排查「玩家说还是旧版本」时先看这个 */
  fromCache?: boolean
}

export function fileNameFromUrl(url: string, fallback = 'game.rom'): string {
  try {
    const pathname = new URL(url, window.location.href).pathname
    return decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1)) || fallback
  } catch {
    return url.split(/[?#]/)[0].split('/').pop() || fallback
  }
}

export async function loadGameBytes(
  game: File | string,
  onProgress?: (progress: LoadProgress) => void,
  signal?: AbortSignal,
  limits: GameBytesLimits = {},
): Promise<LoadedGameBytes> {
  if (typeof game !== 'string') {
    // File.size 可在读盘前取得；先挡住异常大的 SWF，避免 arrayBuffer() 一次申请整块内存。
    assertSizeLimit(game.size, limits.maxBytes, '游戏文件')
    const data = await game.arrayBuffer()
    assertSizeLimit(data.byteLength, limits.maxBytes, '游戏文件')
    onProgress?.({ phase: 'rom', loaded: data.byteLength, total: data.byteLength, ratio: 1 })
    assertNotHtml(data)
    const unpacked = await unpackIfNeeded(data, limits)
    assertNotHtml(unpacked.data)
    if (unpacked.name) return { name: unpacked.name, data: unpacked.data }
    return { name: game.name, data }
  }

  if (romArchiveRef(game)) {
    const validateExtracted = limits.maxUnpackedBytes === undefined
      ? undefined
      : async (blob: Blob) => assertSizeLimit(blob.size, limits.maxUnpackedBytes, '游戏文件')
    const extracted = await loadRemoteArchiveRom(game, onProgress, signal, validateExtracted, limits.maxUnpackedBytes)
    assertSizeLimit(extracted.blob.size, limits.maxUnpackedBytes, '游戏文件')
    const data = await extracted.blob.arrayBuffer()
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
    return { name: extracted.name, data, remoteUrl: game, fromCache: extracted.fromCache }
  }

  // 缓存键只有在播放地址带内容版本号（?romv=<etag>）时才成立，见 romCache.ts 的文件头注释
  const cacheKey = romCacheKey(game)
  if (cacheKey) {
    // 有上限的播放器先以 Blob 检查缓存大小，避免把历史的大 ArrayBuffer 缓存重新读进内存。
    const cachedBlob = limits.maxBytes !== undefined ? await romCacheGetBlob(cacheKey) : null
    let cached: ArrayBuffer | null = null
    if (cachedBlob) {
      try {
        assertSizeLimit(cachedBlob.size, limits.maxBytes, '游戏文件')
        cached = await cachedBlob.arrayBuffer()
      } catch {
        // 超限的历史缓存不能盖住正常网络回源；删除后继续按本局安全上限重新下载。
        await romCacheDelete(cacheKey).catch(() => {})
      }
    } else if (limits.maxBytes === undefined) {
      cached = await romCacheGet(cacheKey)
    }
    if (cached) {
      // 已经取消了就别再往下走，行为要和网络分支一致
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
      // 存进去之前校验过，这里再挡一次：万一是历史上写坏的记录，也不至于喂给模拟器。
      // 坏的那条要**扔掉再走网络**，不然自动重试还是撞上它，这台浏览器上这款游戏就永远起不来
      try {
        assertSizeLimit(cached.byteLength, limits.maxBytes, '游戏文件')
        assertNotHtml(cached)
        if (isRomPackBytes(cached)) {
          const unpacked = await unpackIfNeeded(cached, limits)
          assertNotHtml(unpacked.data)
          onProgress?.({ phase: 'rom', loaded: cached.byteLength, total: cached.byteLength, ratio: 1, cached: true })
          void downloadResumeStore.clear(cacheKey).catch(() => {})
          if (unpacked.name) return { name: unpacked.name, data: unpacked.data, remoteUrl: game, fromCache: true }
        }
        assertSizeLimit(cached.byteLength, limits.maxUnpackedBytes, '游戏文件')
        // 完整缓存验证通过后才报满格；坏缓存回源时不能让进度从 100% 倒退。
        onProgress?.({ phase: 'rom', loaded: cached.byteLength, total: cached.byteLength, ratio: 1, cached: true })
        void downloadResumeStore.clear(cacheKey).catch(() => {})
        return { name: fileNameFromUrl(game), data: cached, remoteUrl: game, fromCache: true }
      } catch {
        await romCacheDelete(cacheKey).catch(() => {})
      }
    }
  }

  const check = (res: Response) => {
    const type = res.headers.get('content-type') ?? ''
    if (/text\/html|application\/xhtml/i.test(type)) throw new Error('ROM 地址返回了网页，不是游戏文件')
  }
  // 只有带 romv 的不可变对象才可拼接旧片；小卡带首个 Range 就是完整文件，仍只需一趟网络。
  // 无版本的外链维持普通 GET，避免源站原地换包时把旧片拼进新 ROM。
  const data = cacheKey
    ? await (await fetchBlobWithProgress(game, {
        phase: 'rom', onProgress, signal, resumeKey: cacheKey, check, maxBytes: limits.maxBytes,
      })).arrayBuffer()
    : await fetchWithProgress(game, { phase: 'rom', onProgress, signal, check, maxBytes: limits.maxBytes })
  assertSizeLimit(data.byteLength, limits.maxBytes, '游戏文件')
  assertNotHtml(data)
  if (isRomPackBytes(data)) {
    const unpacked = await unpackIfNeeded(data, limits)
    assertNotHtml(unpacked.data)
    // 解密、解压、摘要都通过后才缓存密文；截断包不能因为一次失败被永久钉在浏览器里。
    if (cacheKey) void romCachePut(cacheKey, data).catch(() => {})
    return { name: unpacked.name!, data: unpacked.data, remoteUrl: game }
  }
  assertSizeLimit(data.byteLength, limits.maxUnpackedBytes, '游戏文件')
  // 不 await：写几百 MB 要花时间，没理由让玩家在 100% 的进度条前面干等。
  // 失败（配额满、无痕模式）在 romCachePut 内部静默吞掉，这里不需要 catch 以外的处理。
  if (cacheKey) void romCachePut(cacheKey, data).catch(() => {})
  return { name: fileNameFromUrl(game), data, remoteUrl: game }
}
