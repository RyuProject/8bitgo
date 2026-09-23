/*
 * CS15 数据包的流式 store-ZIP 解析器。
 *
 * 这里故意只接受 method=0：外层 Brotli/gzip 已负责压缩，ZIP 内再压一层既不会明显变小，
 * 又会迫使浏览器为单个条目准备完整解压缓冲区。store 条目可以边下载、边验 CRC、边写 MEMFS。
 */

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let value = 0; value < 256; value++) {
    let crc = value
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    table[value] = crc >>> 0
  }
  return table
})()

function updateCrc32(crc, bytes) {
  for (let index = 0; index < bytes.length; index++) {
    crc = CRC32_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  }
  return crc >>> 0
}

export function safePackPath(value) {
  const name = String(value).replaceAll('\\', '/')
  if (!name || name.startsWith('/') || name.includes('\0')) return null
  const parts = name.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\x00-\x1f:]/.test(part))) return null
  return name
}

/**
 * @param {ReadableStream<Uint8Array>} stream
 * @param {{ mkdir?: (name: string) => void|Promise<void>, open: (name: string, size: number) => Promise<{ write: (chunk: Uint8Array) => void|Promise<void>, close: () => void|Promise<void> }>|{ write: (chunk: Uint8Array) => void|Promise<void>, close: () => void|Promise<void> } }} sink
 * @param {{ name?: string, files?: number, bytes?: number, maxBytes?: number, maxFileBytes?: number }} expected
 */
export async function unpackStoredZipStream(stream, sink, expected = {}) {
  const packName = expected.name || '资源包'
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const byteLimit = Number.isSafeInteger(expected.bytes)
    ? expected.bytes
    : (Number.isSafeInteger(expected.maxBytes) ? expected.maxBytes : 1280 * 1024 * 1024)
  const fileLimit = Number.isSafeInteger(expected.maxFileBytes) ? expected.maxFileBytes : 384 * 1024 * 1024
  let chunk = new Uint8Array(0)
  let offset = 0
  let ended = false
  let files = 0
  let bytes = 0

  async function refill() {
    while (offset >= chunk.length && !ended) {
      const next = await reader.read()
      ended = next.done
      chunk = next.value || new Uint8Array(0)
      offset = 0
    }
    return offset < chunk.length
  }

  async function readExact(length) {
    const out = new Uint8Array(length)
    let written = 0
    while (written < length) {
      if (!await refill()) throw new Error(`${packName} 提前结束（还缺 ${length - written} 字节）`)
      const take = Math.min(length - written, chunk.length - offset)
      out.set(chunk.subarray(offset, offset + take), written)
      offset += take
      written += take
    }
    return out
  }

  async function skip(length) {
    let remaining = length
    while (remaining > 0) {
      if (!await refill()) throw new Error(`${packName} 文件数据提前结束`)
      const take = Math.min(remaining, chunk.length - offset)
      offset += take
      remaining -= take
    }
  }

  async function copyFile(name, length, expectedCrc) {
    const target = await sink.open(name, length)
    let remaining = length
    let crc = 0xffffffff
    try {
      while (remaining > 0) {
        if (!await refill()) throw new Error(`${packName} 的 ${name} 提前结束`)
        const take = Math.min(remaining, chunk.length - offset)
        const part = chunk.subarray(offset, offset + take)
        await target.write(part)
        crc = updateCrc32(crc, part)
        offset += take
        remaining -= take
      }
    } finally {
      await target.close()
    }
    const actualCrc = (crc ^ 0xffffffff) >>> 0
    if (actualCrc !== expectedCrc) {
      throw new Error(`${packName} 的 ${name} CRC-32 不符（传输或 R2 对象已损坏）`)
    }
  }

  try {
    while (true) {
      const signatureBytes = await readExact(4)
      const signature = new DataView(signatureBytes.buffer).getUint32(0, true)
      // 每个文件已经由本地头、长度和 CRC 独立验完；中央目录不会再写进虚拟盘。
      if (signature === 0x02014b50 || signature === 0x06054b50) break
      if (signature !== 0x04034b50) {
        throw new Error(`${packName} ZIP 头损坏（0x${signature.toString(16)}）`)
      }

      const header = await readExact(26)
      const view = new DataView(header.buffer)
      const flags = view.getUint16(2, true)
      const method = view.getUint16(4, true)
      const expectedCrc = view.getUint32(10, true)
      const compressedSize = view.getUint32(14, true)
      const rawSize = view.getUint32(18, true)
      const nameLength = view.getUint16(22, true)
      const extraLength = view.getUint16(24, true)
      if (!nameLength || nameLength > 4096 || extraLength > 65535) throw new Error(`${packName} ZIP 条目头无效`)
      const rawName = decoder.decode(await readExact(nameLength))
      await skip(extraLength)

      if (flags & 0x01) throw new Error(`${packName} 含加密条目：${rawName}`)
      if (flags & 0x08) throw new Error(`${packName} 不支持 data descriptor：${rawName}`)
      if (method !== 0 || compressedSize !== rawSize) {
        throw new Error(`${packName} 必须是 store ZIP：${rawName}`)
      }
      const directory = rawName.endsWith('/')
      const name = safePackPath(directory ? rawName.slice(0, -1) : rawName)
      if (!name) throw new Error(`${packName} 含不安全路径：${rawName}`)
      if (rawSize > fileLimit) throw new Error(`${packName} 的 ${name} 单文件异常大`)
      if (bytes + rawSize > byteLimit) throw new Error(`${packName} 展开大小超过清单上限`)

      if (directory) {
        await sink.mkdir?.(name)
        await skip(compressedSize)
        continue
      }
      await copyFile(name, compressedSize, expectedCrc)
      files++
      bytes += rawSize
    }
  } finally {
    await reader.cancel().catch(() => {})
  }

  if (Number.isSafeInteger(expected.files) && files !== expected.files) {
    throw new Error(`${packName} 文件数不符（应为 ${expected.files}，实际 ${files}）`)
  }
  if (Number.isSafeInteger(expected.bytes) && bytes !== expected.bytes) {
    throw new Error(`${packName} 展开大小不符（应为 ${expected.bytes}，实际 ${bytes}）`)
  }
  return { files, bytes }
}
