/**
 * 迁机后只读巡检：把「首页能打开」扩展成搜索入口、静态资源、数据库和定时任务的检查。
 *
 * 用法：node scripts/audit-migration.mjs [--server]
 * --server 在生产机上额外检查构建产物、systemd 和当前用户的 SEO cron。
 * 不读取或打印 .env 密钥，也不提交 URL 给搜索引擎。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const site = new URL(process.env.AUDIT_SITE_URL || 'https://8bitgo.com')
const canonical = (process.env.AUDIT_CANONICAL_URL || 'https://8bitgo.com').replace(/\/+$/, '')
const serverMode = process.argv.includes('--server')
let failed = 0

function report(ok, title, detail = '', fatal = true) {
  console.log(`${ok ? '✅' : fatal ? '❌' : '⚠️'} ${title}${detail ? `：${detail}` : ''}`)
  if (!ok && fatal) failed++
}

function command(name, args) {
  try { return execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() }
  catch { return '' }
}

async function get(url) {
  const target = new URL(url, site)
  // sitemap 与 HTML 都是外部内容：不让里面的 URL 带巡检器去访问内网或第三方主机。
  if (target.origin !== site.origin) throw new Error(`跨域地址：${target.origin}`)
  // 不跟随跳转：巡检本来就要发现意外 301/302，也避免外部页面引导本机访问内网。
  const response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': '8BitGo-Migration-Audit/1.0' } })
  return { response, body: await response.text() }
}

function firstLoc(xml) {
  return xml.match(/<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/i)?.[1]?.replace(/&amp;/g, '&') || ''
}

async function checkPage(name, url, inspect) {
  try {
    const result = await get(url)
    const issue = result.response.ok ? inspect(result) : `HTTP ${result.response.status}`
    report(!issue, name, issue)
    return issue ? null : result
  } catch (error) {
    report(false, name, error.message)
    return null
  }
}

const home = await checkPage('首页与 SSR', '/', ({ body, response }) => {
  if (!/<div id="root">[\s\S]+?<\/div>/.test(body)) return 'SSR 首屏内容为空'
  if (!body.includes(`<link rel="canonical" href="${canonical}/"`)) return '缺少预期的首页 canonical'
  if (/<meta[^>]+name="robots"[^>]+content="[^"]*noindex/i.test(body)) return '页面禁止收录'
  if (/noindex/i.test(response.headers.get('x-robots-tag') || '')) return '响应头禁止收录'
  return ''
})

const robots = await checkPage('robots.txt', '/robots.txt', ({ body }) => {
  if (/^Disallow:\s*\/\s*$/im.test(body)) return '全站被禁止抓取'
  if (!body.includes(`${site.origin}/sitemap.xml`)) return '缺少本站 sitemap 地址'
  return ''
})

const index = await checkPage('sitemap 索引', '/sitemap.xml', ({ body }) =>
  body.includes('<sitemapindex') && body.includes('/sitemaps/games-zh-Hans.xml') ? '' : '不是预期的动态 sitemap 索引')

const games = await checkPage('中文游戏 sitemap', '/sitemaps/games-zh-Hans.xml', ({ body }) =>
  body.includes('<urlset') && /<url>/.test(body) ? '' : '没有游戏 URL')

if (games) {
  const url = firstLoc(games.body)
  await checkPage('首个游戏详情页', url, ({ body, response }) => {
    if (!url || new URL(url).origin !== site.origin) return 'sitemap 中的 URL 不属于本站'
    if (!body.includes('<link rel="canonical"')) return '缺少 canonical'
    if (/<meta[^>]+name="robots"[^>]+content="[^"]*noindex/i.test(body)) return '页面禁止收录'
    if (/noindex/i.test(response.headers.get('x-robots-tag') || '')) return '响应头禁止收录'
    return ''
  })
}

if (home) {
  const asset = home.body.match(/<script[^>]+src="(\/assets\/[^"]+\.js)"/i)?.[1]
  if (!asset) report(false, '首屏 JS', '首页没有找到带哈希的 JS 文件')
  else await checkPage('首屏 JS', asset, ({ response }) =>
    /javascript/i.test(response.headers.get('content-type') || '') ? '' : '返回的不是 JavaScript（常见于旧 HTML 引用已删除的构建文件）')
}

await checkPage('后端与数据库', '/api/health', ({ body }) => {
  try { return JSON.parse(body).db === true ? '' : '数据库未就绪' }
  catch { return '健康检查不是 JSON' }
})

if (serverMode) {
  report(existsSync(path.join(root, 'server/.env')), '生产环境配置文件', 'server/.env')
  report(existsSync(path.join(root, 'dist/client/index.html')) && existsSync(path.join(root, 'dist/server/entry-server.js')), '前后端构建产物')
  for (const unit of ['8bitgo.service', '8bitgo-backup.timer', '8bitgo-watchdog.timer']) {
    report(command('systemctl', ['is-active', unit]) === 'active', unit, '应为 active')
  }
  const cron = command('crontab', ['-l'])
  report(cron.includes('push-daily.sh'), '每日搜索推送兜底', '当前用户的 crontab 未找到 push-daily.sh；若装在其他用户或 timer 下请另行确认', false)
}

if (!robots || !index) console.log('提示：先修复 robots/sitemap，再到 Search Console 检查抓取统计与网页索引。')
console.log(`巡检结束：${failed} 项失败`)
if (failed) process.exitCode = 1
