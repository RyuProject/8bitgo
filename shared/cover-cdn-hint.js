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

/*
 * ── 大陆访客在 8bitgo.com 上：整页静态与只读 API 也走 EdgeOne（2026-11-04）──
 *
 * 同一份「大陆页面」缓存里，SSR 把 /assets/、/fonts/ 改指 `https://cn.<裸域>/_cn/...`，
 * 客户端的只读 API 请求也改走 `https://cn.<裸域>/_cn/api/...`。地址栏仍是 8bitgo.com，
 * 只剩 HTML 本身（已在 Cloudflare 边缘缓存）还要去洛杉矶。
 *
 * 为什么多一层 `/_cn` 前缀而不是直接用 cn.<裸域>/assets/：EdgeOne 早就缓存过大陆入口自己
 * 请求的 /assets/*（同源请求，没有 Access-Control-Allow-Origin），而它的缓存键不看 Origin、
 * 我们又没有清 EdgeOne 缓存的通道。跨域的模块脚本 / 字体拿到那份就会被浏览器拦下。
 * 换一个路径前缀就是一组全新的缓存键，源站对这组路径总是带上 CORS 头。
 */
export const CN_EDGE_PREFIX = '/_cn'

/** 由站点地址推出大陆加速入口的根（`https://8bitgo.com` → `https://cn.8bitgo.com`） */
export function cnEdgeOrigin(siteUrl) {
  try {
    const { protocol, hostname } = new URL(String(siteUrl || ''))
    if (!hostname || hostname === 'localhost' || /^[\d.]+$/.test(hostname)) return ''
    return `${protocol}//cn.${hostname.replace(/^www\./, '')}`
  } catch {
    return ''
  }
}

/**
 * 把 HTML 模板里的 /assets/、/fonts/ 引用改指大陆加速入口。
 * 入口脚本和样式表加 onerror：EdgeOne 出故障时退回同源，页面不至于没有 JS / 样式。
 */
export function retargetStaticToCnEdge(html, edgeOrigin) {
  if (!edgeOrigin) return html
  const base = `${edgeOrigin}${CN_EDGE_PREFIX}`
  const back = `this.onerror=null;`
  let out = html.replace(/(\s(?:src|href|data-src))="\/(assets|fonts)\//g, `$1="${base}/$2/`)
  out = out.replace(
    // data-cfasync 是 Rocket Loader 退出标记（shared/rocket-loader-optout.js），模板里可能已带上
    /<script((?: data-cfasync="false")?) type="module" crossorigin src="([^"]+)"><\/script>/,
    (tag, optOut, src) =>
      src.startsWith(base)
        ? `<script${optOut} type="module" crossorigin src="${src}" onerror="${back}var s=document.createElement('script');s.type='module';s.crossOrigin='';s.src='${src.slice(base.length)}';document.head.appendChild(s)"></script>`
        : tag,
  )
  out = out.replace(/<link rel="stylesheet"([^>]*?) href="([^"]+)"([^>]*)>/g, (tag, pre, href, post) =>
    href.startsWith(base)
      ? `<link rel="stylesheet"${pre} href="${href}"${post.replace(/\s*\/$/, '')} onerror="${back}this.href='${href.slice(base.length)}'">`
      : tag,
  )
  // 尽早和加速入口握手（放在 head 最前面，排在 Cloudflare 的 Early Hints 之后也不亏）
  return out.replace(/<head>/, `<head>\n<link rel="preconnect" href="${edgeOrigin}" crossorigin>`)
}
