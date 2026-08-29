/** 各轻量运行时共用的 ROM 读取入口：完整下载、拒绝 HTML，再交给平台格式校验。 */
import { fetchWithProgress } from './loadProgress'
import type { LoadProgress } from './types'
import { assertNotHtml } from '@/lib/romValidation'

export interface LoadedGameBytes {
  name: string
  data: ArrayBuffer
  remoteUrl?: string
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
  return { name: fileNameFromUrl(game), data, remoteUrl: game }
}
