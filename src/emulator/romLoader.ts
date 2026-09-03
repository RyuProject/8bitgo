/** 各轻量运行时共用的 ROM 读取入口：先查本地缓存，未命中再完整下载、拒绝 HTML，最后交给平台格式校验。 */
import { fetchWithProgress } from './loadProgress'
import { romCacheGet, romCacheKey, romCachePut } from './romCache'
import type { LoadProgress } from './types'
import { assertNotHtml } from '@/lib/romValidation'

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
): Promise<LoadedGameBytes> {
  if (typeof game !== 'string') {
    const data = await game.arrayBuffer()
    onProgress?.({ phase: 'rom', loaded: data.byteLength, total: data.byteLength, ratio: 1 })
    assertNotHtml(data)
    return { name: game.name, data }
  }

  // 缓存键只有在播放地址带内容版本号（?romv=<etag>）时才成立，见 romCache.ts 的文件头注释
  const cacheKey = romCacheKey(game)
  if (cacheKey) {
    const cached = await romCacheGet(cacheKey)
    if (cached) {
      // 已经取消了就别再往下走，行为要和网络分支一致
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
      // 命中也要发一帧满进度：播放器的遮罩靠进度回调收尾，不发的话会停在 0%
      onProgress?.({ phase: 'rom', loaded: cached.byteLength, total: cached.byteLength, ratio: 1 })
      // 存进去之前校验过，这里再挡一次：万一是历史上写坏的记录，也不至于喂给模拟器
      assertNotHtml(cached)
      return { name: fileNameFromUrl(game), data: cached, remoteUrl: game, fromCache: true }
    }
  }

  const data = await fetchWithProgress(game, {
    phase: 'rom',
    onProgress,
    signal,
    check: (res) => {
      const type = res.headers.get('content-type') ?? ''
      if (/text\/html|application\/xhtml/i.test(type)) throw new Error('ROM 地址返回了网页，不是游戏文件')
    },
  })
  assertNotHtml(data)
  // 不 await：写几百 MB 要花时间，没理由让玩家在 100% 的进度条前面干等。
  // 失败（配额满、无痕模式）在 romCachePut 内部静默吞掉，这里不需要 catch 以外的处理。
  if (cacheKey) void romCachePut(cacheKey, data).catch(() => {})
  return { name: fileNameFromUrl(game), data, remoteUrl: game }
}
