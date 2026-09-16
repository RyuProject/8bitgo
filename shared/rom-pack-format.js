/**
 * 8BitGo ROM 容器的纯数据格式。
 *
 * 这一层故意不碰 Zstd、AES 或浏览器 API：打包脚本、浏览器 Worker、播放器和服务端
 * 都要读同一份格式定义。codec 写进文件头而不是数据库列，今后加入 lzma2 时，老的
 * zstd 包仍能照常读取，不需要把整个库再迁一次。
 */

export const ROM_PACK_VERSION = 1
export const ROM_PACK_MAGIC_TEXT = '8BG1'
export const ROM_PACK_HEADER_PREFIX_BYTES = 8
export const ROM_PACK_MAX_HEADER_BYTES = 1024 * 1024
export const ROM_PACK_CHUNK_BYTES = 8 * 1024 * 1024
// 单块原文最多 64MB，压缩结果不应膨胀到原文两倍以上；这道上限主要防损坏文件头
// 诱导播放器在解密前申请数百 GB。正常 Zstd / store 包远低于它。
export const ROM_PACK_MAX_ENCODED_CHUNK_BYTES = 128 * 1024 * 1024
export const ROM_PACK_CODEC = Object.freeze({ STORE: 'store', ZSTD: 'zstd', LZMA2: 'lzma2' })

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function isRomPackBytes(value) {
  const b = value instanceof Uint8Array ? value : new Uint8Array(value)
  return b.byteLength >= 4 && b[0] === 0x38 && b[1] === 0x42 && b[2] === 0x47 && b[3] === 0x31
}

export function isRomPackUrl(value) {
  if (typeof value !== 'string') return false
  return /\.8bg(?:$|[?#])/i.test(value)
}

/** 新容器保留原扩展名：kof97.zip -> kof97.zip.8bg，运行时选择仍能看出它是街机 ZIP。 */
export function romPackKey(key) {
  if (isRomPackUrl(key)) return key
  // 签名外链的查询串必须留在末尾；`game.zip?token=x.8bg` 会让服务端收到错误 token。
  const suffixAt = String(key).search(/[?#]/)
  return suffixAt < 0 ? `${key}.8bg` : `${key.slice(0, suffixAt)}.8bg${key.slice(suffixAt)}`
}

/** 从 `game.nds.8bg` 取出真正交给模拟器的扩展名。 */
export function romPackInnerName(name) {
  const clean = String(name || '').split(/[?#]/)[0]
  return clean.replace(/\.8bg$/i, '')
}

export function encodeRomPackPrefix(header) {
  validateRomPackHeader(header)
  const json = encoder.encode(JSON.stringify(header))
  if (json.byteLength <= 0 || json.byteLength > ROM_PACK_MAX_HEADER_BYTES) throw new Error('8BG 文件头大小异常')
  const out = new Uint8Array(ROM_PACK_HEADER_PREFIX_BYTES + json.byteLength)
  out.set(encoder.encode(ROM_PACK_MAGIC_TEXT), 0)
  new DataView(out.buffer).setUint32(4, json.byteLength, true)
  out.set(json, ROM_PACK_HEADER_PREFIX_BYTES)
  return out
}

export function romPackHeaderLength(prefix) {
  const b = prefix instanceof Uint8Array ? prefix : new Uint8Array(prefix)
  if (b.byteLength < ROM_PACK_HEADER_PREFIX_BYTES || !isRomPackBytes(b)) throw new Error('不是 8BG ROM 容器')
  const length = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(4, true)
  if (length <= 0 || length > ROM_PACK_MAX_HEADER_BYTES) throw new Error('8BG 文件头大小异常')
  return length
}

export function parseRomPackHeader(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const length = romPackHeaderLength(b)
  const dataOffset = ROM_PACK_HEADER_PREFIX_BYTES + length
  if (b.byteLength < dataOffset) throw new Error('8BG 文件头下载不完整')
  let header
  try {
    header = JSON.parse(decoder.decode(b.subarray(ROM_PACK_HEADER_PREFIX_BYTES, dataOffset)))
  } catch {
    throw new Error('8BG 文件头不是有效 JSON')
  }
  validateRomPackHeader(header)
  return { header, dataOffset }
}

export function validateRomPackHeader(header) {
  if (!header || typeof header !== 'object' || header.version !== ROM_PACK_VERSION) throw new Error('不支持的 8BG 容器版本')
  if (!/^[a-f0-9]{32}$/i.test(header.packageId || '')) throw new Error('8BG packageId 无效')
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(header.keyId || '')) throw new Error('8BG keyId 无效')
  if (!Object.values(ROM_PACK_CODEC).includes(header.codec)) throw new Error(`不认识的 8BG 压缩算法：${header.codec || '空'}`)
  if (header.cipher !== 'aes-256-gcm') throw new Error(`不认识的 8BG 加密算法：${header.cipher || '空'}`)
  const badOriginalName = typeof header.originalName !== 'string' || [...(header.originalName || '')].some((ch) => {
    const code = ch.codePointAt(0)
    return code < 32 || code === 127 || ch === '/' || ch === '\\'
  })
  if (badOriginalName || !header.originalName || header.originalName.length > 500) {
    throw new Error('8BG 原始文件名无效')
  }
  if (!Number.isSafeInteger(header.codecVersion) || header.codecVersion <= 0) throw new Error('8BG codec 版本无效')
  if (header.codecOptions != null && (!header.codecOptions || typeof header.codecOptions !== 'object' || Array.isArray(header.codecOptions) || Object.values(header.codecOptions).some((value) => !['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))))) {
    throw new Error('8BG codec 参数无效')
  }
  if (header.codec === ROM_PACK_CODEC.ZSTD && (!Number.isInteger(header.compressionLevel) || header.compressionLevel < 1 || header.compressionLevel > 22)) {
    throw new Error('8BG Zstd 等级无效')
  }
  if (!Number.isSafeInteger(header.originalSize) || header.originalSize <= 0) throw new Error('8BG 原始大小无效')
  if (!Number.isSafeInteger(header.chunkSize) || header.chunkSize < 64 * 1024 || header.chunkSize > 64 * 1024 * 1024) {
    throw new Error('8BG 分块大小无效')
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(header.noncePrefix || '')) throw new Error('8BG nonce 前缀无效')
  if (!Array.isArray(header.chunks) || !header.chunks.length || header.chunks.length > 10000) throw new Error('8BG 分块表无效')

  const expectedChunks = Math.ceil(header.originalSize / header.chunkSize)
  if (header.chunks.length !== expectedChunks) throw new Error('8BG 分块数量与原文件不一致')

  let original = 0
  let payload = 0
  for (let index = 0; index < header.chunks.length; index++) {
    const chunk = header.chunks[index]
    if (!chunk || !Number.isSafeInteger(chunk.sourceSize) || chunk.sourceSize <= 0 || chunk.sourceSize > header.chunkSize) {
      throw new Error('8BG 原始分块大小无效')
    }
    const expectedSourceSize = index === header.chunks.length - 1
      ? header.originalSize - header.chunkSize * index
      : header.chunkSize
    if (chunk.sourceSize !== expectedSourceSize) throw new Error('8BG 分块边界无效')
    if (!Number.isSafeInteger(chunk.encodedSize) || chunk.encodedSize <= 0 || chunk.encodedSize > ROM_PACK_MAX_ENCODED_CHUNK_BYTES || !Number.isSafeInteger(chunk.cipherSize) || chunk.cipherSize !== chunk.encodedSize + 16) {
      throw new Error('8BG 密文分块大小无效')
    }
    if (header.codec === ROM_PACK_CODEC.STORE && chunk.encodedSize !== chunk.sourceSize) throw new Error('8BG store 分块大小无效')
    if (!/^[a-f0-9]{64}$/i.test(chunk.sha256 || '')) throw new Error('8BG 分块摘要无效')
    original += chunk.sourceSize
    payload += chunk.cipherSize
    if (!Number.isSafeInteger(original) || !Number.isSafeInteger(payload)) throw new Error('8BG 文件大小超出安全整数范围')
  }
  if (original !== header.originalSize) throw new Error('8BG 分块总大小与原文件不一致')
  if (header.payloadSize !== payload) throw new Error('8BG 密文总大小与分块表不一致')
  if (header.originalSha256 != null && !/^[a-f0-9]{64}$/i.test(header.originalSha256)) throw new Error('8BG 文件摘要无效')
  return header
}

/**
 * 每块的 AAD 把关键元数据和块号一起认证。文件头若被人改了文件名、大小或 codec，
 * AES-GCM 会在第一块就拒绝，而不是把错误内容继续交给模拟器。
 */
export function romPackAad(header, index) {
  const chunk = header.chunks[index]
  if (!chunk) throw new Error('8BG 分块号越界')
  return encoder.encode(JSON.stringify([
    '8bitgo-rom-pack', header.version, header.packageId, header.keyId, header.codec,
    header.codecVersion, header.compressionLevel ?? null, header.codecOptions ?? null, header.cipher,
    header.originalName, header.originalSize, header.chunkSize, index,
    chunk.sourceSize, chunk.encodedSize, chunk.sha256,
  ]))
}

/** 96 位 GCM IV：随机 64 位前缀 + 32 位块号；同一包里永不重复。 */
export function romPackIv(header, index) {
  const prefix = base64UrlToBytes(header.noncePrefix)
  if (prefix.byteLength !== 8) throw new Error('8BG nonce 前缀长度无效')
  const iv = new Uint8Array(12)
  iv.set(prefix)
  new DataView(iv.buffer).setUint32(8, index, false)
  return iv
}

/**
 * 读取单个 Zstd frame 自报的解压大小，并要求它和容器分块表一致。
 *
 * @bokuweb/zstd-wasm 会先相信 frame 里的 content size 再申请 WASM 内存。只在解压后检查
 * sourceSize 太迟了：一份拿公开数据密钥制作的恶意包可以在这里写几十 GB，播放器还没机会
 * 报“大小不符”就已被浏览器杀掉。本站打包器始终写 content size，所以不接受省略该字段的 frame。
 */
export function assertZstdFrameContentSize(value, expectedSize) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  if (bytes.byteLength < 6 || bytes[0] !== 0x28 || bytes[1] !== 0xb5 || bytes[2] !== 0x2f || bytes[3] !== 0xfd) {
    throw new Error('8BG Zstd frame 无效')
  }
  const descriptor = bytes[4]
  // Zstd v1 的 unused / reserved 位都必须是 0；放行未知含义只会让下面的字段偏移判断失真。
  if (descriptor & 0x18) throw new Error('8BG Zstd frame 使用了不支持的标志')
  const singleSegment = Boolean(descriptor & 0x20)
  const contentSizeFlag = descriptor >>> 6
  const dictionarySize = [0, 1, 2, 4][descriptor & 0x03]
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : contentSizeFlag === 1 ? 2 : contentSizeFlag === 2 ? 4 : 8
  if (!contentSizeBytes) throw new Error('8BG Zstd frame 没有声明解压大小')

  let at = 5 + (singleSegment ? 0 : 1) + dictionarySize
  if (bytes.byteLength < at + contentSizeBytes) throw new Error('8BG Zstd frame 头不完整')
  let declared = 0n
  for (let i = 0; i < contentSizeBytes; i++) declared |= BigInt(bytes[at + i]) << BigInt(i * 8)
  if (contentSizeBytes === 2) declared += 256n
  if (declared > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('8BG Zstd frame 解压大小过大')
  if (Number(declared) !== expectedSize) throw new Error('8BG Zstd frame 解压大小与分块表不一致')
}

export function bytesToBase64Url(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function base64UrlToBytes(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}
