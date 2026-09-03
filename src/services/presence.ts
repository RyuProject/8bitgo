/**
 * 房主 / 成员的「名片」：用什么设备玩、人在哪个国家、网络好不好。
 *
 * 三样东西全部由服务端从握手信息里推断（见 server/src/presence.js），前端只负责
 * 把它们画成 emoji —— 客户端一个字段都不上报，否则挂个 VPN 报个 🇯🇵、
 * 把延迟报成 1ms 都是一行代码的事，这三个标记的意义就没了。
 *
 * 唯一的例外是云端房间的 RTT：那条路没有常驻连接，服务端量不到，只能让浏览器
 * 把自己心跳请求的耗时报上去（见 services/rooms.ts 的 keepAlive）。
 */

export type DeviceKind = 'desktop' | 'mobile' | 'unknown'
export type NetGrade = 'good' | 'fair' | 'poor' | 'unknown'

export interface Presence {
  device: DeviceKind
  /** ISO 3166-1 alpha-2，查不到是 null（内网、库没装、地址不合法） */
  country: string | null
  net: NetGrade
  /** 毫秒。只用来写进 title，格子本身看的是 net */
  rtt: number | null
}

export const UNKNOWN_PRESENCE: Presence = { device: 'unknown', country: null, net: 'unknown', rtt: null }

/** 后端可能是老版本（字段整个没有），或者字段被改坏了，一律退回全未知 */
export function normalizePresence(raw: unknown): Presence {
  const p = (raw ?? {}) as Partial<Presence>
  const device: DeviceKind = p.device === 'desktop' || p.device === 'mobile' ? p.device : 'unknown'
  const net: NetGrade = p.net === 'good' || p.net === 'fair' || p.net === 'poor' ? p.net : 'unknown'
  const country = typeof p.country === 'string' && /^[A-Za-z]{2}$/.test(p.country) ? p.country.toUpperCase() : null
  const rtt = typeof p.rtt === 'number' && Number.isFinite(p.rtt) && p.rtt >= 0 ? Math.round(p.rtt) : null
  return { device, country, net, rtt }
}

/** 这张名片一点信息都没有？三个格子全是 ❓ 的话，紧凑模式下干脆不画 */
export function presenceEmpty(p: Presence): boolean {
  return p.device === 'unknown' && p.country === null && p.net === 'unknown'
}

export const deviceEmoji: Record<DeviceKind, string> = {
  desktop: '💻',
  mobile: '📱',
  unknown: '❓',
}

/**
 * 👌 好 / 🀄️ 中 / 👎 差。
 * 🀄️ 是麻将的「中」—— 正好是中间档，也不至于和另外两个手势撞在一起。
 */
export const netEmoji: Record<NetGrade, string> = {
  good: '👌',
  fair: '🀄️',
  poor: '👎',
  unknown: '❓',
}

/**
 * 国家码 -> 国旗 emoji。'CN' -> 🇨🇳（两个「区域指示符」字母拼起来）。
 *
 * ⚠️ Windows 的系统字体到现在都不带国旗字形，Chrome / Edge 在 Windows 上会
 * 原样显示成「CN」两个字母。这算是个还能看的退化 —— 至少信息没丢，
 * 所以没有为它引一套国旗 SVG（那是几十 KB 起步，为一个装饰不值）。
 */
export function flagEmoji(country: string | null | undefined): string {
  if (!country || !/^[A-Za-z]{2}$/.test(country)) return ''
  const cc = country.toUpperCase()
  const A = 0x1f1e6 // 🇦
  return String.fromCodePoint(A + (cc.charCodeAt(0) - 65), A + (cc.charCodeAt(1) - 65))
}

/**
 * 国家码 -> 当前语言下的国名，给 title 用。
 * Intl.DisplayNames 各家浏览器和 Node 都有了；没有或者认不出这个码就退回码本身。
 */
const nameCache = new Map<string, string>()
export function countryName(country: string | null | undefined, lang: string): string {
  if (!country) return ''
  const key = `${lang}|${country}`
  const hit = nameCache.get(key)
  if (hit !== undefined) return hit
  let name = country
  try {
    name = new Intl.DisplayNames([lang], { type: 'region' }).of(country) || country
  } catch {
    /* 老环境 / 不认识的地区码：显示原样的两个字母 */
  }
  nameCache.set(key, name)
  return name
}
