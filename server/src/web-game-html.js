/**
 * 源站 `/web/<名字>` 的网页游戏 HTML，补上 Pages 构建会注入的 8BitGo 脚本。
 *
 * 为什么要补（2026-11-22）：CS1.6 正式入口是 Cloudflare Pages（cs16.8bitgo.com），大陆部分线路连不上；
 * 播放器给大陆访客改嵌同一份运行时的源站副本（经 cn.8bitgo.com / EdgeOne）。Pages 构建
 * （scripts/build-web-game-pages.mjs）会往 HTML 里注入生命周期桥、媒体桥和游戏 SDK，源站副本没有：
 * 跨源嵌入时播放器收不到「可玩」信号，镜像退回逻辑也就无从确认，直播 / 截图也会消失。
 *
 * 这里在发 HTML 时按同一规则注入，URL 带文件内容的 sha256 前 16 位（与 Pages 构建一致），
 * 命中 cache.js 里 /html5-api/ 的版本化长缓存。仓库里的 index.html 保持原样，runtime.json 不受影响。
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 需要注入的游戏：就绪选择器 + 引擎脚本（媒体桥必须排在它前面，引擎初始化时就会建 WebAudio） */
export const WEB_GAME_HTML_INJECTIONS = Object.freeze({
  cs16: Object.freeze({
    readySelector: '#canvas',
    sdkCanvasSelector: '#canvas',
    runtimeScript: /<script\b[^>]*\bsrc=(['"])[^'"]*cs16\.bundle\.js(?:\?[^'"]*)?\1[^>]*>/i,
  }),
})

const escapeAttribute = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('"', '&quot;')
  .replaceAll('<', '&lt;')

/**
 * 纯函数：versions = { bridge, media, sdk }（各自的内容哈希）。
 * 已经带有这些脚本的 HTML 原样返回，避免重复注入。
 */
export function injectWebGameScripts(html, config, versions) {
  let out = String(html)
  if (!config) return out
  if (!/<\/body>/i.test(out) || !/<\/head>/i.test(out)) return out
  const hasBridge = /html5-api\/8bitgo-runtime-bridge\.js/i.test(out)
  const hasSdk = /html5-api\/8bitgo-game-sdk(?:\.min)?\.js/i.test(out)
  const hasMedia = /html5-api\/8bitgo-media-bridge\.js/i.test(out)
  if (!hasMedia) {
    const media = `<script src="/html5-api/8bitgo-media-bridge.js?v=${versions.media}"></script>`
    const runtime = config.runtimeScript && out.match(config.runtimeScript)
    out = runtime ? out.replace(runtime[0], `${media}\n${runtime[0]}`) : out.replace(/<\/head>/i, `${media}</head>`)
  }
  let tail = ''
  if (!hasSdk) {
    tail += `<script src="/html5-api/8bitgo-game-sdk.min.js?v=${versions.sdk}" data-canvas-selector="${escapeAttribute(config.sdkCanvasSelector)}"></script>`
  }
  if (!hasBridge) {
    tail += `<script src="/html5-api/8bitgo-runtime-bridge.js?v=${versions.bridge}" data-ready-selector="${escapeAttribute(config.readySelector)}"></script>`
  }
  return tail ? out.replace(/<\/body>/i, `${tail}</body>`) : out
}

function fileVersion(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
}

/**
 * 读取并注入；按 index.html 与三个脚本的 mtime+size 缓存（部署会换文件）。
 * 任一脚本缺失时返回 null，调用方照旧 sendFile 原文件（不会因为注入失败让游戏打不开）。
 */
export function createWebGameHtmlRenderer(clientDir) {
  const cache = new Map()
  const stamp = (path) => {
    const info = statSync(path)
    return `${info.mtimeMs}:${info.size}`
  }
  return function render(name) {
    const config = WEB_GAME_HTML_INJECTIONS[name]
    if (!config) return null
    try {
      const htmlPath = join(clientDir, 'web', name, 'index.html')
      const api = join(clientDir, 'html5-api')
      const paths = {
        bridge: join(api, '8bitgo-runtime-bridge.js'),
        media: join(api, '8bitgo-media-bridge.js'),
        sdk: join(api, '8bitgo-game-sdk.min.js'),
      }
      const key = [htmlPath, ...Object.values(paths)].map(stamp).join('|')
      const hit = cache.get(name)
      if (hit?.key === key) return hit.html
      const versions = {
        bridge: fileVersion(paths.bridge),
        media: fileVersion(paths.media),
        sdk: fileVersion(paths.sdk),
      }
      const html = injectWebGameScripts(readFileSync(htmlPath, 'utf8'), config, versions)
      cache.set(name, { key, html })
      return html
    } catch {
      return null
    }
  }
}
