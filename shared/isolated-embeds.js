/**
 * 需要「跨源隔离」(cross-origin isolation) 才跑得起来的整页游戏。
 *
 * 有些 WebAssembly 游戏（reVC 移植的 GTA、Unity 的多线程构建等）要用 SharedArrayBuffer，
 * 而浏览器只在**顶层文档**发了
 *
 *     Cross-Origin-Opener-Policy: same-origin
 *     Cross-Origin-Embedder-Policy: require-corp
 *
 * 且整条祖先链都隔离时，才把 SharedArrayBuffer 交出来。iframe 自己声明没有用。
 *
 * ## 为什么不能直接加在游戏详情页上
 *
 * `require-corp` 会把页面里所有没带 CORP 头的跨源资源**直接掐掉**，我们这边正好三样全中：
 * Google Fonts 的 <link>、字节的 push.js 收录脚本、对象存储上的封面图。
 * 本来 `Cross-Origin-Embedder-Policy: credentialless` 能绕开这一层，但
 * **Safari 桌面和 iOS 全版本都不支持它**（Chrome 96+ / Firefox 119+ 才有），
 * 用它等于放弃所有苹果用户 —— 所以只能用 require-corp，也就只能换一页来开。
 *
 * 于是这些游戏走一条独立的整页路由 `/play/<slug>`：由 server/src/routes/play.js
 * 吐一个只有 iframe 的极简外壳，那一页不引任何第三方资源，隔离头开在它身上。
 * 详情页一个字节都不用改，其它页面零风险。
 *
 * ## 怎么加一款
 *
 * 1. 把游戏部署好，两种形态都支持，`embed` 写法不同：
 *
 *    - **同源路径**（`/embed/vc/`）：反代到本站同一个域名下。好处是不怕对方加
 *      X-Frame-Options、云存档的 Cookie 算第一方。坏处是如果游戏的前端请求的是
 *      **根绝对路径**（reVCDOS 的 server.py 就把 /vcsky/ /vcbr/ 挂在根上），
 *      你得把那几条路径一起反代过去，别只代 /embed/vc/。上线前拿 DevTools 的
 *      Network 面板确认一遍它到底请求了哪些路径。
 *    - **独立子域名**（`https://vc.8bitgo.com/`）：根绝对路径天然能用，省掉上面那堆
 *      路径对齐的活。代价是跨源，外壳页的 iframe 要带 allow="cross-origin-isolated"
 *      （play.js 里已经带上了），云存档要吃第三方 Cookie 的限制。
 *
 * 2. 在下面登记一条。
 *
 * 3. 被登记的 slug，详情页就不再内嵌模拟器，改成显示一个跳到 /play/<slug> 的入口。
 *
 * ⚠️ 游戏那一侧**也必须**发 `Cross-Origin-Embedder-Policy: require-corp`：
 *    require-corp 的父页面只肯装载同样声明了 COEP 的子框架，否则 iframe 直接空白。
 *    reVCDOS 的 server.py 默认就是这么设的；自己写反代或 Worker 时注意别把这个头丢了。
 */
export const ISOLATED_EMBEDS = Object.freeze({
  // 'gta-vice-city': Object.freeze({ embed: '/embed/vc/', title: 'GTA: Vice City' }),
})

/** 这个 slug 是否走独立的隔离整页。命中返回登记项，否则 undefined */
export function isolatedEmbedFor(slug) {
  if (!slug) return undefined
  return Object.prototype.hasOwnProperty.call(ISOLATED_EMBEDS, slug) ? ISOLATED_EMBEDS[slug] : undefined
}
