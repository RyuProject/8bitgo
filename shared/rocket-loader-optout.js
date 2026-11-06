/**
 * 让 Cloudflare Rocket Loader 跳过本站自己的脚本。
 *
 * ── 为什么（2026-11-06《铁拳》详情页实测）──────────────────────────────────────
 * 区域里开着 Rocket Loader：Cloudflare 把 HTML 里每个 `<script>` 改写成
 * `type="<随机前缀>-module"` / `-text/javascript`，再由 rocket-loader.min.js 在 **window load 之后**
 * 统一补执行。load 要等首屏所有封面图和 Cloudflare Insights 的 beacon.min.js 都下完：
 *   · 入口 JS 4.86s 就到手了，React 却到 8.1s 才开始跑（DOMContentLoaded / load 都卡在 beacon 上）；
 *   · `/api/auth/me`、游戏详情、ROM 探测、「开始游戏」按钮全部顺延 3 秒多；
 *   · `edge-route-v2.js` 本该「在 React 之前选好边缘」，也被挪到 load 之后，形同虚设；
 *   · SSR 的 `window.__8BITGO__` 注水数据同样被推迟（顺序还在，但整体晚了一截）。
 * 本站是 SPA + 模块脚本，没有任何一段需要 Rocket Loader 的「异步化」。官方给的逐脚本退出方式
 * 就是 `data-cfasync="false"`：带了这个属性的 `<script>` 原样留给浏览器按标准顺序执行。
 *
 * 根治仍然是在 Cloudflare 后台关掉 Rocket Loader（Speed → Optimization → Content Optimization），
 * 这里保证即使开着，本站的 HTML 也不受影响。JSON-LD 不是脚本，不碰。
 */
export const ROCKET_LOADER_OPT_OUT = 'data-cfasync="false"'

const SCRIPT_OPEN = /<script\b([^>]*)>/gi

/** 给 HTML 里每个可执行的 `<script>` 补上 data-cfasync="false"（已有的不重复加） */
export function optOutRocketLoader(html) {
  return String(html).replace(SCRIPT_OPEN, (tag, attrs) => {
    if (/\bdata-cfasync\s*=/i.test(attrs)) return tag
    if (/\btype\s*=\s*["']?application\/(?:ld\+)?json/i.test(attrs)) return tag
    return `<script ${ROCKET_LOADER_OPT_OUT}${attrs}>`
  })
}
