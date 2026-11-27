import { readFileSync } from 'node:fs'
import path from 'node:path'

const LANGUAGES = new Set(['zh-Hant', 'en', 'es', 'fr', 'it', 'de', 'ja'])
const manifestCache = new Map()

function entryChunk(template) {
  const tags = String(template ?? '').match(/<script\b[^>]*>/gi) ?? []
  const tag = tags.find((candidate) => /\btype="module"/i.test(candidate))
  const src = tag && /\bsrc="([^"]+)"/i.exec(tag)?.[1]
  if (!src) return ''
  let pathname = src
  try {
    pathname = new URL(src, 'https://8bitgo.invalid').pathname
  } catch {
    return ''
  }
  const name = path.posix.basename(pathname)
  return /^index-[A-Za-z0-9_-]+\.js$/.test(name) ? name : ''
}

/**
 * SSR HTML 已经带着目标语言的正文，但 entry-client 会等动态语言包下载后才 hydrate。
 * 把同一份构建的语言 chunk 放进 HTML head，让浏览器和入口 / React 并行下载；不额外复制文案，
 * 弱网下少一个「入口执行后才发起」的 RTT。旧构建没有清单时返回空串，保留原来的动态加载路径。
 */
export function localePreloadTag(template, lang, clientDir) {
  if (!LANGUAGES.has(lang)) return ''
  const entry = entryChunk(template)
  const match = /^index-([A-Za-z0-9_-]+)\.js$/.exec(entry)
  if (!match) return ''

  const manifestPath = path.join(clientDir, 'assets', `integrity-${match[1]}.json`)
  let manifest = manifestCache.get(manifestPath)
  if (!manifest) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (parsed?.v !== 2 || parsed?.alg !== 'sha256' || parsed?.entry !== entry) return ''
      manifest = parsed
      manifestCache.set(manifestPath, manifest)
      // 部署会不断产生新的内容哈希；旧构建清单不能随进程寿命一直累积。
      while (manifestCache.size > 8) manifestCache.delete(manifestCache.keys().next().value)
    } catch {
      // 构建窗口里清单可能还没落盘；不缓存缺失，下一次请求能自行恢复。
      return ''
    }
  }

  const asset = manifest.locales?.[lang]
  if (typeof asset !== 'string' || !/^assets\/[A-Za-z0-9_.-]+\.js$/.test(asset)) return ''
  return `<link rel="modulepreload" crossorigin data-8bitgo-locale-preload="true" href="/${asset}">`
}
