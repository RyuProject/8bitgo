/**
 * ROM 主域（assets）、大陆镜像（cn-assets）与下载优选域（download）之间的地址换算。
 *
 * 三个域名读同一 R2 对象，所以凡是**拿 URL 当身份**的地方（ROM / 系统盘的 IndexedDB 缓存键、
 * Sockdrive 存档键）都必须先换回主域写法，否则换一次线路就当成另一份文件：缓存全部重下、
 * Sockdrive 存档读不回来。
 *
 * 只读构建期配置（不读管理员本机覆盖），也不 import 任何业务模块，romCache 等底层模块可以放心引用。
 */
import { readCachedRomHost, rememberRomHostFromDownload, type RomHost } from './romRoute'
import { hedgedRequest } from './hedgedRequest'
import {
  isRomRouteOpen,
  rankRomRoutes,
  recordRomRouteFailure,
  recordRomRouteSuccess,
  romRouteOrigin,
  romRouteRate,
} from './romRouteHealth'

const trim = (value: string | undefined) => {
  const raw = String(value ?? '').trim().replace(/\/+$/, '')
  if (!raw) return ''
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
}

export const ENV_ROM_BASE = trim(import.meta.env.VITE_ROM_BASE_URL)
export const ENV_ROM_MIRROR = trim(import.meta.env.VITE_ROM_MIRROR_URL)
export const ENV_ROM_DOWNLOAD = trim(import.meta.env.VITE_ROM_DOWNLOAD_URL)

/** 将本站 R2 对象改写到下载优选域；外站和自定义存储地址保持原样。 */
export function downloadRomUrl(url: string, base = ENV_ROM_BASE, mirror = ENV_ROM_MIRROR, download = ENV_ROM_DOWNLOAD): string {
  if (!url || !download) return ''
  for (const source of [base, mirror]) {
    if (source && source !== download && url.startsWith(`${source}/`)) {
      return `${download}${url.slice(source.length)}`
    }
  }
  return ''
}

/** 镜像或下载域地址换回主域写法；其它地址原样返回 */
export function canonicalRomUrl(url: string, base = ENV_ROM_BASE, mirror = ENV_ROM_MIRROR): string {
  if (!url || !base) return url
  if (mirror && base !== mirror && url.startsWith(`${mirror}/`)) return `${base}${url.slice(mirror.length)}`
  if (ENV_ROM_DOWNLOAD && base !== ENV_ROM_DOWNLOAD && url.startsWith(`${ENV_ROM_DOWNLOAD}/`)) {
    return `${base}${url.slice(ENV_ROM_DOWNLOAD.length)}`
  }
  return url
}

/** 主域地址换成镜像写法；不在主域上的地址返回空串 */
export function mirrorRomUrl(url: string, base = ENV_ROM_BASE, mirror = ENV_ROM_MIRROR): string {
  if (!url || !base || !mirror || base === mirror || !url.startsWith(`${base}/`)) return ''
  return `${mirror}${url.slice(base.length)}`
}

/**
 * 同一个对象的下一条备用线路；不在本站资源域上的地址返回空串。
 *
 * 下载器在首段测速或当前线路重试失败后切换（loadProgress.ts）：三条线路读取同一个 R2 桶，
 * 带同一个 romv 就是同一份字节，断点分片按 canonical 键存，换线路也能接着补。
 * 2026-11-10 墨西哥玩家《合金弹头 3》两次「Failed to fetch」：那条线路对他不通，而另一条从没试过。
 */
export function alternateRomUrl(url: string, base = ENV_ROM_BASE, mirror = ENV_ROM_MIRROR): string {
  return alternateRomUrls(url, base, mirror)[0] ?? ''
}

/** 同一 R2 对象的备用线路：先试下载优选域，再保留原有主域 / EdgeOne 作为兜底。 */
export function alternateRomUrls(url: string, base = ENV_ROM_BASE, mirror = ENV_ROM_MIRROR): string[] {
  if (!url) return []
  const candidates: string[] = []
  const downloadUrl = downloadRomUrl(url, base, mirror)
  if (downloadUrl) candidates.push(downloadUrl)
  if (mirror && url.startsWith(`${mirror}/`)) candidates.push(canonicalRomUrl(url, base, mirror))
  else if (base && url.startsWith(`${base}/`)) {
    const mirrorUrl = mirrorRomUrl(url, base, mirror)
    if (mirrorUrl) candidates.push(mirrorUrl)
  } else if (ENV_ROM_DOWNLOAD && url.startsWith(`${ENV_ROM_DOWNLOAD}/`)) {
    candidates.push(canonicalRomUrl(url, base, mirror))
  }
  // 下载域作为当前线路时，原线路和 EdgeOne 都可接着兜底。
  if (ENV_ROM_DOWNLOAD && url.startsWith(`${ENV_ROM_DOWNLOAD}/`)) {
    const canonical = canonicalRomUrl(url, base, mirror)
    const mirrorUrl = mirrorRomUrl(canonical, base, mirror)
    if (canonical) candidates.push(canonical)
    if (mirrorUrl) candidates.push(mirrorUrl)
  }
  return [...new Set(candidates.filter((candidate) => candidate && candidate !== url))]
}

/** 刚确认可读的线路（origin → 到期时间）。「不可达」不在这里记：交给线路记分板，别处也看得见 */
const reachableRomOrigins = new Map<string, number>()
/** 第一条线路这么久没答复就同时问下一条 */
const REACHABLE_HEDGE_MS = 600
const REACHABLE_TIMEOUT_MS = 1800

/**
 * 给只接受单个 URL 的引擎（EmulatorJS 的 EJS_biosUrl）挑一个当前可读的同对象域名。
 *
 * 候选按线路记分板（romRouteHealth.ts）排序：排第一的线路刚有真实下载、或 60 秒内探过可读，就直接用；
 * 否则发 1 字节 Range 探测，第一条 600ms 没答复就同时问下一条，谁先答可读用谁。
 * 以前逐条串行、每条 1.8 秒，不可达结论只在这里记 8 秒，ROM 下载那边看不见。
 */
export async function reachableRomAssetUrl(url: string, signal?: AbortSignal): Promise<string> {
  if (!url || typeof fetch !== 'function') return url
  const candidates = rankRomRoutes([url, ...alternateRomUrls(url)])
  const top = candidates[0] ?? url
  if (!isRomRouteOpen(top) && ((reachableRomOrigins.get(romRouteOrigin(top)) ?? 0) > Date.now() || romRouteRate(top))) {
    return top
  }
  try {
    return await hedgedRequest(candidates, async (candidate, attemptSignal) => {
      let response: Response
      try {
        response = await fetch(candidate, {
          method: 'GET',
          mode: 'cors',
          credentials: 'omit',
          cache: 'no-store',
          headers: { Range: 'bytes=0-0' },
          signal: attemptSignal,
        })
      } catch (error) {
        // 超时算这条线路的账；被对冲的另一条抢先、或调用方取消，不算
        const reason = (attemptSignal.reason as { name?: string } | undefined)?.name
        if (!attemptSignal.aborted) recordRomRouteFailure(candidate, 'network')
        else if (reason === 'TimeoutError') recordRomRouteFailure(candidate, 'timeout')
        throw error
      }
      void response.body?.cancel().catch(() => {})
      if (!response.ok) {
        if (response.status >= 500 || response.status === 429) recordRomRouteFailure(candidate, 'server')
        throw new Error(`HTTP ${response.status}`)
      }
      recordRomRouteSuccess(candidate)
      reachableRomOrigins.set(romRouteOrigin(candidate), Date.now() + 60_000)
      return candidate
    }, { hedgeDelayMs: REACHABLE_HEDGE_MS, attemptTimeoutMs: REACHABLE_TIMEOUT_MS, signal })
  } catch {
    return url
  }
}

/** 已在 ROM / 光盘的真实 Range 请求中验证或回退成功的线路，短时供下一局和系统资源复用。 */
export function rememberRomHostForUrl(url: string, base = ENV_ROM_BASE, mirror = ENV_ROM_MIRROR): void {
  if (!url || typeof window === 'undefined' || !base || !mirror) return
  if (url.startsWith(`${mirror}/`)) rememberRomHostFromDownload(base, mirror, 'mirror')
  else if (url.startsWith(`${base}/`)) rememberRomHostFromDownload(base, mirror, 'primary')
}

/**
 * 开局前已经测好的线路（chooseRomHost 写的 30 分钟探针结论，或真实下载写的 5 分钟结论）；还没测完时用 fallback。
 * 只在浏览器里有意义，SSR 一律主域。
 */
export function currentRomHost(fallback: RomHost = 'primary'): RomHost {
  if (typeof window === 'undefined' || !ENV_ROM_BASE || !ENV_ROM_MIRROR) return 'primary'
  return readCachedRomHost(ENV_ROM_BASE, ENV_ROM_MIRROR) ?? fallback
}

/** 把主域上的一个资源地址换到当前线路 */
export function routeRomAssetUrl(url: string, fallback: RomHost = 'primary'): string {
  if (!url || currentRomHost(fallback) !== 'mirror') return url
  return mirrorRomUrl(url) || url
}

/* ── Sockdrive：每块盘在每个浏览器里钉死一条线路 ──────────────────────────────
   js-dos 按完整 URL 在 OPFS 里存这块盘读过的扇区。跟着 30 分钟的线路结论来回切的话，同一块盘会在
   OPFS 里存两份（各可达几百 MB），每次换线路还要重新预热。所以第一次挂载时按当时的最优线路选定，
   之后这个浏览器一直用它；挂载失败时 clearSockdrivePin 解除，下一次按新线路重选。 */
const PIN_KEY = '8bitgo.sockdrive-host.v1'
const PIN_TTL_MS = 30 * 24 * 60 * 60 * 1000

type PinMap = Record<string, { host: RomHost; at: number }>

function readPins(): PinMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(PIN_KEY) || '{}') as PinMap
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writePins(pins: PinMap) {
  try {
    // 只留最近 50 块盘，免得无限增长
    const entries = Object.entries(pins).sort((a, b) => b[1].at - a[1].at).slice(0, 50)
    localStorage.setItem(PIN_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    /* 存不了就每次按当前线路选；OPFS 至多多存一份 */
  }
}

export function pinnedSockdriveUrl(url: string, fallback: RomHost = 'primary'): string {
  if (!url || typeof window === 'undefined') return url
  const canonical = canonicalRomUrl(url)
  if (!mirrorRomUrl(canonical)) return url
  const pins = readPins()
  const pin = pins[canonical]
  let host: RomHost
  if (pin && (pin.host === 'primary' || pin.host === 'mirror') && Date.now() - pin.at < PIN_TTL_MS) {
    host = pin.host
  } else {
    host = currentRomHost(fallback)
  }
  pins[canonical] = { host, at: Date.now() }
  writePins(pins)
  return host === 'mirror' ? mirrorRomUrl(canonical) : canonical
}

export function clearSockdrivePin(url: string): void {
  if (!url || typeof window === 'undefined') return
  const pins = readPins()
  const canonical = canonicalRomUrl(url)
  if (!(canonical in pins)) return
  delete pins[canonical]
  writePins(pins)
}

/**
 * js-dos 的 Sockdrive 存档包是一串记录：[u32 URL 长度][URL][u32 数据长度][扇区差异]，
 * 开机时**按 URL 原样匹配**当前挂载的盘（emulators.js 的 traverseSockdriveChanges）。
 * 在另一条线路上存的档，URL 对不上就被静默丢弃。这里把「同一块盘的另一种写法」改成当前地址。
 * 格式对不上（老 ZIP 存档等）原样返回，交给 js-dos 自己处理。
 */
export function retargetSockdriveChanges(bytes: Uint8Array, currentUrl: string): Uint8Array {
  if (!bytes?.length || !currentUrl) return bytes
  // ZIP 层（PK 开头）不是扇区差异包
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return bytes
  const target = canonicalRomUrl(currentUrl.replace(/\/+$/, ''))
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const parts: Uint8Array[] = []
  let changed = false
  let i = 0
  try {
    while (i < bytes.length) {
      if (i + 4 > bytes.length) return bytes
      const urlLen = view.getUint32(i, true)
      if (urlLen > 4096 || i + 4 + urlLen + 4 > bytes.length) return bytes
      const url = decoder.decode(bytes.subarray(i + 4, i + 4 + urlLen))
      if (!/^https?:\/\//.test(url)) return bytes
      const dataLen = view.getUint32(i + 4 + urlLen, true)
      const dataStart = i + 8 + urlLen
      if (dataStart + dataLen > bytes.length) return bytes
      let outUrl = url
      if (url !== currentUrl && canonicalRomUrl(url.replace(/\/+$/, '')) === target) {
        outUrl = currentUrl
        changed = true
      }
      const urlBytes = encoder.encode(outUrl)
      const head = new Uint8Array(4)
      new DataView(head.buffer).setUint32(0, urlBytes.length, true)
      const lenBytes = new Uint8Array(4)
      new DataView(lenBytes.buffer).setUint32(0, dataLen, true)
      parts.push(head, urlBytes, lenBytes, bytes.subarray(dataStart, dataStart + dataLen))
      i = dataStart + dataLen
    }
  } catch {
    return bytes
  }
  if (!changed) return bytes
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
