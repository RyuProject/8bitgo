/**
 * 把资源提前拉进 HTTP 缓存 / 提前建好跨源连接。
 *
 * 只做一件事：让浏览器在玩家真正需要某份资源**之前**就开始下载它。
 * 这里不解析、不使用、不持有结果 —— 唯一的作用是让后面那次真正的请求命中缓存。
 *
 * 两种用途在站内是分开的，别混：
 *   · 引擎资源（prewarm.ts）—— 玩家把指针移到「开始游戏」上时就可以拉，
 *     它跟具体哪一款游戏无关，也不会泄露任何访问意图；
 *   · 游戏文件（ROM）—— **只有过了成人门、播放器真的挂载之后**才能拉，
 *     见 adapters/j2me.ts 里那处调用。在门之前拉等于把成人内容提前取到浏览器，
 *     也绕开了「玩家最后可能选择不玩」这件事。
 *
 * 为什么用 fetch 而不是 <link rel=prefetch>：prefetch 的优先级极低，
 * 浏览器在忙的时候会一直往后排；而我们要的恰恰是「趁启动那几十秒把带宽用起来」。
 */

/** 已经预热过的 URL。同一个页面里重复调用只发一次请求。 */
const warmed = new Set<string>()

/**
 * 预热一个同源（或带 CORS 的跨源）资源。
 *
 * `cache: 'force-cache'` 的语义是「有缓存就直接用，没有就正常请求」——
 * 对我们来说两种情况都对：没请求过就下载进缓存，已经新鲜就什么都不做。
 */
export function warmHttpCache(url: string): void {
  if (!url || warmed.has(url)) return
  warmed.add(url)
  void fetch(url, { cache: 'force-cache', credentials: 'same-origin' }).catch(() => {
    // 预热失败不能惊动玩家，也不该占着 warmed 不放 —— 允许下一次再试
    warmed.delete(url)
  })
}

/**
 * 提前建好到某个源的连接（DNS + TCP + TLS）。
 *
 * ⚠️ **不要给 link.crossOrigin 赋值。** 它的含义是「这条连接要用于 CORS 请求」
 * （字体、fetch 那类），带 crossorigin 预热的连接和普通跨源 `<script src>`
 * （CheerpJ 的 loader.js 就是这种）常常复用不上，等于白预热 ——
 * 而且**不会报任何错**，只是那几百毫秒握手照旧发生。
 * 只有真去拉字体 / CORS 资源时才该加 crossorigin。
 */
export function preconnectOrigin(origin: string): void {
  if (!origin || typeof document === 'undefined') return
  const selector = `link[rel="preconnect"][href="${origin}"]`
  if (document.head.querySelector(selector)) return
  const link = document.createElement('link')
  link.rel = 'preconnect'
  link.href = origin
  document.head.appendChild(link)
}
