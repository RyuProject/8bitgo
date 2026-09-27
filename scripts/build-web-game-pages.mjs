/*
 * 把六款网页游戏分别打成六个 Cloudflare Pages 直接上传目录。
 *
 * Minecraft 的合法自建客户端按版权规则不进 Git，因此这里从 operator 当前机器复制；
 * 这也是这些项目不能交给 Cloudflare Git 自动构建、而要本地 Direct Upload 的原因。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WEB_GAME_PAGES, webGamePage } from '../deploy/cloudflare-pages/web-games-config.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const outputRoot = resolve(repo, '.cloudflare-pages')
const names = process.argv.slice(2).filter((value) => !value.startsWith('-'))
const selected = names.length ? names : Object.keys(WEB_GAME_PAGES)
const maxFileBytes = 25 * 1024 * 1024
const maxFiles = 20_000

for (const name of selected) {
  if (!webGamePage(name)) throw new Error(`未知 Pages 游戏：${name}`)
}

const walk = (root) => {
  const files = []
  const visit = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, item.name)
      if (item.isDirectory()) visit(path)
      else if (item.isFile()) files.push(path)
    }
  }
  visit(root)
  return files
}

function injectRuntimeBridge(path, selector) {
  let html = readFileSync(path, 'utf8')
  if (html.includes('/html5-api/8bitgo-runtime-bridge.js')) return
  const attribute = selector
    ? ` data-ready-selector=${JSON.stringify(selector)}`
    : ''
  const script = `<script src="/html5-api/8bitgo-runtime-bridge.js"${attribute}></script>`
  if (!/<\/body>/i.test(html)) throw new Error(`${path} 没有 </body>，无法安全注入运行桥`)
  html = html.replace(/<\/body>/i, `${script}</body>`)
  writeFileSync(path, html)
}

/**
 * 主站版本只放行 8bitgo.com；Pages 的固定项目域名也属于本站管理，但不能把白名单放宽到
 * 任意 pages.dev。只在生成 PvZ 独立包时加入这一个精确主机，源站副本继续保持原规则。
 */
function allowPvzPagesHost(path) {
  let html = readFileSync(path, 'utf8')
  const before = "h.endsWith('.8bitgo.com')||local"
  const after = "h.endsWith('.8bitgo.com')||h==='8bitgo-pvz.pages.dev'||local"
  const hits = html.split(before).length - 1
  if (hits !== 1) throw new Error(`${path} 的 PvZ 来源保护出现 ${hits} 次，期望 1 次`)
  html = html.replace(before, after)
  writeFileSync(path, html)
}

function rootPage(config) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${config.title} · 8BitGo</title></head>
<body><p><a href="${config.entry}">进入 ${config.title}</a></p></body></html>\n`
}

mkdirSync(outputRoot, { recursive: true })
const workerTemplate = readFileSync(resolve(repo, 'deploy/cloudflare-pages/web-game-worker.js'), 'utf8')
const bridgeSource = resolve(repo, 'public/html5-api/8bitgo-runtime-bridge.js')

for (const name of selected) {
  const config = WEB_GAME_PAGES[name]
  const source = resolve(repo, 'public/web', config.sourceDir)
  const output = resolve(outputRoot, name)
  if (!existsSync(source)) throw new Error(`${name} 源目录不存在：${source}`)
  if (name === 'minecraft' && !existsSync(resolve(source, 'eaglercraft/classes.js'))) {
    throw new Error('Minecraft Pages 包缺少 operator 自建客户端；先运行 npm run minecraft:fetch')
  }

  rmSync(output, { recursive: true, force: true })
  mkdirSync(resolve(output, 'web'), { recursive: true })
  cpSync(source, resolve(output, 'web', config.sourceDir), {
    recursive: true,
    filter: (path) => {
      const rel = relative(source, path).replaceAll('\\', '/')
      return !rel.split('/').includes('_framework') && !rel.endsWith('.DS_Store')
    },
  })
  mkdirSync(resolve(output, 'html5-api'), { recursive: true })
  cpSync(bridgeSource, resolve(output, 'html5-api/8bitgo-runtime-bridge.js'))

  for (const [file, selector] of config.html) {
    const path = resolve(output, 'web', config.sourceDir, file)
    if (!existsSync(path)) throw new Error(`${name} 缺少要注入运行桥的入口：${file}`)
    if (name === 'pvz') allowPvzPagesHost(path)
    injectRuntimeBridge(path, selector)
  }

  const workerConfig = JSON.stringify({
    name,
    entry: config.entry,
    runtime: config.runtime,
    isolated: config.isolated,
  })
  writeFileSync(resolve(output, '_worker.js'), workerTemplate.replace('/*__GAME_CONFIG__*/ null', workerConfig))
  writeFileSync(resolve(output, 'index.html'), rootPage(config))
  writeFileSync(resolve(output, '.8bitgo-pages.json'), JSON.stringify({
    format: '8bitgo.cloudflare-pages.web-game.v1',
    name,
    project: config.project,
    domain: config.domain,
    entry: config.entry,
  }, null, 2) + '\n')

  const files = walk(output)
  if (files.length > maxFiles) throw new Error(`${name} 有 ${files.length} 个文件，超过 Pages 免费版 ${maxFiles} 个上限`)
  for (const path of files) {
    const size = statSync(path).size
    if (size > maxFileBytes) {
      throw new Error(`${name} 的 ${relative(output, path)} 为 ${size} 字节，超过 Pages 单文件 25 MiB 上限`)
    }
  }
  const bytes = files.reduce((sum, path) => sum + statSync(path).size, 0)
  console.log(`${name}: ${files.length} 个文件，${(bytes / 1024 / 1024).toFixed(1)} MiB → ${relative(repo, output)}`)
}
