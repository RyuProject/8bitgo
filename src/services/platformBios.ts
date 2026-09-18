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

/**
 * 绑定表。两种键混在同一张表里（后端也是同一张 `platform_bios` 表）：
 *   · `<平台 id>`      —— 这个平台默认用哪份 BIOS（历史遗留的粗粒度）
 *   · `bios:<系统名>`  —— **某个 BIOS 系统包**用哪份（`bios:neogeo`、`bios:pgm`）
 *
 * 后者是为了街机：一个平台底下好几套硬件，而引擎只吃一个 BIOS 地址，
 * 「这个 ROM 要哪个系统包」必须能分开绑。键的格式两边必须一致，见
 * server/src/routes/platform-bios.js 的 VALID_BIOS_SET。
 */
export type PlatformBiosMap = Partial<Record<PlatformId, string>> & Partial<Record<`bios:${string}`, string>>

/**
 * BIOS 系统包在绑定表里的键。
 *
 * ⚠️ 名字在这里**统一收口**成小写去空格：库里存的、后台填的、页面手输的都从这儿过一遍。
 * 不归一化的话 `' PGM '` 查不到 `bios:pgm`，而失败是静默的（就是"没绑定"）。
 */
export function biosSetKey(name: string): `bios:${string}` {
  return `bios:${String(name).trim().toLowerCase()}`
}

let cache: PlatformBiosMap | null = null
/** 上次请求失败的时刻。失败之后不写 cache，靠这个做短退避 */
let failedAt = 0
const RETRY_BACKOFF_MS = 5000
let inflight: Promise<PlatformBiosMap> | null = null
const listeners = new Set<() => void>()

function notify() {
  for (const l of listeners) l()
}

/** 取全部平台的 BIOS 绑定。结果缓存在内存里，一次页面生命周期只请求一次 */
export function fetchPlatformBios(force = false): Promise<PlatformBiosMap> {
  if (!apiEnabled()) return Promise.resolve({})
  if (!force && cache) return Promise.resolve(cache)
  // 上一次失败之后的退避窗口内直接给空表，别把失败的接口打爆
  if (!force && failedAt && Date.now() - failedAt < RETRY_BACKOFF_MS) return Promise.resolve({})
  if (!force && inflight) return inflight
  inflight = api
    .get<PlatformBiosMap>('/api/platform-bios')
    .then((m) => {
      cache = m && typeof m === 'object' ? m : {}
      failedAt = 0
      return cache
    })
    .catch(() => {
      /**
       * 取不到就当没配 —— BIOS 缺失由引擎自己报错，比在这里抛出去有用（那样连不需要
       * BIOS 的平台也一起打不开了）。
       *
       * ⚠️ **但绝不能把空表写进 cache。** 写了的话 `if (!force && cache) return` 就再也
       * 不会重新请求，整页生命周期里 `platformBiosUrlSync` 一律返回空 →
       * `EJS_biosUrl` 不设 → 所有 Neo Geo 街机报 `sp-s2.sp1 not found` 起不来，
       * 玩家点重试、换游戏、来回切都一样，因为毒在模块级变量里。
       * 而触发它只需要进站那一刻接口抖一下（5xx / 弱网超时 / 被拦截器挡一次）。
       *
       * 所以：保持 cache 为空，下一次调用照常重新请求。加一个短退避，免得
       * 接口真挂了时每次渲染都打一发。
       */
      failedAt = Date.now()
      return cache ?? {}
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

/**
 * 同步取某平台的 BIOS 地址，只看已经缓存下来的那份（没缓存就返回空串）。
 *
 * 「玩本地 ROM」页面需要它：那儿的平台是把文件拖进来**当场识别**出来的，
 * 而引擎在同一轮里就挂载完了。父组件传下来的 biosUrl 是按识别**之前**的平台
 * （默认 nes）算的，等它跟着新平台重新渲染一遍，引擎早已经起来了 ——
 * 而播放器刻意不会因为「BIOS 迟到」重启正在跑的游戏。
 *
 * 缓存在页面加载时就拉好了，所以挂载那一刻同步读一次正好补上这个缺口。
 */
export function platformBiosUrlSync(platform: PlatformId): string {
  const key = cache?.[platform]
  return key ? romUrlForKey(key) : ''
}

/** 后台改完 BIOS 之后调，让正在开着的页面重新拉一次 */
export function invalidatePlatformBios() {
  cache = null
  void fetchPlatformBios(true)
}

/**
 * 某个 BIOS **系统包**的地址（`neogeo` / `pgm` / `skns` …）。后台没绑就返回空串。
 *
 * 「玩本地 ROM」和后台表单那种「同一轮里就要用」的场合读这个（和 platformBiosUrlSync 同理）：
 * 绑定表在进页面时就拉好了，同步读一次正好。
 */
export function biosSetUrlSync(name: string | undefined): string {
  if (!name) return ''
  const key = cache?.[biosSetKey(name)]
  return key ? romUrlForKey(key) : ''
}

/**
 * 订阅一个键（平台 id 或 `bios:<系统名>`）的地址。
 *
 * 组件里用：BIOS 是异步取的，第一帧多半还没到，所以返回值会从 '' 变成真实地址。
 * 播放器只在真正挂载引擎那一刻读它，不会因为这一次变化重启游戏。
 */
function useBiosUrlByKey(key: string | undefined): string {
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
  const raw = key ? (map as Record<string, string | undefined>)[key] : undefined
  return raw ? romUrlForKey(raw) : ''
}

/** 某平台的 BIOS 完整 URL。没配就返回空串。 */
export function usePlatformBiosUrl(platform: PlatformId | undefined): string {
  return useBiosUrlByKey(platform)
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

/** 绑定某个 BIOS **系统包**（`neogeo` / `pgm` …）。接口和平台级共用一个，键带 `bios:` 前缀 */
export async function bindBiosSet(name: string, objectKey: string): Promise<void> {
  await api.put(`/api/platform-bios/${encodeURIComponent(biosSetKey(name))}`, { objectKey }, true)
  invalidatePlatformBios()
}

export async function unbindBiosSet(name: string): Promise<void> {
  await api.del(`/api/platform-bios/${encodeURIComponent(biosSetKey(name))}`, true)
  invalidatePlatformBios()
}
