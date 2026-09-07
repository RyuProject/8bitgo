import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'

/**
 * 头条「自动收录 / js 提交」在前端路由下的补推。
 *
 * 为什么需要这一层：index.html 里那段脚本是个一次性 IIFE，push.js 执行时读的是
 * **当时的** location.href。本站是 SPA，用户从首页点进游戏详情页时不会有第二次
 * 整页加载，于是第二个 URL 头条永远收不到 —— 而绝大多数页面浏览恰恰是这么发生的。
 * 平台自己也写着「建议优先使用 js 提交功能」，只推首屏那一个 URL 等于把它废掉大半。
 *
 * 做法就是把那段脚本重新插一遍：同一个 src 再次执行时读到的是新的 location.href。
 *
 * 几个刻意的选择：
 *
 *  1. **src 从 DOM 上取，不在这里抄第二份。** 那串 128 位 hash 是站点凭证，
 *     抄一份就迟早会和 index.html 里的那份对不上（换站点、平台重置 key 时只改一处）。
 *  2. **带查询串的地址一条都不推。** `/games?platform=gba`、`/games?q=…` 这类在
 *     robots.txt 里是明确禁抓的，把它推给搜索引擎属于自相矛盾；而分页页面
 *     本来就躺在 sitemap 里、现在也有真链接可循，不缺这一条。
 *
 *     ⚠️ 这里必须**连 search 一起判**，只看 pathname 是不够的 ——
 *     push.js 提交的是它执行那一刻的 `location.href`，**带查询串**。
 *     守卫看 pathname、载荷带 query，两者不是一回事：玩家在游戏详情页点一个
 *     `#标签` 跳到 `/games?q=经典`，pathname 从 `/games/xxx` 变成 `/games`
 *     → 守卫放行 → 推出去的却是那个禁抓的 `?q=` 地址。2026-09-07 查出来的，
 *     GSC 里那批「已被 robots.txt 屏蔽」的搜索页就是这么被主动送出去的。
 *  3. **推过的 URL 不再推。** 用户来回翻同一批页面很常见，没必要重复打点。
 *  4. 整段用 try 兜住，并且任何一步失败都当没发生过 —— 收录是锦上添花，
 *     绝不能让第三方脚本的问题影响到页面本身。
 */

/** 这些路径没有收录价值（后台、跨站嵌入、登录态相关），一条都不推。 */
const SKIP = /^\/(admin|embed|auth|login|me)(\/|$)/

/** index.html 里那段脚本的 src。第一次进来时从 DOM 上读一次记住。 */
let scriptSrc = ''
/** 本次会话已经推过的路径。 */
const pushed = new Set<string>()

function repush() {
  try {
    document.getElementById('ttzz')?.remove()
    const el = document.createElement('script')
    el.src = scriptSrc
    el.id = 'ttzz'
    const first = document.getElementsByTagName('script')[0]
    first?.parentNode?.insertBefore(el, first)
  } catch {
    /* 推送失败不该有任何可见后果 */
  }
}

export function useAutoInclude() {
  const { pathname, search } = useLocation()
  // basename 已经被 react-router 剥掉了，所以这里的 pathname 不带 /en 这类语言前缀
  const firstRun = useRef(true)

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      // 首屏那次由 index.html 发出，这里只把 src 记下来备用，别重复推一遍
      if (!scriptSrc) scriptSrc = document.getElementById('ttzz')?.getAttribute('src') ?? ''
      pushed.add(pathname)
      return
    }
    if (!scriptSrc) return
    // 见上面第 2 条：push.js 读的是完整 location.href，所以有查询串就整条跳过。
    // 刻意**不**记进 pushed —— 待会儿玩家回到干净的 /games 时那一次仍然该推
    if (search) return
    if (SKIP.test(pathname)) return
    if (pushed.has(pathname)) return
    pushed.add(pathname)
    repush()
  }, [pathname])
}
