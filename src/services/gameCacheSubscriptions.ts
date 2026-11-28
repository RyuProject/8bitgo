/**
 * 按游戏 slug 订阅缓存变更，避免一批游戏返回时让无关页面和卡片一起重渲染。
 */
export function createSlugSubscriptions() {
  const listenersBySlug = new Map<string, Set<() => void>>()

  return {
    subscribe(slugs: string[], listener: () => void) {
      const uniqueSlugs = [...new Set(slugs.filter(Boolean))]
      for (const slug of uniqueSlugs) {
        let listeners = listenersBySlug.get(slug)
        if (!listeners) listenersBySlug.set(slug, listeners = new Set())
        listeners.add(listener)
      }

      return () => {
        for (const slug of uniqueSlugs) {
          const listeners = listenersBySlug.get(slug)
          if (!listeners) continue
          listeners.delete(listener)
          if (!listeners.size) listenersBySlug.delete(slug)
        }
      }
    },

    notify(slugs: string[]) {
      const affected = new Set<() => void>()
      for (const slug of new Set(slugs)) {
        for (const listener of listenersBySlug.get(slug) ?? []) affected.add(listener)
      }
      for (const listener of affected) listener()
    },
  }
}
