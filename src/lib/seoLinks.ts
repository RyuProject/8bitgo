/**
 * 站内目标要不要输出成真实 href。
 *
 * **零 import** —— 这样 `scripts/test-robots.mjs` 能在 node 里直接验证它。
 * robots.txt 和这里刻意分工：前者允许 Google 重抓已知 URL，才能读到
 * noindex / canonical；这里不向爬虫主动暴露新的筛选组合。
 *
 * ## 为什么需要它
 *
 * 筛选组合是乘积级的 URL，canonical 又都指回干净的 `/games`，
 * 搜索页则是 noindex。它们必须可抓才能让 Google 看到这些信号，但没有必要从站内继续
 * 发现新组合，因此不给它们 href。只有 `/games?page=` 这类干净分页保留真链接，
 * 让第 2 页往后的游戏还有正常的发现通路。
 *
 * 站内曾经一直往这些地址上挂真链接 —— 2026-09-07 数了一遍**九条，其中四条在首页**
 * （「更多」按钮：`?sort=` / `?multiplayer=1` / `?coin=1`），另外还有游戏详情页的
 * `#标签`（`?q=`）和开发商（`?developer=`）、开发商列表页的每一张卡片、
 * 搜索兜底的「你是不是想搜」。
 *
 * ## 从 nofollow 改成「根本不出 href」（2026-09-07）
 *
 * 原来的做法是给这些链接挂 `rel="nofollow"`。**这一步不够**：
 * nofollow 只是不传权重，**挡不住发现** —— 2019 年起 Google 明确把它当"提示"，
 * 照样会把这些 URL 排进抓取队列。实测证据就在 Search Console：
 * 「已被 robots.txt 屏蔽」那一档里躺着 `/de/games?q=…`、`/en/games?developer=Miniclip`
 * 这类地址，而站内除了这些 nofollow 链接没有别的来源。
 *
 * 真正的代价不是权重，是**告警被噪音淹掉**：这一档只要长期非零，真事故就藏得住 ——
 * 09-06 那次「me 那条通配规则」误伤 48 个《合金弹头》URL，就是混在这堆里才拖了一天。
 * 所以现在的目标是让这一档能**归零**，变成一个有用的告警：
 * 非收录目标一律不出现在 HTML 的 `href` 里，改成客户端跳转
 * （见 `components/ui/InternalLink.tsx`）。Google 自己关于 faceted navigation
 * 的建议也是同一条：筛选控件别用可抓的 `<a href>`。
 *
 * ⚠️ **这不是「把标签做成可索引的页面」的替代方案，那条路是错的。** 当时量过：
 * 91 款游戏、65 个标签平均 2.7 款（46% 只有 1 款）、42 个开发商平均 2.2 款
 * （69% 只有 1 款）—— 给它们建 path 页就是造几百个只列一两款游戏的薄内容页，
 * 做了比不做糟。这个库唯一撑得起 taxonomy 页的是 genres（12 个，平均 11.6 款），
 * 而 `/genres/:id` 早就有了，游戏详情页也已经链过去。
 *
 * ## 判据
 *
 * 传进来的 `to` 是**不带语言前缀**的站内路径（前缀由 router 的 basename 补）。
 */

/**
 * @param to 站内路径，形如 `/games?q=x`、`/games?page=2`、`/genres/action`
 * @returns 是否输出 href。false = 仍可以客户端跳转，但不主动给爬虫新入口
 */
export function shouldExposeSeoHref(to: string): boolean {
  const q = to.indexOf('?')
  // 没有查询串的 path 页都要保留真内链（/games、/games/:slug、/genres/:id …）
  if (q === -1) return true
  // 这条规则只针对游戏库列表页；平台页 / 类型页的 ?page= 要保留内链
  if (!/^\/games\/?$/.test(to.slice(0, q))) return true
  /*
    只有 page 作为**第一**个参数时才给真链接；
    `/games?platform=gba&page=2` 这种仍是筛选组合，不应该主动暴露给爬虫。
  */
  return to.slice(q + 1).startsWith('page=')
}
