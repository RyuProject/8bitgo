/**
 * 缓存策略集中在这里。
 *
 * 站点前面是 Cloudflare，所以每条策略同时给两个对象看：
 *   max-age    —— 浏览器自己缓存多久
 *   s-maxage   —— Cloudflare 边缘节点缓存多久（会覆盖 max-age）
 *   stale-while-revalidate —— 过期后先把旧的给用户，同时后台悄悄回源更新，
 *                             这样用户永远不会为了「刷新」而等待
 *
 * ⚠️ 光有响应头还不够：Cloudflare 默认只缓存静态后缀，HTML 和 /api 是不缓存的。
 * 需要在控制台加一条 Cache Rule 才会生效，见 server/README.md 的「Cloudflare 缓存」一节。
 */
const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)

/** SSR 页面在边缘的缓存秒数。后台改了内容最多这么久之后前台才会变（也可以手动清缓存） */
const PAGE_S_MAXAGE = n(process.env.PAGE_S_MAXAGE, 300)
/** 公开只读接口在边缘的缓存秒数 */
const API_S_MAXAGE = n(process.env.API_S_MAXAGE, 300)

export const CACHE = {
  /** 带内容哈希的构建产物：文件名变了才算新文件，可以永久缓存 */
  immutable: 'public, max-age=31536000, immutable',

  /** 字体：名字不带哈希，但内容基本不会变；真要换字体请顺手改文件名 */
  font: 'public, max-age=31536000, immutable',

  /**
   * Ruffle / js-dos 的 wasm / js：体积大、更新不频繁，但文件名固定。
   * 浏览器缓存一天，边缘缓存 30 天，升级 Ruffle 后清一次 Cloudflare 缓存即可。
   */
  engine: 'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=86400',

  /** 图片、favicon 之类 */
  image: 'public, max-age=3600, s-maxage=604800, stale-while-revalidate=86400',

  /** robots.txt / sitemap.xml：构建时生成，别缓存太久 */
  meta: 'public, max-age=300, s-maxage=3600, stale-while-revalidate=3600',

  /**
   * SSR 出来的 HTML。浏览器不缓存（max-age=0，保证用户刷新一定拿到新的），
   * 但边缘可以缓存 —— 页面是匿名的，登录态和后台数据都在客户端，不存在串号。
   */
  page: `public, max-age=0, s-maxage=${PAGE_S_MAXAGE}, stale-while-revalidate=86400`,

  /** 404：短暂缓存一下挡住爬虫的反复请求，又不至于长期钉死 */
  notFound: 'public, max-age=0, s-maxage=60',

  /** 公开只读接口 */
  api: `public, max-age=30, s-maxage=${API_S_MAXAGE}, stale-while-revalidate=600`,

  /** 任何跟身份有关、或者实时性要求高的东西 */
  none: 'no-store',
}

/** express.static 的 setHeaders：按路径决定缓存多久 */
export function staticCacheHeaders(res, filePath) {
  const p = filePath.replace(/\\/g, '/')
  const set = (v) => res.setHeader('Cache-Control', v)

  if (p.includes('/assets/')) return set(CACHE.immutable)
  if (p.includes('/fonts/')) return set(CACHE.font)
  if (p.includes('/ruffle/') || p.includes('/emulatorjs/') || p.includes('/j2me/') || p.includes('/jsdos/') || p.includes('/webretro/')) return set(CACHE.engine)
  if (/\.(png|jpg|jpeg|gif|webp|avif|svg|ico)$/i.test(p)) return set(CACHE.image)
  if (/\/(robots\.txt|sitemap[^/]*\.xml)$/i.test(p)) return set(CACHE.meta)
  // 兜底：短缓存 + 允许边缘复用，总好过每次都回源
  set('public, max-age=300, s-maxage=3600, stale-while-revalidate=3600')
}

/**
 * /api 的默认策略：一律不缓存。
 * 公开只读的接口再自己调 publicApi() 覆盖掉 —— 默认安全，漏配只会少一层缓存，
 * 而不会把某个用户的资料发给下一个人。
 */
export function noStore(_req, res, next) {
  res.setHeader('Cache-Control', CACHE.none)
  next()
}

/** 公开只读接口：可以被浏览器和边缘缓存一小会儿 */
export function publicApi(res) {
  res.setHeader('Cache-Control', CACHE.api)
  res.setHeader('Vary', 'Accept-Encoding')
}
