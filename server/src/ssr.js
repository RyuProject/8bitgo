/**
 * 服务端渲染中间件。
 *
 * 流程：读 dist/client/index.html 当模板 -> 调 dist/server 的 render() 得到 HTML 与 head
 *      -> 把两者塞进模板 -> 连同数据一起返回。
 *
 * 没有构建产物时（还没 npm run build）会直接跳过，方便只跑 API 的场景。
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadForRoute } from './content.js'
import { CACHE } from './cache.js'

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const CLIENT_DIR = path.join(root, 'dist/client')
const TEMPLATE = path.join(CLIENT_DIR, 'index.html')
const SERVER_ENTRY = path.join(root, 'dist/server/entry-server.js')

export function ssrAvailable() {
  return existsSync(TEMPLATE) && existsSync(SERVER_ENTRY)
}

let renderFn = null
async function getRender() {
  if (!renderFn) {
    const mod = await import(path.toNamespacedPath(SERVER_ENTRY))
    renderFn = mod.render
  }
  return renderFn
}

// 模板缓存。按 mtime 判断是否需要重读：
// 重新 npm run build 之后 index.html 里的资源哈希会变，如果这里一直用启动时读到的旧内容，
// 页面会去请求已经被删掉的 assets/xxx.js，浏览器只拿到 HTML，白屏且报 MIME 错误。
// 加这一下，构建完不重启 node 也不会挂。
let template = null
let templateMtime = 0
function getTemplate() {
  let mtime = 0
  try {
    mtime = statSync(TEMPLATE).mtimeMs
  } catch {
    /* 读不到就用缓存 */
  }
  if (template === null || mtime !== templateMtime) {
    template = readFileSync(TEMPLATE, 'utf8')
    templateMtime = mtime
  }
  return template
}

/** 防止数据里的 </script> 提前结束脚本块 */
function safeJson(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c')
}

/**
 * HTML 文本转义。<title> 里的内容会被浏览器当普通文本解析，但只要出现 </title>
 * 就会提前闭合标签，后面的东西按 HTML 解析 —— 页面标题里带搜索关键词时，
 * 一条 /games?q=</title><script>… 的链接就能在本站域名下执行脚本。
 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * String.prototype.replace 的**替换串**里，$& / $` / $' / $$ 是有特殊含义的模式。
 * 我们要塞进模板的是渲染结果和 JSON 数据，里面完全可能出现这些字符
 * （文章正文里的 shell 片段、搜索关键词……），一旦被当成模式解释，
 * 整个页面会被复制/撕碎。用函数形式的替换值就不会走模式解析。
 */
function injectOnce(page, marker, value) {
  return page.replace(marker, () => value)
}

/**
 * 后台路径（/admin、/en/admin …）不做服务端渲染。
 *
 * 理由有三：
 *  1. SSR 注入的是前台数据（hidden=0 / published=1），后台需要看全量，预渲染反而误导；
 *  2. 后台是 noindex 的，预渲染没有 SEO 收益；
 *  3. 是否解锁取决于 sessionStorage，服务端拿不到，渲染出来必然与客户端不一致。
 * 直接返回空壳模板，让浏览器自己渲染。
 */
const LANG_SEG = new Set(['zh-Hans', 'zh-Hant', 'en', 'es', 'fr', 'it', 'de', 'ja'])

/** 剥掉语言前缀：/en/games -> /games */
function stripLang(pathname) {
  const parts = pathname.split('?')[0].split('/').filter(Boolean)
  if (parts[0] && LANG_SEG.has(parts[0])) parts.shift()
  return '/' + parts.join('/')
}

function isAdminPath(pathname) {
  return stripLang(pathname).split('/')[1] === 'admin'
}

/**
 * 第三方登录回调（/auth/…）不进缓存。
 *
 * 页面本身是空壳（登录全在浏览器里做），但 URL 上挂着一次性的授权 code，
 * 而边缘缓存是按完整 URL 分条目的 —— 按 CACHE.page 发出去，等于每个人登录一次
 * 就在 Cloudflare 上留一条永远不会再被命中的缓存。
 */
function isNoStorePath(pathname) {
  return stripLang(pathname).split('/')[1] === 'auth'
}

export async function renderPage(req, res, next) {
  try {
    if (isAdminPath(req.path)) {
      return res
        .status(200)
        .set({
          'Content-Type': 'text/html; charset=utf-8',
          'X-Robots-Tag': 'noindex, nofollow',
          'Cache-Control': CACHE.none,
        })
        .end(getTemplate())
    }

    const render = await getRender()
    const url = req.originalUrl
    // v2：按路由取数，只把这个页面要渲染的那部分注入 HTML。
    // v1 是把整个游戏库塞进每一个页面 —— 上千款游戏时首屏体积会失控。
    const [pathname, qs] = url.split('?')
    const data = await loadForRoute(stripLang(pathname), new URLSearchParams(qs ?? ''))

    const { html, head, lang, notFound } = await render({ url, data })

    let page = getTemplate()

    // <html lang> 跟随当前语言
    page = page.replace(/<html([^>]*)\slang="[^"]*"/, `<html$1 lang="${lang}"`)

    // 用本页真实的 head 覆盖模板里的默认值：
    // 先删掉模板里会重复的那几项，再插入渲染出来的标签。
    // 按 data-ssr-default 标记删除模板里的默认标签。
    // 以前是按属性名逐个匹配（name="description" 之类），但模板里那两个标签是多行写的，
    // [^>]* 匹配不到跨行内容 —— 结果每个页面都留着模板里的中文 description，
    // 加上本页的就是两份，搜索引擎取第一份，8 种语言的摘要全是中文。
    // 现在改成认标记，并要求模板里这些标签写在一行内（index.html 里有注释说明）。
    page = page
      .replace(/<title>[\s\S]*?<\/title>/, '')
      .replace(/<meta\b[^>]*\bdata-ssr-default\b[^>]*>/g, '')

    const headHtml = `<title>${escapeHtml(head.title)}</title>\n${head.tags.join('\n')}`
    page = injectOnce(page, '</head>', `${headHtml}\n</head>`)

    // 首屏 HTML + 给客户端 hydrate 用的数据
    const bootstrap = `<script>window.__8BITGO__=${safeJson({ data, lang })}</script>`
    page = injectOnce(page, '<div id="root"></div>', `<div id="root">${html}</div>\n${bootstrap}`)

    // 渲染出「页面不存在」时回 404：一律 200 会让爬虫把不存在的 URL 当正常页面收录
    // 页面是匿名的（登录态在客户端 localStorage 里，SSR 不碰用户数据），
    // 所以可以放心让 Cloudflare 缓存。后台改完内容想立刻生效就清一次 Cloudflare 缓存。
    res
      .status(notFound ? 404 : 200)
      .set({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': notFound ? CACHE.notFound : isNoStorePath(req.path) ? CACHE.none : CACHE.page,
        Vary: 'Accept-Encoding',
      })
      .end(page)
  } catch (e) {
    console.error('[ssr] 渲染失败，退回纯客户端渲染：', e)
    // SSR 挂了不能让站点打不开：返回不带首屏内容的模板，浏览器自己渲染
    try {
      // 这是降级返回的空壳，一旦被边缘缓存住，故障恢复后用户还会拿到没有首屏的页面
      res.status(200).set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': CACHE.none }).end(getTemplate())
    } catch {
      next(e)
    }
  }
}

export { CLIENT_DIR }
