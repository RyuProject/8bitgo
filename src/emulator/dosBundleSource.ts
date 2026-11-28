/**
 * 大型普通 DOS 游戏的 Blob 加载路径。
 *
 * `romLoader` 为卡带机准备的 ArrayBuffer 路径会同时保留密文、完整明文和最终 Blob；
 * 503MB 的《辐射》因此能把标签页峰值推近 1GB。这里复用光盘/街机已经验证过的做法：
 * 8MB Range 断点续传、逐块解密解压、只读 ZIP 中央目录，最后把 Blob 直接交给 js-dos。
 */
import type { LoadProgress } from './types'
import { downloadResumeStore } from './downloadResume'
import { fetchBlobWithProgress, withResumeTimeout } from './loadProgress'
import { alternateRomUrls } from '@/services/romHosts'
import {
  romCacheDelete,
  romCacheGetBlobRecord,
  romCacheIntegrityIsFresh,
  romCacheKey,
  romCacheMarkIntegrityVerified,
  romCachePutBlob,
} from './romCache'
import { isReadyJsdosBundleBlob } from '@/lib/jsdosBundle'
import { inspectRemoteRomPack, isBlobReadError, isRomPackBytes, isRomPackUrl, prewarmRomPackDecoder, readBlobRange, unpackRomPackBlob } from '@/services/romPack'
import { fetchRomIntegrityManifest, romBlobIntegrityTag, romIntegrityManifestTag, verifyRomBlob } from '@/services/romIntegrity'

/** 四字节探测不该被浏览器的坏 Blob 存储拖成一局永不结束。 */
const DOS_BLOB_PROBE_TIMEOUT_MS = 10_000
const DEFAULT_DOS_BUNDLE_BLOB_BYTES = 2 * 1024 * 1024 * 1024
const DEFAULT_DOS_BUNDLE_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024
// 8BG 头与每块认证标签是密文包自身的额外开销，不应挤占原始 ZIP 的设备预算。
const DOS_8BG_CONTAINER_OVERHEAD_BYTES = 16 * 1024 * 1024

class DosBundleSizeLimitError extends RangeError {
  override name = 'DosBundleSizeLimitError'

  constructor(maxBytes: number) {
    super(`DOS 游戏包超过此设备的安全载入上限（${Math.ceil(maxBytes / 1024 / 1024)} MiB）；大型游戏请使用 Sockdrive 或更高内存设备`)
  }
}

function isDosBundleLimitError(error: unknown): boolean {
  if (!(error instanceof RangeError)) return false
  const name = (error as { name?: unknown }).name
  return name === 'DosBundleSizeLimitError' || name === 'RomPackSizeLimitError' || name === 'ZipExpansionLimitError'
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException('已取消', 'AbortError')
}

export interface DosBundleBlob {
  name: string
  blob: Blob
  /** false 表示是安全的普通文件/ZIP，仍需交给旧逻辑补 dosbox.conf。 */
  ready: boolean
  fromCache: boolean
}

function fileNameFromUrl(url: string): string {
  try {
    const base = typeof location === 'undefined' ? 'https://8bitgo.invalid/' : location.href
    const path = new URL(url, base).pathname
    return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)).replace(/\.8bg$/i, '') || 'game.zip'
  } catch {
    return url.split(/[?#]/)[0].split('/').pop()?.replace(/\.8bg$/i, '') || 'game.zip'
  }
}

async function decodeDosBundle(
  stored: Blob,
  fallbackName: string,
  onChunk?: () => void,
  signal?: AbortSignal,
  maxDecodedBytes = DEFAULT_DOS_BUNDLE_BLOB_BYTES,
  maxUnpackedBytes = DEFAULT_DOS_BUNDLE_UNPACKED_BYTES,
): Promise<Omit<DosBundleBlob, 'fromCache'>> {
  if (signal) throwIfAborted(signal)
  const magic = new Uint8Array(await readBlobRange(stored, 0, 4, DOS_BLOB_PROBE_TIMEOUT_MS, signal))
  let blob = stored
  let name = fallbackName
  if (isRomPackBytes(magic)) {
    const unpacked = await unpackRomPackBlob(stored, onChunk, signal, maxDecodedBytes)
    blob = unpacked.blob
    name = unpacked.name
  }

  if (signal) throwIfAborted(signal)
  const head = new Uint8Array(await readBlobRange(blob, 0, 4, DOS_BLOB_PROBE_TIMEOUT_MS, signal))
  const zip = head.length >= 2 && head[0] === 0x50 && head[1] === 0x4b
  // 单个 EXE/COM 仍允许走旧逻辑；只有“看起来是 ZIP 却损坏”的包才应该在这里明确失败。
  const ready = zip ? await isReadyJsdosBundleBlob(blob, 30_000, signal, maxUnpackedBytes) : false
  if (signal) throwIfAborted(signal)
  return { name, blob, ready }
}

export async function prepareRemoteDosBundle(
  url: string,
  onProgress: ((progress: LoadProgress) => void) | undefined,
  signal: AbortSignal,
  maxBundleBytes = DEFAULT_DOS_BUNDLE_BLOB_BYTES,
  maxUnpackedBytes = DEFAULT_DOS_BUNDLE_UNPACKED_BYTES,
): Promise<DosBundleBlob> {
  if (!Number.isSafeInteger(maxBundleBytes) || maxBundleBytes <= 0 ||
      !Number.isSafeInteger(maxUnpackedBytes) || maxUnpackedBytes <= 0) {
    throw new RangeError('DOS 游戏包容量上限无效')
  }
  const maxStoredBytes = maxBundleBytes + (isRomPackUrl(url) ? DOS_8BG_CONTAINER_OVERHEAD_BYTES : 0)
  if (!Number.isSafeInteger(maxStoredBytes)) throw new RangeError('DOS 游戏包容量上限过大')
  const fallbackName = fileNameFromUrl(url)
  const cacheKey = romCacheKey(url)
  // 普通 DOS 包走这里而不经过 loadGameBytes：解码器和密钥同样要与下载（或读缓存）并行取，
  // 否则下完 ROM 还要串行等两趟往返（2026-11-12《凯撒大帝》实测约 2 秒）。
  if (isRomPackUrl(url)) prewarmRomPackDecoder(url)
  // 缓存命中也要核对本站发布的分块清单；与 ROM 下载并行取，避免命中后再串行多等一趟。
  const integrityTask = fetchRomIntegrityManifest(url, signal)
  void integrityTask.catch(() => {})

  const decode = async (stored: Blob) => {
    throwIfAborted(signal)
    // 下载到 100% 后还有 63 个 8MB 块要验签/解密/解压；把真相写在遮罩上，别让 99% 像死机。
    const report = () => onProgress?.({ phase: 'starting', detail: 'rom-pack' })
    report()
    // 每解完一块再报一次：500MB 的包有 63 块，低配机上会超过启动看门狗的 120 秒
    return decodeDosBundle(stored, fallbackName, report, signal, maxBundleBytes, maxUnpackedBytes)
  }

  if (cacheKey) {
    const cachedRecord = await romCacheGetBlobRecord(cacheKey)
    const cached = cachedRecord?.blob ?? null
    if (cached) {
      const cacheRecord = cachedRecord ?? { blob: cached }
      if (signal.aborted) throw new DOMException('已取消', 'AbortError')
      try {
        if (cached.size > maxStoredBytes) throw new DosBundleSizeLimitError(maxBundleBytes)
        const integrity = await integrityTask
        if (integrity) {
          const integrityTag = await romIntegrityManifestTag(integrity)
          if (cached.size !== integrity.size || !romCacheIntegrityIsFresh(cacheRecord, integrityTag)) {
            await verifyRomBlob(cached, integrity, signal)
            // 复验只更新读取时的缓存代次；过期旧记录每周重验一次，避免每次开局读完整大包。
            void romCacheMarkIntegrityVerified(cacheKey, integrityTag, cached.size, cacheRecord).catch(() => {})
          }
        }
        const decoded = await decode(cached)
        throwIfAborted(signal)
        onProgress?.({ phase: 'rom', loaded: cached.size, total: cached.size, ratio: 1, cached: true })
        // 两个标签页并发下载时可能在完整缓存写好后又落了几片，命中时顺手收尾。
        void downloadResumeStore.clear(cacheKey).catch(() => {})
        return { ...decoded, fromCache: true }
      } catch (error) {
        // 用户切换游戏时停止解包即可，不能把有效缓存误判为损坏并删除。
        if (signal.aborted) throw signal.reason ?? new DOMException('已取消', 'AbortError')
        if (isDosBundleLimitError(error)) throw error
        // 本机旧密钥、截断写入或旧格式都不能把玩家永久困住；删掉后立刻回远端自愈。
        await romCacheDelete(cacheKey).catch(() => {})
        console.warn('[jsdos] DOS ROM 缓存不可用，重新下载：', error)
      }
    }
  }

  // 预制 bundle 本来就能走 Blob 直通，因此不能套 ArrayBuffer 上限；但 8BG 头里的原文长度可
  // 在 Range 预检时先读到，超限就停止，避免弱网把整份大包下完后才发现手机带不动。
  if (isRomPackUrl(url)) {
    const header = await inspectRemoteRomPack(url, signal)
    if (header && header.originalSize > maxBundleBytes) throw new DosBundleSizeLimitError(maxBundleBytes)
  }

  const download = (resume: boolean) => fetchBlobWithProgress(url, {
    phase: 'rom',
    onProgress,
    signal,
    alternateUrls: alternateRomUrls(url),
    maxBytes: maxStoredBytes,
    // URL 没有 romv 时可能被后台原地替换，绝不能把两代分片拼成一个“完整”坏包。
    resumeKey: resume ? cacheKey || undefined : undefined,
    check: (response) => {
      const type = response.headers.get('content-type') ?? ''
      if (/text\/html|application\/xhtml/i.test(type)) {
        throw new Error(`ROM 地址返回了网页而不是游戏文件（HTTP ${response.status}）`)
      }
    },
  })
  let stored = await download(true)
  let decoded: Omit<DosBundleBlob, 'fromCache'>
  try {
    decoded = await decode(stored)
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? new DOMException('已取消', 'AbortError')
    // 续传片拼出的包读不出来（Blob 存储坏了或读包卡死）：作废续传片，不带续传重下一次。
    if (!cacheKey || !isBlobReadError(error)) throw error
    console.warn('[jsdos] 下载好的 DOS 包读不出来，作废续传片重下一次：', error)
    await withResumeTimeout(downloadResumeStore.clear(cacheKey), 5_000).catch(() => {})
    stored = await download(false)
    decoded = await decode(stored)
  }

  throwIfAborted(signal)
  // 保留 8BG 密文而不是明文：既避免扩大磁盘占用，也不把后台加密在浏览器缓存层绕开。
  // 不 await，写几百 MB 的 IndexedDB 不应该挡住 DOSBox 开机。
  if (cacheKey) void romCachePutBlob(cacheKey, stored, romBlobIntegrityTag(stored)).catch(() => {})
  return { ...decoded, fromCache: false }
}
