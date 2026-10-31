import { isCnHost } from '../../shared/cn-host.js'

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

export function setSsrCnSite(v: boolean) {
  ssrCnSite = v
}

/** 当前这次渲染是不是在大陆入口上 */
export function onCnSite(): boolean {
  if (typeof window === 'undefined') return ssrCnSite
  return SITE_HOST ? isCnHost(window.location.hostname, SITE_HOST) : false
}
