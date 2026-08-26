/**
 * 服务端渲染中间件。
 *
 * 流程：读 dist/client/index.html 当模板 -> 调 dist/server 的 render() 得到 HTML 与 head
 *      -> 把两者塞进模板 -> 连同数据一起返回。
 *
 * 没有构建产物时（还没 npm run build）会直接跳过，方便只跑 API 的场景。
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getContent } from './content.js'

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

// 模板只在启动时读一次（生产环境不会变）
let template = null
function getTemplate() {
  if (template === null) template = readFileSync(TEMPLATE, 'utf8')
  return template
}

/** 防止数据里的 </script> 提前结束脚本块 */
function safeJson(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c')
}

export async function renderPage(req, res, next) {
  try {
    const render = await getRender()
    const { games, posts } = await getContent()
    const url = req.originalUrl

    const { html, head, lang, status = 200 } = render({ url, games, posts })

    let page = getTemplate()

    // <html lang> 跟随当前语言
    page = page.replace(/<html([^>]*)\slang="[^"]*"/, `<html$1 lang="${lang}"`)

    // 用本页真实的 head 覆盖模板里的默认值：
    // 先删掉模板里会重复的那几项，再插入渲染出来的标签。
    page = page
      .replace(/<title>[\s\S]*?<\/title>/, '')
      .replace(/<meta name="description"[^>]*>/g, '')
      .replace(/<meta name="robots"[^>]*>/g, '')
      .replace(/<meta property="og:[^"]*"[^>]*>/g, '')
      .replace(/<meta name="twitter:[^"]*"[^>]*>/g, '')

    const headHtml = `<title>${head.title}</title>\n${head.tags.join('\n')}`
    page = page.replace('</head>', `${headHtml}\n</head>`)

    // 首屏 HTML + 给客户端 hydrate 用的数据
    const bootstrap = `<script>window.__8BITGO__=${safeJson({ games, posts, lang })}</script>`
    page = page.replace('<div id="root"></div>', `<div id="root">${html}</div>\n${bootstrap}`)

    // 不存在的页面要回真正的 404，不能一律 200（软 404 会被搜索引擎降权）
    res.status(status).set({ 'Content-Type': 'text/html; charset=utf-8' }).end(page)
  } catch (e) {
    console.error('[ssr] 渲染失败，退回纯客户端渲染：', e)
    // SSR 挂了不能让站点打不开：返回不带首屏内容的模板，浏览器自己渲染
    try {
      res.status(200).set({ 'Content-Type': 'text/html; charset=utf-8' }).end(getTemplate())
    } catch {
      next(e)
    }
  }
}

export { CLIENT_DIR }
