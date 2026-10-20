/**
 * 服务端 8BG → 原生 ROM 转码（开放平台中间件）。
 *
 * 浏览器端在 Worker 里做 zstd + AES-256-GCM 的解码；低端设备（ESP32 之类）没这能力，
 * 于是把这一步挪到服务端：开放平台用 appid+key 换来的签名凭据（和 /v1/rom/:grant 同一张票）
 * 调本模块，服务端取回 8BG 对象、逐块解密解压、把明文 ROM 流式吐回去。
 *
 * 安全面（转码是 CPU + 带宽开销，必须挡住放大的那一侧）：
 *   · 不落盘 —— 边解边吐，峰值内存约等于一个分块（8MB）。
 *   · 每块都校验 sha256 与声明的 sourceSize，zip-bomb 级别的恶意包在单块边界就被挡下。
 *   · 密钥不落库：直接复用 rom-pack-key.js 的 deriveRomPackKey（ROM_PACK_SECRET 派生）。
 *   · 单 ROM 大小上限、全局并发闸、按 AppID/IP 限流都在路由层（open.js）收口，超额拒服务。
 */
import { createDecipheriv, createHash } from 'node:crypto'
import zlib from 'node:zlib'
import { deriveRomPackKey } from './rom-pack-key.js'
import { envNumber } from './resource-limits.js'
import {
  ROM_PACK_CODEC,
  ROM_PACK_HEADER_PREFIX_BYTES,
  ROM_PACK_MAX_ENCODED_CHUNK_BYTES,
  ROM_PACK_MAX_HEADER_BYTES,
  assertZstdFrameContentSize,
  isRomPackBytes,
  parseRomPackHeader,
  romPackAad,
  romPackHeaderLength,
  romPackInnerName,
  romPackIv,
} from '../../shared/rom-pack-format.js'

/** 单 ROM 转码上限：默认 512MB / 2 并发 / 10 分钟，环境可覆盖。超额直接拒服务，不是排队。 */
export function romTranscodeLimits(env = process.env) {
  return {
    /*
      这三项不能只判 NaN：`1e100` 也是合法数字，却会把大小闸变成摆设；小数并发则会
      让实际槽位向上取整。统一走有上下界的解析，填错时宁可回安全默认值或收紧。
    */
    maxBytes: envNumber('ROM_TRANSCODE_MAX_BYTES', 512 * 1024 * 1024, {
      min: 1024 * 1024,
      max: 8 * 1024 * 1024 * 1024,
      source: env,
    }),
    concurrency: envNumber('ROM_TRANSCODE_CONCURRENCY', 2, { max: 32, source: env }),
    timeoutMs: envNumber('ROM_TRANSCODE_TIMEOUT_MS', 10 * 60 * 1000, {
      min: 1000,
      max: 60 * 60 * 1000,
      source: env,
    }),
  }
}

/* ------------------------------------------------------------------ *
 * 全局并发闸：服务端转码是 CPU + 带宽开销，不能无上限并行。
 * ------------------------------------------------------------------ */

let activeTranscodes = 0

export function tryAcquireTranscodeSlot(limits = romTranscodeLimits()) {
  if (activeTranscodes >= limits.concurrency) return false
  activeTranscodes += 1
  return true
}

export function releaseTranscodeSlot() {
  if (activeTranscodes > 0) activeTranscodes -= 1
}

/* ------------------------------------------------------------------ *
 * zstd 解码：优先原生 node:zlib，回退 @bokuweb/zstd-wasm（根目录依赖）。
 * ------------------------------------------------------------------ */

let zstdImpl = null

async function resolveZstd() {
  if (zstdImpl) return zstdImpl
  // Node 22+ 自带 zstd（取决于构建是否带 zlib）。优先它：无需新依赖、无 WASM 初始化开销。
  if (typeof zlib.zstdDecompressSync === 'function') {
    zstdImpl = { kind: 'native', decompress: (buf) => Buffer.from(zlib.zstdDecompressSync(buf)) }
    return zstdImpl
  }
  // 兜底：根目录已装 @bokuweb/zstd-wasm（脚本和打包器在用）。动态 import 让 server 不强制依赖它。
  try {
    const mod = await import('@bokuweb/zstd-wasm')
    await mod.default.init()
    zstdImpl = { kind: 'wasm', decompress: (buf) => Buffer.from(mod.default.decompress(buf)) }
    return zstdImpl
  } catch {
    throw new Error('服务端缺少可用的 zstd 解码器（需要 Node 22+ 的 zlib，或 @bokuweb/zstd-wasm）')
  }
}

export { resolveZstd }

/* ------------------------------------------------------------------ *
 * 流式读取：把一个 async iterator of Buffer 包成「精确读 N 字节」。
 * 多出的尾巴留到下一次读，避免把一块的剩余字节丢给下一块。
 * ------------------------------------------------------------------ */

export class ByteReader {
  constructor(iter) {
    this.iter = iter
    this.left = null
    this.leftPos = 0
  }

  static fromWeb(body) {
    if (!body || typeof body[Symbol.asyncIterator] !== 'function') throw new Error('上游响应没有可读流')
    return new ByteReader(body[Symbol.asyncIterator]())
  }

  async readExactly(size) {
    if (!Number.isInteger(size) || size < 0) throw new Error('readExactly 大小无效')
    const out = Buffer.allocUnsafe(size)
    let filled = 0
    while (filled < size) {
      if (this.left) {
        const avail = this.left.byteLength - this.leftPos
        const take = Math.min(avail, size - filled)
        this.left.copy(out, filled, this.leftPos, this.leftPos + take)
        this.leftPos += take
        filled += take
        if (this.leftPos >= this.left.byteLength) { this.left = null; this.leftPos = 0 }
        continue
      }
      const { value, done } = await this.iter.next()
      if (done) throw new Error('ROM 数据在传输中提前结束')
      // fetch 给的是 Uint8Array；共享底层缓冲区，避免每个网络片先复制一次再拷进目标块。
      this.left = Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      this.leftPos = 0
    }
    return out
  }

  async skipExactly(size) {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('skipExactly 大小无效')
    // 忽略 Range 的源站会回整包。逐片丢弃前缀，不能为盘尾偏移分配一个 GB 级 Buffer。
    let remaining = size
    while (remaining > 0) {
      if (this.left) {
        const take = Math.min(this.left.byteLength - this.leftPos, remaining)
        this.leftPos += take
        remaining -= take
        if (this.leftPos >= this.left.byteLength) { this.left = null; this.leftPos = 0 }
        continue
      }
      const { value, done } = await this.iter.next()
      if (done) throw new Error('ROM 数据在传输中提前结束')
      this.left = Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      this.leftPos = 0
    }
  }

  async cancel() {
    // fromWeb 用的是 async iterator，期间流被它锁住；直接 body.cancel() 会被拒绝。
    await this.iter.return?.()
  }
}

/** Range 的末尾编号是闭区间；后续分块计划统一使用半开区间。 */
export function parseRomByteRange(header, total) {
  if (!Number.isSafeInteger(total) || total < 0) throw new RangeError('ROM 大小无效')
  const value = String(header || '').trim()
  if (!value) return { start: 0, end: total, isRange: false }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value)
  const invalid = { unsatisfiable: true, total }
  if (!match || (!match[1] && !match[2]) || total === 0) return invalid
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix < 1) return invalid
    return { start: Math.max(0, total - suffix), end: total, isRange: true }
  }
  const start = Number(match[1])
  const last = match[2] ? Number(match[2]) : total - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(last) || start >= total || last < start) return invalid
  return { start, end: Math.min(total, last + 1), isRange: true }
}

/* ------------------------------------------------------------------ *
 * 纯逻辑：分块计划 & 单块解密。单测直接打这两块。
 * ------------------------------------------------------------------ */

/**
 * 把输出的 [start, end) 字节范围映射到需要解密的分块。
 * 每个分块独立压缩+加密，所以支持 Range：只解压命中范围的块，并裁剪头尾。
 * @returns {Array<{index:number, skipHead:number, takeLen:number}>}
 */
export function planRomPackChunks(header, start = 0, end = header.originalSize) {
  const total = Number(header.originalSize)
  const from = Math.max(0, Math.floor(Number(start)) || 0)
  const to = Math.min(total, Number.isFinite(end) ? Math.floor(Number(end)) : total)
  const plan = []
  if (from >= to) return plan
  let acc = 0
  for (let i = 0; i < header.chunks.length; i++) {
    const size = header.chunks[i].sourceSize
    const chunkStart = acc
    const chunkEnd = acc + size
    acc = chunkEnd
    if (chunkEnd <= from) continue
    if (chunkStart >= to) break
    const skipHead = Math.max(0, from - chunkStart)
    const takeLen = Math.min(size, to - chunkStart) - skipHead
    if (takeLen <= 0) continue
    plan.push({ index: i, skipHead, takeLen })
  }
  return plan
}

/**
 * 解密 + 解压单个分块，并就地校验。返回该块解压后的明文（完整 sourceSize 字节）。
 * 校验失败（GCM tag / zstd 声明大小 / sha256 / sourceSize）会抛错 —— 调用方据此中断整个转码。
 */
export async function decryptRomPackChunk({ header, key, index, encrypted }) {
  const meta = header.chunks[index]
  if (!meta) throw new Error(`ROM 包没有第 ${index + 1} 块`)
  if (encrypted.byteLength !== meta.cipherSize) {
    throw new Error(`ROM 包第 ${index + 1} 块密文长度不符（期望 ${meta.cipherSize}）`)
  }
  const cipher = encrypted.subarray(0, meta.encodedSize)
  const tag = encrypted.subarray(meta.encodedSize)
  const decipher = createDecipheriv('aes-256-gcm', key, romPackIv(header, index))
  decipher.setAAD(Buffer.from(romPackAad(header, index)))
  decipher.setAuthTag(tag)
  let encoded
  try {
    encoded = Buffer.concat([decipher.update(cipher), decipher.final()])
  } catch {
    throw new Error(`ROM 包第 ${index + 1} 块解密失败：文件损坏或服务端密钥不匹配`)
  }
  let source
  if (header.codec === ROM_PACK_CODEC.STORE) {
    source = Buffer.from(encoded)
  } else if (header.codec === ROM_PACK_CODEC.ZSTD) {
    const z = await resolveZstd()
    assertZstdFrameContentSize(encoded, meta.sourceSize)
    source = z.decompress(encoded)
  } else {
    throw new Error(`不认识的 8BG 压缩算法：${header.codec || '空'}`)
  }
  if (source.byteLength !== meta.sourceSize) throw new Error(`ROM 包第 ${index + 1} 块解压大小不符`)
  if (createHash('sha256').update(source).digest('hex') !== meta.sha256) {
    throw new Error(`ROM 包第 ${index + 1} 块校验失败`)
  }
  return source
}

/* ------------------------------------------------------------------ *
 * 头解析
 * ------------------------------------------------------------------ */

/** 前 8 字节是否 8BG 魔法。用于路由层「是包就转码、不是包就透传」。 */
export function isRomPackHeadPrefix(bytes) {
  return isRomPackBytes(bytes)
}

/**
 * 从读取器里取前缀 + JSON 头。约定调用前已确认开头是 8BG 魔法（或至少前 8 字节可读）。
 */
export async function readRomPackHead(reader) {
  const prefix = await reader.readExactly(ROM_PACK_HEADER_PREFIX_BYTES)
  if (!isRomPackBytes(prefix)) throw new Error('不是 8BG ROM 容器')
  const headerLength = romPackHeaderLength(prefix)
  const head = Buffer.concat([prefix, await reader.readExactly(headerLength)])
  const { header, dataOffset } = parseRomPackHeader(head)
  return { header, dataOffset }
}

export {
  romPackInnerName,
  deriveRomPackKey,
  ROM_PACK_MAX_ENCODED_CHUNK_BYTES,
  ROM_PACK_MAX_HEADER_BYTES,
}
