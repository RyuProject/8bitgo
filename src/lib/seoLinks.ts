/**
 * 站内链接指向的地址，爬虫能不能进。
 *
 * **零 import** —— 这样 `scripts/test-robots.mjs` 能在 node 里直接把它和真的
 * `public/robots.txt` 对着核（那个脚本本来就有一个按 RFC 9309 裁决的 robots 模拟器）。
 * 这条规则的真相只有一份：robots.txt。这里**不重新实现** robots，只表达同一个意图，
 * 由那个测试保证两边不漂。
 *
 * ## 为什么需要它
 *
 * robots.txt 里 `/games?` 全部禁抓（各语言前缀逐条列全），只单独放行 `/games?page=`：
 * 那些筛选组合是乘积级的 URL，canonical 又都指回干净的 `/games`，抓了也不会被收录，
 * 纯耗抓取预算（见 robots.txt 里那段注释）。
 *
 * 但站内一直在往那些地址上挂真链接 —— 2026-09-07 数了一遍**九条，其中四条在首页**
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
 * 禁抓的地址一律不出现在 HTML 的 `href` 里，改成客户端跳转
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
 * 传进来的 `to` 是**不带语言前缀**的站内路径（前缀由 router 的 basename 补），
 * 而 robots.txt 里各语言那几组规则形状完全一样，所以只看无前缀的那一份就够。
 */

/**
 * @param to 站内路径，形如 `/games?q=x`、`/games?page=2`、`/genres/action`
 * @returns 爬虫能不能抓这个地址。false = 别给它 href
 */
export function isCrawlableInternal(to: string): boolean {
  const q = to.indexOf('?')
  // 没有查询串的一律是可抓的 path 页（/games、/games/:slug、/genres/:id …）
  if (q === -1) return true
  // 这条规则只针对游戏库列表页 —— 平台页 / 类型页的 ?page= 没有任何 robots 规则拦
  if (!/^\/games\/?$/.test(to.slice(0, q))) return true
  /*
    只有 page 作为**第一个**参数时才是放行的，和 robots.txt 的
    `Allow: /games?page=` 一字对应（前缀匹配）——
    `/games?platform=gba&page=2` 这种仍然落在 `Disallow: /games?` 里。
  */
  return to.slice(q + 1).startsWith('page=')
}
