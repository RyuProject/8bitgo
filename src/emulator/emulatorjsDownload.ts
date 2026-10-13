import type { LoadPhase } from './types'

/**
 * 引擎下载按用途分类。独立成纯函数，是为了把“核心 404 不能回落坏 CDN”写进 Node 回归测试，
 * 而不用在测试里加载整份依赖浏览器环境的 EmulatorJS 适配器。
 */
export function emulatorJsDownloadPhase(url: string, gameUrl = ''): LoadPhase {
  if (url && gameUrl && url.startsWith(gameUrl)) return 'rom'
  if (/\/cores\/|-wasm\.data/.test(url)) return 'engine'
  return 'assets'
}

/** ROM、BIOS 和自托管核心缺任一项都不可能可靠开局。 */
export function isCriticalEmulatorJsDownload(url: string, gameUrl = '', biosUrl = ''): boolean {
  if (!url) return false
  return emulatorJsDownloadPhase(url, gameUrl) === 'engine'
    || Boolean(gameUrl && url.startsWith(gameUrl))
    || Boolean(biosUrl && url.startsWith(biosUrl))
}
