/*
 * 把独立网页游戏分别打成各自的 Cloudflare Pages 直接上传目录。
 *
 * Minecraft 的合法自建客户端按版权规则不进 Git，因此这里从 operator 当前机器复制；
 * 这也是这些项目不能交给 Cloudflare Git 自动构建、而要本地 Direct Upload 的原因。
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WEB_GAME_PAGES, webGamePage } from '../deploy/cloudflare-pages/web-games-config.js'
import { copyGtaVc7zRuntime } from './copy-gta-vc-7z.mjs'
import { buildGameSdk } from './build-8bitgo-game-sdk.mjs'
import { patchGamblersTableRuntime } from './patch-gamblers-table.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const outputRoot = resolve(repo, '.cloudflare-pages')
const bridgeSource = resolve(repo, 'public/html5-api/8bitgo-runtime-bridge.js')
const mediaBridgeSource = resolve(repo, 'public/html5-api/8bitgo-media-bridge.js')
const gameSdkMinSource = resolve(repo, 'public/html5-api/8bitgo-game-sdk.min.js')
const bridgeVersion = createHash('sha256').update(readFileSync(bridgeSource)).digest('hex').slice(0, 16)
const mediaBridgeVersion = createHash('sha256').update(readFileSync(mediaBridgeSource)).digest('hex').slice(0, 16)
const names = process.argv.slice(2).filter((value) => !value.startsWith('-'))
const selected = names.length ? names : Object.keys(WEB_GAME_PAGES)
const maxFileBytes = 25 * 1024 * 1024
const maxFiles = 20_000
buildGameSdk()
const gameSdkVersion = createHash('sha256').update(readFileSync(gameSdkMinSource)).digest('hex').slice(0, 16)

for (const name of selected) {
  if (!webGamePage(name)) throw new Error(`未知 Pages 游戏：${name}`)
}
if (selected.includes('gamblers-table')) patchGamblersTableRuntime()

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
  const bridgeUrl = `/html5-api/8bitgo-runtime-bridge.js?v=${bridgeVersion}`
  const existingScript = /<script\b[^>]*\ssrc=(["'])[^"']*html5-api\/8bitgo-runtime-bridge\.js(?:\?[^"']*)?\1[^>]*>/i
  const match = html.match(existingScript)
  const escapeAttribute = (value) => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
  const readyAttribute = selector ? ` data-ready-selector="${escapeAttribute(selector)}"` : ''
  if (match) {
    let tag = match[0].replace(/\ssrc=(["'])[^"']*html5-api\/8bitgo-runtime-bridge\.js(?:\?[^"']*)?\1/i, ` src="${bridgeUrl}"`)
    if (selector) {
      const currentAttribute = /\sdata-ready-selector=(["']).*?\1/i
      tag = currentAttribute.test(tag)
        ? tag.replace(currentAttribute, readyAttribute)
        : tag.replace(/>$/, `${readyAttribute}>`)
    }
    html = html.replace(match[0], tag)
    writeFileSync(path, html)
    return
  }
  const script = `<script src="${bridgeUrl}"${readyAttribute}></script>`
  if (!/<\/body>/i.test(html)) throw new Error(`${path} 没有 </body>，无法安全注入运行桥`)
  html = html.replace(/<\/body>/i, `${script}</body>`)
  writeFileSync(path, html)
}

/** 只给明确支持直播的 Pages 游戏主动接入 SDK；其它游戏仍由各自页面决定是否启用。 */
function injectGameSdk(path, selector, runtimeScriptPattern) {
  let html = readFileSync(path, 'utf8')
  const script = `<script src="/html5-api/8bitgo-game-sdk.min.js?v=${gameSdkVersion}" data-canvas-selector="${selector}"></script>`
  const mediaScript = `<script src="/html5-api/8bitgo-media-bridge.js?v=${mediaBridgeVersion}"></script>`
  const existingScript = /<script\b[^>]*\ssrc=(['"])[^'"]*html5-api\/8bitgo-game-sdk\.min\.js(?:\?[^'"]*)?\1[^>]*><\/script>/i
  const existingMediaScript = /<script\b[^>]*\ssrc=(['"])[^'"]*html5-api\/8bitgo-media-bridge\.js(?:\?[^'"]*)?\1[^>]*><\/script>/i
  if (existingScript.test(html)) html = html.replace(existingScript, script)
  else {
    if (!/<\/body>/i.test(html)) throw new Error(`${path} 没有 </body>，无法安全接入 8BitGo 游戏 SDK`)
    html = html.replace(/<\/body>/i, `${script}</body>`)
  }
  if (existingMediaScript.test(html)) html = html.replace(existingMediaScript, mediaScript)
  else {
    const runtimeScript = runtimeScriptPattern && html.match(runtimeScriptPattern)
    if (runtimeScript) html = html.replace(runtimeScript[0], `${mediaScript}\n${runtimeScript[0]}`)
    else {
      if (!/<\/head>/i.test(html)) throw new Error(`${path} 没有 </head>，无法在游戏音频初始化前安装媒体桥`)
      html = html.replace(/<\/head>/i, `${mediaScript}</head>`)
    }
  }
  writeFileSync(path, html)
}

function injectPvzGameSdk(path) {
  injectGameSdk(path, 'body.game-mode canvas#canvas', /<script\b[^>]*\bsrc=(['"])[^'"]*pvz-wasm-loader\.js(?:\?[^'"]*)?\1[^>]*>/i)
}

function injectMinecraftGameSdk(path) {
  // Eaglercraft 在 classes.js 初始化时创建 WebAudio；媒体桥必须先于它安装。
  injectGameSdk(path, 'body#game_frame canvas', /<script\b[^>]*\bsrc=(['"])[^'"]*classes\.js(?:\?[^'"]*)?\1[^>]*>/i)
}

function injectCs16GameSdk(path) {
  // Xash 在模块脚本执行时创建 WebGL 与 WebAudio；媒体桥要先于引擎，SDK 则绑定唯一游戏画布。
  injectGameSdk(path, '#canvas', /<script\b[^>]*\bsrc=(['"])[^'"]*cs16\.bundle\.js(?:\?[^'"]*)?\1[^>]*>/i)
}

function versionSubwaySdk(htmlPath, bootstrapPath) {
  let html = readFileSync(htmlPath, 'utf8')
  const mediaUrl = `/html5-api/8bitgo-media-bridge.js?v=${mediaBridgeVersion}`
  const mediaScript = '<script src="/html5-api/8bitgo-media-bridge.js"></script>'
  if (html.split(mediaScript).length !== 2) throw new Error(`${htmlPath} 的 8BitGo 媒体桥标签数量不正确`)
  html = html.replace(mediaScript, `<script src="${mediaUrl}"></script>`)
  writeFileSync(htmlPath, html)

  let bootstrap = readFileSync(bootstrapPath, 'utf8')
  const sdkUrl = "var sdkUrl = '/html5-api/8bitgo-game-sdk.min.js';"
  const versionedSdkUrl = `var sdkUrl = '/html5-api/8bitgo-game-sdk.min.js?v=${gameSdkVersion}';`
  if (bootstrap.split(sdkUrl).length !== 2) throw new Error(`${bootstrapPath} 的 8BitGo SDK 地址数量不正确`)
  bootstrap = bootstrap.replace(sdkUrl, versionedSdkUrl)
  writeFileSync(bootstrapPath, bootstrap)
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

/**
 * PvZ 大资源统一从 download.8bitgo.com 获取。Pages 包仍走同源 Worker，以保留 Range / ETag
 * 转发能力；Worker 的上游也指向下载域，源站副本则由页面直接请求下载域。
 */
function usePvzPagesDataProxy(path) {
  let html = readFileSync(path, 'utf8')
  const before = "window.PVZ_DATA_BASE='https://download.8bitgo.com/PvZ/properties/';"
  // 加载器会把它作为 new URL(relative, base) 的 base，必须给出绝对 URL，不能只写根相对路径。
  const after = "window.PVZ_DATA_BASE=location.origin+'/pvz-data/';"
  const hits = html.split(before).length - 1
  if (hits !== 1) throw new Error(`${path} 的 PvZ 数据基址出现 ${hits} 次，期望 1 次`)
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
      const segments = rel.split('/')
      return !segments.includes('_framework') &&
        !(config.excludeDirs || []).some((name) => segments.includes(name)) &&
        !rel.endsWith('.DS_Store')
    },
  })
  if (name === 'gtavc') {
    copyGtaVc7zRuntime(resolve(output, 'web', 'gta-vc', 'vendor', 'un7z-opfs'))
  }
  mkdirSync(resolve(output, 'html5-api'), { recursive: true })
  cpSync(bridgeSource, resolve(output, 'html5-api/8bitgo-runtime-bridge.js'))
  cpSync(resolve(repo, 'public/html5-api/8bitgo-game-sdk.min.js'), resolve(output, 'html5-api/8bitgo-game-sdk.min.js'))
  cpSync(mediaBridgeSource, resolve(output, 'html5-api/8bitgo-media-bridge.js'))

  for (const [file, selector] of config.html) {
    const path = resolve(output, 'web', config.sourceDir, file)
    if (!existsSync(path)) throw new Error(`${name} 缺少要注入运行桥的入口：${file}`)
    if (name === 'pvz') {
      allowPvzPagesHost(path)
      if (file === 'cn/index.html' || file === 'en/index.html') usePvzPagesDataProxy(path)
    }
    injectRuntimeBridge(path, selector)
    if (name === 'pvz' && (file === 'cn/index.html' || file === 'en/index.html')) injectPvzGameSdk(path)
    if (name === 'gamblers-table' && file === 'index.html') injectGameSdk(path, '#canvas', /<script\b[^>]*\bsrc=(['"])[^'"]*index\.js(?:\?[^'"]*)?\1[^>]*>/i)
    if (name === 'minecraft' && file === 'eaglercraft/index.html') injectMinecraftGameSdk(path)
    if (name === 'cs16' && file === 'index.html') injectCs16GameSdk(path)
    if (name === 'subway' && file === 'index.html') {
      versionSubwaySdk(path, resolve(output, 'web', config.sourceDir, 'js/8bitgo.js'))
    }
  }

  const workerConfig = JSON.stringify({
    name,
    entry: config.entry,
    runtime: config.runtime,
    isolated: config.isolated,
    apiOrigin: config.apiOrigin || '',
    r2ArchiveKey: config.r2ArchiveKey || '',
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
