import { isPsxM3uUrl, parsePsxM3u, PSX_M3U_MAX_BYTES } from './psxM3u'

/** Beetle PSX 直接读 CHD：只有对象版本被 R2 锁住时，跨请求拼接才不会混入另一版镜像。 */
export const PSX_RANGE_BYTES = 2 * 1024 * 1024
const MAX_CHD_BYTES = 1024 * 1024 * 1024
const MAX_CACHED_BLOCKS = 32
const MAX_M3U_BYTES = PSX_M3U_MAX_BYTES
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
  readonly multiDisc: false
  readonly url: string
  readonly name: string
  readonly size: number
  /** 加载条只计算开局必需的首尾分片，不把尚未需要的整张盘伪报为已下载。 */
  readonly startupBytes: number
  /** CHD 头的前 32 字节（含压缩器清单）；开局前据此挑核心，见 psxChd.ts 的 psxChdCoreForCodecs。 */
  readonly head: Uint8Array
  readonly heads: readonly Uint8Array[]
  install(fs: PsxRangeFs, xhrFactory: typeof XMLHttpRequest): void
  dispose(): void
}

/** 单盘与 M3U 共用的流式媒体契约，安装时由一个 EmulatorJS 下载钩子挂入虚拟文件系统。 */
export interface PsxRangeMedia {
  readonly multiDisc: boolean
  readonly url: string
  readonly name: string
  readonly size: number
  readonly startupBytes: number
  readonly head: Uint8Array
  readonly heads: readonly Uint8Array[]
  install(fs: PsxRangeFs, xhrFactory: typeof XMLHttpRequest): void
  dispose(): void
}

function rangeVersion(url: string, extension: 'chd' | 'm3u' = 'chd'): string | null {
  try {
    const parsed = new URL(url, typeof window === 'undefined' ? 'https://8bitgo.com/' : window.location.href)
    const version = parsed.searchParams.get('romv')
    return /^https?:$/.test(parsed.protocol) && new RegExp(`\\.${extension}$`, 'i').test(parsed.pathname) &&
      version && /^[a-f\d]{32}(?:-\d+)?$/i.test(version) ? version : null
  } catch {
    return null
  }
}

export function canStreamPsxChd(platform: string, url: string): boolean {
  return platform === 'psx' && rangeVersion(url) !== null
}

export function canStreamPsxM3u(platform: string, url: string): boolean {
  return platform === 'psx' && isPsxM3uUrl(url) && rangeVersion(url, 'm3u') !== null
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
  fetcher: typeof fetch = fetch, onFatal?: (message: string) => void,
  options: { includeTail?: boolean; prefetch?: boolean; maxCachedBlocks?: number } = {}): Promise<PsxRangeDisc> {
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
  const maxCachedBlocks = Math.max(2, Math.min(MAX_CACHED_BLOCKS, Math.floor(options.maxCachedBlocks ?? MAX_CACHED_BLOCKS)))
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
    if (lastIndex > 0 && options.includeTail !== false) {
      const start = lastIndex * PSX_RANGE_BYTES
      const last = await fetchBlock(url, version, start, size - 1, size, controller.signal, fetcher)
      cache.set(lastIndex, last.bytes)
    }

    const remember = (index: number, bytes: Uint8Array) => {
      cache.delete(index)
      cache.set(index, bytes)
      while (cache.size > maxCachedBlocks) {
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
    if (options.prefetch !== false) {
      background(1)
      background(2)
      background(3)
    }

    return {
      multiDisc: false, url, name, size,
      head: first.bytes.slice(0, 32),
      heads: [first.bytes.slice(0, 32)],
      startupBytes: Math.min(size, PSX_RANGE_BYTES) + (lastIndex > 0 && options.includeTail !== false ? size - lastIndex * PSX_RANGE_BYTES : 0),
      install(fs, xhrFactory) {
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
              /*
                读盘请求必须由外层页面创建的 XHR 发出。

                EmulatorJS 跑在 sandbox srcdoc iframe 里，浏览器会把它视为不透明源（Origin: null）；
                R2 只允许本站页面源时，iframe 内的跨域 XHR 会被 CORS 拒绝。首尾预热由外层页面
                fetch 发出所以看起来正常，只有核心第一次读到未缓存分片才黑屏。把构造器从调用方
                传进来，避免误拿 iframe 自己的 XMLHttpRequest。
              */
              const xhr = new xhrFactory()
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

function manifestVersion(url: string): string {
  const version = rangeVersion(url, 'm3u')
  if (!version) throw new Error('PS1 多盘清单缺少固定对象版本；请从已绑定的 R2 ROM 地址启动')
  return version
}

async function boundedManifestText(response: Response, version: string): Promise<{ text: string; bytes: number }> {
  if (response.status !== 200) throw new Error(`PS1 多盘清单读取失败（HTTP ${response.status}）`)
  if (response.headers.get('ETag') !== `"${version}"`) throw new Error('PS1 多盘清单在读取期间已换版')
  const encoding = response.headers.get('Content-Encoding')
  if (encoding && encoding.toLowerCase() !== 'identity') throw new Error('PS1 多盘清单不能压缩传输')
  if (/text\/html|application\/(?:json|problem\+json)/i.test(response.headers.get('Content-Type') || '')) {
    throw new Error('PS1 多盘地址返回了网页或错误信息，不是 M3U 清单')
  }
  const declared = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > MAX_M3U_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new Error('PS1 多盘清单超过 16KB 上限')
  }
  if (!response.body) throw new Error('PS1 多盘清单没有可读取的数据')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_M3U_BYTES) throw new Error('PS1 多盘清单超过 16KB 上限')
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  if (Number.isFinite(declared) && declared > 0 && total !== declared) throw new Error('PS1 多盘清单长度不符')
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), bytes: total } }
  catch { throw new Error('PS1 多盘清单不是有效的 UTF-8 文本') }
}

async function probeDiscObject(url: string, signal: AbortSignal, fetcher: typeof fetch): Promise<{ url: string; size: number }> {
  const response = await fetcher(url, { method: 'HEAD', cache: 'no-store', signal })
  if (!response.ok) throw new Error(`PS1 光盘 ${new URL(url).pathname.split('/').pop()} 不可用（HTTP ${response.status}）`)
  const etag = response.headers.get('ETag')
  const version = etag?.replace(/^W\//, '').replace(/^"|"$/g, '') || ''
  if (!/^[a-f\d]{32}(?:-\d+)?$/i.test(version) || etag !== `"${version}"`) {
    throw new Error('PS1 多盘组中的 CHD 缺少可验证的强 ETag，无法安全按 Range 拼盘')
  }
  const size = Number(response.headers.get('Content-Length'))
  if (!Number.isSafeInteger(size) || size < PSX_RANGE_BYTES || size > MAX_CHD_BYTES) {
    throw new Error('PS1 多盘组中的 CHD 大小无效（支持范围为 2MB–1GB）')
  }
  const parsed = new URL(url)
  parsed.searchParams.set('romv', version)
  return { url: parsed.href, size }
}

/**
 * 下载并验证小型 M3U，然后逐盘只取 CHD 开头；只有第一盘预读尾块与顺序热区。
 * M3U 只允许同目录 CHD，逐盘绑定强 ETag，切盘不会读到上传了一半的新旧混合镜像。
 */
export async function preparePsxRangePlaylist(url: string, signal: AbortSignal,
  fetcher: typeof fetch = fetch, onFatal?: (message: string) => void): Promise<PsxRangeMedia> {
  const version = manifestVersion(url)
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) controller.abort()
  const discs: PsxRangeDisc[] = []
  try {
    const response = await fetcher(url, { headers: { 'If-Match': `"${version}"` }, cache: 'no-store', signal: controller.signal })
    const manifest = await boundedManifestText(response, version)
    const entries = parsePsxM3u(manifest.text)
    const manifestUrl = new URL(url)
    const directory = manifestUrl.pathname.slice(0, manifestUrl.pathname.lastIndexOf('/') + 1)
    const maxPerDisc = Math.max(2, Math.floor(MAX_CACHED_BLOCKS / entries.length))
    let startupBytes = manifest.bytes
    let totalSize = 0
    // 最多并发两张盘的头部探测，避免 8 盘组开局时占满连接和瞬时内存。
    let cursor = 0
    const prepareWorker = async () => {
      while (cursor < entries.length) {
        const index = cursor++
        const entry = entries[index]
        const discUrl = new URL(entry.filename, manifestUrl)
        let resolvedName = ''
        try { resolvedName = decodeURIComponent(discUrl.pathname.slice(directory.length)) } catch { /* 下面按路径不匹配拒绝 */ }
        if (discUrl.origin !== manifestUrl.origin || !discUrl.pathname.startsWith(directory) || resolvedName !== entry.filename) {
          throw new Error('PS1 多盘清单中的光盘必须和清单位于同一目录')
        }
        const probed = await probeDiscObject(discUrl.href, controller.signal, fetcher)
        const disc = await preparePsxRangeDisc(probed.url, entry.filename, controller.signal, fetcher, onFatal, {
          includeTail: index === 0,
          prefetch: index === 0,
          maxCachedBlocks: maxPerDisc,
        })
        if (disc.size !== probed.size) {
          disc.dispose()
          throw new Error(`PS1 光盘 ${entry.filename} 在探测期间大小发生变化`)
        }
        discs[index] = disc
        startupBytes += disc.startupBytes
        totalSize += disc.size
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, entries.length) }, () => prepareWorker()))
    const name = manifestUrl.pathname.slice(manifestUrl.pathname.lastIndexOf('/') + 1)
    let decodedName = name
    try { decodedName = decodeURIComponent(name) } catch { /* 后面的安全检查会拒绝不合法路径 */ }
    if (!/^[^\\/:?#|\u0000-\u001f\u007f]{1,156}\.m3u$/i.test(decodedName)) {
      throw new Error('PS1 多盘清单文件名无效')
    }
    const encoder = new TextEncoder()
    const playlistBytes = encoder.encode(manifest.text.replace(/^\uFEFF/, ''))
    return {
      multiDisc: true, url, name: decodedName, size: totalSize, startupBytes,
      head: discs[0].head,
      heads: discs.map(disc => disc.head),
      install(fs, xhrFactory) {
        for (const disc of discs) disc.install(fs, xhrFactory)
        fs.writeFile(`/${decodedName}`, playlistBytes)
      },
      dispose() {
        for (const disc of discs) disc.dispose()
        controller.abort()
        signal.removeEventListener('abort', abort)
      },
    }
  } catch (error) {
    controller.abort()
    signal.removeEventListener('abort', abort)
    for (const disc of discs) disc?.dispose()
    throw error
  }
}
