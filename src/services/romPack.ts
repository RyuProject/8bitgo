import { decompress, init } from '@bokuweb/zstd-wasm'
import { apiBase, apiEnabled } from './api'
import {
  ROM_PACK_CODEC,
  ROM_PACK_HEADER_PREFIX_BYTES,
  assertZstdFrameContentSize,
  base64UrlToBytes,
  isRomPackBytes,
  isRomPackUrl,
  parseRomPackHeader,
  romPackAad,
  romPackHeaderLength,
  romPackIv,
  romPackKey,
  type RomPackCodec,
  type RomPackHeader,
} from '../../shared/rom-pack-format.js'

export { isRomPackBytes, isRomPackUrl, romPackKey }

export const ROM_PACK_DEFAULT_CODEC: RomPackCodec = ROM_PACK_CODEC.ZSTD
export const ROM_PACK_DEFAULT_LEVEL = 19

interface KeyResponse {
  packageId: string
  keyId: string
  key: string
}

interface PackProgress {
  loaded: number
  total: number
}

const keyCache = new Map<string, Promise<CryptoKey>>()
let zstdReady: Promise<void> | null = null
const readyZstd = () => (zstdReady ??= init())

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (v) => v.toString(16).padStart(2, '0')).join('')
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (v) => v.toString(16).padStart(2, '0')).join('')

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

/** 后台上传的新 ROM 默认走这里；Worker 做重活，React 页面只收进度和最终 Blob。 */
export async function packRomForUpload(
  file: File,
  originalName = file.name,
  onProgress?: (progress: PackProgress) => void,
  codec: RomPackCodec = ROM_PACK_DEFAULT_CODEC,
): Promise<{ blob: Blob; header: RomPackHeader }> {
  const packageId = randomId()
  const grant = await fetchRawKey(packageId)
  const rawKey = base64UrlToBytes(grant.key)
  const worker = new Worker(new URL('../workers/romPackWorker.ts', import.meta.url), { type: 'module', name: '8bitgo-rom-pack' })

  return new Promise((resolve, reject) => {
    const finish = () => worker.terminate()
    worker.onerror = (event) => {
      finish()
      reject(new Error(event.message || 'ROM 打包 Worker 失败'))
    }
    worker.onmessage = (event: MessageEvent<
      | { type: 'progress'; loaded: number; total: number }
      | { type: 'done'; blob: Blob; header: RomPackHeader }
      | { type: 'error'; message: string }
    >) => {
      const message = event.data
      if (message.type === 'progress') return onProgress?.(message)
      finish()
      if (message.type === 'error') reject(new Error(message.message))
      else resolve({ blob: message.blob, header: message.header })
    }
    worker.postMessage({
      type: 'pack', file, originalName, packageId, keyId: grant.keyId,
      key: rawKey.buffer, codec, level: ROM_PACK_DEFAULT_LEVEL,
    }, [rawKey.buffer])
  })
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
  if (header.originalSize > 1024 * 1024 * 1024) throw new Error('ROM 包解开后超过 1GB，请改用支持 Blob 的播放器路径')
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

/** 只读取并验证文件头与总长度；后台识别现成 .8bg 时不能只看四字节魔数。 */
export async function inspectRomPackBlob(blob: Blob): Promise<{ header: RomPackHeader; dataOffset: number }> {
  const prefix = new Uint8Array(await blob.slice(0, ROM_PACK_HEADER_PREFIX_BYTES).arrayBuffer())
  const headerLength = romPackHeaderLength(prefix)
  const headBytes = new Uint8Array(await blob.slice(0, ROM_PACK_HEADER_PREFIX_BYTES + headerLength).arrayBuffer())
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

/** 大 ROM 走 Blob：逐块解密解压，浏览器可把结果落盘，避免申请一整块连续内存。 */
export async function unpackRomPackBlob(blob: Blob): Promise<{ name: string; blob: Blob; header: RomPackHeader }> {
  const { header, dataOffset } = await inspectRomPackBlob(blob)
  const key = await contentKey(header)
  const output: Blob[] = []
  let cipherAt = dataOffset
  for (let index = 0; index < header.chunks.length; index++) {
    const meta = header.chunks[index]
    const cipher = await blob.slice(cipherAt, cipherAt + meta.cipherSize).arrayBuffer()
    const source = await decryptChunk(header, index, cipher, key)
    // 每块立刻固化成 Blob：既脱离可能复用的 WASM 内存，也允许浏览器把大结果落到磁盘。
    output.push(new Blob([source]))
    cipherAt += meta.cipherSize
  }
  return { name: header.originalName, blob: new Blob(output, { type: 'application/octet-stream' }), header }
}
