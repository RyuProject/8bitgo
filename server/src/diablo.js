/** Diablo 的三份 WebAssembly 核心从 R2 同源流式提供，浏览器 URL 保持 webpack 生成的地址。 */
import { envNumber } from './resource-limits.js'
import { assetBaseUrl } from './site-urls.js'
import { createR2RuntimeProxy } from './r2-runtime-proxy.js'

const ASSET_BASE = assetBaseUrl()
const PREFIX = (process.env.DIABLO_ASSET_PREFIX || 'web/diablo/runtime').replace(/^\/+|\/+$/g, '')
const SAFE_CORE = /^(?:Diablo|DiabloSpawn|MpqCmp)\.[a-f0-9]{8}\.wasm$/

export function diabloCoreAsset(file) {
  if (!SAFE_CORE.test(file)) return null
  return {
    url: ASSET_BASE ? `${ASSET_BASE}/${PREFIX}/${encodeURIComponent(file)}` : '',
    contentType: 'application/wasm',
    cacheControl: 'public, max-age=31536000, s-maxage=31536000, immutable',
  }
}

export const diabloCoreProxy = createR2RuntimeProxy({
  label: 'diablo',
  resolveAsset: diabloCoreAsset,
  maxProxies: envNumber('DIABLO_PROXY_MAX', 16, { max: 128 }),
  timeoutMs: envNumber('DIABLO_PROXY_TIMEOUT_MS', 120_000, { max: 600_000 }),
})
