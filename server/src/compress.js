/**
 * 给 Express 加 gzip。
 *
 * ── 为什么自己写而不用 compression 包 ────────────────────────
 * 只是不想为一个中间件多一条生产依赖：要的行为很窄（只压文本、只压动态响应），
 * Node 自带 zlib 就够。真需要 brotli / 静态预压缩那天再换包不迟。
 *
 * ── 省在哪里 ────────────────────────────────────────────────
 * SSR 出来的首页 HTML 有几十 KB（数据直接内联在 window.__8BITGO__ 里），
 * /api/games、/api/page 这类列表 JSON 也是同样量级 —— 这些都是**动态**响应，
 * 没有预压缩文件可用，而 Cloudflare 只对它自己缓存到的那一份做压缩，
 * 回源路径上从源站到边缘走的还是明文。文本普遍能压到原来的 1/4 上下。
 *
 * ⚠️ 二进制一律不压：.wasm 和 EmulatorJS 的 .data 已经是压缩过的容器，
 *    再压一遍只是白烧 CPU（一个 35MB 的 mame 核心能让这次请求占满一个核好几秒）。
 *
 * ⚠️ 只压**动态**响应。express.static 走的是 send，它会先 writeHead 再流式写，
 *    到我们这里 headersSent 已经是 true，改不了响应头了 —— 正好，静态文件本来
 *    就该由边缘/CDN 压，源站不该为它们付 CPU。
 */
import { createGzip } from 'node:zlib'

/** 小于这个体积就不压：省下的字节还不够抵消一次 zlib 上下文初始化 */
const MIN_BYTES = Number(process.env.GZIP_MIN_BYTES || 1024)
/** 5 是「再往上每级只多省 1~2%，CPU 却翻倍」那个拐点 */
const LEVEL = Number(process.env.GZIP_LEVEL || 5)

/** 值得压的 Content-Type。逐个前缀比，命中就压 */
const COMPRESSIBLE = [
  'text/',
  'application/json',
  'application/javascript',
  'application/x-javascript',
  'application/xml',
  'application/manifest+json',
  'image/svg+xml',
  'application/ld+json',
]

function shouldCompress(res) {
  // SSE 必须逐条立刻发出去：压了就会被 zlib 攒在缓冲区里，弹幕和房间列表全都会卡住
  const type = String(res.getHeader?.('content-type') || '')
  if (!type) return false
  if (/text\/event-stream/i.test(type)) return false
  // 明确不让改的（上游可能是另一个压缩层）
  if (String(res.getHeader?.('cache-control') || '').includes('no-transform')) return false
  if (res.getHeader?.('content-encoding')) return false
  const base = type.split(';')[0].trim().toLowerCase()
  if (!COMPRESSIBLE.some((p) => base.startsWith(p))) return false
  const len = Number(res.getHeader?.('content-length'))
  // 已知长度且太短就不压；长度未知（分块）的一律压 —— 能分块说明不会太小
  if (Number.isFinite(len) && len > 0 && len < MIN_BYTES) return false
  return true
}

export function gzipResponse(req, res, next) {
  if (req.method === 'HEAD') return next()
  // 客户端明说不收就别费劲
  if (!/\b(?:gzip|x-gzip)\b/.test(String(req.headers['accept-encoding'] || ''))) return next()

  const origWrite = res.write.bind(res)
  const origEnd = res.end.bind(res)
  let gzip = null
  let decided = false

  const decide = () => {
    if (decided) return
    decided = true
    // 头已经发出去了（express.static / send 走的就是这条路）—— 改不动了，原样放行
    if (res.headersSent) return
    if (!shouldCompress(res)) return
    res.setHeader('Content-Encoding', 'gzip')
    res.removeHeader('Content-Length')
    // 同一个 URL 可能压也可能不压，缓存层必须按这个请求头分开存
    const vary = String(res.getHeader('vary') || '')
    if (!/accept-encoding/i.test(vary)) {
      res.setHeader('Vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding')
    }
    gzip = createGzip({ level: LEVEL })
    gzip.on('data', (chunk) => origWrite(chunk))
    gzip.on('end', () => origEnd())
    gzip.on('error', () => {
      // 压缩中途炸了：客户端一条字节都没收到，只能把连接关掉，
      // 比发半个 gzip 流过去强 —— 后者会让浏览器报一句看不懂的解码错误
      try {
        res.destroy()
      } catch {
        /* 已经断了 */
      }
    })
  }

  res.write = function patchedWrite(chunk, ...rest) {
    decide()
    if (!gzip) return origWrite(chunk, ...rest)
    if (chunk) gzip.write(chunk)
    return true
  }

  res.end = function patchedEnd(chunk, ...rest) {
    decide()
    if (!gzip) return origEnd(chunk, ...rest)
    if (chunk) gzip.write(chunk)
    gzip.end()
    return true
  }

  next()
}
