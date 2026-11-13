import { decompress, init } from '@bokuweb/zstd-wasm'
import { apiBase, apiEnabled } from './api'
import {
  ROM_PACK_CHUNK_BYTES,
  ROM_PACK_CODEC,
  ROM_PACK_HEADER_PREFIX_BYTES,
  ROM_PACK_MAX_HEADER_BYTES,
  ROM_PACK_VERSION,
  assertZstdFrameContentSize,
  base64UrlToBytes,
  bytesToBase64Url,
  encodeRomPackPrefix,
  isRomPackBytes,
  isRomPackUrl,
  parseRomPackHeader,
  recommendedRomPackCodec,
  romPackAad,
  romPackHeaderLength,
  romPackIv,
  romPackKey,
  type RomPackCodec,
  type RomPackHeader,
} from '../../shared/rom-pack-format.js'

export { isRomPackBytes, isRomPackUrl, romPackKey }
export { recommendedRomPackCodec }

export const ROM_PACK_DEFAULT_CODEC: RomPackCodec = ROM_PACK_CODEC.ZSTD
export const ROM_PACK_DEFAULT_LEVEL = 19
/**
 * ArrayBuffer 路径的硬上限。
 *
 * `unpackRomPack()` 要同时持有密文、解密后的连续缓冲和调用方后续生成的游戏层；超过 1GB 时，
 * 浏览器即使偶尔分配成功，也很容易在下一次复制时直接杀掉标签页。大型 Windows 游戏必须改成
 * Sockdrive，不能靠放宽这个数字把内存问题推迟到玩家机器上。
 */
export const ROM_PACK_ARRAY_BUFFER_LIMIT = 1024 * 1024 * 1024

const REMOTE_HEADER_PREVIEW_BYTES = 64 * 1024

/**
 * 只用 HTTP Range 读取远端 8BG 的文件头。
 *
 * 这道预检专门防止 StarCraft 这类超大 Windows 包：旧流程会先下载 1.4GB，最后才在
 * `unpackRomPack()` 里发现它超过连续内存上限。资源域名不支持 Range 时返回 null，交给原下载
 * 路径兼容处理；绝不能把一次 200 响应读完整，否则“预检”本身又会变成整包下载。
 */
export async function inspectRemoteRomPack(
  url: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<RomPackHeader | null> {
  const readPrefix = async (end: number): Promise<{ bytes: Uint8Array<ArrayBuffer>; total?: number } | null> => {
    const response = await fetchImpl(url, {
      headers: { Range: `bytes=0-${end}` },
      signal,
      cache: 'no-store',
    })
    if (response.status === 200) {
      // 有些源在响应头里声称支持 Range，实际仍回整包；立刻取消，不能为一次预检吞下 GB 级文件。
      void response.body?.cancel().catch(() => {})
      return null
    }
    if (response.status !== 206) throw new Error(`读取 8BG 文件头失败（HTTP ${response.status}）`)
    const match = response.headers.get('content-range')?.match(/^bytes\s+0-(\d+)\/(\d+)$/i)
    if (!match) throw new Error('8BG 文件头响应缺少有效的 Content-Range')
    const bytes = new Uint8Array(await response.arrayBuffer()) as Uint8Array<ArrayBuffer>
    const expected = Number(match[1]) + 1
    if (bytes.byteLength !== expected) throw new Error('8BG 文件头 Range 响应长度不完整')
    return { bytes, total: Number(match[2]) }
  }

  let preview = await readPrefix(REMOTE_HEADER_PREVIEW_BYTES - 1)
  if (!preview) return null
  let headerLength: number
  try {
    headerLength = romPackHeaderLength(preview.bytes.subarray(0, ROM_PACK_HEADER_PREFIX_BYTES))
  } catch {
    throw new Error('远端文件不是有效的 8BG 容器')
  }
  if (headerLength > ROM_PACK_MAX_HEADER_BYTES) throw new Error('8BG 文件头超过格式上限')
  const required = ROM_PACK_HEADER_PREFIX_BYTES + headerLength
  if (preview.bytes.byteLength < required) {
    const complete = await readPrefix(required - 1)
    if (!complete) return null
    preview = complete
  }
  const { header, dataOffset } = parseRomPackHeader(preview.bytes)
  if (preview.total !== undefined && dataOffset + header.payloadSize !== preview.total) {
    throw new Error('8BG 文件长度与文件头不一致')
  }
  return header
}

interface KeyResponse {
  packageId: string
  keyId: string
  key: string
}

interface PackProgress {
  loaded: number
  total: number
}

export interface PackedRomUpload {
  blob: Blob
  header: RomPackHeader
  workers: number
  /** 网络失败后再次选择同一个源文件时，可直接复用上一份完全相同的密文。 */
  reused: boolean
}

interface RomPackCapacity {
  hardwareConcurrency?: number
  deviceMemory?: number
}

const keyCache = new Map<string, Promise<CryptoKey>>()
let zstdReady: Promise<void> | null = null
const readyZstd = (): Promise<void> => {
  if (!zstdReady) {
    const pending = init()
    zstdReady = pending
    // 一次网络失败不能把解码器永久钉死在 rejected：下一局 / 自动重试要能重新取 wasm。
    pending.catch(() => {
      if (zstdReady === pending) zstdReady = null
    })
  }
  return zstdReady
}

/**
 * 在下载 8BG 的**同时**把 Zstd 解码器（约 74KB br 的 wasm）取回并编译好。
 *
 * 2026-11-11 大陆《森林冰火人》慢启动：SWF 用 10.9 秒下完，到 11.0 秒解包时才第一次
 * `init()` 去取 zstd-*.wasm，又在弱网上花了 7 秒 —— 一个几十 KB 的文件排在整个 ROM 之后
 * 串行走一趟高 RTT 往返。loadGameBytes 见到 .8bg 地址就调这里；失败静默，解包时会再试一次。
 */
export function prewarmRomPackDecoder(url?: string): void {
  void readyZstd().catch(() => {})
  if (url) prewarmRomPackKey(url)
}

/** 取包头只读这么多：单块包头约 600 字节，每多一个 8MB 块约多 200 字节，4KB 覆盖到约 150MB 的 ROM。 */
const KEY_PREWARM_PREFIX_BYTES = 4096
const keyPrewarmed = new Set<string>()

/**
 * 与 ROM 下载并行取这一包的数据密钥。
 *
 * 2026-11-12《凯撒大帝》（DOS，737KB）实测：ROM 下完才读包头、才去要密钥，密钥回来才取解码器 ——
 * 高 RTT 线路上 ROM 之后又串行走了两趟往返（约 2 秒）。包头就在文件最前面，先用一个小 Range
 * 读出 packageId，把密钥请求提前到下载期间；结果放进 contentKey 的同一份缓存，解包时直接复用。
 * 包头超出这段前缀（超大 ROM）就不预取，照旧在解包时取；任何失败都静默，由解包那一步报错。
 * 解包先一步调了 contentKey 也没关系：两边按 keyId + packageId 共用同一个 promise，不会多要一次。
 */
export function prewarmRomPackKey(url: string, fetchImpl: typeof fetch = fetch): void {
  if (!apiEnabled() || !isRomPackUrl(url) || keyPrewarmed.has(url)) return
  keyPrewarmed.add(url)
  void (async () => {
    const response = await fetchImpl(url, { headers: { Range: `bytes=0-${KEY_PREWARM_PREFIX_BYTES - 1}` } })
    if (response.status !== 206) {
      // 不支持 Range 的源会回整包，预取不值得为此多下一份
      void response.body?.cancel().catch(() => {})
      return
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    const required = ROM_PACK_HEADER_PREFIX_BYTES + romPackHeaderLength(bytes.subarray(0, ROM_PACK_HEADER_PREFIX_BYTES))
    if (bytes.byteLength < required) return
    await contentKey(parseRomPackHeader(bytes.subarray(0, required)).header)
  })().catch(() => {
    keyPrewarmed.delete(url)
  })
}

interface PackedRomRetryCache extends Omit<PackedRomUpload, 'reused'> {
  sourceName: string
  sourceSize: number
  sourceLastModified: number
  originalName: string
  codec: RomPackCodec
  createdAt: number
}

/**
 * 只留最近一次失败后可能重试的打包结果。
 *
 * R2 的续传账本认的是“打包后的密文”。若每次重试都重新生成 packageId / IV，即使源 ROM 没变，
 * 密文也会完全不同，之前已经传完的分片就无法复用。把最后一份结果留在当前页面内存里，既不把
 * GB 级 ROM 再写一份 IndexedDB，也能让最常见的“网络失败后马上重试”跳过 Zstd 19 和 AES。
 */
let packedRomRetryCache: PackedRomRetryCache | null = null
const PACK_RETRY_CACHE_TTL = 2 * 60 * 60 * 1000

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (v) => v.toString(16).padStart(2, '0')).join('')
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (v) => v.toString(16).padStart(2, '0')).join('')

/**
 * 浏览器打包并行度：给页面至少留一个逻辑核心，并用内存档位限制同时存在的 WASM 堆。
 *
 * 8MB 原文在 Zstd / AES 期间会有原文、编码结果和密文三份短暂驻留；直接照
 * hardwareConcurrency 启十几个 Worker 在高核数低内存设备上反而会换页甚至杀标签。
 */
export function romPackWorkerConcurrency(
  fileSize: number,
  capacity: RomPackCapacity = {
    hardwareConcurrency: globalThis.navigator?.hardwareConcurrency,
    deviceMemory: (globalThis.navigator as Navigator & { deviceMemory?: number } | undefined)?.deviceMemory,
  },
): number {
  const chunks = Math.max(1, Math.ceil(fileSize / ROM_PACK_CHUNK_BYTES))
  const hardware = Number.isFinite(capacity.hardwareConcurrency) && Number(capacity.hardwareConcurrency) > 0
    ? Math.floor(Number(capacity.hardwareConcurrency))
    : 2
  const memory = Number(capacity.deviceMemory)
  const memoryCap = Number.isFinite(memory) && memory > 0
    ? memory <= 2 ? 1 : memory <= 4 ? 2 : 4
    : 4
  return Math.max(1, Math.min(chunks, 4, memoryCap, Math.max(1, hardware - 1)))
}

export async function matchesRomPackSource(
  file: File,
  header: RomPackHeader,
  onProgress?: (progress: PackProgress) => void,
): Promise<boolean> {
  if (file.size !== header.originalSize || header.chunkSize !== ROM_PACK_CHUNK_BYTES) return false
  const expectedChunks = Math.ceil(file.size / ROM_PACK_CHUNK_BYTES)
  if (header.chunks.length !== expectedChunks) return false

  // 不能只比名字、大小、mtime 或头中尾样本：误命中会把另一份 ROM 的旧密文上传成功，直到玩家
  // 开局才发现内容不对。这里重读每个 8MB 原块核对已保存的 SHA；一次顺序磁盘读取仍远快于
  // 重新执行 Zstd 19，而且不会改变密文，所以 R2 已完成的分片可以真正续上。
  let nextIndex = 0
  let verifiedBytes = 0
  let matched = true
  const workers = Math.min(romPackWorkerConcurrency(file.size), expectedChunks)
  await Promise.all(Array.from({ length: workers }, async () => {
    while (matched) {
      const index = nextIndex++
      if (index >= expectedChunks) return
      const start = index * ROM_PACK_CHUNK_BYTES
      const end = Math.min(file.size, start + ROM_PACK_CHUNK_BYTES)
      const bytes = await file.slice(start, end).arrayBuffer()
      const digest = hex(await crypto.subtle.digest('SHA-256', bytes))
      if (digest !== header.chunks[index]?.sha256) {
        matched = false
        return
      }
      verifiedBytes += end - start
      onProgress?.({ loaded: verifiedBytes, total: file.size })
    }
  }))
  return matched
}

/** 上传确认完成后立即放掉大 Blob；失败时故意保留，供当前页面的下一次选择续传。 */
export function releasePackedRomUpload(blob: Blob): void {
  if (packedRomRetryCache?.blob === blob) packedRomRetryCache = null
}

async function fetchRawKey(packageId: string, keyId?: string): Promise<KeyResponse> {
  if (!apiEnabled()) throw new Error('8BG 打包需要后端 API（VITE_API_URL）')
  const params = new URLSearchParams({ packageId })
  if (keyId) params.set('keyId', keyId)
  const res = await fetch(`${apiBase()}/api/rom-pack/key?${params}`, { cache: 'no-store' })
  const data = (await res.json().catch(() => null)) as (Partial<KeyResponse> & { error?: string }) | null
  if (!res.ok || !data?.key || !data.keyId) throw new Error(data?.error || `获取 ROM 包密钥失败（HTTP ${res.status}）`)
  // 不能只信“有一段 key”：代理缓存串包或后端回错 packageId 时，用错密钥打出来的文件
  // 会在上传成功后永久无法解开，而且表面上仍是一份合法 8BG。
  if (data.packageId !== packageId || (keyId && data.keyId !== keyId)) throw new Error('ROM 包密钥响应与请求不一致')
  let raw: Uint8Array
  try {
    raw = base64UrlToBytes(data.key)
  } catch {
    throw new Error('ROM 包密钥不是有效的 Base64URL')
  }
  if (raw.byteLength !== 32) throw new Error('ROM 包密钥长度不是 256 位')
  return { packageId: data.packageId, keyId: data.keyId, key: data.key }
}

async function contentKey(header: Pick<RomPackHeader, 'packageId' | 'keyId'>): Promise<CryptoKey> {
  const cacheKey = `${header.keyId}:${header.packageId}`
  let pending = keyCache.get(cacheKey)
  if (!pending) {
    pending = fetchRawKey(header.packageId, header.keyId).then((data) =>
      crypto.subtle.importKey('raw', base64UrlToBytes(data.key), 'AES-GCM', false, ['decrypt']),
    )
    keyCache.set(cacheKey, pending)
    pending.catch(() => keyCache.delete(cacheKey))
  }
  return pending
}

/** 后台上传的新 ROM 默认走这里；Worker 池做重活，React 页面只收进度和最终 Blob。 */
export async function packRomForUpload(
  file: File,
  originalName = file.name,
  onProgress?: (progress: PackProgress) => void,
  codec: RomPackCodec = recommendedRomPackCodec(originalName),
): Promise<PackedRomUpload> {
  const cached = packedRomRetryCache
  if (
    cached &&
    Date.now() - cached.createdAt < PACK_RETRY_CACHE_TTL &&
    cached.sourceName === file.name &&
    cached.sourceSize === file.size &&
    cached.sourceLastModified === file.lastModified &&
    cached.originalName === originalName &&
    cached.codec === codec
  ) {
    if (await matchesRomPackSource(file, cached.header, onProgress)) {
      return { blob: cached.blob, header: cached.header, workers: cached.workers, reused: true }
    }
    // 同名同大小同时间的文件也可能被外部工具原地改过；完整散列不一致时绝不能沿用旧密文。
    packedRomRetryCache = null
    onProgress?.({ loaded: 0, total: file.size })
  } else if (cached) {
    // 单槽缓存避免连续尝试不同 ROM 时长期占住上一份 GB 级 Blob。
    packedRomRetryCache = null
  }

  const packageId = randomId()
  const grant = await fetchRawKey(packageId)
  const rawKey = base64UrlToBytes(grant.key)
  const noncePrefix = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(8)))
  const workerCount = romPackWorkerConcurrency(file.size)
  const workers = Array.from({ length: workerCount }, (_, index) => new Worker(
    new URL('../workers/romPackWorker.ts', import.meta.url),
    { type: 'module', name: `8bitgo-rom-pack-${index + 1}` },
  ))
  const terminate = () => workers.forEach((worker) => worker.terminate())

  try {
    await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
      worker.onerror = (event) => reject(new Error(event.message || 'ROM 打包 Worker 初始化失败'))
      worker.onmessage = (event: MessageEvent<{ type: 'ready' } | { type: 'error'; message: string }>) => {
        if (event.data.type === 'error') reject(new Error(event.data.message))
        else resolve()
      }
      const key = rawKey.slice().buffer
      worker.postMessage({
        type: 'init',
        packageId,
        keyId: grant.keyId,
        key,
        codec,
        level: ROM_PACK_DEFAULT_LEVEL,
        originalName,
        originalSize: file.size,
        noncePrefix,
      }, [key])
    })))
    rawKey.fill(0)

    const totalChunks = Math.ceil(file.size / ROM_PACK_CHUNK_BYTES)
    const encryptedChunks = Array<Blob>(totalChunks)
    const chunks = Array<RomPackHeader['chunks'][number]>(totalChunks)
    let nextIndex = 0
    let completedBytes = 0
    await new Promise<void>((resolve, reject) => {
      let completed = 0
      let settled = false
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      const dispatch = (worker: Worker) => {
        if (settled) return
        const index = nextIndex++
        if (index >= totalChunks) return
        const start = index * ROM_PACK_CHUNK_BYTES
        worker.postMessage({
          type: 'chunk',
          index,
          // Blob 的结构化克隆不复制正文；每个 Worker 只在真正处理自己的块时读取 8MB。
          source: file.slice(start, Math.min(file.size, start + ROM_PACK_CHUNK_BYTES)),
        })
      }
      for (const worker of workers) {
        worker.onerror = (event) => fail(new Error(event.message || 'ROM 打包 Worker 失败'))
        worker.onmessage = (event: MessageEvent<
          | { type: 'chunk'; index: number; cipher: ArrayBuffer; chunk: RomPackHeader['chunks'][number] }
          | { type: 'error'; message: string; index?: number }
        >) => {
          const message = event.data
          if (message.type === 'error') {
            fail(new Error(message.index === undefined ? message.message : `第 ${message.index + 1} 块：${message.message}`))
            return
          }
          if (settled || encryptedChunks[message.index]) return
          encryptedChunks[message.index] = new Blob([message.cipher])
          chunks[message.index] = message.chunk
          completed++
          completedBytes += message.chunk.sourceSize
          onProgress?.({ loaded: completedBytes, total: file.size })
          if (completed === totalChunks) {
            settled = true
            resolve()
          } else {
            dispatch(worker)
          }
        }
        dispatch(worker)
      }
    })

    const header: RomPackHeader = {
      version: ROM_PACK_VERSION,
      packageId,
      keyId: grant.keyId,
      codec,
      codecVersion: 1,
      compressionLevel: codec === ROM_PACK_CODEC.ZSTD ? ROM_PACK_DEFAULT_LEVEL : undefined,
      codecOptions: {},
      cipher: 'aes-256-gcm',
      originalName,
      originalSize: file.size,
      originalSha256: null,
      chunkSize: ROM_PACK_CHUNK_BYTES,
      noncePrefix,
      chunks,
      payloadSize: chunks.reduce((sum, chunk) => sum + chunk.cipherSize, 0),
      createdAt: new Date().toISOString(),
    }
    const result: PackedRomUpload = {
      blob: new Blob([encodeRomPackPrefix(header), ...encryptedChunks], { type: 'application/x-8bitgo-rom' }),
      header,
      workers: workerCount,
      reused: false,
    }
    packedRomRetryCache = {
      blob: result.blob,
      header,
      workers: workerCount,
      sourceName: file.name,
      sourceSize: file.size,
      sourceLastModified: file.lastModified,
      originalName,
      codec,
      createdAt: Date.now(),
    }
    return result
  } finally {
    rawKey.fill(0)
    terminate()
  }
}

async function decode(header: Pick<RomPackHeader, 'codec' | 'codecVersion'>, data: Uint8Array, expectedSize: number): Promise<Uint8Array<ArrayBuffer>> {
  // codecVersion 是以后更换编码参数/实现时的兼容边界。静默拿 v1 解码器读 v2，报出来只会像
  // “ROM 损坏”；明确拒绝才能保证以后加 LZMA2 或 Zstd 新封装时老客户端不会误判。
  if (header.codecVersion !== 1) throw new Error(`这个版本的播放器不支持 ${header.codec} codec v${header.codecVersion}`)
  if (header.codec === ROM_PACK_CODEC.STORE) return new Uint8Array(data)
  if (header.codec === ROM_PACK_CODEC.ZSTD) {
    assertZstdFrameContentSize(data, expectedSize)
    await readyZstd()
    // TS 6 会把第三方声明视为可能指向 SharedArrayBuffer；复制后 Web Crypto 才能确认是普通 ArrayBuffer。
    // 无帧大小的 Zstd 数据也只能申请当前块声明的大小，不能让畸形文件退回库默认的 1MB。
    return new Uint8Array(decompress(data, { defaultHeapSize: expectedSize }))
  }
  throw new Error(`这个版本的播放器还没有安装 ${header.codec} 解码器`)
}

async function decryptChunk(header: RomPackHeader, index: number, cipher: ArrayBuffer, key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  let encoded: ArrayBuffer
  try {
    encoded = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: romPackIv(header, index), additionalData: romPackAad(header, index), tagLength: 128 },
      key,
      cipher,
    )
  } catch {
    throw new Error(`ROM 包第 ${index + 1} 块解密失败：文件损坏或服务端密钥不匹配`)
  }
  const expected = header.chunks[index]
  const source = await decode(header, new Uint8Array(encoded), expected.sourceSize)
  if (source.byteLength !== expected.sourceSize) throw new Error(`ROM 包第 ${index + 1} 块解压大小不符`)
  const digest = hex(await crypto.subtle.digest('SHA-256', source))
  if (digest !== expected.sha256) throw new Error(`ROM 包第 ${index + 1} 块校验失败`)
  return source
}

/** 小/中型 ROM 的完整解包；返回原始文件名，让模拟器仍按 .zip/.nes/.nds 识别。 */
export async function unpackRomPack(data: ArrayBuffer): Promise<{ name: string; data: ArrayBuffer; header: RomPackHeader }> {
  const bytes = new Uint8Array(data)
  const { header, dataOffset } = parseRomPackHeader(bytes)
  if (dataOffset + header.payloadSize !== bytes.byteLength) throw new Error('8BG 文件长度与文件头不一致')
  // 这一条路径必须申请连续 ArrayBuffer；光盘等大文件走下面的 Blob 版本。先挡住异常文件头，
  // 避免在校验第一块之前就把手机标签页用一笔超大分配直接杀掉。
  if (header.originalSize > ROM_PACK_ARRAY_BUFFER_LIMIT) throw new Error('ROM 包解开后超过 1GB，请改用支持 Blob 的播放器路径')
  const key = await contentKey(header)
  const output = new Uint8Array(header.originalSize)
  let sourceAt = 0
  let cipherAt = dataOffset
  for (let index = 0; index < header.chunks.length; index++) {
    const meta = header.chunks[index]
    const cipher = bytes.slice(cipherAt, cipherAt + meta.cipherSize).buffer
    const source = await decryptChunk(header, index, cipher, key)
    output.set(source, sourceAt)
    sourceAt += source.byteLength
    cipherAt += meta.cipherSize
  }
  if (header.originalSha256) {
    const digest = hex(await crypto.subtle.digest('SHA-256', output))
    if (digest !== header.originalSha256) throw new Error('ROM 包整文件校验失败')
  }
  return { name: header.originalName, data: output.buffer, header }
}

/**
 * 读一段 Blob 最多等这么久。8MB 一块，就算老机器在换页也该几秒读完；卡满一分钟就当底层存储坏了。
 * 2026-11-12《口袋妖怪：白 2》（2GB Windows Chrome）：续传片拼出的 ROM 有一局读包时永不返回，
 * 一局抛 NotReadableError —— 前者以前只会让进度停在 100% 等看门狗。现在两种都抛 NotReadableError，
 * 调用方据此作废续传与缓存、重下一次。
 */
export const ROM_PACK_READ_TIMEOUT_MS = 60_000

export async function readBlobRange(blob: Blob, start: number, end: number, timeoutMs = ROM_PACK_READ_TIMEOUT_MS): Promise<ArrayBuffer> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      blob.slice(start, end).arrayBuffer(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DOMException('读取已下载的 ROM 超时', 'NotReadableError')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Blob 读不出来（底层存储丢失、损坏或卡死）。浏览器原生的和 readBlobRange 超时的都是这个名字。 */
export function isBlobReadError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'NotReadableError')
}

/** 只读取并验证文件头与总长度；后台识别现成 .8bg 时不能只看四字节魔数。 */
export async function inspectRomPackBlob(blob: Blob): Promise<{ header: RomPackHeader; dataOffset: number }> {
  const prefix = new Uint8Array(await readBlobRange(blob, 0, ROM_PACK_HEADER_PREFIX_BYTES))
  const headerLength = romPackHeaderLength(prefix)
  const headBytes = new Uint8Array(await readBlobRange(blob, 0, ROM_PACK_HEADER_PREFIX_BYTES + headerLength))
  const parsed = parseRomPackHeader(headBytes)
  if (parsed.dataOffset + parsed.header.payloadSize !== blob.size) throw new Error('8BG 文件长度与文件头不一致')
  return parsed
}

/**
 * 后台上传别人预先打好的 8BG 前做完整校验。只认魔数会把碰巧以 8BG1 开头的普通 ROM
 * 当容器，而只验第一块又会把后半截损坏的包原样传上云；逐块验证不保留输出，内存仍是常数。
 */
export async function verifyRomPackBlob(blob: Blob, onProgress?: (progress: PackProgress) => void): Promise<RomPackHeader> {
  const { header, dataOffset } = await inspectRomPackBlob(blob)
  const key = await contentKey(header)
  let cipherAt = dataOffset
  let verified = 0
  for (let index = 0; index < header.chunks.length; index++) {
    const meta = header.chunks[index]
    const cipher = await blob.slice(cipherAt, cipherAt + meta.cipherSize).arrayBuffer()
    await decryptChunk(header, index, cipher, key)
    cipherAt += meta.cipherSize
    verified += meta.sourceSize
    onProgress?.({ loaded: verified, total: header.originalSize })
  }
  return header
}

/**
 * 大 ROM 走 Blob：逐块解密解压，浏览器可把结果落盘，避免申请一整块连续内存。
 *
 * onProgress 每解完一块报一次。114MB 的 NDS 有 14 块，低配机上要几十秒；以前这段一个进度都不报，
 * 进度条停在 100%，启动看门狗也把它当成卡死。
 */
export async function unpackRomPackBlob(
  blob: Blob,
  onProgress?: (progress: PackProgress) => void,
): Promise<{ name: string; blob: Blob; header: RomPackHeader }> {
  const { header, dataOffset } = await inspectRomPackBlob(blob)
  const key = await contentKey(header)
  const output: Blob[] = []
  let cipherAt = dataOffset
  let unpacked = 0
  for (let index = 0; index < header.chunks.length; index++) {
    const meta = header.chunks[index]
    const cipher = await readBlobRange(blob, cipherAt, cipherAt + meta.cipherSize)
    const source = await decryptChunk(header, index, cipher, key)
    // 每块立刻固化成 Blob：既脱离可能复用的 WASM 内存，也允许浏览器把大结果落到磁盘。
    output.push(new Blob([source]))
    cipherAt += meta.cipherSize
    unpacked += meta.sourceSize
    onProgress?.({ loaded: unpacked, total: header.originalSize })
  }
  return { name: header.originalName, blob: new Blob(output, { type: 'application/octet-stream' }), header }
}
