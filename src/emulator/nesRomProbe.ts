/** NES mapper 选择只需要 iNES 头；探测不可成为开始游戏的无限等待或额外整包下载。 */
export const NES_HEADER_BYTES = 16
export const NES_HEADER_PROBE_TIMEOUT_MS = 4_000

export interface NesRomHeaderProbe {
  header: Uint8Array
  totalBytes: number
}

export interface NesRomHeaderProbeOptions {
  signal?: AbortSignal
  timeoutMs?: number
  /** 注入 fetch 只供回归测试；生产仍走浏览器 fetch。 */
  fetchImpl?: typeof fetch
}

/**
 * 只读一个严格匹配的 Range 头；服务端忽略 Range、回错偏移、停住或给超长正文时都降级到 EmulatorJS。
 * jsnes 是快路径，探测失败不应让玩家连开始游戏都点不了。
 */
export async function probeNesRomHeader(
  url: string,
  options: NesRomHeaderProbeOptions = {},
): Promise<NesRomHeaderProbe | null> {
  const { signal, timeoutMs = NES_HEADER_PROBE_TIMEOUT_MS } = options
  if (!url || signal?.aborted) return null

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let response: Response | null = null
  const abortFromParent = () => controller.abort()
  if (signal) signal.addEventListener('abort', abortFromParent, { once: true })

  const cancelBody = () => {
    if (response?.body) void response.body.cancel().catch(() => {})
  }

  try {
    timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
    response = await (options.fetchImpl ?? fetch)(url, {
      headers: { Range: `bytes=0-${NES_HEADER_BYTES - 1}` },
      signal: controller.signal,
    })
    if (!response.ok || response.status !== 206) {
      cancelBody()
      return null
    }

    // Range 对压缩后的表示没有稳定含义；未知或错误响应一律走稳定的 EmulatorJS 路径。
    if (response.headers.get('content-encoding')) {
      cancelBody()
      return null
    }
    const range = new RegExp(`^bytes 0-${NES_HEADER_BYTES - 1}/(\\d+)$`, 'i')
      .exec(response.headers.get('content-range') ?? '')
    const totalBytes = Number(range?.[1])
    const contentLength = response.headers.get('content-length')
    if (
      !range
      || !Number.isSafeInteger(totalBytes)
      || totalBytes <= NES_HEADER_BYTES
      || (contentLength !== null && Number(contentLength) !== NES_HEADER_BYTES)
      || !response.body
    ) {
      cancelBody()
      return null
    }

    const reader = response.body.getReader()
    const header = new Uint8Array(NES_HEADER_BYTES)
    let loaded = 0
    try {
      while (loaded < header.byteLength) {
        const { done, value } = await reader.read()
        if (done || !value) return null
        // Content-Range 已声明 16 字节；多出来说明中间层没有遵守范围，不能整段读进内存。
        if (value.byteLength > header.byteLength - loaded) return null
        header.set(value, loaded)
        loaded += value.byteLength
      }
      return { header, totalBytes }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  } catch {
    // 网络抖动、页面切换和 4 秒看门狗都只会失去 jsnes 快路径，不阻塞整局。
    return null
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', abortFromParent)
  }
}
