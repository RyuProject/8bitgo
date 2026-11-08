/**
 * js-dos IPX 邀请地址校验。
 *
 * IPX 的对端地址只允许是 WebRTC-NET 分配的数字 peer id 或本站生成的短别名；
 * 不把任意输入直接交给底层网络接口，避免链接中的路径 / URL 被误当作对端地址。
 */
export type IpxAddress =
  | { kind: 'peer'; peerId: number }
  | { kind: 'alias'; alias: string }

export function parseIpxAddress(raw: string): IpxAddress | null {
  const value = raw.trim().replace(/^ipx=/i, '')
  if (!value) return null

  if (/^\d{1,10}$/.test(value)) {
    const peerId = Number(value)
    return Number.isSafeInteger(peerId) && peerId > 0 && peerId <= 0xffff_ffff
      ? { kind: 'peer', peerId }
      : null
  }

  const alias = value.toLowerCase()
  return /^[a-z0-9][a-z0-9-]{2,31}$/.test(alias)
    ? { kind: 'alias', alias }
    : null
}

/** 房间号不是凭据，但需要足够随机，避免同一时刻多个玩家撞名。 */
export function createIpxAlias(bytes: Uint8Array): string {
  if (bytes.length < 8) throw new Error('IPX 房间号至少需要 64 位随机数据')
  return `8bg-${Array.from(bytes.slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/** same-origin 是项目的构建期特殊值，不是主机名，必须映射回相对 API 路径。 */
export function jsdosIceEndpoint(apiBase: string | undefined): string {
  const base = (apiBase ?? '').trim().replace(/\/+$/, '')
  if (!base || base === 'same-origin') return '/api/netplay/ice'
  return `${base}/api/netplay/ice`
}
