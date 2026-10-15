/**
 * 8BitGo 通用存档容器。
 *
 * 模拟器真正吃的是 payload；外面的短文件头只负责在读取前回答三件事：
 *   1. 这是哪个运行时、哪款游戏、哪个槽位的存档；
 *   2. 它由哪一代核心生成；
 *   3. 文件有没有被截断或损坏。
 *
 * 旧存档没有 MAGIC 时仍按裸 payload 读取，升级不会把玩家已有文件作废。
 */

const MAGIC = new TextEncoder().encode('8BGSAVE1')
const PREFIX_BYTES = MAGIC.length + 4
const MAX_HEADER_BYTES = 64 * 1024

export interface SaveArchiveDetails {
  core?: string
  build?: string
  /** 有内容哈希时放哈希；暂时没有时，gameSlug 本身仍会做第一层身份校验。 */
  romFingerprint?: string
  format?: string
}

export interface SaveArchiveCoordinate {
  runtime: string
  gameSlug: string
  slot: number
}

export interface SaveArchiveHeader extends SaveArchiveCoordinate, SaveArchiveDetails {
  schema: 1
  createdAt: number
  payloadBytes: number
  checksum: string
}

export interface DecodedSaveArchive {
  payload: Uint8Array
  /** null 表示升级前的裸存档；调用方仍应允许读取。 */
  header: SaveArchiveHeader | null
}

function cleanDetail(value: string | undefined): string | undefined {
  if (!value) return undefined
  const next = value.trim()
  return next ? next.slice(0, 160) : undefined
}

function hex(bytes: Uint8Array): string {
  let out = ''
  for (const value of bytes) out += value.toString(16).padStart(2, '0')
  return out
}

function fnv1a(bytes: Uint8Array, initial = 0x811c9dc5): number {
  let hash = initial
  for (const value of bytes) {
    hash ^= value
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** WebView 没有 SubtleCrypto 时仍给一份校验；正常的小存档优先走原生 SHA-256。 */
async function checksum(bytes: Uint8Array, algorithm?: 'sha256' | 'fnv1a32'): Promise<string> {
  if (algorithm !== 'fnv1a32') {
    try {
      const subtle = globalThis.crypto?.subtle
      if (subtle) {
        const digest = await subtle.digest('SHA-256', bytes.slice().buffer)
        return `sha256:${hex(new Uint8Array(digest))}`
      }
    } catch {
      if (algorithm === 'sha256') throw new Error('当前浏览器无法校验这份 SHA-256 存档')
      /* 下面的 FNV 是兼容兜底，不能因为摘要 API 被策略禁用而让玩家无法存档。 */
    }
    if (algorithm === 'sha256') throw new Error('当前浏览器无法校验这份 SHA-256 存档')
  }
  const hash = fnv1a(bytes)
  return `fnv1a32:${hash.toString(16).padStart(8, '0')}`
}

function hasMagic(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC.length) return false
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return false
  return true
}

function archivePrefix(
  coordinate: SaveArchiveCoordinate,
  details: SaveArchiveDetails,
  createdAt: number,
  payloadBytes: number,
  payloadChecksum: string,
): Uint8Array {
  const header: SaveArchiveHeader = {
    schema: 1,
    runtime: coordinate.runtime,
    gameSlug: coordinate.gameSlug,
    slot: coordinate.slot,
    createdAt,
    payloadBytes,
    checksum: payloadChecksum,
    core: cleanDetail(details.core),
    build: cleanDetail(details.build),
    romFingerprint: cleanDetail(details.romFingerprint),
    format: cleanDetail(details.format),
  }
  const headerBytes = new TextEncoder().encode(JSON.stringify(header))
  if (!headerBytes.length || headerBytes.length > MAX_HEADER_BYTES) throw new Error('存档文件头太大')

  const out = new Uint8Array(PREFIX_BYTES + headerBytes.length)
  out.set(MAGIC, 0)
  new DataView(out.buffer).setUint32(MAGIC.length, headerBytes.length, true)
  out.set(headerBytes, PREFIX_BYTES)
  return out
}

export async function encodeSaveArchive(
  payload: Uint8Array,
  coordinate: SaveArchiveCoordinate,
  details: SaveArchiveDetails = {},
  createdAt = Date.now(),
): Promise<Uint8Array> {
  if (!payload.length) throw new Error('存档是空的')
  const prefix = archivePrefix(coordinate, details, createdAt, payload.length, await checksum(payload))
  const out = new Uint8Array(prefix.length + payload.length)
  out.set(prefix, 0)
  out.set(payload, prefix.length)
  return out
}

/**
 * 大型 Dolphin / PSP 状态直接下载时不能先整体转成 ArrayBuffer：256MB 的 Blob 再复制两遍，
 * 移动端很容易在“保存成功后准备下载”这一步反而 OOM。逐片计算校验并用 Blob 拼接，不复制正文。
 */
export async function encodeSaveArchiveBlob(
  payload: Blob,
  coordinate: SaveArchiveCoordinate,
  details: SaveArchiveDetails = {},
  createdAt = Date.now(),
): Promise<Blob> {
  if (!payload.size) throw new Error('存档是空的')
  let hash = 0x811c9dc5
  const chunkBytes = 1024 * 1024
  for (let offset = 0; offset < payload.size; offset += chunkBytes) {
    const chunk = new Uint8Array(await payload.slice(offset, offset + chunkBytes).arrayBuffer())
    hash = fnv1a(chunk, hash)
  }
  const digest = `fnv1a32:${hash.toString(16).padStart(8, '0')}`
  const prefix = archivePrefix(coordinate, details, createdAt, payload.size, digest)
  return new Blob([prefix as BlobPart, payload], { type: 'application/octet-stream' })
}

export async function decodeSaveArchive(
  bytes: Uint8Array,
  expected?: Partial<SaveArchiveCoordinate>,
): Promise<DecodedSaveArchive> {
  // 兼容上线前已经存在的云端、本地和手工导出文件。
  if (!hasMagic(bytes)) return { payload: bytes, header: null }
  if (bytes.length < PREFIX_BYTES) throw new Error('存档文件头不完整')

  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(MAGIC.length, true)
  if (!headerLength || headerLength > MAX_HEADER_BYTES || PREFIX_BYTES + headerLength > bytes.length) {
    throw new Error('存档文件头损坏')
  }

  let header: SaveArchiveHeader
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + headerLength))) as SaveArchiveHeader
  } catch {
    throw new Error('存档文件头无法解析')
  }
  if (
    header?.schema !== 1 ||
    typeof header.runtime !== 'string' ||
    typeof header.gameSlug !== 'string' ||
    !Number.isInteger(header.slot) ||
    !Number.isInteger(header.payloadBytes) ||
    typeof header.checksum !== 'string'
  ) {
    throw new Error('存档文件头格式不正确')
  }
  if (expected?.runtime !== undefined && header.runtime !== expected.runtime) throw new Error('这份存档来自另一个模拟器')
  if (expected?.gameSlug !== undefined && header.gameSlug !== expected.gameSlug) throw new Error('这份存档属于另一款游戏')
  if (expected?.slot !== undefined && header.slot !== expected.slot) throw new Error('这份存档属于另一个存档位')

  const payload = bytes.slice(PREFIX_BYTES + headerLength)
  if (payload.length !== header.payloadBytes) throw new Error('存档文件不完整')
  const algorithm = header.checksum.startsWith('fnv1a32:') ? 'fnv1a32' : 'sha256'
  if ((await checksum(payload, algorithm)) !== header.checksum) throw new Error('存档校验失败，文件可能已损坏')
  return { payload, header }
}
