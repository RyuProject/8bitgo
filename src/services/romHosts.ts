/**
 * 主域（assets.<裸域>，Cloudflare）与加速镜像（cn-assets.<裸域>，EdgeOne）之间的地址换算。
 *
 * 两个域名回源同一个 R2 桶，同一路径就是同一个对象，所以凡是**拿 URL 当身份**的地方
 * （ROM / 系统盘的 IndexedDB 缓存键、Sockdrive 存档键）都必须先换回主域写法，否则换一次线路
 * 就当成另一份文件：缓存全部重下、Sockdrive 存档读不回来。
 *
 * 只读构建期配置（不读管理员本机覆盖），也不 import 任何业务模块，romCache 等底层模块可以放心引用。
 */
import { readCachedRomHost, type RomHost } from './romRoute'

const trim = (value: string | undefined) => {
  const raw = String(value ?? '').trim().replace(/\/+$/, '')
  if (!raw) return ''
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
}

export const ENV_ROM_BASE = trim(import.meta.env.VITE_ROM_BASE_URL)
export const ENV_ROM_MIRROR = trim(import.meta.env.VITE_ROM_MIRROR_URL)

/** 镜像地址换回主域写法；其它地址原样返回 */
export function canonicalRomUrl(url: string, base = ENV_ROM_BASE, mirror = ENV_ROM_MIRROR): string {
  if (!url || !base || !mirror || base === mirror) return url
  return url.startsWith(`${mirror}/`) ? `${base}${url.slice(mirror.length)}` : url
}

/** 主域地址换成镜像写法；不在主域上的地址返回空串 */
export function mirrorRomUrl(url: string, base = ENV_ROM_BASE, mirror = ENV_ROM_MIRROR): string {
  if (!url || !base || !mirror || base === mirror || !url.startsWith(`${base}/`)) return ''
  return `${mirror}${url.slice(base.length)}`
}

/**
 * 开局前已经测好的线路（chooseRomHost 写的 30 分钟结论）；还没测完时用 fallback。
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
