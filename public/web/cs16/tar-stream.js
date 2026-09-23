const BLOCK = 512
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

const decoder = new TextDecoder()

function fieldText(block, start, length) {
  const end = block.subarray(start, start + length).indexOf(0)
  return decoder.decode(block.subarray(start, start + (end < 0 ? length : end))).trim()
}

function octal(block, start, length, label) {
  const raw = fieldText(block, start, length)
  if (!raw) return 0
  if (!/^[0-7]+$/.test(raw)) throw new Error(`TAR 的 ${label} 不是八进制数`)
  const value = Number.parseInt(raw, 8)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`TAR 的 ${label} 超出范围`)
  return value
}

export function safePackPath(value) {
  const path = String(value ?? '')
  if (!path || path.startsWith('/') || path.includes('\\') || /^[a-z]:/i.test(path)) return null
  // 资产最终写入 Emscripten 根文件系统；外部 packsroot 也不能借 ../ 覆盖引擎动态库。
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f:]/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) return null
  return path
}

class StreamCursor {
  constructor(stream) {
    this.reader = stream.getReader()
    this.queue = []
    this.queued = 0
    this.done = false
    this.read = 0
  }

  async fill(size) {
    while (this.queued < size && !this.done) {
      const next = await this.reader.read()
      this.done = next.done
      if (next.value?.byteLength) {
        this.queue.push(next.value)
        this.queued += next.value.byteLength
      }
    }
    if (this.queued < size) throw new Error('TAR 数据提前结束')
  }

  async take(size) {
    if (!size) return new Uint8Array(0)
    await this.fill(size)
    const out = new Uint8Array(size)
    let written = 0
    while (written < size) {
      const head = this.queue[0]
      const count = Math.min(head.byteLength, size - written)
      out.set(head.subarray(0, count), written)
      written += count
      this.queued -= count
      if (count === head.byteLength) this.queue.shift()
      else this.queue[0] = head.subarray(count)
    }
    this.read += size
    return out
  }
}

function verifyChecksum(block) {
  const expected = octal(block, 148, 8, '校验和')
  let actual = 0
  for (let i = 0; i < block.length; i++) actual += i >= 148 && i < 156 ? 32 : block[i]
  if (actual !== expected) throw new Error(`TAR 头校验失败（期望 ${expected}，实际 ${actual}）`)
}

/**
 * 流式展开 ustar 包。每次只分配当前文件的大小，避免 800MB 资产包和 MEMFS 副本同时驻留。
 */
export async function unpackTarStream(stream, onFile, onProgress) {
  const cursor = new StreamCursor(stream)
  let files = 0
  let bytes = 0
  let zeroBlocks = 0
  for (;;) {
    const header = await cursor.take(BLOCK)
    if (header.every((value) => value === 0)) {
      zeroBlocks++
      if (zeroBlocks >= 2) return { files, bytes, streamBytes: cursor.read }
      continue
    }
    zeroBlocks = 0
    verifyChecksum(header)
    const name = fieldText(header, 0, 100)
    const prefix = fieldText(header, 345, 155)
    const fullName = prefix ? `${prefix}/${name}` : name
    const type = header[156]
    const size = octal(header, 124, 12, '文件长度')
    if (size > MAX_FILE_BYTES) throw new Error(`TAR 单文件过大：${fullName}（${size} 字节）`)
    if (bytes + size > MAX_TOTAL_BYTES) throw new Error('TAR 展开后超过 2GB 安全上限')

    const data = await cursor.take(size)
    const padding = (BLOCK - (size % BLOCK)) % BLOCK
    if (padding) await cursor.take(padding)
    if (type === 0 || type === 48) {
      const safe = safePackPath(fullName)
      if (!safe) throw new Error(`TAR 含不安全路径：${fullName}`)
      await onFile(safe, data)
      files++
      bytes += size
      onProgress?.({ files, bytes, streamBytes: cursor.read, name: safe })
    } else if (type !== 53) {
      throw new Error(`TAR 含不支持的条目类型 ${String.fromCharCode(type || 0)}：${fullName}`)
    }
  }
}
