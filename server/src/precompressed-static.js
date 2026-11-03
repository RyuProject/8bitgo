/**
 * 体积大、不会变、又没有被压缩过的静态运行时文件：预先压好 `<原名>.br`，由源站直接吐压缩字节。
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
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { acceptsBrotli } from './r2-runtime-proxy.js'

/** 只收这些路径。别放 .wasm / .js（边缘本来就会压）或已经是压缩容器的文件 */
export const PRECOMPRESSED_STATIC_PATTERNS = Object.freeze([
  /^\/ppsspp\/v[0-9a-f]+\/v\d+\/PPSSPPSDL\.data$/,
])

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

    // 跨源隔离头与缓存策略按**原文件**的路径给，和 express.static 那条路完全一致
    setHeaders?.(res, file)
    res.setHeader('Content-Type', 'application/octet-stream')
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
