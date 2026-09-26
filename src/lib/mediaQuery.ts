/**
 * 订阅媒体查询。Safari 13 及更早版本只有 addListener/removeListener，直接调标准的
 * addEventListener 会在 effect 里抛错，进而让响应式侧栏或播放器布局停止更新。
 */
export function listenMediaQuery(media: MediaQueryList, listener: () => void): () => void {
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  }
  media.addListener(listener)
  return () => media.removeListener(listener)
}
