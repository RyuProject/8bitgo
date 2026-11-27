/**
 * 体积大、不会变、又没有被压缩过的静态文件：预先压好 `<原名>.br`，由源站直接吐压缩字节。
 *
 * ── 为什么（2026-11-04《GT 赛车》PSP 实测）────────────────────────────
 * PPSSPPSDL.data 是 Emscripten 的资源包（字体、界面图集、着色器、语言文件），19.4MB，
 * Content-Type 是 application/octet-stream —— Cloudflare 不压这个类型，线上一直是明文传输：
 * 同一次冷启动里 18MB 的 wasm 走 zstd 只传 5.6MB、6 秒，data 却实打实传了 19.4MB、20 秒，
 * 成了 PSP 冷启动里最长的一段。Brotli 11 压到 9.2MB（-53%）。
 *
 * express.static 不会自己找预压缩文件（compress.js 也故意不碰静态响应），所以这里在它前面
 * 接一手：命中白名单、客户端接受 br、不是 Range 请求、`.br` 文件存在 —— 四个条件都满足才接，
 * 否则原样交给 express.static。两条路都带 `Vary: Accept-Encoding`，边缘按编码分开缓存。
 *
 * ⚠️ `.br` 必须与原文件逐字节一致（解压后）。scripts/check-ppsspp.mjs 会把它解开、对
 *    runtime.json 的 sha256，prebuild 与 postbuild 都跑；生成用 `npm run ppsspp:precompress`。
 * ⚠️ Range 一律退回原文件：Range 的偏移是针对未编码内容的，不能套在压缩字节上。
 */
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { acceptsBrotli } from './r2-runtime-proxy.js'
import { fileSha256 } from './file-hash.js'

/**
 * 只收这些路径。别放已经是压缩容器的文件（EmulatorJS 的 cores/*.data 是 7z）。
 *
 * PPSSPPSDL.data 的 .br 随运行时目录提交、由 scripts/check-ppsspp.mjs 校验；
 * 其余（2026-11-09 加）由 scripts/precompress-runtimes.mjs 在构建时生成，旁边带 `.br.json`
 * 记原文件字节数与 sha256，这里内容对不上就不吐（防过期的压缩版，见 sidecarMatches）。实测 Cloudflare 现场压 wasm
 * 比 Brotli 11 大 25~30%：Ruffle 4.68MB → 3.26MB、Dolphin 4.59MB → 3.22MB。
 */
export const PRECOMPRESSED_STATIC_PATTERNS = Object.freeze([
  // Vite 哈希产物：有内容哈希，且 Cloudflare 对常见浏览器请求目前会选 gzip；源站预压缩可稳定下发 Brotli。
  /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:css|js)$/,
  /^\/ppsspp\/v[0-9a-f]+\/v\d+\/PPSSPPSDL\.data$/,
  /^\/ruffle\/v[^/]+\/[^/]+\.wasm$/,
  /^\/jsdos\/v[^/]+\/emulators\/(?:wdosbox|wdosbox-x|wdosbox-x-jspi|wlibzip)\.wasm$/,
  /^\/dolphin\/v[^/]+\/cores\/dolphin\/[^/]+\.wasm$/,
  /^\/play\/(?:[^/]+\/)?Play\.wasm$/,
  /^\/ppsspp\/v[0-9a-f]+\/v\d+\/PPSSPPSDL\.wasm$/,
  /^\/emulatorjs\/emulator\.min\.js$/,
  // EKA2L1：octet-stream 的 data（字体 / 着色器 / HLE 补丁）Cloudflare 不压，wasm 现场压也比 Brotli 11 大
  /^\/eka2l1\/v[0-9a-f]{12}\/eka2l1\.(?:wasm|data)$/,
])

/** 提交在运行时目录里、没有旁注的历史 .br（由各自的检查脚本保证一致） */
const LEGACY_WITHOUT_SIDECAR = /^\/ppsspp\/v[0-9a-f]+\/v\d+\/PPSSPPSDL\.data$/

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.js': 'application/javascript; charset=utf-8',
  '.data': 'application/octet-stream',
}

/**
 * `.br` 是不是「当前原文件」的压缩版：旁注里的字节数、sha256 都要与磁盘上的原文件一致，
 * `.br` 本身的字节数也要与旁注记录的 brBytes 一致。
 *
 * ⚠️ 以前只比字节数。原文件被改了、长度却没变（补丁改一个字符、换一个等长的标识符）时，
 * 过期的 `.br` 会被当成当前版本发出去 —— 对 `/emulatorjs/emulator.min.js?v=<新内容哈希>` 来说，
 * 就是把旧引擎挂在新版本号下面，再被边缘 immutable 缓存一年（和 2026-11-17 全站事故同一个后果）。
 * sha256 按「路径 + 大小 + mtime」缓存（file-hash.js），每份文件每次部署只算一次。
 */
const sidecarCache = new Map()
async function sidecarMatches(file, encoded) {
  let source
  let brInfo
  try {
    ;[source, brInfo] = await Promise.all([stat(file), stat(encoded)])
  } catch {
    return false
  }
  const key = `${file}:${source.size}:${source.mtimeMs}:${brInfo.size}:${brInfo.mtimeMs}`
  if (sidecarCache.has(key)) return sidecarCache.get(key)
  const pending = (async () => {
    try {
      const sidecar = JSON.parse(await readFile(`${file}.br.json`, 'utf8'))
      if (sidecar?.bytes !== source.size) return false
      if (typeof sidecar.brBytes === 'number' && sidecar.brBytes !== brInfo.size) return false
      if (typeof sidecar.sha256 !== 'string') return false
      const actual = await fileSha256(file)
      return Boolean(actual) && actual.sha256 === sidecar.sha256
    } catch {
      return false
    }
  })()
  if (sidecarCache.size > 500) sidecarCache.clear()
  sidecarCache.set(key, pending)
  return pending
}

function appendVary(res, token) {
  const current = String(res.getHeader('Vary') || '')
  const values = current.split(',').map((value) => value.trim()).filter(Boolean)
  if (!values.some((value) => value.toLowerCase() === token.toLowerCase())) values.push(token)
  res.setHeader('Vary', values.join(', '))
}

/**
 * @param {string} root 静态根目录（dist/client）
 * @param {object} [options]
 * @param {(res: import('express').Response, filePath: string) => void} [options.setHeaders] 与 express.static 同一个 setHeaders
 * @param {readonly RegExp[]} [options.patterns]
 */
export function precompressedStatic(root, { setHeaders, patterns = PRECOMPRESSED_STATIC_PATTERNS } = {}) {
  const base = path.resolve(root)
  return async function precompressedStaticMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    const urlPath = req.path
    if (!patterns.some((pattern) => pattern.test(urlPath))) return next()
    // 不管走哪条路，边缘都必须按编码分开存；只在压缩那条上写 Vary 会让无 br 的客户端拿到压缩字节
    appendVary(res, 'Accept-Encoding')
    if (req.headers.range || !acceptsBrotli(req.headers['accept-encoding'])) return next()

    const file = path.resolve(base, `.${urlPath}`)
    if (!file.startsWith(base + path.sep)) return next()
    const encoded = `${file}.br`
    try {
      const info = await stat(encoded)
      if (!info.isFile()) return next()
    } catch {
      return next()
    }
    if (!LEGACY_WITHOUT_SIDECAR.test(urlPath) && !(await sidecarMatches(file, encoded))) return next()

    // 跨源隔离头与缓存策略按**原文件**的路径给，和 express.static 那条路完全一致
    setHeaders?.(res, file)
    // wasm 必须是 application/wasm，否则 WebAssembly.instantiateStreaming 直接拒绝
    res.setHeader('Content-Type', CONTENT_TYPES[path.extname(file)] || 'application/octet-stream')
    res.setHeader('Content-Encoding', 'br')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.sendFile(encoded, {
      // Cache-Control 已经由 setHeaders 给过；send 的默认值会把它盖成 max-age=0
      cacheControl: false,
      acceptRanges: false,
      lastModified: true,
      etag: true,
      dotfiles: 'deny',
    }, (error) => {
      if (!error) return
      // 头还没发出去就退回原文件；发了一半只能断开，浏览器那边的核心资源下载会自己重试
      if (!res.headersSent) {
        res.removeHeader('Content-Encoding')
        res.removeHeader('Content-Type')
        next()
      } else {
        res.destroy(error)
      }
    })
  }
}
