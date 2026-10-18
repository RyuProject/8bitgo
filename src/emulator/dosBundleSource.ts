/**
 * 大型普通 DOS 游戏的 Blob 加载路径。
 *
 * `romLoader` 为卡带机准备的 ArrayBuffer 路径会同时保留密文、完整明文和最终 Blob；
 * 503MB 的《辐射》因此能把标签页峰值推近 1GB。这里复用光盘/街机已经验证过的做法：
 * 8MB Range 断点续传、逐块解密解压、只读 ZIP 中央目录，最后把 Blob 直接交给 js-dos。
 */
import type { LoadProgress } from './types'
import { downloadResumeStore } from './downloadResume'
import { fetchBlobWithProgress } from './loadProgress'
import { romCacheDelete, romCacheGetBlob, romCacheKey, romCachePutBlob } from './romCache'
import { isReadyJsdosBundleBlob } from '@/lib/jsdosBundle'
import { isRomPackBytes, unpackRomPackBlob } from '@/services/romPack'

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

async function decodeDosBundle(stored: Blob, fallbackName: string): Promise<Omit<DosBundleBlob, 'fromCache'>> {
  const magic = new Uint8Array(await stored.slice(0, 4).arrayBuffer())
  let blob = stored
  let name = fallbackName
  if (isRomPackBytes(magic)) {
    const unpacked = await unpackRomPackBlob(stored)
    blob = unpacked.blob
    name = unpacked.name
  }

  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer())
  const zip = head.length >= 2 && head[0] === 0x50 && head[1] === 0x4b
  // 单个 EXE/COM 仍允许走旧逻辑；只有“看起来是 ZIP 却损坏”的包才应该在这里明确失败。
  const ready = zip ? await isReadyJsdosBundleBlob(blob) : false
  return { name, blob, ready }
}

export async function prepareRemoteDosBundle(
  url: string,
  onProgress: ((progress: LoadProgress) => void) | undefined,
  signal: AbortSignal,
): Promise<DosBundleBlob> {
  const fallbackName = fileNameFromUrl(url)
  const cacheKey = romCacheKey(url)

  const decode = async (stored: Blob) => {
    // 下载到 100% 后还有 63 个 8MB 块要验签/解密/解压；把真相写在遮罩上，别让 99% 像死机。
    onProgress?.({ phase: 'starting', detail: 'rom-pack' })
    return decodeDosBundle(stored, fallbackName)
  }

  if (cacheKey) {
    const cached = await romCacheGetBlob(cacheKey)
    if (cached) {
      if (signal.aborted) throw new DOMException('已取消', 'AbortError')
      onProgress?.({ phase: 'rom', loaded: cached.size, total: cached.size, ratio: 1, cached: true })
      try {
        const decoded = await decode(cached)
        // 两个标签页并发下载时可能在完整缓存写好后又落了几片，命中时顺手收尾。
        void downloadResumeStore.clear(cacheKey).catch(() => {})
        return { ...decoded, fromCache: true }
      } catch (error) {
        // 本机旧密钥、截断写入或旧格式都不能把玩家永久困住；删掉后立刻回远端自愈。
        await romCacheDelete(cacheKey).catch(() => {})
        console.warn('[jsdos] DOS ROM 缓存不可用，重新下载：', error)
      }
    }
  }

  const stored = await fetchBlobWithProgress(url, {
    phase: 'rom',
    onProgress,
    signal,
    // URL 没有 romv 时可能被后台原地替换，绝不能把两代分片拼成一个“完整”坏包。
    resumeKey: cacheKey || undefined,
    check: (response) => {
      const type = response.headers.get('content-type') ?? ''
      if (/text\/html|application\/xhtml/i.test(type)) {
        throw new Error(`ROM 地址返回了网页而不是游戏文件（HTTP ${response.status}）`)
      }
    },
  })
  const decoded = await decode(stored)

  // 保留 8BG 密文而不是明文：既避免扩大磁盘占用，也不把后台加密在浏览器缓存层绕开。
  // 不 await，写几百 MB 的 IndexedDB 不应该挡住 DOSBox 开机。
  if (cacheKey) void romCachePutBlob(cacheKey, stored).catch(() => {})
  return { ...decoded, fromCache: false }
}
