/**
 * 封面域名的边缘决策（2026-11-04）。
 *
 * 以前 8bitgo.com 的访客要靠浏览器测速才知道该用 image.8bitgo.com 还是 image-cn.8bitgo.com：
 * SSR 吐出来的首屏封面一律指向主域（预加载扫描器在任何脚本运行前就发出了请求），
 * 大陆访客满屏封面先绕 Cloudflare 洛杉矶，测速完才把没加载完的切过去；单次 16px 探针
 * 还会被两边缓存冷热不同带偏。
 *
 * 现在由边缘直接给答案：
 *   - Cloudflare 一条 URL Rewrite 规则：`ip.src.country eq "CN"` 的页面请求在进缓存**之前**
 *     追加 `__cdn=cn`。改写后的查询串进缓存键，大陆访客与其他访客各自一份页面缓存，
 *     浏览器地址栏不变（改写只发生在边缘内部）。
 *   - 源站据此在 SSR 里直接用大陆封面域，并写一个 `<meta name="8bitgo-cover-cdn">`，
 *     客户端 hydrate 时读它，两边算出同一个地址，不再测速。
 *   - 没有改写参数、但 Cloudflare 告诉我们访客不在大陆（CF-IPCountry）时判为 main；
 *     其它情况（规则没配、本地开发）不下结论，客户端退回测速。
 *
 * ⚠️ 大陆访客且没带参数（规则丢了）时**不能**按 CF-IPCountry 渲染成 cn：那一份会落进
 *    所有人共用的缓存键，全世界都会拿到大陆封面域。
 */

/** Cloudflare 改写规则追加的查询参数名；源站在 normalizeUrl 之前剥掉，不会出现在任何跳转里 */
export const COVER_CDN_QUERY = '__cdn'

/** SSR 写给客户端的 meta 名 */
export const COVER_CDN_META = '8bitgo-cover-cdn'

/** @returns {'cn' | 'main' | ''} */
export function coverCdnHint({ cnSite = false, queryValue = '', country = '' } = {}) {
  if (cnSite) return 'cn'
  if (String(queryValue).trim().toLowerCase() === 'cn') return 'cn'
  const cc = String(country || '').trim().toUpperCase()
  // XX = 未知、T1 = Tor：Cloudflare 的两个占位值，不代表真实地区
  if (/^[A-Z]{2}$/.test(cc) && cc !== 'CN' && cc !== 'XX' && cc !== 'T1') return 'main'
  return ''
}

/**
 * 从原始 URL 里拿掉 `__cdn` 参数。返回 { url, value }；没有这个参数时原样返回。
 * 只动这一个参数，其余查询串顺序保持不变。
 */
export function stripCoverCdnQuery(rawUrl) {
  const url = String(rawUrl || '')
  const cut = url.indexOf('?')
  if (cut < 0) return { url, value: '' }
  const hashCut = url.indexOf('#', cut)
  const query = url.slice(cut + 1, hashCut < 0 ? undefined : hashCut)
  const hash = hashCut < 0 ? '' : url.slice(hashCut)
  let value = ''
  const kept = []
  for (const part of query.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const name = eq < 0 ? part : part.slice(0, eq)
    if (name === COVER_CDN_QUERY) {
      value = eq < 0 ? '' : decodeURIComponent(part.slice(eq + 1))
      continue
    }
    kept.push(part)
  }
  if (kept.length === query.split('&').filter(Boolean).length) return { url, value: '' }
  return { url: url.slice(0, cut) + (kept.length ? `?${kept.join('&')}` : '') + hash, value }
}
