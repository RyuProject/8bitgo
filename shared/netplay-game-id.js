/**
 * P2P 联机协议里的 game_id。
 *
 * EmulatorJS 只接受数字 game_id，而站内稳定标识是 slug，所以用 FNV-1a 32 位散列。
 * 这份算法必须前后端共用：浏览器拿它开房，开放接口拿它按 slug 筛房；各抄一份只要漂一位，
 * `?game=<slug>` 就会永远返回空房间，而且双方都不会报错。
 */
export function netplayGameId(slug) {
  let h = 0x811c9dc5
  const value = String(slug ?? '')
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
