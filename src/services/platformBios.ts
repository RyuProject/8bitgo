/**
 * 平台级 BIOS。
 *
 * 有些平台不给 BIOS 根本起不来 —— Neo Geo 就是典型：拳皇、合金弹头、侍魂
 * 全都要 `neogeo.zip`，没有它 FBNeo 直接报错，和 ROM 对不对无关。
 * 同一份 BIOS 整个平台共用，所以按平台存一次，而不是挂到每一款游戏上。
 *
 * 绑定值可以是对象存储 key、站内路径或公开直链；对象 key 用时再拼成 URL，
 * 换存储桶 / 换域名不用改已有对象 key。
 */
import { useEffect, useState } from 'react'
import type { PlatformId } from '@/types'
import { api, apiEnabled } from './api'
import { romUrlForKey } from './roms'
import { downloadRomUrl, routeRomAssetUrl } from './romHosts'
import { coverCdnHint } from './cnHost'
import { psxBiosObjectKey, type PsxBiosRegion } from '@/emulator/psxBiosRegion'

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
/* EmulatorJS 只接受一个平台 BIOS URL；优先给下载域，适配器会在开局前探测并回退到已有资源域。 */
const biosUrlForKey = (key: string) => {
  const routed = routeRomAssetUrl(romUrlForKey(key), coverCdnHint() === 'cn' ? 'mirror' : 'primary')
  return downloadRomUrl(routed) || routed
}

export function biosSetKey(name: string): `bios:${string}` {
  return `bios:${String(name).trim().toLowerCase()}`
}

let cache: PlatformBiosMap | null = null
/** 上次请求失败的时刻。失败之后不写 cache，靠这个做短退避 */
let failedAt = 0
const RETRY_BACKOFF_MS = 5000
let inflight: Promise<PlatformBiosMap> | null = null
let inflightRevision = -1
/** 写入绑定后递增，防止写入前发出的旧 GET 晚到并覆盖刚保存的值 */
let cacheRevision = 0
let startupRetry: Promise<PlatformBiosMap> | null = null
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
  if (!force && inflight && inflightRevision === cacheRevision) return inflight
  const requestRevision = cacheRevision
  let request: Promise<PlatformBiosMap>
  request = api
    .get<PlatformBiosMap>('/api/platform-bios/map')
    .then((m) => {
      const fetched = m && typeof m === 'object' ? m : {}
      if (requestRevision === cacheRevision) {
        cache = fetched
        failedAt = 0
        return cache
      }
      // GET 在后台写入前已经发出；不能让它把新绑定回滚成旧值。
      if (cache) return cache
      if (inflight && inflight !== request && inflightRevision === cacheRevision) return inflight
      return fetched
    })
    .catch(() => {
      if (requestRevision !== cacheRevision) {
        if (cache) return cache
        if (inflight && inflight !== request && inflightRevision === cacheRevision) return inflight
        return {}
      }
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
      if (inflight === request) {
        inflight = null
        inflightRevision = -1
      }
      notify()
    })
  inflight = request
  inflightRevision = requestRevision
  return request
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
  return key ? biosUrlForKey(key) : ''
}

/**
 * 开局时解析平台 BIOS。
 *
 * 普通页面请求失败会保留 5 秒退避，避免组件反复渲染时打爆接口；但模拟器开局不能把
 * 「绑定表还没成功读到」当成「管理员确实没配」。因此在 cache 仍为 null 时绕过退避
 * 再试一次，并在同一页面的并发开局间共享这次重试。成功读到空表才代表配置项确实缺失。
 */
export async function resolvePlatformBiosForStartup(platform: PlatformId): Promise<{ url: string; mapLoaded: boolean }> {
  await fetchPlatformBios()
  if (cache === null) {
    if (!startupRetry) {
      startupRetry = fetchPlatformBios(true).finally(() => {
        startupRetry = null
      })
    }
    await startupRetry
  }
  return { url: platformBiosUrlSync(platform), mapLoaded: cache !== null }
}

/** 后台改完 BIOS 之后调，让正在开着的页面重新拉一次 */
export function invalidatePlatformBios() {
  cacheRevision++
  cache = null
  failedAt = 0
  void fetchPlatformBios(true)
}

/** 保存成功后先更新本页缓存，避免重新读取时短暂或永久显示旧绑定。 */
function updatePlatformBiosBinding(platform: string, objectKey: string | null) {
  cacheRevision++
  failedAt = 0
  if (cache) {
    const next = { ...cache } as Record<string, string>
    if (objectKey) next[platform] = objectKey
    else delete next[platform]
    cache = next as PlatformBiosMap
    notify()
    return
  }
  // 尚无完整映射时从源站重读；旧请求受 cacheRevision 保护，不能覆盖这次写入。
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
  return key ? biosUrlForKey(key) : ''
}

/** BIOS 异步到达时通知组件；多个选择器共用同一份缓存和订阅逻辑。 */
function usePlatformBiosMap(): PlatformBiosMap {
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
  return map
}

/** 订阅一个键（平台 id 或 `bios:<系统名>`）的地址。 */
function useBiosUrlByKey(key: string | undefined): string {
  const map = usePlatformBiosMap()
  const raw = key ? (map as Record<string, string | undefined>)[key] : undefined
  return raw ? biosUrlForKey(raw) : ''
}

/** 某平台的 BIOS 完整 URL。没配就返回空串。 */
export function usePlatformBiosUrl(platform: PlatformId | undefined): string {
  return useBiosUrlByKey(platform)
}

/** PS1 按光盘区域选 BIOS；对应区域未上传时兼容现有平台级 BIOS。 */
export function usePsxBiosUrl(region?: PsxBiosRegion): string {
  const map = usePlatformBiosMap()
  const key = psxBiosObjectKey(map, region)
  return key ? biosUrlForKey(key) : ''
}


/* ---------------- 后台写接口 ---------------- */

export async function bindPlatformBios(platform: PlatformId, objectKey: string): Promise<void> {
  await api.put(`/api/platform-bios/${encodeURIComponent(platform)}`, { objectKey }, true)
  updatePlatformBiosBinding(platform, objectKey)
}

export async function unbindPlatformBios(platform: PlatformId): Promise<void> {
  await api.del(`/api/platform-bios/${encodeURIComponent(platform)}`, true)
  updatePlatformBiosBinding(platform, null)
}

/** 绑定某个 BIOS **系统包**（`neogeo` / `pgm` …）。接口和平台级共用一个，键带 `bios:` 前缀 */
export async function bindBiosSet(name: string, objectKey: string): Promise<void> {
  const key = biosSetKey(name)
  await api.put(`/api/platform-bios/${encodeURIComponent(key)}`, { objectKey }, true)
  updatePlatformBiosBinding(key, objectKey)
}

export async function unbindBiosSet(name: string): Promise<void> {
  const key = biosSetKey(name)
  await api.del(`/api/platform-bios/${encodeURIComponent(key)}`, true)
  updatePlatformBiosBinding(key, null)
}
