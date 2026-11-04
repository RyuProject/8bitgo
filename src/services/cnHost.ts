import { isCnHost } from '../../shared/cn-host.js'
import { CN_EDGE_PREFIX, COVER_CDN_META, cnEdgeOrigin } from '../../shared/cover-cdn-hint.js'

/**
 * 「这次渲染是不是在大陆入口 cn.8bitgo.com 上」的唯一判定入口。
 *
 * 规则本体在 shared/cn-host.js，这里只解决怎么拿到当前 host（和 services/tvHost.ts 同一个套路）：
 *   · 浏览器里 —— 直接读 location.hostname
 *   · 服务端渲染时 —— 由 entry-server 在渲染前塞进来（服务端看不到 cn 这个 Host，见 shared/cn-host.js）
 */

const SITE_HOST = (() => {
  const raw = (import.meta.env.VITE_SITE_URL ?? '').trim()
  if (!raw) return ''
  try {
    return new URL(raw).hostname.toLowerCase()
  } catch {
    return ''
  }
})()

/** ⚠️ 模块级变量，和 setSsrTvHost 一样必须在 renderToString 之前同步设好，中间不能有 await */
let ssrCnSite = false

let ssrCoverHint: CoverCdnHint = ''

export type CoverCdnHint = 'cn' | 'main' | ''

export function setSsrCnSite(v: boolean, coverHint: CoverCdnHint = '') {
  ssrCnSite = v
  ssrCoverHint = coverHint
}

/**
 * 边缘替这个访客定好的封面域（shared/cover-cdn-hint.js）。
 * 客户端读 SSR 写进 head 的 meta，和服务端渲染时用的是同一个值，hydrate 不会对不上。
 * 只在首次读取时查 DOM：之后的路由切换沿用同一份决定。
 */
let clientCoverHint: CoverCdnHint | null = null
export function coverCdnHint(): CoverCdnHint {
  if (typeof window === 'undefined') return ssrCoverHint
  if (onCnSite()) return 'cn'
  if (clientCoverHint === null) {
    const value = document.querySelector(`meta[name="${COVER_CDN_META}"]`)?.getAttribute('content')
    clientCoverHint = value === 'cn' || value === 'main' ? value : ''
  }
  return clientCoverHint
}

/** 当前这次渲染是不是在大陆入口上 */
export function onCnSite(): boolean {
  if (typeof window === 'undefined') return ssrCnSite
  return SITE_HOST ? isCnHost(window.location.hostname, SITE_HOST) : false
}

/**
 * 8bitgo.com 上的大陆访客：只读 API 改走 EdgeOne 的 `https://cn.<裸域>/_cn`（server/src/cn-edge.js）。
 * 大陆入口本身、非大陆访客、本地开发都返回空串（照旧同源）。
 * 这次会话里加速入口出过网络错误就不再用它（edgeApiFailed）。
 */
let edgeApiFailed = false
export function cnEdgeApiBase(): string {
  if (typeof window === 'undefined' || edgeApiFailed) return ''
  if (onCnSite() || coverCdnHint() !== 'cn') return ''
  const origin = cnEdgeOrigin(import.meta.env.VITE_SITE_URL ?? '')
  return origin && origin !== window.location.origin ? `${origin}${CN_EDGE_PREFIX}` : ''
}
export function markCnEdgeApiFailed() {
  edgeApiFailed = true
}
