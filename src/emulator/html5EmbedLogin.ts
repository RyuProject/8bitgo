/**
 * 第三方 HTML5 游戏自带的「用 Google / Discord 登录」，在本站的游戏框里**一定**失败。
 *
 * ## 2026-11-20《Pokecatch》取证
 *
 * 玩家报「在 /games/pokecatch 用 Google 登录是 403」。本站自己的登录根本没走到：
 * 失败的是游戏页面（pokecatch-online.netlify.app）里那颗按钮。它调 Supabase
 * `signInWithOAuth({ provider: 'google' })`，把**它自己所在的框**整页跳到
 * supabase.co/auth/v1/authorize → accounts.google.com/v3/signin/identifier。
 * Google 的登录页按 `Sec-Fetch-Dest` 区分：顶层文档 200，框架里 403
 * （「403. 抱歉，你没有此页面的访问权限」）—— 这是 Google 防点击劫持的策略，
 * 和本站服务器、Cloudflare、nginx 都无关。同一款游戏的 Discord 登录也一样：
 * discord.com 的授权页发 `frame-ancestors 'none'`，框里直接拒绝显示。
 *
 * ## 为什么本站修不了「在框里登录」
 *
 * - 跳转发生在跨源框架**内部**，父页面读不到它的地址，也拦不住它的导航；
 * - 给 sandbox 加 allow-top-navigation / allow-popups-to-escape-sandbox 都没用：
 *   游戏改的是自己那个窗口的 location，不是顶层，也不开弹窗；
 * - 就算玩家在新标签页登好了，浏览器对第三方框架的存储分区（Chrome 115+ 等）
 *   也让框里的游戏拿不到那份登录态。
 *
 * 对仍在 iframe 内运行的游戏，本站只能在玩家点那颗按钮之前告诉他去游戏自己的页面。
 * Pokecatch 已从 shared/builtin-web-games.js 登记为直接新标签页启动，不再经过 iframe。
 * 这里按游戏入口的**主机名**登记（问题属于被嵌的页面，不属于 slug：换 slug、
 * 多语言槽指向同一个站，都该命中）。只认 https 外链，本站同源的 /web/… 不在此列。
 *
 * 加一款前先取证：游戏的登录是不是在自己框里跳转、对方授权页在框里是否被拒
 * （curl 带 `Sec-Fetch-Dest: iframe` 看状态码，或看 X-Frame-Options / frame-ancestors）。
 * 用弹窗登录、或用 Google Identity Services 一键登录的游戏不受影响，别往里塞。
 */

export interface Html5EmbedLogin {
  /** 在新标签页打开的地址：就是框里加载的那个入口 */
  url: string
  /** 给玩家看的登录方式名称，原样显示（品牌名不翻译） */
  providers: readonly string[]
}

const TOP_LEVEL_LOGIN_HOSTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'pokecatch-online.netlify.app': Object.freeze(['Google', 'Discord']),
})

/** 这款 HTML5 游戏的入口是否属于「账号登录只能在顶层页面完成」的站点。命中返回提示所需信息 */
export function html5EmbedLoginFor(entry: string | null | undefined): Html5EmbedLogin | null {
  if (!entry) return null
  let parsed: URL
  try {
    parsed = new URL(entry)
  } catch {
    // 相对路径（/web/xxx）是本站同源页面，登录本来就在顶层范围内，不需要提示
    return null
  }
  if (parsed.protocol !== 'https:') return null
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (!Object.prototype.hasOwnProperty.call(TOP_LEVEL_LOGIN_HOSTS, host)) return null
  return { url: parsed.href, providers: TOP_LEVEL_LOGIN_HOSTS[host] }
}
