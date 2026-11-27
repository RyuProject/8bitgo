/** 各轻量运行时共用的 ROM 读取入口：有内容版本的地址可跨刷新补缺片，无版本地址保持单次直取。 */
import { CHUNK_BYTES, fetchBlobWithProgress, fetchWithProgress, optionalManifestWithin } from './loadProgress'
import { alternateRomUrls } from '@/services/romHosts'
import { downloadResumeStore } from './downloadResume'
import {
  romCacheGetBlobRecord, romCacheGetRecord, romCacheGetRecordWithinLimit, romCacheKey,
  romCacheMarkIntegrityManifestVerified, romCachePut,
} from './romCache'
import type { RomCacheBlobRecord } from './romCache'
import type { LoadProgress } from './types'
import { assertNotHtml } from '@/lib/romValidation'
import { romCacheDelete } from './romCache'
import { romArchiveRef } from '@/lib/romArchiveUrl'
import { loadRemoteArchiveRom } from './remoteArchive'
import { isRomPackBytes, prewarmRomPackDecoder, unpackRomPack } from '@/services/romPack'
import { parseRomPackHeader } from '../../shared/rom-pack-format.js'
import { fetchRomIntegrityManifest, romIntegrityManifestForUrl, verifyRomBytes } from '@/services/romIntegrity'

export interface GameBytesLimits {
  /** 下载/本地容器原始字节上限。设置后读取本地 File 前先检查 size。 */
  maxBytes?: number
  /** 8BG 解包后的文件上限；必须在分配输出缓冲前检查容器头。 */
  maxUnpackedBytes?: number
  /** 平台格式校验必须先于 ROM 缓存写入，避免把损坏内容钉在浏览器里。 */
  validate?: (data: ArrayBuffer) => void
  /** 远程 ZIP 内层内容以 Blob 缓存时使用，避免为校验额外复制整份文件。 */
  validateBlob?: (blob: Blob) => void | Promise<void>
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

async function unpackIfNeeded(
  data: ArrayBuffer,
  limits: GameBytesLimits,
  onProgress?: (progress: LoadProgress) => void,
  signal?: AbortSignal,
): Promise<{ name?: string; data: ArrayBuffer }> {
  assertUnpackedSize(data, limits.maxUnpackedBytes)
  if (!isRomPackBytes(data)) return { data }
  const unpacked = await unpackRomPack(data, () => {
    // 密文下载已经结束；继续报活动但不重复推进下载字节，解包内部已节流到每 200ms 最多一次。
    onProgress?.({ phase: 'rom', ratio: 1, detail: 'rom-pack' })
  }, signal)
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

const BLOB_READ_TIMEOUT_MS = 30_000
/** 普通小 ROM 可直接落入最终缓冲；无上限外链即使谎报长度，也最多预申请这一档内存。 */
const SMALL_ROM_PREALLOCATE_MAX_BYTES = 32 * 1024 * 1024

/** Blob.arrayBuffer 没有取消接口；FileReader 可在存储读取卡死时真正中止并放弃这一局。 */
function readBlobArrayBuffer(blob: Blob, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (signal?.aborted) return Promise.reject(new DOMException('已取消', 'AbortError'))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    let settled = false
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reader.onload = null
      reader.onerror = null
      reader.onabort = null
    }
    const finish = (error?: Error, data?: ArrayBuffer) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(data!)
    }
    const abort = () => {
      try { reader.abort() } catch { /* 尚未进入读取状态 */ }
      finish(new DOMException('已取消', 'AbortError'))
    }
    timer = setTimeout(() => {
      timedOut = true
      try { reader.abort() } catch { /* 读取可能刚结束 */ }
      finish(new Error(`本地 ROM 缓存读取超过 ${Math.round(BLOB_READ_TIMEOUT_MS / 1000)} 秒`))
    }, BLOB_READ_TIMEOUT_MS)
    signal?.addEventListener('abort', abort, { once: true })
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) finish(undefined, reader.result)
      else finish(new Error('浏览器未能读取 ROM 缓存'))
    }
    reader.onerror = () => finish(reader.error ?? new Error('浏览器读取 ROM 缓存失败'))
    reader.onabort = () => finish(timedOut
      ? new Error(`本地 ROM 缓存读取超过 ${Math.round(BLOB_READ_TIMEOUT_MS / 1000)} 秒`)
      : new DOMException('已取消', 'AbortError'))
    try {
      reader.readAsArrayBuffer(blob)
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/** 地址本身就指向 8BG 容器（`….swf.8bg?romv=…`）。只看路径，查询串和片段不算。 */
export function isRomPackUrl(url: string): boolean {
  try {
    return new URL(url, 'https://x.invalid/').pathname.toLowerCase().endsWith('.8bg')
  } catch {
    return /\.8bg(?:[?#]|$)/i.test(url)
  }
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
    const data = await readBlobArrayBuffer(game, signal)
    assertSizeLimit(data.byteLength, limits.maxBytes, '游戏文件')
    onProgress?.({
      phase: 'rom', loaded: data.byteLength, total: data.byteLength, ratio: 1,
      ...(isRomPackBytes(data) ? { detail: 'rom-pack' as const } : {}),
    })
    assertNotHtml(data)
    const unpacked = await unpackIfNeeded(data, limits, onProgress, signal)
    assertNotHtml(unpacked.data)
    limits.validate?.(unpacked.data)
    if (unpacked.name) return { name: unpacked.name, data: unpacked.data }
    return { name: game.name, data }
  }

  if (romArchiveRef(game)) {
    const validateExtracted = limits.maxUnpackedBytes === undefined && !limits.validate && !limits.validateBlob
      ? undefined
      : async (blob: Blob) => {
          assertSizeLimit(blob.size, limits.maxUnpackedBytes, '游戏文件')
          if (limits.validateBlob) await limits.validateBlob(blob)
          else if (limits.validate) limits.validate(await readBlobArrayBuffer(blob, signal))
        }
    const extracted = await loadRemoteArchiveRom(game, onProgress, signal, validateExtracted, limits.maxUnpackedBytes)
    assertSizeLimit(extracted.blob.size, limits.maxUnpackedBytes, '游戏文件')
    const data = await readBlobArrayBuffer(extracted.blob, signal)
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
    return { name: extracted.name, data, remoteUrl: game, fromCache: extracted.fromCache }
  }

  // 8BG 的解码器 wasm 和数据密钥与 ROM 并行取，别等下完了才发现要它（见 prewarmRomPackDecoder）
  if (isRomPackUrl(game)) prewarmRomPackDecoder(game)

  // 先查缓存；有随字节保存的已验证清单时不必再发完整性旁路请求。
  // 缓存未命中时下载器会与 ROM 并行启动清单请求，旧缓存则在确认没有本地证明后再取。
  let integrityTask: ReturnType<typeof fetchRomIntegrityManifest> | null = null
  const getIntegrityManifest = () => {
    if (!integrityTask) {
      integrityTask = fetchRomIntegrityManifest(game, signal)
      integrityTask.catch(() => {})
    }
    return integrityTask
  }

  // 缓存键只有在播放地址带内容版本号（?romv=<etag>）时才成立，见 romCache.ts 的文件头注释
  const cacheKey = romCacheKey(game)
  if (cacheKey) {
    // 有上限的播放器先以 Blob 检查缓存大小，避免把历史的大 ArrayBuffer 缓存重新读进内存。
    const cachedBlobRecord = limits.maxBytes !== undefined ? await romCacheGetBlobRecord(cacheKey) : null
    const cachedBlob = cachedBlobRecord?.blob ?? null
    let cachedIntegrityRequired = cachedBlobRecord?.integrityRequired
    let cachedIntegrityManifest = cachedBlobRecord?.integrityManifest
    let cachedIdentity: Pick<RomCacheBlobRecord, 'recordId' | 'storedAt'> | undefined = cachedBlobRecord ?? undefined
    let cached: ArrayBuffer | null = null
    if (cachedBlob) {
      try {
        assertSizeLimit(cachedBlob.size, limits.maxBytes, '游戏文件')
        cached = await readBlobArrayBuffer(cachedBlob, signal)
      } catch {
        if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
        // 超限的历史缓存不能盖住正常网络回源；删除后继续按本局安全上限重新下载。
        await romCacheDelete(cacheKey).catch(() => {})
      }
    } else {
      // 有 maxBytes 的旧版本 ROM 也可能以 ArrayBuffer 形式缓存；先用 IDB 元数据挡住超限项再读字节。
      const record = limits.maxBytes === undefined
        ? await romCacheGetRecord(cacheKey)
        : await romCacheGetRecordWithinLimit(cacheKey, limits.maxBytes)
      cached = record?.data ?? null
      cachedIntegrityRequired = record?.integrityRequired
      cachedIntegrityManifest = record?.integrityManifest
      cachedIdentity = record ?? undefined
    }
    if (cached) {
      // 已经取消了就别再往下走，行为要和网络分支一致
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
      // 存进去之前校验过，这里再挡一次：万一是历史上写坏的记录，也不至于喂给模拟器。
      // 坏的那条要**扔掉再走网络**，不然自动重试还是撞上它，这台浏览器上这款游戏就永远起不来
      try {
        assertSizeLimit(cached.byteLength, limits.maxBytes, '游戏文件')
        assertNotHtml(cached)
        // 只有完整下载校验过的清单才可免网络等待；老缓存先取当前清单，有清单就逐块复验。
        const savedManifest = romIntegrityManifestForUrl(game, cachedIntegrityManifest, cached.byteLength)
        const integrity = savedManifest ?? await getIntegrityManifest()
        if (cachedIntegrityRequired === true && !integrity) {
          throw new Error('本站要求校验此 ROM，但本地缓存对应的 SHA-256 清单不可用')
        }
        if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
        if (integrity) {
          const repaired = await verifyRomBytes(game, cached, integrity, signal)
          // 修复块同时回写缓存；否则每次开局都会重新发现、重下同一块坏数据。
          if (repaired) {
            void romCachePut(cacheKey, cached, cachedIntegrityRequired, integrity).catch(() => {})
          } else if (!savedManifest && cachedIdentity) {
            // 旧缓存经过当前可信清单复验后，只更新元信息，不重写整份 ROM 字节。
            void romCacheMarkIntegrityManifestVerified(cacheKey, integrity, cached.byteLength, cachedIdentity).catch(() => {})
          }
        }
        if (isRomPackBytes(cached)) {
          const unpacked = await unpackIfNeeded(cached, limits, onProgress, signal)
          assertNotHtml(unpacked.data)
          limits.validate?.(unpacked.data)
          onProgress?.({ phase: 'rom', loaded: cached.byteLength, total: cached.byteLength, ratio: 1, cached: true })
          void downloadResumeStore.clear(cacheKey).catch(() => {})
          if (unpacked.name) return { name: unpacked.name, data: unpacked.data, remoteUrl: game, fromCache: true }
        }
        assertSizeLimit(cached.byteLength, limits.maxUnpackedBytes, '游戏文件')
        limits.validate?.(cached)
        // 完整缓存验证通过后才报满格；坏缓存回源时不能让进度从 100% 倒退。
        onProgress?.({ phase: 'rom', loaded: cached.byteLength, total: cached.byteLength, ratio: 1, cached: true })
        void downloadResumeStore.clear(cacheKey).catch(() => {})
        return { name: fileNameFromUrl(game), data: cached, remoteUrl: game, fromCache: true }
      } catch (error) {
        // 取消/切游戏不是缓存损坏；保留有效字节与续传片，也别让上一局继续占网回源。
        if (signal?.aborted) throw signal.reason ?? error
        await romCacheDelete(cacheKey).catch(() => {})
        // 旧缓存对应的续传片也可能不可信；一并清掉，回源不能再拼出同一份坏内容。
        await downloadResumeStore.clear(cacheKey).catch(() => {})
      }
    }
  }

  const check = (res: Response) => {
    const type = res.headers.get('content-type') ?? ''
    if (/text\/html|application\/xhtml/i.test(type)) throw new Error('ROM 地址返回了网页，不是游戏文件')
  }
  let integrityRequired: boolean | undefined
  const noteIntegrityRequired = (required: boolean) => { integrityRequired = required }
  const reportDownloadProgress = (progress: LoadProgress) => {
    const complete = (progress.ratio ?? 0) >= 1 ||
      (Number(progress.total) > 0 && Number(progress.loaded) >= Number(progress.total))
    onProgress?.(isRomPackUrl(game) && progress.phase === 'rom' && complete
      ? { ...progress, detail: 'rom-pack' }
      : progress)
  }
  const boundedMaxBytes = typeof limits.maxBytes === 'number' &&
    Number.isSafeInteger(limits.maxBytes) && limits.maxBytes > 0
  // 内存模式会整局关闭临时分片续传。只有调用方上限本身不超过一片时启用，确保它不会误伤大 ROM 的跨刷新续传。
  const smallRomMemoryLimit = boundedMaxBytes && limits.maxBytes! <= CHUNK_BYTES ? limits.maxBytes! : undefined
  // 只有带 romv 的不可变对象才可拼接旧片；小卡带首个 Range 就是完整文件，仍只需一趟网络。
  // 无版本的外链维持普通 GET，避免源站原地换包时把旧片拼进新 ROM。
  const data = cacheKey
      ? await (await fetchBlobWithProgress(game, {
        phase: 'rom', onProgress: reportDownloadProgress, signal, resumeKey: cacheKey, check, maxBytes: limits.maxBytes,
        onIntegrityRequired: noteIntegrityRequired,
        alternateUrls: alternateRomUrls(game),
        ...(smallRomMemoryLimit ? { inMemoryUpTo: smallRomMemoryLimit } : {}),
      })).arrayBuffer()
      : await fetchWithProgress(game, {
        phase: 'rom', onProgress: reportDownloadProgress, signal, check, maxBytes: limits.maxBytes,
        onIntegrityRequired: noteIntegrityRequired,
        alternateUrls: alternateRomUrls(game),
        // 已知长度的小 ROM 直接写最终缓冲；无上限下载封顶 32 MiB，未知/压缩长度仍沿用分块拼接。
        preallocateKnownLength: true,
        preallocateMaxBytes: boundedMaxBytes ? limits.maxBytes : SMALL_ROM_PREALLOCATE_MAX_BYTES,
      })
  assertSizeLimit(data.byteLength, limits.maxBytes, '游戏文件')
  assertNotHtml(data)
  // 必校验响应在下载器返回前已逐块验完；普通旧对象则只等 150ms 看可选清单是否已就绪，
  // 若就绪就验证一次再随缓存保存，避免后续热启动重复请求 sidecar；迟到清单不背书本次字节。
  const verifiedIntegrityManifest = integrityRequired
    ? await getIntegrityManifest()
    : cacheKey ? await optionalManifestWithin(getIntegrityManifest(), signal) : null
  if (!integrityRequired && verifiedIntegrityManifest) {
    await verifyRomBytes(game, data, verifiedIntegrityManifest, signal)
  }
  // fetchWithProgress / fetchBlobWithProgress 已在所有标记响应返回前校验；这里不再重复扫大 ROM。
  if (isRomPackBytes(data)) {
    const unpacked = await unpackIfNeeded(data, limits, onProgress, signal)
    assertNotHtml(unpacked.data)
    limits.validate?.(unpacked.data)
    // 解密、解压、摘要都通过后才缓存密文；截断包不能因为一次失败被永久钉在浏览器里。
    if (cacheKey) void romCachePut(cacheKey, data, integrityRequired, verifiedIntegrityManifest).catch(() => {})
    return { name: unpacked.name!, data: unpacked.data, remoteUrl: game }
  }
  assertSizeLimit(data.byteLength, limits.maxUnpackedBytes, '游戏文件')
  limits.validate?.(data)
  // 不 await：写几百 MB 要花时间，没理由让玩家在 100% 的进度条前面干等。
  // 失败（配额满、无痕模式）在 romCachePut 内部静默吞掉，这里不需要 catch 以外的处理。
  if (cacheKey) void romCachePut(cacheKey, data, integrityRequired, verifiedIntegrityManifest).catch(() => {})
  return { name: fileNameFromUrl(game), data, remoteUrl: game }
}
