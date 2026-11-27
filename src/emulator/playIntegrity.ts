/** Play! 核心 WASM 的可信构建摘要；check-play.mjs 会和随仓库清单逐字节核对。 */
export const PLAY_WASM_BYTES = 3_182_723
export const PLAY_WASM_SHA256 = '308d4b666cac07b6170ea50b1f7ac48724350c6d88627fc0e36add2cefa1c55d'
/** Play.js 走原 URL 动态导入以保留 pthread Worker 的相对路径，因此用 modulepreload SRI 先验证入口模块。 */
export const PLAY_JS_SHA256 = 'cd2204d9e07e29b7fb9b247d069b4a9d443609c4de9599c0e424c995c48b82df'

function sriSha256(hex: string): string {
  if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error('Play! 核心的 SHA-256 配置无效')
  const binary = hex.match(/.{2}/g)!.map((byte) => String.fromCharCode(Number.parseInt(byte, 16))).join('')
  return `sha256-${btoa(binary)}`
}

/**
 * 把入口模块以 SRI 方式放进浏览器 module map，随后同 URL 的 import 复用已校验响应。
 * 校验失败或长时间未完成时必须拒绝，不能继续对同一 URL 做无完整性约束的动态导入。
 */
export function preloadVerifiedPlayModule(
  url: string,
  doc: Pick<Document, 'createElement' | 'head'> = document,
  timeoutMs = 15_000,
): Promise<void> {
  const link = doc.createElement('link')
  if (!link.relList.supports('modulepreload')) {
    return Promise.reject(new Error('此浏览器不支持安全加载 Play! 核心，请更新浏览器'))
  }
  link.rel = 'modulepreload'
  link.as = 'script'
  link.href = url
  link.crossOrigin = 'anonymous'
  link.integrity = sriSha256(PLAY_JS_SHA256)

  return new Promise((resolve, reject) => {
    let settled = false
    const timer = globalThis.setTimeout(() => finish(new Error('Play.js 完整性预加载超时')), timeoutMs)
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      globalThis.clearTimeout(timer)
      link.onload = null
      link.onerror = null
      link.remove()
      if (error) reject(error)
      else resolve()
    }
    link.onload = () => finish()
    link.onerror = () => finish(new Error('Play.js 下载失败或 SRI 完整性校验不匹配'))
    try {
      doc.head.append(link)
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/**
 * 下载完成后再把 WASM 交给 Emscripten，避免错误 CDN 响应进入编译器或被运行时缓存。
 * Play! 核心只有约 3 MiB；保留一份定长缓冲的额外峰值远小于核心自身内存，摘要只算一次。
 */
export async function verifyPlayWasmResponse(response: Response): Promise<Response> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    throw new Error(`Play.wasm 下载失败（HTTP ${response.status}）`)
  }
  if (!globalThis.crypto?.subtle) {
    void response.body?.cancel().catch(() => {})
    throw new Error('当前浏览器不支持 SHA-256，无法安全加载 Play! 核心')
  }

  let bytes: ArrayBuffer
  try {
    bytes = await response.arrayBuffer()
  } catch (error) {
    throw new Error(`Play.wasm 下载正文不可读：${error instanceof Error ? error.message : String(error)}`)
  }
  if (bytes.byteLength !== PLAY_WASM_BYTES) {
    throw new Error(`Play.wasm 长度不符：应为 ${PLAY_WASM_BYTES}，实际 ${bytes.byteLength}`)
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
  const actual = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
  if (actual !== PLAY_WASM_SHA256) throw new Error('Play.wasm SHA-256 不匹配，已阻止启动')

  // fetch 已把 gzip/br 响应解码；不能把旧 Content-Encoding / Content-Length 复制给新正文。
  const headers = new Headers(response.headers)
  headers.delete('content-encoding')
  headers.delete('content-length')
  return new Response(bytes, { status: response.status, statusText: response.statusText, headers })
}
