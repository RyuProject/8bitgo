/**
 * 站内公开页面数据的短时内存缓存。
 *
 * API 已有边缘缓存，但浏览器仍可能在站内返回时重新发请求（尤其是带 Authorization 的 GET）。
 * 这里仅在当前标签页留很短时间，减少回退/重复访问的网络往返；不写本地存储，避免跨会话
 * 留下搜索内容，也不缓存 ROM、账号或存档等运行时数据。
 */
const TTL_MS = 20_000
const MAX_ENTRIES = 24

interface Entry<T> {
  data: T
  expiresAt: number
}

const entries = new Map<string, Entry<unknown>>()

/** 渲染期间可安全读取；不改写全局缓存状态，避免并发渲染被丢弃时留下副作用。 */
export function peekPageDataCache<T>(key: string, now = Date.now()): T | null {
  const entry = entries.get(key)
  if (!entry) return null
  return entry.expiresAt > now ? entry.data as T : null
}

/** 获取仍新鲜的页面数据，并在 effect / 事件阶段提升其 LRU 优先级。 */
export function getPageDataCache<T>(key: string, now = Date.now()): T | null {
  const data = peekPageDataCache<T>(key, now)
  if (data === null) {
    const entry = entries.get(key)
    if (entry && entry.expiresAt <= now) entries.delete(key)
    return null
  }
  const entry = entries.get(key)
  if (!entry) return null
  entries.delete(key)
  entries.set(key, entry)
  return data
}

/** 只保存成功响应；容量固定，避免不断搜索/筛选导致标签页内存无界增长。 */
export function setPageDataCache<T>(key: string, data: T, now = Date.now()): void {
  if (entries.has(key)) entries.delete(key)
  entries.set(key, { data, expiresAt: now + TTL_MS })
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
  }
}

/** 供回归测试及明确需要刷新公开页面数据的场景使用。 */
export function clearPageDataCache(): void {
  entries.clear()
}
