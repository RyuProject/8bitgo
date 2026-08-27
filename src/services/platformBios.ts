/**
 * 平台级 BIOS。
 *
 * 有些平台不给 BIOS 根本起不来 —— Neo Geo 就是典型：拳皇、合金弹头、侍魂
 * 全都要 `neogeo.zip`，没有它 FBNeo 直接报错，和 ROM 对不对无关。
 * 同一份 BIOS 整个平台共用，所以按平台存一次，而不是挂到每一款游戏上。
 *
 * 这里存的是对象存储 key，用的时候再拼成 URL —— 和 ROM 的处理方式一致，
 * 换存储桶 / 换域名不用改数据。
 */
import { useEffect, useState } from 'react'
import type { PlatformId } from '@/types'
import { api, apiEnabled } from './api'
import { romUrlForKey } from './roms'

export type PlatformBiosMap = Partial<Record<PlatformId, string>>

let cache: PlatformBiosMap | null = null
let inflight: Promise<PlatformBiosMap> | null = null
const listeners = new Set<() => void>()

function notify() {
  for (const l of listeners) l()
}

/** 取全部平台的 BIOS 绑定。结果缓存在内存里，一次页面生命周期只请求一次 */
export function fetchPlatformBios(force = false): Promise<PlatformBiosMap> {
  if (!apiEnabled()) return Promise.resolve({})
  if (!force && cache) return Promise.resolve(cache)
  if (!force && inflight) return inflight
  inflight = api
    .get<PlatformBiosMap>('/api/platform-bios')
    .then((m) => {
      cache = m && typeof m === 'object' ? m : {}
      return cache
    })
    .catch(() => {
      // 取不到就当没配。BIOS 缺失会由引擎自己报错，比在这里抛出去更有用 ——
      // 那样连不需要 BIOS 的平台也一起打不开了
      cache = cache ?? {}
      return cache
    })
    .finally(() => {
      inflight = null
      notify()
    })
  return inflight
}

/** 同步读已缓存的绑定；没加载过返回 undefined */
export function loadedPlatformBios(): PlatformBiosMap | null {
  return cache
}

/** 后台改完 BIOS 之后调，让正在开着的页面重新拉一次 */
export function invalidatePlatformBios() {
  cache = null
  void fetchPlatformBios(true)
}

/**
 * 某平台的 BIOS 完整 URL。没配就返回空串。
 *
 * 组件里用：BIOS 是异步取的，第一帧多半还没到，所以返回值会从 '' 变成真实地址。
 * 播放器只在真正挂载引擎那一刻读它，不会因为这一次变化重启游戏。
 */
export function usePlatformBiosUrl(platform: PlatformId | undefined): string {
  const [map, setMap] = useState<PlatformBiosMap>(() => cache ?? {})
  useEffect(() => {
    let alive = true
    const sync = () => {
      if (alive) setMap(cache ?? {})
    }
    listeners.add(sync)
    void fetchPlatformBios().then(sync)
    return () => {
      alive = false
      listeners.delete(sync)
    }
  }, [])
  const key = platform ? map[platform] : undefined
  return key ? romUrlForKey(key) : ''
}

/* ---------------- 后台写接口 ---------------- */

export async function bindPlatformBios(platform: PlatformId, objectKey: string): Promise<void> {
  await api.put(`/api/platform-bios/${encodeURIComponent(platform)}`, { objectKey }, true)
  invalidatePlatformBios()
}

export async function unbindPlatformBios(platform: PlatformId): Promise<void> {
  await api.del(`/api/platform-bios/${encodeURIComponent(platform)}`, true)
  invalidatePlatformBios()
}
