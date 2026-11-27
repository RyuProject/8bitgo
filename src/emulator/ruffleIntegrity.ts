/** Ruffle 自托管运行时的浏览器端可信摘要；scripts/check-ruffle.mjs 与 runtime.json 逐项对照。 */
export const RUFFLE_RUNTIME_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'ruffle.js': '8418ac50bd25f7dce8b81b84c02fdbab9de3a355f7ee730fe0b19e3f0455d8d2',
  'core.ruffle.1e8ba0ba354ac1c1caa1.js': '43117660943fbca9853e1f9a0aa6f42f5b30f2ad9e4c0a3c7c67d59d1ceb6cb0',
  'core.ruffle.d9827e036807622b5ae9.js': 'f8ccb4a1afb7568a7519e5ca14c19b8e3e2b6a773882f49d83faff3ab03eee64',
  'fc897fa050f6083d84aa.wasm': '0dd2507bd021e3a625910f8043dcd34cfe1759827c7fe31762aae3d0d1751205',
  '73c962b987ad7c7f7ee8.wasm': 'cd926a83b736146ec9f8786ecfd4c4db3ec6a843ea54caa1ddcb6a9f15601ec3',
})

function sri(hex: string): string {
  if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error('Ruffle 运行时 SHA-256 配置无效')
  const binary = hex.match(/.{2}/g)!.map((part) => String.fromCharCode(Number.parseInt(part, 16))).join('')
  return `sha256-${btoa(binary)}`
}

function runtimeFile(rawUrl: string | URL, root: string, base: string): string | null {
  try {
    const rootUrl = new URL(root, base)
    const assetUrl = new URL(rawUrl, rootUrl)
    if (assetUrl.origin !== rootUrl.origin || !assetUrl.pathname.startsWith(rootUrl.pathname)) return null
    const name = assetUrl.pathname.slice(rootUrl.pathname.length)
    return name && !name.includes('/') ? name : null
  } catch { return null }
}

/** 给 Ruffle 按需插入的核心 JS 预先挂 SRI，必须在设置 src 前完成。 */
export function applyRuffleScriptIntegrity(script: HTMLScriptElement, rawUrl: string, root: string, base: string): void {
  const name = runtimeFile(rawUrl, root, base)
  const expected = name ? RUFFLE_RUNTIME_SHA256[name] : undefined
  if (!expected || !name?.endsWith('.js')) return
  script.integrity = sri(expected)
  script.crossOrigin = 'anonymous'
}

/** 核心 WASM 在交给 WebAssembly 编译器前完整核验；失败不返回原响应供 Ruffle 兜底使用。 */
export async function verifyRuffleWasmResponse(response: Response, name: string): Promise<Response> {
  const expected = RUFFLE_RUNTIME_SHA256[name]
  if (!expected || !name.endsWith('.wasm')) throw new Error(`未知的 Ruffle WASM 核心：${name}`)
  if (!response.ok || response.status !== 200 || !response.body) {
    void response.body?.cancel().catch(() => {})
    throw new Error(`Ruffle WASM 下载失败（HTTP ${response.status}）`)
  }
  if (!globalThis.crypto?.subtle) {
    void response.body.cancel().catch(() => {})
    throw new Error('当前浏览器不支持 SHA-256，无法安全加载 Ruffle 核心')
  }

  let bytes: ArrayBuffer
  try { bytes = await response.arrayBuffer() }
  catch (error) { throw new Error(`Ruffle WASM 正文不可读：${error instanceof Error ? error.message : String(error)}`) }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
  const actual = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
  if (actual !== expected) throw new Error(`Ruffle WASM SHA-256 不匹配，已阻止启动：${name}`)

  // fetch 会解开 br/gzip；不能把压缩长度头复制给解码后的字节。
  const headers = new Headers(response.headers)
  headers.delete('content-encoding')
  headers.delete('content-length')
  return new Response(bytes, { status: 200, statusText: response.statusText, headers })
}

/**
 * 在 Ruffle 加载器运行前拦住其核心 fetch 与动态 script。只匹配版本目录内的固定清单文件，
 * 不改 SWF、字体和其它外部请求；核心字节只请求一次，SHA-256 和下载并行完成。
 */
export function installRuffleRuntimeIntegrity(
  win: Window & typeof globalThis,
  doc: Document,
  getRoot: () => string,
): () => void {
  const originalFetch = win.fetch
  const wrappedFetch: typeof fetch = async (input, init) => {
    // iframe 与父页面属于不同 JS realm；用结构判断，避免跨 realm 的 Request instanceof 失败后漏验 WASM。
    const requested = input && typeof input === 'object' && 'url' in input
      ? String((input as Request).url)
      : String(input)
    const response = await originalFetch.call(win, input, init)
    const name = runtimeFile(requested, getRoot(), doc.baseURI)
    if (!name?.endsWith('.wasm')) return response
    return verifyRuffleWasmResponse(response, name)
  }
  win.fetch = wrappedFetch

  const scriptPrototype = win.HTMLScriptElement.prototype
  const srcDescriptor = Object.getOwnPropertyDescriptor(scriptPrototype, 'src')
  const originalSetAttribute = scriptPrototype.setAttribute
  if (srcDescriptor?.set && srcDescriptor.get) {
    Object.defineProperty(scriptPrototype, 'src', {
      configurable: srcDescriptor.configurable,
      enumerable: srcDescriptor.enumerable,
      get() { return srcDescriptor.get!.call(this) },
      set(value: string) {
        applyRuffleScriptIntegrity(this, value, getRoot(), doc.baseURI)
        srcDescriptor.set!.call(this, value)
      },
    })
  }
  scriptPrototype.setAttribute = function(name: string, value: string): void {
    if (name.toLowerCase() === 'src') applyRuffleScriptIntegrity(this, value, getRoot(), doc.baseURI)
    originalSetAttribute.call(this, name, value)
  }

  return () => {
    if (win.fetch === wrappedFetch) win.fetch = originalFetch
    if (srcDescriptor) Object.defineProperty(scriptPrototype, 'src', srcDescriptor)
    scriptPrototype.setAttribute = originalSetAttribute
  }
}
