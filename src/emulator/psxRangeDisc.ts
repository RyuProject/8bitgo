/** Beetle PSX 直接读 CHD：只有对象版本被 R2 锁住时，跨请求拼接才不会混入另一版镜像。 */
export const PSX_RANGE_BYTES = 2 * 1024 * 1024
const MAX_CHD_BYTES = 1024 * 1024 * 1024
const MAX_CACHED_BLOCKS = 32
const MAX_CORE_READ_BYTES = 16 * 1024 * 1024
const CHD_MAGIC = 'MComprHD'

export interface PsxRangeFs {
  writeFile(path: string, bytes: Uint8Array): void
  lookupPath(path: string): { node: {
    usedBytes: number
    stream_ops: {
      read?: (stream: unknown, buffer: Uint8Array, offset: number, length: number, position: number) => number
    }
  } }
}

export interface PsxRangeDisc {
  readonly url: string
  readonly name: string
  readonly size: number
  /** 加载条只计算开局必需的首尾分片，不把尚未需要的整张盘伪报为已下载。 */
  readonly startupBytes: number
  install(fs: PsxRangeFs, frame: Window): void
  dispose(): void
}

function rangeVersion(url: string): string | null {
  try {
    const parsed = new URL(url, typeof window === 'undefined' ? 'https://8bitgo.com/' : window.location.href)
    const version = parsed.searchParams.get('romv')
    return /^https?:$/.test(parsed.protocol) && /\.chd$/i.test(parsed.pathname) &&
      version && /^[a-f\d]{32}(?:-\d+)?$/i.test(version) ? version : null
  } catch {
    return null
  }
}

export function canStreamPsxChd(platform: string, url: string): boolean {
  return platform === 'psx' && rangeVersion(url) !== null
}

function contentRange(value: string | null): { start: number; end: number; total: number } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(value?.trim() || '')
  if (!match) return null
  const [start, end, total] = match.slice(1).map(Number)
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && Number.isSafeInteger(total) &&
    start <= end && end < total ? { start, end, total } : null
}

function assertRange(response: { status: number; range: string | null; etag: string | null; encoding: string | null },
  start: number, end: number, total: number | null, version: string): number {
  const parsed = contentRange(response.range)
  if (response.status !== 206 || !parsed || parsed.start !== start || parsed.end !== end ||
      parsed.total <= 0 || parsed.total > MAX_CHD_BYTES || (total !== null && parsed.total !== total)) {
    throw new Error('PS1 CHD 服务器没有返回正确的 Range 区间')
  }
  // 没有可核对的 ETag 就不拼盘：URL 上写 romv 并不能证明第三方源真按版本锁定内容。
  // 弱 ETag 只保证语义等价，不保证每个字节不变；跨请求拼 CHD 必须逐片核对强版本。
  if (response.etag !== `"${version}"`) {
    throw new Error('PS1 CHD 在读取期间已换版')
  }
  if (response.encoding && response.encoding.toLowerCase() !== 'identity') {
    throw new Error('PS1 CHD Range 响应不能压缩传输')
  }
  return parsed.total
}

async function fetchBlock(url: string, version: string, start: number, end: number, total: number | null,
  signal: AbortSignal, fetcher: typeof fetch): Promise<{ bytes: Uint8Array; total: number }> {
  const response = await fetcher(url, {
    headers: { Range: `bytes=${start}-${end}`, 'If-Match': `"${version}"` },
    signal,
  })
  const size = assertRange({
    status: response.status,
    range: response.headers.get('Content-Range'),
    etag: response.headers.get('ETag'),
    encoding: response.headers.get('Content-Encoding'),
  }, start, end, total, version)
  const expected = end - start + 1
  const declared = response.headers.get('Content-Length')
  if (declared !== null && Number(declared) !== expected) {
    await response.body?.cancel().catch(() => {})
    throw new Error('PS1 CHD Range 区间长度不符')
  }
  if (!response.body) throw new Error('PS1 CHD Range 响应没有可读取的数据')
  // Content-Range 是服务端自报，不能直接 arrayBuffer()；错误源持续发数据会耗尽内存。
  const bytes = new Uint8Array(expected)
  const reader = response.body.getReader()
  let received = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (received + value.byteLength > expected) throw new Error('PS1 CHD Range 响应超过请求长度')
      bytes.set(value, received)
      received += value.byteLength
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  if (received !== expected) throw new Error('PS1 CHD Range 区间长度不符')
  return { bytes, total: size }
}

/** 不满足 Range / CORS / CHD 格式时抛错，由调用方回退到现有完整下载路径。 */
export async function preparePsxRangeDisc(url: string, name: string, signal: AbortSignal,
  fetcher: typeof fetch = fetch, onFatal?: (message: string) => void): Promise<PsxRangeDisc> {
  const version = rangeVersion(url)
  if (!version) throw new Error('PS1 CHD 缺少固定对象版本')
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) controller.abort()
  const cache = new Map<number, Uint8Array>()
  const loading = new Map<number, AbortController>()
  let size = 0
  let failed = false
  const checkAlive = () => {
    if (controller.signal.aborted || failed) throw new Error('PS1 CHD Range 会话已结束')
  }
  try {
    // 首片同时验证 CHD 魔数、版本和内容长度；禁止用 200 整包冒充一次区间请求。
    const first = await fetchBlock(url, version, 0, PSX_RANGE_BYTES - 1, null, controller.signal, fetcher)
    size = first.total
    if (size < PSX_RANGE_BYTES || String.fromCharCode(...first.bytes.subarray(0, 8)) !== CHD_MAGIC ||
        new DataView(first.bytes.buffer, first.bytes.byteOffset, first.bytes.byteLength).getUint32(12) !== 5) {
      throw new Error('PS1 镜像不是受支持的 CHD v5')
    }
    cache.set(0, first.bytes)
    const lastIndex = Math.floor((size - 1) / PSX_RANGE_BYTES)
    if (lastIndex > 0) {
      const start = lastIndex * PSX_RANGE_BYTES
      const last = await fetchBlock(url, version, start, size - 1, size, controller.signal, fetcher)
      cache.set(lastIndex, last.bytes)
    }

    const remember = (index: number, bytes: Uint8Array) => {
      cache.delete(index)
      cache.set(index, bytes)
      while (cache.size > MAX_CACHED_BLOCKS) {
        const victim = [...cache.keys()].find(key => key !== 0 && key !== lastIndex)
        if (victim === undefined) break
        cache.delete(victim)
      }
    }
    const background = (index: number) => {
      if (index < 0 || index > lastIndex || cache.has(index) || loading.has(index) || loading.size >= 3 ||
          controller.signal.aborted || failed) return
      const prefetch = new AbortController()
      const abortPrefetch = () => prefetch.abort()
      controller.signal.addEventListener('abort', abortPrefetch, { once: true })
      loading.set(index, prefetch)
      const start = index * PSX_RANGE_BYTES
      void fetchBlock(url, version, start, Math.min(size - 1, start + PSX_RANGE_BYTES - 1), size,
        prefetch.signal, fetcher).then(({ bytes }) => {
        if (!controller.signal.aborted && !prefetch.signal.aborted) remember(index, bytes)
      }).catch(() => { /* 弱网预读失败不拦开局，真正用到时同步请求会重试。 */ })
        .finally(() => {
          controller.signal.removeEventListener('abort', abortPrefetch)
          if (loading.get(index) === prefetch) loading.delete(index)
        })
    }
    // 趁核心与 BIOS 还在下载，先把顺序开局常读的几块铺好。
    background(1)
    background(2)
    background(3)

    return {
      url, name, size,
      startupBytes: Math.min(size, PSX_RANGE_BYTES) + (lastIndex > 0 ? size - lastIndex * PSX_RANGE_BYTES : 0),
      install(fs, frame) {
        checkAlive()
        const path = `/${name.split('/').pop()}`
        fs.writeFile(path, new Uint8Array(0))
        const node = fs.lookupPath(path).node
        if (!node?.stream_ops) throw new Error('PS1 核心的虚拟文件系统不支持按需读盘')
        node.usedBytes = size

        const synchronousBlock = (index: number): Uint8Array => {
          const cached = cache.get(index)
          if (cached) { remember(index, cached); return cached }
          // 预读尚未落入 JS 缓存时，同步核心无法等异步 fetch；先取消同片请求，避免双份抢带宽。
          loading.get(index)?.abort()
          loading.delete(index)
          const start = index * PSX_RANGE_BYTES
          const end = Math.min(size - 1, start + PSX_RANGE_BYTES - 1)
          let lastError: unknown
          for (let attempt = 0; attempt < 2; attempt++) {
            checkAlive()
            try {
              const Xhr = (frame as Window & { XMLHttpRequest: typeof XMLHttpRequest }).XMLHttpRequest
              const xhr = new Xhr()
              xhr.open('GET', url, false)
              // 浏览器主线程禁止同步 XHR 的 arraybuffer；单字节文本映射仍能保留原始 CHD 字节。
              xhr.overrideMimeType('text/plain; charset=x-user-defined')
              xhr.setRequestHeader('Range', `bytes=${start}-${end}`)
              xhr.setRequestHeader('If-Match', `"${version}"`)
              xhr.send()
              assertRange({
                status: xhr.status,
                range: xhr.getResponseHeader('Content-Range'),
                etag: xhr.getResponseHeader('ETag'),
                encoding: xhr.getResponseHeader('Content-Encoding'),
              }, start, end, size, version)
              const raw = xhr.responseText
              if (raw.length !== end - start + 1) throw new Error('PS1 CHD Range 区间长度不符')
              const bytes = new Uint8Array(raw.length)
              for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) & 255
              remember(index, bytes)
              return bytes
            } catch (error) { lastError = error }
          }
          failed = true
          controller.abort()
          const message = `PS1 CHD 读盘失败：${lastError instanceof Error ? lastError.message : String(lastError)}`
          // 核心可能吞掉虚拟文件系统异常；独立上报才能在运行中断网时给玩家可见的错误。
          queueMicrotask(() => onFatal?.(message))
          throw new Error(message)
        }

        // MEMFS 的文件 stream_ops 是共享表；原地改 read 会让 BIOS/存档也读成 CHD 数据。
        node.stream_ops = { ...node.stream_ops, read: (_stream, buffer, offset, length, position) => {
          checkAlive()
          if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 0 ||
              length > MAX_CORE_READ_BYTES || offset < 0 || offset + length > buffer.length) {
            throw new Error('PS1 核心请求了异常大的 CHD 读盘范围；请检查整盘预缓存是否已关闭')
          }
          let done = 0
          const wanted = Math.min(length, size - position)
          while (done < wanted) {
            const at = position + done
            const index = Math.floor(at / PSX_RANGE_BYTES)
            const bytes = synchronousBlock(index)
            const inBlock = at - index * PSX_RANGE_BYTES
            const count = Math.min(wanted - done, bytes.length - inBlock)
            if (count <= 0) throw new Error('PS1 CHD 分片索引越界')
            buffer.set(bytes.subarray(inBlock, inBlock + count), offset + done)
            done += count
            background(index + 1)
            background(index + 2)
          }
          return done
        } }
      },
      dispose() {
        failed = true
        controller.abort()
        cache.clear()
        signal.removeEventListener('abort', abort)
      },
    }
  } catch (error) {
    controller.abort()
    signal.removeEventListener('abort', abort)
    throw error
  }
}
