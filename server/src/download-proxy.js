/**
 * 下载域名（download.8bitgo.com）经 ROM Worker 转发过来的请求，用它取真实客户端 IP。
 *
 * 为什么需要：Worker 向源站发子请求时，Cloudflare 填的 CF-Connecting-IP 是 Worker 的出口
 * （2026-11-16 实测 `2a06:98c0:3600::103`），不是玩家。不处理的话，所有走下载域名的客户端
 * 会挤在 /v1/rom-plain 同一个「每 IP 每分钟 60 次」的额度里，一个人刷满全员 429。
 *
 * 为什么要密钥：这两个头谁都能自己加。只有带上与 Worker 共享的 DOWNLOAD_PROXY_SECRET
 * 时才采信 X-8BitGo-Client-IP；密钥缺失、太短或对不上，一律当作没带，退回原来的取法。
 * 用常数时间比较，避免按响应时间逐字节猜密钥。
 */
import { timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'

export const PROXY_KEY_HEADER = 'x-8bitgo-proxy-key'
export const PROXY_CLIENT_IP_HEADER = 'x-8bitgo-client-ip'
const MIN_SECRET_LENGTH = 32

function headerValue(headers, name) {
  const value = headers?.[name]
  return Array.isArray(value) ? '' : String(value ?? '')
}

/** 密钥对得上时返回 Worker 报上来的客户端 IP，否则返回空串。 */
export function trustedProxyClientIp(headers, secret = process.env.DOWNLOAD_PROXY_SECRET) {
  const expected = String(secret ?? '')
  if (expected.length < MIN_SECRET_LENGTH) return ''
  const given = headerValue(headers, PROXY_KEY_HEADER)
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return ''
  const ip = headerValue(headers, PROXY_CLIENT_IP_HEADER).trim()
  return isIP(ip) ? ip : ''
}
