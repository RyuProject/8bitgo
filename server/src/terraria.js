/**
 * `/web/terraria` 的运行时供给。
 *
 * 这个页面是 .NET 的 WebAssembly 构建（Blazor + FNA），`_framework/` 有 **134.9MiB**
 * （光 `dotnet.native.<hash>.wasm` 就 100,104,513 字节，另有 103 个 dll、3 个 ICU 数据），
 * 按仓库的规矩不进 git（对标 qemu-wasm 的 140MB、cs15 的 packs），放 R2。
 *
 * 于是这里只有一件事：把 `/web/terraria/_framework/<文件>` 转发到对象存储。
 *
 * 三条容易踩的坑，都写在下面：
 *
 * 1. **必须注册在 `express.static` 之后**（同 `/j2me/jar/:name`）。生产机上如果把
 *    `_framework/` 放在 `public/web/terraria/` 下（或做软链），本地文件应当优先命中；
 *    代理抢先的话，本机放的文件永远取不到，而线上一切正常 —— 这种「只有本机不生效」
 *    的问题查起来非常费劲。
 *
 * 2. **必须流式转发，不能整包读进内存**。单个 wasm 95MiB，一页要并行取上百个文件；
 *    像 j2me 那样先攒完再发会直接把 Node 堆打爆。实际转发在 r2-runtime-proxy.js，
 *    用 await pipeline 保持背压，并确保流没结束前并发名额不会被提前释放。
 *
 * 3. R2 的预压缩文件以 `<原名>.br` 独立对象保存，元数据不写 Content-Encoding。
 *    代理显式取 identity 字节，再向浏览器补 `Content-Encoding: br`；这样 Node 不会自动解压，
 *    content-length 仍是准确的压缩长度，浏览器则能一边下载一边解码。
 *
 * 顺带一个 COEP 细节：`_framework/dotnet.native.worker.<hash>.mjs` 是 pthread 的 Worker
 * 入口，必须自己声明 `Cross-Origin-Embedder-Policy`，否则 Worker 加载失败、页面永远卡在
 * 启动（同 cache.js 里 qemu 那条注释）。
 */
import { envNumber } from './resource-limits.js'
import { assetBaseUrl } from './site-urls.js'
import { createR2RuntimeProxy } from './r2-runtime-proxy.js'

const ASSET_BASE = assetBaseUrl()
const PREFIX = (process.env.TERRARIA_ASSET_PREFIX || 'web/terraria/_framework').replace(/^\/+|\/+$/g, '')

/** `_framework/` 是平铺的，只允许单层名字；`..` 是合法的文件名取值，必须一起挡住。 */
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

const MAX_PROXIES = envNumber('TERRARIA_PROXY_MAX', 48, { max: 512 })
const PROXY_TIMEOUT_MS = envNumber('TERRARIA_PROXY_TIMEOUT_MS', 300_000, { max: 3_600_000 })

/** 运行时入口（未带内容哈希，改一版就要换名的就这两个）走短缓存，其余按内容寻址长期缓存。 */
const MUTABLE_FILES = new Set(['dotnet.js', 'blazor.boot.json'])

const EXTRA_CACHE = {
  dll: 'public, max-age=31536000, s-maxage=31536000, immutable',
  wasm: 'public, max-age=31536000, s-maxage=31536000, immutable',
  dat: 'public, max-age=31536000, s-maxage=31536000, immutable',
  mjs: 'public, max-age=31536000, s-maxage=31536000, immutable',
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
  return at < 0 ? '' : file.slice(at + 1).toLowerCase()
}

/**
 * 某个文件名对应的对象存储地址与缓存策略（纯函数，`scripts/test-terraria-web.mjs` 覆盖）。
 * 返回 null 表示名字不合法，调用方回 400。
 */
export function frameworkAsset(file) {
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

export const terrariaFrameworkProxy = createR2RuntimeProxy({
  label: 'terraria',
  resolveAsset: frameworkAsset,
  maxProxies: MAX_PROXIES,
  timeoutMs: PROXY_TIMEOUT_MS,
  extraHeaders: (file) => file.includes('.worker.')
    ? { 'Cross-Origin-Embedder-Policy': 'require-corp' }
    : {},
})
