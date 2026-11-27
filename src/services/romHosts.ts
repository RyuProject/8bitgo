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
  recordRomRouteTransfer,
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
/** 测试用：清掉「刚探过可读」的短时结论 */
export function clearReachableRomOrigins(): void {
  reachableRomOrigins.clear()
}
/** 第一条线路这么久没读完样本就同时问下一条 */
const REACHABLE_HEDGE_MS = 600
/** 每条线路读完样本的时限（含响应头）。要读正文，比只等响应头宽一些 */
const REACHABLE_TIMEOUT_MS = 3000
/**
 * 探测读的正文量。量的是吞吐，不是延迟：2026-11-20 大陆实测，优选域 rom / download.8bitgo.com 的响应头
 * 照样秒回，正文却只有 7 KB/s；1 字节探测于是选中了它，《实况足球 2000》开局等这份 512KB 的 PS1 BIOS 等了 74 秒
 * （CHD 早在第 39 秒就挂好了），同一时刻 cn-assets 读 8MB 只要 3～5 秒。64KB 在慢线路上要好几秒，
 * 对冲 600ms 后快线路先读完、先赢。比它小的 BIOS（GBA 16KB）整份读完就是了。
 */
const REACHABLE_SAMPLE_BYTES = 64 * 1024
/**
 * 记分板上排第一的线路吞吐至少这么快，才免探测直接用（字节 / 毫秒，约 2Mbps）。
 * 只有它测过、别的都没测过时，排序会把没测过的当成「和它一样快」，慢线路照样排第一 ——
 * 以前只要有吞吐记录就直接用，测出来再慢也一样。
 */
const REACHABLE_TRUSTED_RATE = 256

/**
 * 给只接受单个 URL 的引擎（EmulatorJS 的 EJS_biosUrl）挑一个当前读得快的同对象域名。
 * 引擎自己只会对着这一个地址下，不会换线路，所以这里选错了整局都要等它。
 *
 * 候选按线路记分板（romRouteHealth.ts）排序：排第一的线路吞吐够快、或 60 秒内刚探过，就直接用；
 * 否则每条默认读 64KB 样本，第一条 600ms 没读完就同时问下一条，谁先读完用谁，样本吞吐记进记分板。
 * 后台文件直开可缩小样本并强制重测：浏览器接管后不会把完整下载吞吐回报给页面，旧分数不能证明这次线路仍快。
 */
export interface ReachableRomAssetOptions {
  /** 后台“打开”只需要迅速比较候选线路，避免为选线路额外读取过多 ROM 正文。 */
  sampleBytes?: number
  hedgeDelayMs?: number
  attemptTimeoutMs?: number
  /** 文件直开不会回报完整下载吞吐；不能让旧的高分把本次线路探测跳过去。 */
  forceProbe?: boolean
}

export async function reachableRomAssetUrl(
  url: string,
  signal?: AbortSignal,
  options: ReachableRomAssetOptions = {},
): Promise<string> {
  if (!url || typeof fetch !== 'function') return url
  const candidates = rankRomRoutes([url, ...alternateRomUrls(url)])
  const sampleBytes = Math.max(1, Math.floor(options.sampleBytes ?? REACHABLE_SAMPLE_BYTES))
  const top = candidates[0] ?? url
  if (!options.forceProbe && !isRomRouteOpen(top) && ((reachableRomOrigins.get(romRouteOrigin(top)) ?? 0) > Date.now() || (romRouteRate(top) ?? 0) >= REACHABLE_TRUSTED_RATE)) {
    return top
  }
  try {
    return await hedgedRequest(candidates, async (candidate, attemptSignal) => {
      let bytes = 0
      let headersAt = 0
      try {
        const response = await fetch(candidate, {
          method: 'GET',
          mode: 'cors',
          credentials: 'omit',
          cache: 'no-store',
          headers: { Range: `bytes=0-${sampleBytes - 1}` },
          signal: attemptSignal,
        })
        if (!response.ok) {
          void response.body?.cancel().catch(() => {})
          if (response.status >= 500 || response.status === 429) recordRomRouteFailure(candidate, 'server')
          throw new Error(`HTTP ${response.status}`)
        }
        headersAt = Date.now()
        const reader = response.body?.getReader()
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            bytes += value?.byteLength ?? 0
            // 不支持 Range、回了整份 200 的源：读够样本就停，不把大文件整个拖下来
            if (bytes >= sampleBytes) {
              void reader.cancel().catch(() => {})
              break
            }
          }
        }
      } catch (error) {
        if (/^HTTP \d{3}$/.test((error as Error | undefined)?.message ?? '')) throw error
        // 超时算这条线路的账（包括正文读得太慢）；被对冲的另一条抢先、或调用方取消，不算
        const reason = (attemptSignal.reason as { name?: string } | undefined)?.name
        if (!attemptSignal.aborted) recordRomRouteFailure(candidate, 'network')
        else if (reason === 'TimeoutError') recordRomRouteFailure(candidate, headersAt ? 'stall' : 'timeout')
        throw error
      }
      // 样本够大就记一笔吞吐（太小的记分板自己会忽略，只算一次成功）
      recordRomRouteTransfer(candidate, bytes, headersAt ? Date.now() - headersAt : 0)
      reachableRomOrigins.set(romRouteOrigin(candidate), Date.now() + 60_000)
      return candidate
    }, {
      hedgeDelayMs: options.hedgeDelayMs ?? REACHABLE_HEDGE_MS,
      attemptTimeoutMs: options.attemptTimeoutMs ?? REACHABLE_TIMEOUT_MS,
      signal,
    })
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

/** 启动线路失败后明确钉到同一 R2 对象的另一条线路，避免缓存测速结论让下一局又选回故障域名。 */
export function failoverSockdriveUrl(url: string): string {
  if (!url || typeof window === 'undefined') return url
  const canonical = canonicalRomUrl(url)
  const mirror = mirrorRomUrl(canonical)
  if (!mirror) return url
  const failedOnMirror = url.startsWith(`${ENV_ROM_MIRROR}/`)
  const nextHost: RomHost = failedOnMirror ? 'primary' : 'mirror'
  const pins = readPins()
  pins[canonical] = { host: nextHost, at: Date.now() }
  writePins(pins)
  return nextHost === 'mirror' ? mirror : canonical
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
