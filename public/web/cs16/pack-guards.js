const MIB = 1024 * 1024

export const MAX_CATALOG_BYTES = 256 * 1024
export const MAX_BUFFERED_RESOURCE_BYTES = 20 * MIB
export const MAX_ZSTD_CHUNK_RAW_BYTES = 16 * MIB
export const MAX_ZSTD_CHUNK_COMPRESSED_BYTES = 20 * MIB

const MAX_BASE_RAW_BYTES = 160 * MIB
const MAX_BASE_COMPRESSED_BYTES = 128 * MIB
const MAX_MAP_RAW_BYTES = 60 * MIB
const MAX_MAP_COMPRESSED_BYTES = 60 * MIB
const SHA256_RE = /^[a-f0-9]{64}$/
const ZSTD_FORMAT = '8bitgo.cs16.zstd-chunks.v1'

export function packLimits(key) {
  return key === 'base'
    ? { rawBytes: MAX_BASE_RAW_BYTES, compressedBytes: MAX_BASE_COMPRESSED_BYTES, chunks: 10 }
    : { rawBytes: MAX_MAP_RAW_BYTES, compressedBytes: MAX_MAP_COMPRESSED_BYTES, chunks: 4 }
}

/**
 * 清单来自可单独更新的 R2；即使对象误传或边缘缓存损坏，也不能让一份 JSON 指挥浏览器
 * 下载几 GB 数据并在校验发生前 OOM。这里的上限比当前最大产物留有余量，但低于 512MB 引擎上限。
 */
export function validatePackCatalog(catalog) {
  if (!catalog || catalog.format !== ZSTD_FORMAT || !catalog.packs || typeof catalog.packs !== 'object' || Array.isArray(catalog.packs)) {
    throw new Error('Incompatible CS1.6 Zstd manifest format')
  }
  if (catalog.compression?.algorithm !== 'zstd' || catalog.compression?.chunkRawBytes !== MAX_ZSTD_CHUNK_RAW_BYTES) {
    throw new Error('Incompatible compression parameters in CS1.6 Zstd manifest')
  }

  const entries = Object.entries(catalog.packs)
  if (!entries.length || entries.length > 64) throw new Error('Invalid pack count in CS1.6 Zstd manifest')
  const chunksByCompressedHash = new Map()

  for (const [key, pack] of entries) {
    if (!(key === 'base' || /^maps\/[a-z0-9_]+$/.test(key))) throw new Error(`Invalid pack name in Zstd manifest: ${key}`)
    const limits = packLimits(key)
    if (!pack || typeof pack !== 'object' || Array.isArray(pack) ||
        !Number.isSafeInteger(pack.rawBytes) || pack.rawBytes <= 0 || pack.rawBytes > limits.rawBytes ||
        !Number.isSafeInteger(pack.compressedBytes) || pack.compressedBytes <= 0 || pack.compressedBytes > limits.compressedBytes ||
        !SHA256_RE.test(pack.rawSha256) || !Array.isArray(pack.chunks) || !pack.chunks.length || pack.chunks.length > limits.chunks) {
      throw new Error(`Invalid metadata for ${key} in Zstd manifest`)
    }

    let rawBytes = 0, compressedBytes = 0
    pack.chunks.forEach((chunk, index) => {
      if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk) ||
          chunk.index !== index || chunk.path !== `chunks/${chunk.compressedSha256}.zst` ||
          !SHA256_RE.test(chunk.compressedSha256) || !SHA256_RE.test(chunk.rawSha256) ||
          !Number.isSafeInteger(chunk.rawBytes) || chunk.rawBytes <= 0 || chunk.rawBytes > MAX_ZSTD_CHUNK_RAW_BYTES ||
          !Number.isSafeInteger(chunk.compressedBytes) || chunk.compressedBytes <= 0 || chunk.compressedBytes > MAX_ZSTD_CHUNK_COMPRESSED_BYTES) {
        throw new Error(`Invalid chunk ${index + 1} for ${key} in Zstd manifest`)
      }

      // Promise 缓存按压缩哈希去重；同一哈希若带两套解压元数据，会让后一次绕过自己的校验。
      const metadata = `${chunk.compressedBytes}:${chunk.rawBytes}:${chunk.rawSha256}`
      const previous = chunksByCompressedHash.get(chunk.compressedSha256)
      if (previous && previous !== metadata) throw new Error(`Conflicting metadata for chunk ${chunk.compressedSha256}`)
      chunksByCompressedHash.set(chunk.compressedSha256, metadata)
      rawBytes += chunk.rawBytes
      compressedBytes += chunk.compressedBytes
    })
    if (rawBytes !== pack.rawBytes || compressedBytes !== pack.compressedBytes) {
      throw new Error(`Total length mismatch for ${key} in Zstd manifest`)
    }
  }
  return catalog
}
