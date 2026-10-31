/**
 * 中国大陆入口（`cn.8bitgo.com`，腾讯 EdgeOne 加速）的**唯一**判定规则。
 *
 * 为什么要单独判定：Cloudflare 免费版把大陆访客送到洛杉矶机房，HTML 和封面都要跨两次太平洋。
 * `cn.8bitgo.com` 走 EdgeOne 香港节点，封面也要换成同样走 EdgeOne 的封面域，
 * 否则页面快了、满屏封面仍在绕 LAX。
 *
 * 前后端都认这一份（规则同 shared/tv-host.js 的理由）：客户端读 location.hostname，
 * 服务端渲染时由 ssr.js 判好传进来。两边答案不一致，SSR 吐的封面地址和 hydrate 后的就对不上。
 *
 * ⚠️ 服务端**看不到** `cn.8bitgo.com` 这个 Host：EdgeOne 的回源 Host 必须设成 `8bitgo.com`
 * （应用对不认识的子域一律 404，见 url-normalize.js 的「未知子域」那条）。
 * 所以源站 nginx 在请求带着正确的 EdgeOne 回源密钥时，补一个 `X-8bitgo-Site: cn`
 * （见 deploy/nginx/edge-gate.conf）。这个头由 nginx 每次覆盖，客户端伪造不进来。
 *
 * 本文件不 import 任何浏览器 / Node 依赖，scripts/test-game-media-url.mjs 能直接在 node 里跑。
 */

/** 子域前缀。换名字只改这里 */
export const CN_SUBDOMAIN = 'cn'

/** 源站 nginx 给 EdgeOne 回源请求补的站点标记头（小写，Node 的 req.headers 就是小写） */
export const CN_SITE_HEADER = 'x-8bitgo-site'

/** 这个 hostname 是不是大陆入口 */
export function isCnHost(hostname, siteHostname) {
  const site = String(siteHostname || '').trim().toLowerCase()
  const host = String(hostname || '').trim().toLowerCase()
  return Boolean(site) && host === `${CN_SUBDOMAIN}.${site}`
}

/** 服务端：这个请求是不是经 EdgeOne 打到大陆入口的 */
export function isCnRequest({ hostname, siteHostname, siteHeader }) {
  return isCnHost(hostname, siteHostname) || String(siteHeader || '').trim().toLowerCase() === CN_SUBDOMAIN
}
