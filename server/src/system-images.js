/**
 * Windows 客体系统镜像的同源兜底。
 *
 * 浏览器直连 assets.8bitgo.com 在部分网络会一直收不到首字节；js-dos 官方 CDN 又没有
 * Access-Control-Allow-Origin，网页即使能下载也读不到响应。这里让主站按白名单流式转发
 * 同一份 R2 对象：玩家已经能打开 8bitgo.com 时，就还有一条不依赖资源子域的可用路径。
 */
import { envNumber } from './resource-limits.js'
import { assetBaseUrl } from './site-urls.js'
import { createR2RuntimeProxy } from './r2-runtime-proxy.js'

const ASSET_BASE = assetBaseUrl()
const PREFIX = 'systems/dos'

/** 只能代理已经人工核对过的系统镜像，不能把这条路扩成任意 R2 对象代理。 */
const ALLOWED_SYSTEM_IMAGES = new Set([
  'system-dos7.1-v1.jsdos',
  'system-win311-v1.jsdos',
  'system-win95-v1.jsdos',
  'system-win98-v1.jsdos',
  // 《天之痕》使用的本地化镜像没有可信第三方副本；这里只代理 R2 上同一份对象作同源兜底。
  'Windows95_Traditional-Chinese.jsdos',
])

export function systemImageAsset(file) {
  if (!ALLOWED_SYSTEM_IMAGES.has(file)) return null
  return {
    url: ASSET_BASE ? `${ASSET_BASE}/${PREFIX}/${encodeURIComponent(file)}` : '',
    contentType: 'application/octet-stream',
    // 文件名固定，后台可能原地换镜像；边缘可抗抖，但不能像版本目录那样永久缓存。
    cacheControl: 'public, max-age=300, s-maxage=3600, stale-while-revalidate=3600',
    // `.jsdos` 已是 ZIP；再探测一份不存在的 `<文件>.br` 只会拖慢真正的兜底。
    precompressed: false,
  }
}

export const systemImageProxy = createR2RuntimeProxy({
  label: 'system-image',
  resolveAsset: systemImageAsset,
  // 只在资源子域失败时才会走这里；限制并发，避免异常流量把 Node 文件描述符耗尽。
  maxProxies: envNumber('SYSTEM_IMAGE_PROXY_MAX', 16, { max: 128 }),
  timeoutMs: envNumber('SYSTEM_IMAGE_PROXY_TIMEOUT_MS', 300_000, { max: 1_800_000 }),
})
