/**
 * 缓存策略集中在这里。
 *
 * 站点前面是 Cloudflare，所以每条策略同时给两个对象看：
 *   max-age    —— 浏览器自己缓存多久
 *   s-maxage   —— Cloudflare 边缘节点缓存多久（会覆盖 max-age）
 *   stale-while-revalidate —— 过期后先把旧的给用户，同时后台悄悄回源更新，
 *                             这样用户永远不会为了「刷新」而等待
 *
 * ⚠️ 光有响应头还不够：Cloudflare 默认只缓存静态后缀，HTML 和 /api 是不缓存的。
 * 需要在控制台加一条 Cache Rule 才会生效，见 server/README.md 的「Cloudflare 缓存」一节。
 */
const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)

/** SSR 页面在边缘的缓存秒数。后台改了内容最多这么久之后前台才会变（也可以手动清缓存） */
const PAGE_S_MAXAGE = n(process.env.PAGE_S_MAXAGE, 300)
/** 公开只读接口在边缘的缓存秒数 */
const API_S_MAXAGE = n(process.env.API_S_MAXAGE, 300)

export const CACHE = {
  /** 带内容哈希的构建产物：文件名变了才算新文件，可以永久缓存 */
  immutable: 'public, max-age=31536000, immutable',

  /** 字体：名字不带哈希，但内容基本不会变；真要换字体请顺手改文件名 */
  font: 'public, max-age=31536000, immutable',

  /** 带版本目录的引擎产物。版本升级会换 URL，所以可以放心长期缓存。 */
  engineVersioned: 'public, max-age=31536000, immutable',

  /**
   * 仍使用固定 URL 的引擎。这里不能再缓存 30 天：EmulatorJS 的文件名不带哈希，
   * 补丁升级后长期命中旧边缘副本会让线上和构建验收成为两套代码。
   */
  engine: 'public, max-age=300, s-maxage=3600, stale-while-revalidate=300',

  /**
   * 公告条（/api/site-notice）。**故意比别的内容短得多**。
   *
   * 它的用途就是「站点出事了，立刻告诉所有人」，而其它内容走的是 PAGE_S_MAXAGE(300)
   * 那档 —— 公告迟到五分钟，恰好就错过了唯一需要它的那五分钟。
   * 这里不给 stale-while-revalidate：可以先看旧的，不适合一条「正在故障」的声明。
   */
  notice: 'public, max-age=30, s-maxage=30',

  /** 图片、favicon 之类 */
  image: 'public, max-age=3600, s-maxage=604800, stale-while-revalidate=86400',

  /** robots.txt / sitemap.xml：构建时生成，别缓存太久 */
  meta: 'public, max-age=300, s-maxage=3600, stale-while-revalidate=3600',

  /**
   * SSR 出来的 HTML。浏览器不缓存（max-age=0，保证用户刷新一定拿到新的），
   * 但边缘可以缓存 —— 页面是匿名的，登录态和后台数据都在客户端，不存在串号。
   *
   * 这里**故意不带 no-transform**。它曾经用来挡 Cloudflare 的 Email Obfuscation（把正文邮箱
   * 改写成 `/cdn-cgi/l/email-protection`，被 Google 当普通链接抓到后报 404），代价是边缘也
   * 不能改压缩：源站 nginx 给的 gzip 原样下发，静态 JS 早就是 zstd，HTML 却一直是 gzip。
   * 2026-10-26 起改为在区域里关掉 Email Obfuscation（Speed/Scrape Shield 设置），HTML 才能
   * 和其它资源一样由边缘按浏览器选 Brotli / zstd。重新打开那个开关之前先看这里。
   */
  // 内容上架后这段 stale 窗口也算进可见延迟；留 5 分钟扛回源抖动，
  // 避免旧首页/详情页在边缘继续可用整整一天，尤其影响低流量页面的爬虫首访。
  page: `public, max-age=0, s-maxage=${PAGE_S_MAXAGE}, stale-while-revalidate=300`,

  /** 404：短暂缓存一下挡住爬虫的反复请求，又不至于长期钉死 */
  notFound: 'public, max-age=0, s-maxage=60',

  /** 公开只读接口 */
  api: `public, max-age=30, s-maxage=${API_S_MAXAGE}, stale-while-revalidate=600`,

  /**
   * 平台 BIOS 映射（/api/platform-bios）。一行数据，但**配错或读到旧的，街机就整个起不来**。
   *
   * 不能跟 api 那档共用：s-maxage=300 + swr=600 意味着后台改完绑定，
   * 最多 15 分钟里前台还在拿旧的（常见是绑之前那个空 `{}`）。而后台的 PUT 只调
   * invalidateContent()，清的是**本进程内**的内容缓存，够不着 Cloudflare 的边缘。
   * 表现就是「后台明明配好了，游戏还是报缺 BIOS」—— 查起来非常费劲，
   * 因为刷新、清浏览器缓存都没用，得等边缘自己过期。
   *
   * 一行 JSON 而已，不值得为它省这点回源。
   */
  bios: 'public, max-age=30, s-maxage=30, stale-while-revalidate=60',

  /** 任何跟身份有关、或者实时性要求高的东西 */
  none: 'no-store',
}

/** express.static 的 setHeaders：按路径决定缓存多久 */
/**
 * 模拟器运行页不是搜索落地页。真正应被收录的是带游戏资料、封面、说明和结构化数据的
 * `/games/:slug`；这些 HTML 只是 iframe / 独立运行时的启动壳。
 *
 * 不把规则散落进每个第三方 index.html：PPSSPP、Dolphin 和网页游戏升级时会整批覆盖
 * 上游文件，漏掉一份就又会产生一个 200 的重复页。响应头对 HTML 比 `<meta>` 优先，
 * 也同时覆盖历史版本目录和带查询串的访问。
 */
export function isRuntimeHtmlShell(filePath) {
  const p = String(filePath || '').replace(/\\/g, '/')
  if (!/\.html?$/i.test(p)) return false
  return /\/(?:web|ppsspp|dolphin|j2me)\//i.test(p)
}

/** 请求 URL 带非空的 `v` 查询参数（express.static 的 setHeaders 只给文件路径，URL 要从 res.req 取） */
function isVersionedRequest(res) {
  const url = res?.req?.originalUrl ?? res?.req?.url
  if (typeof url !== 'string') return false
  const q = url.indexOf('?')
  if (q < 0) return false
  return Boolean(new URLSearchParams(url.slice(q + 1)).get('v'))
}

export function staticCacheHeaders(res, filePath) {
  const p = filePath.replace(/\\/g, '/')
  const set = (v) => res.setHeader('Cache-Control', v)

  /*
    不该被收录的静态 HTML：`__*.html` 是本地复现用的调试页（标题是中文调试说明），
    flash-frame.html 是播放器 iframe 的空壳。express.static 直接回 200、没有 robots 信号，
    爬虫顺着任何外链就能把它们当正常页面收录。
  */
  if (isRuntimeHtmlShell(p) || /\/(?:__[^/]*|flash-frame)\.html$/i.test(p)) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow')
  }

  // /play-local 是跨源隔离文档，它内嵌这个同源页时，子文档也必须声明
  // COEP。否则 Chromium 不报 SWF 错误，而是直接把 iframe 换成 chrome-error 黑屏。
  if (p.endsWith('/flash-frame.html')) {
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  }

  // pthread Worker 必须自己声明 COEP；只有顶层 /linux 声明会让 Worker 在加载时失败，
  // QEMU 就永远卡在 Emscripten 的 loading-workers 依赖上，画面一片黑且不报错。
  if (p.endsWith('/qemu-wasm/qemu-system-x86_64.worker.js')) {
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
  }
  // Play.js 同时是主线程 ES module 和 pthread Worker 入口；官方部署也给它发这两项。
  if (p.endsWith('/play/Play.js')) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  }
  // wasm-dolphin 的页面、Worker 和 WASM 都在隔离页里加载；任一层少 COEP 都会白屏。
  if (p.includes('/dolphin/')) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    return set(CACHE.engineVersioned)
  }
  // PPSSPP 同样是 pthread 构建；页面、胶水、Worker、WASM、data 必须处在同一个隔离上下文。
  if (p.includes('/ppsspp/')) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    // index.html 只是启动入口，不是内容寻址产物。若某次部署中浏览器先缓存到缺文件时的
    // 回退响应，immutable 会让 iframe 长期显示 ERR_BLOCKED_BY_RESPONSE；核心二进制仍可
    // 长缓存，只有这不足 2KB 的外壳每次重新校验。
    if (/\/ppsspp\/[^/]+\/v\d+\/index\.html$/i.test(p)) return set(CACHE.engine)
    return set(CACHE.engineVersioned)
  }

  /*
    自托管的网页游戏（`public/web/<名字>/`）：js / wasm 的文件名不带哈希，
    所以走「固定 URL 的引擎」那档，而不是永久缓存 —— 换一版 PvZ 是**覆盖同名文件**，
    边缘留旧副本会让线上和构建验收变成两套代码（和上面 EmulatorJS 那条同理）。
  */
  /*
    Terraria 的运行时文件（本地放一份时才走这里，线上通常由 server/src/terraria.js
    从对象存储转发）。文件名里带内容哈希（`terraria.<hash>.dll`、`dotnet.native.<hash>.wasm`），
    可以长期缓存；只有 `dotnet.js` 与 `blazor.boot.json` 这两个「入口」不带哈希，
    必须短缓存 —— 否则换了构建，边缘还在指着上一版的哈希文件。
    这套策略与代理那条路保持一致，别只改一边。
  */
  if (p.includes('/web/terraria/_framework/')) {
    const file = p.slice(p.lastIndexOf('/') + 1)
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    // pthread Worker 入口要自己声明 COEP，同上面 qemu 那条。
    // ⚠️ 名字是 `dotnet.native.worker.<hash>.mjs`，哈希在中间，别写成 endsWith('.worker.mjs')。
    if (file.includes('.worker.')) res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    // ⚠️ `blazor.boot.json` 虽然后缀是 json，但它是「清单」不是内容寻址的产物。
    return set(file === 'dotnet.js' || file === 'blazor.boot.json' ? CACHE.engine : CACHE.immutable)
  }
  // express.static 传进来的是绝对文件路径（例如
  // `/var/www/8bitgo/dist/client/web/PvZ/...`），不是 URL pathname。这里若用
  // startsWith('/web/') 会永远落到默认的 1 小时 stale 窗口：网页游戏发版后可能把新
  // index.html 与旧 wasm / js 混用。前面的 Terraria 分支已先截住其内容寻址文件。
  if (p.includes('/web/')) return set(CACHE.engine)
  if (p.includes('/assets/')) return set(CACHE.immutable)
  if (p.includes('/fonts/')) return set(CACHE.font)
  if (/\/(?:ruffle|jsdos)\/v[^/]+\//.test(p)) return set(CACHE.engineVersioned)
  /*
    EmulatorJS 的文件名不带哈希，但播放器交给引擎的入口、样式、核心与核心报告全部经
    EJS_paths 带上 `?v=<EJS_RUNTIME_GENERATION>`（src/emulator/paths.ts），换代就换 URL。
    这些带版本的请求可以长期缓存：以前一律 max-age=300，玩家隔几分钟再开同一款游戏，
    loader → emulator.min.js → css → 核心报告 → 核心 HEAD 每一步都要回源校验一次，
    串行叠成近一秒；引擎的 IndexedDB 核心缓存也按这个 max-age 记过期时间。
    不带 ?v 的（引擎自己拼的 compression/*.js、localization/*.json）仍走短缓存。
  */
  if (p.includes('/emulatorjs/') && isVersionedRequest(res)) return set(CACHE.engineVersioned)
  if (p.includes('/ruffle/') || p.includes('/emulatorjs/') || p.includes('/j2me/') || p.includes('/jsdos/') || p.includes('/webretro/') || p.includes('/qemu-wasm/') || p.includes('/play/')) return set(CACHE.engine)
  if (/\.(png|jpg|jpeg|gif|webp|avif|svg|ico)$/i.test(p)) return set(CACHE.image)
  // ads.txt 跟 robots / sitemap 一样属于「构建时生成、但要能被外部频繁核对」的元文件，
  // 走兜底那档 s-maxage=3600 会让广告主和爬虫拿着边缘缓存里的旧版本看半天。
  if (/\/(robots\.txt|ads\.txt|sitemap[^/]*\.xml)$/i.test(p)) return set(CACHE.meta)
  // 兜底：短缓存 + 允许边缘复用，总好过每次都回源
  set('public, max-age=300, s-maxage=3600, stale-while-revalidate=3600')
}

/**
 * /api 的默认策略：一律不缓存。
 * 公开只读的接口再自己调 publicApi() 覆盖掉 —— 默认安全，漏配只会少一层缓存，
 * 而不会把某个用户的资料发给下一个人。
 */
export function noStore(_req, res, next) {
  res.setHeader('Cache-Control', CACHE.none)
  next()
}

/**
 * 公开只读接口：可以被浏览器和边缘缓存一小会儿。
 * 个别接口对「拿到旧的」特别敏感，传第二个参数换一档更短的（见 CACHE.bios）。
 */
export function publicApi(res, policy = CACHE.api) {
  res.setHeader('Cache-Control', policy)
  res.setHeader('Vary', 'Accept-Encoding')
}
