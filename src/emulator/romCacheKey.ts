import { romArchiveRef } from '@/lib/romArchiveUrl'
import { canonicalRomUrl } from '@/services/romHostConfig'

/**
 * 只计算稳定的 ROM 缓存身份，不打开 IndexedDB。
 *
 * NDS 核心回退记忆在页面渲染与开局决策中都要查这个键；若从 romCache 导入，
 * 页面会因此提前加载整套缓存读写与校验实现。把纯地址判断拆开，缓存本身仍在开局时按需使用。
 */
export function romCacheKey(url: string): string {
  if (!url || /^(blob|data):/i.test(url)) return ''
  const source = url.split('#')[0]
  const queryAt = source.indexOf('?')
  const version = queryAt >= 0 ? new URLSearchParams(source.slice(queryAt + 1)).get('romv')?.trim() : ''
  // 空 romv 不是内容版本；把它当键会让覆盖后的新旧分片在同一地址下混合。
  if (!version && !romArchiveRef(url)?.version.trim()) return ''
  // 主域和 EdgeOne 镜像是同一个对象：键按主域写，换线路后仍命中同一份缓存。
  return canonicalRomUrl(url)
}
