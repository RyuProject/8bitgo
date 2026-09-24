/**
 * `/web/celeste` 的运行时供给（Webleste，celeste-wasm 一脉，与 terraria 同架构）。
 *
 * .NET 的 WebAssembly 构建，`_framework/` 共 130MiB（5 片 `dotnet.native.<hash>.wasm0..4`
 * 分片 + 204 个 dll + 3 份 ICU 数据），按仓库的规矩不进 git（对标 terraria 的 134.9MiB、
 * qemu-wasm 的 140MB），放 R2。这里只有一件事：把 `/web/celeste/_framework/<文件>`
 * 转发到对象存储。
 *
 * 结构和取舍全部沿用 `server/src/terraria.js`，三条坑也在那边写透了：
 *
 * 1. **必须注册在 `express.static` 之后**：本机把 `_framework/` 放进
 *    `public/web/celeste/`（已 gitignore）时本地文件优先命中，代理不该抢。
 * 2. **必须流式转发**：单批 wasm 每片 20MiB、一页并行取两百多个文件，整包读进内存
 *    会打爆 Node 堆。实际转发在 r2-runtime-proxy.js，全程背压。
 * 3. **`.worker.` 文件必须自己声明 COEP**：`dotnet.native.worker.<hash>.mjs` 是
 *    pthread 的 Worker 入口，不声明就加载失败、页面永远卡在启动。
 *
 * 与 terraria 的差异：入口只有 `dotnet.js` 一个（.NET 10 产物没有 blazor.boot.json，
 * 启动清单被并进 native 胶水里）；wasm 是 5 片 `.wasm0..4` 分片，由前端拼回，
 * Content-Type 落到默认的 octet-stream 即可。
 */
import { envNumber } from './resource-limits.js'
import { assetBaseUrl } from './site-urls.js'
import { createR2RuntimeProxy } from './r2-runtime-proxy.js'

const ASSET_BASE = assetBaseUrl()
const PREFIX = (process.env.CELESTE_ASSET_PREFIX || 'web/celeste/_framework').replace(/^\/+|\/+$/g, '')

/** `_framework/` 是平铺的，只允许单层名字；`..` 是合法的文件名取值，必须一起挡住。 */
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

const MAX_PROXIES = envNumber('CELESTE_PROXY_MAX', 48, { max: 512 })
const PROXY_TIMEOUT_MS = envNumber('CELESTE_PROXY_TIMEOUT_MS', 300_000, { max: 3_600_000 })

/** 运行时入口（不带内容哈希，换一版就要换名的就这一个）走短缓存，其余按内容寻址长期缓存。 */
const MUTABLE_FILES = new Set(['dotnet.js'])

const EXTRA_CACHE = {
  dll: 'public, max-age=31536000, s-maxage=31536000, immutable',
  wasm: 'public, max-age=31536000, s-maxage=31536000, immutable',
  dat: 'public, max-age=31536000, s-maxage=31536000, immutable',
  mjs: 'public, max-age=31536000, s-maxage=31536000, immutable',
  // celeste 与 terraria 的差异：_framework 里还有带内容哈希的 dotnet.native.<hash>.js /
  // dotnet.runtime.<hash>.js，同样按内容寻址长期缓存（无哈希的入口由 MUTABLE_FILES 单独钉住）
  js: 'public, max-age=31536000, s-maxage=31536000, immutable',
}

const CONTENT_TYPES = {
  wasm: 'application/wasm',
  dll: 'application/octet-stream',
  dat: 'application/octet-stream',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
}

const extensionOf = (file) => {
  const at = file.lastIndexOf('.')
  let ext = at < 0 ? '' : file.slice(at + 1).toLowerCase()
  // 上游把 wasm 切成 .wasm0..4 分片（前端拼回）；类型、缓存、预压缩全按 .wasm 处理。
  // 不归一化的后果：分片落到 1 小时缓存 + 不做 Brotli，边缘每次回源 100MB。
  ext = ext.replace(/^wasm\d$/, 'wasm')
  return ext
}

/**
 * 某个文件名对应的对象存储地址与缓存策略（纯函数，`scripts/test-celeste-web.mjs` 覆盖）。
 * 返回 null 表示名字不合法，调用方回 400。
 */
export function celesteFrameworkAsset(file) {
  if (!SAFE_FILE.test(file)) return null
  const ext = extensionOf(file)
  return {
    url: ASSET_BASE ? `${ASSET_BASE}/${PREFIX}/${encodeURIComponent(file)}` : '',
    contentType: CONTENT_TYPES[ext] || 'application/octet-stream',
    cacheControl: MUTABLE_FILES.has(file)
      ? 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600'
      : EXTRA_CACHE[ext] || 'public, max-age=3600, s-maxage=3600',
  }
}

export const celesteFrameworkProxy = createR2RuntimeProxy({
  label: 'celeste',
  resolveAsset: celesteFrameworkAsset,
  maxProxies: MAX_PROXIES,
  timeoutMs: PROXY_TIMEOUT_MS,
  extraHeaders: (file) => file.includes('.worker.')
    ? { 'Cross-Origin-Embedder-Policy': 'require-corp' }
    : {},
})
