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
export function staticCacheHeaders(res, filePath) {
  const p = filePath.replace(/\\/g, '/')
  const set = (v) => res.setHeader('Cache-Control', v)

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
  if (p.startsWith('/web/')) return set(CACHE.engine)
  if (p.includes('/assets/')) return set(CACHE.immutable)
  if (p.includes('/fonts/')) return set(CACHE.font)
  if (/\/(?:ruffle|jsdos)\/v[^/]+\//.test(p)) return set(CACHE.engineVersioned)
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
