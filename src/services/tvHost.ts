import { isTvHost } from '../../shared/tv-host.js'

/**
 * 「这次渲染是不是在 TV 子域上」的唯一判定入口。
 *
 * 规则本体在 shared/tv-host.js（前后端共用），这里只解决**怎么拿到当前 host**：
 *   · 浏览器里 —— 直接读 location.hostname
 *   · 服务端渲染时 —— 没有 location，由 entry-server 在渲染前塞进来
 *
 * ⚠️ 两边必须给出**同一个答案**，否则就是 hydration 不一致：服务端渲了 TV 页、
 * 客户端按首页 hydrate，页面先闪一下 TV 再变成首页，控制台里只有一句含糊的警告。
 * 所以这个模块刻意不做任何「聪明」的兜底 —— 拿不准就一律返回 false（当作主域），
 * 主域是两边都能一致算出来的那个答案。
 */

/** 站点主域名。构建时从 VITE_SITE_URL 烘进来，和服务端的 PUBLIC_SITE_URL 是同一个值 */
const SITE_HOST = (() => {
  const raw = (import.meta.env.VITE_SITE_URL ?? '').trim()
  if (!raw) return ''
  try {
    return new URL(raw).hostname.toLowerCase()
  } catch {
    // 配错了就当没配。这里不能抛 —— 一个环境变量写错不该让整站白屏
    return ''
  }
})()

/**
 * SSR 期间的判定结果。由 entry-server 在 renderToString **之前**同步设好。
 *
 * ⚠️ 和 setLangForRender / setSsrPath 一样是模块级变量：它们之间不能有 await，
 * 否则两个并发请求会交错，把别人的 host 用到这次渲染上（见 entry-server 的注释）。
 */
let ssrTvHost = false

export function setSsrTvHost(v: boolean) {
  ssrTvHost = v
}

/** 当前这次渲染是不是在 TV 子域上 */
export function onTvHost(): boolean {
  if (typeof window === 'undefined') return ssrTvHost
  return SITE_HOST ? isTvHost(window.location.hostname, SITE_HOST) : false
}

/** TV 子域的完整 origin（canonical / hreflang 要用）。没配站点域名时返回空串 */
export function tvOrigin(): string {
  if (!SITE_HOST) return ''
  const raw = (import.meta.env.VITE_SITE_URL ?? '').trim()
  const proto = raw.startsWith('http://') ? 'http' : 'https'
  return `${proto}://tv.${SITE_HOST}`
}
