/**
 * R2 上大型 WebAssembly 运行时的同源流式代理。
 *
 * 上传器把 Brotli 结果存成独立的 `<原名>.br` 对象，**不**在 R2 元数据里写
 * Content-Encoding。这样 Node fetch 不会擅自解压；代理把压缩字节原样流给浏览器，
 * 再由这一层补 `Content-Encoding: br`。浏览器边收边解压，Node 与浏览器都不用先攒完整文件。
 */
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Accept-Encoding 不是简单的 includes('br')：`br;q=0` 明确表示不接受。 */
export function acceptsBrotli(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .some((part) => {
      const [coding, ...params] = part.split(';').map((item) => item.trim())
      if (coding !== 'br') return false
      const q = params.find((item) => item.startsWith('q='))
      return !q || Number(q.slice(2)) > 0
    })
}

function appendVary(res, token) {
  const current = String(res.getHeader('Vary') || '')
  const values = current.split(',').map((value) => value.trim()).filter(Boolean)
  if (!values.some((value) => value.toLowerCase() === token.toLowerCase())) values.push(token)
  res.setHeader('Vary', values.join(', '))
}

/**
 * @param {object} options
 * @param {string} options.label 日志前缀
 * @param {(file: string) => null | {url: string, contentType: string, cacheControl: string, precompressed?: boolean}} options.resolveAsset
 * @param {number} options.maxProxies
 * @param {number} options.timeoutMs
 * @param {(file: string) => Record<string, string>} [options.extraHeaders]
 */
/** 包体传输阶段允许多久没有新字节。 */
const STALL_MS = Math.max(5000, Number(process.env.R2_RUNTIME_STALL_MS) || 60_000)

export function createR2RuntimeProxy({
  label,
  resolveAsset,
  maxProxies,
  timeoutMs,
  extraHeaders = () => ({}),
}) {
  let activeProxies = 0

  return async function r2RuntimeProxy(req, res) {
    const file = String(req.params.file || '')
    const asset = resolveAsset(file)
    if (!asset) return res.status(400).send('bad name')
    if (!asset.url) return res.status(503).send('ROM_BASE_URL 未配置')

    if (activeProxies >= maxProxies) {
      res.setHeader('Retry-After', '1')
      return res.status(503).send('运行时文件代理繁忙')
    }

    activeProxies++
    const disconnect = new AbortController()
    /*
      timeoutMs 只管「拿到响应头」之前；以前同一个超时一直盖到包体传完，
      100MB 的 wasm 给慢于约 2.7Mbps 的玩家传到第 300 秒就被硬切成半截文件。
      包体阶段改成失速超时：连续 STALL_MS 没有新字节才放弃。
    */
    const timeout = new AbortController()
    const headerTimer = setTimeout(() => timeout.abort(new Error('upstream header timeout')), timeoutMs)
    headerTimer.unref?.()
    let stallTimer = null
    const signal = AbortSignal.any([disconnect.signal, timeout.signal])
    const onClose = () => {
      if (!res.writableEnded) disconnect.abort(new Error('Client disconnected'))
    }
    res.once('close', onClose)

    let upstream = null
    try {
      /*
        HTTP Range 针对的是未编码文件的偏移，不能套在 `.br` 压缩字节上。
        .NET / Emscripten 的正常启动不会 Range 这些核心；调试工具真发 Range 时退回原对象。
      */
      // 系统镜像这类对象本身已经是 ZIP，不另存 `.br`；显式关掉可避免每次兜底都先多打一条 404。
      const encoded = asset.precompressed !== false && !req.headers.range && acceptsBrotli(req.headers['accept-encoding'])
      const candidates = encoded
        ? [{ url: `${asset.url}.br`, brotli: true }, { url: asset.url, brotli: false }]
        : [{ url: asset.url, brotli: false }]

      let selected = null
      for (const candidate of candidates) {
        const headers = { 'accept-encoding': 'identity' }
        if (!candidate.brotli && req.headers.range) headers.range = req.headers.range
        if (req.headers['if-none-match']) headers['if-none-match'] = req.headers['if-none-match']
        if (req.headers['if-modified-since']) headers['if-modified-since'] = req.headers['if-modified-since']
        upstream = await fetch(candidate.url, {
          headers,
          signal,
          method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        })
        if (candidate.brotli && upstream.status === 404) {
          await upstream.body?.cancel().catch(() => {})
          upstream = null
          continue
        }
        selected = candidate
        break
      }

      if (!upstream || !selected) return res.status(404).end()
      if (upstream.status === 304) {
        await upstream.body?.cancel().catch(() => {})
        res.setHeader('Cache-Control', asset.cacheControl)
        if (selected.brotli) res.setHeader('Content-Encoding', 'br')
        appendVary(res, 'Accept-Encoding')
        return res.status(304).end()
      }
      if (!upstream.ok && upstream.status !== 206) {
        await upstream.body?.cancel().catch(() => {})
        console.error(`[${label}] 对象存储返回 ${upstream.status}：${selected.url}`)
        return res.status(upstream.status).end()
      }

      res.status(upstream.status)
      res.setHeader('Content-Type', asset.contentType)
      for (const name of ['content-length', 'etag', 'last-modified']) {
        const value = upstream.headers.get(name)
        if (value) res.setHeader(name, value)
      }
      if (!selected.brotli) {
        for (const name of ['content-range', 'accept-ranges']) {
          const value = upstream.headers.get(name)
          if (value) res.setHeader(name, value)
        }
      } else {
        res.setHeader('Content-Encoding', 'br')
      }
      appendVary(res, 'Accept-Encoding')
      res.setHeader('Cache-Control', asset.cacheControl)
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      for (const [name, value] of Object.entries(extraHeaders(file))) res.setHeader(name, value)

      if (req.method === 'HEAD' || !upstream.body) {
        await upstream.body?.cancel().catch(() => {})
        return res.end()
      }

      /*
        必须 await pipeline。原实现 `stream.pipe(res)` 后函数立刻进入 finally，
        并发名额当场释放、close 监听也被摘掉：100MB 仍在传，代码却以为已经结束。
        pipeline 同时提供背压、错误传播，并把“玩家关页”真正传到 AbortController。
      */
      clearTimeout(headerTimer)
      const body = Readable.fromWeb(upstream.body)
      let lastProgress = Date.now()
      body.on('data', () => { lastProgress = Date.now() })
      stallTimer = setInterval(() => {
        if (Date.now() - lastProgress > STALL_MS) timeout.abort(new Error('upstream body stalled'))
      }, Math.min(5000, STALL_MS))
      stallTimer.unref?.()
      await pipeline(body, res, { signal })
    } catch (error) {
      if (disconnect.signal.aborted || res.destroyed) return
      console.error(`[${label}] 运行时文件代理失败：`, error.message)
      if (!res.headersSent) res.status(timeout.signal.aborted ? 504 : 502).send('运行时文件获取失败')
      else res.destroy()
    } finally {
      clearTimeout(headerTimer)
      if (stallTimer) clearInterval(stallTimer)
      res.off('close', onClose)
      activeProxies--
    }
  }
}
