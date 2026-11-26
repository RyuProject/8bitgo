/** R2 游戏 ROM / BIOS 的 SHA-256 分块清单；哈希块与光盘读取器的最小单位对齐。 */
export const ROM_INTEGRITY_BLOCK_BYTES = 2 * 1024 * 1024
export const ROM_INTEGRITY_MAX_BLOCKS = 2_560
const encoder = new TextEncoder()

export interface RomIntegrityManifest {
  v: 1
  alg: 'sha256'
  key: string
  etag: string
  size: number
  blockBytes: number
  blocks: string[]
}

export type RomIntegrityManifestPayload = Omit<RomIntegrityManifest, 'etag'>

export function isIntegrityKey(key: string): boolean {
  return typeof key === 'string' && key.startsWith('roms/') && key.length <= 1024 &&
    encoder.encode(key).byteLength <= 1024 && !key.startsWith('roms/covers/') &&
    !key.includes('..') && !key.includes('\\') && !/[\x00-\x1f\x7f]/.test(key) && !key.endsWith('/')
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256(bytes: BufferSource): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('此浏览器不能为 ROM / BIOS 生成 SHA-256 校验清单，请换用 HTTPS 下的现代浏览器')
  return hex(new Uint8Array(await subtle.digest('SHA-256', bytes)))
}

/** 管理员上传时分块取 Blob，限制并发，避免大 ISO 同时占用大量临时内存。 */
export async function createRomIntegrityManifest(file: Blob, key: string, signal?: AbortSignal): Promise<RomIntegrityManifestPayload> {
  if (!isIntegrityKey(key)) throw new Error('完整性清单只接受 roms/ 下的游戏 ROM 与 BIOS')
  if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error('空文件不能发布 ROM / BIOS 校验清单')
  const count = Math.ceil(file.size / ROM_INTEGRITY_BLOCK_BYTES)
  if (count > ROM_INTEGRITY_MAX_BLOCKS) throw new Error('ROM / BIOS 超过完整性清单支持的最大体积')

  const blocks: string[] = []
  // 四块并行足以隐藏在上传耗时里；不把整份大文件读入 ArrayBuffer。
  for (let first = 0; first < count; first += 4) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
    const batch = await Promise.all(Array.from({ length: Math.min(4, count - first) }, async (_, offset) => {
      const start = (first + offset) * ROM_INTEGRITY_BLOCK_BYTES
      return sha256(await file.slice(start, Math.min(file.size, start + ROM_INTEGRITY_BLOCK_BYTES)).arrayBuffer())
    }))
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
    blocks.push(...batch)
  }

  return { v: 1, alg: 'sha256', key, size: file.size, blockBytes: ROM_INTEGRITY_BLOCK_BYTES, blocks }
}

export function validateRomIntegrityManifest(
  value: unknown,
  key: string,
  etag: string,
  size: number,
): RomIntegrityManifest | null {
  if (!value || typeof value !== 'object') return null
  const manifest = value as Partial<RomIntegrityManifest>
  const count = Math.ceil(size / ROM_INTEGRITY_BLOCK_BYTES)
  if (!Number.isSafeInteger(size) || size <= 0 || count <= 0 || count > ROM_INTEGRITY_MAX_BLOCKS ||
      manifest.v !== 1 || manifest.alg !== 'sha256' || manifest.key !== key || manifest.etag !== etag ||
      manifest.size !== size || manifest.blockBytes !== ROM_INTEGRITY_BLOCK_BYTES ||
      !Array.isArray(manifest.blocks) || manifest.blocks.length !== count ||
      manifest.blocks.some((hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) return null
  return manifest as RomIntegrityManifest
}
