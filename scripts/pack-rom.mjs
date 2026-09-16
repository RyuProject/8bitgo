#!/usr/bin/env node

/**
 * 把一份 ROM 制成 8BG 容器。默认 Zstd 19 + AES-256-GCM，按 8MB 原文分块。
 *
 * 用法：
 *   npm run rompack -- ./kof97.zip
 *   npm run rompack -- ./game.nds ./game.nds.8bg --name game.nds
 *
 * codec 只通过分发表接入。以后加 LZMA2 时在本文件、浏览器 Worker/播放器以及
 * unpack-rom.mjs 注册 `lzma2`；容器头负责分派，已存在的 zstd 包和数据库绑定都不用改。
 */
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import zstd from '@bokuweb/zstd-wasm'
import { activeRomPackKeyId, deriveRomPackKey } from '../server/src/rom-pack-key.js'
import {
  ROM_PACK_CHUNK_BYTES,
  ROM_PACK_CODEC,
  ROM_PACK_VERSION,
  bytesToBase64Url,
  encodeRomPackPrefix,
  romPackAad,
  romPackIv,
} from '../shared/rom-pack-format.js'

try { process.loadEnvFile(path.resolve('server/.env')) } catch { /* CI 和显式环境变量不需要文件。 */ }

const args = process.argv.slice(2)
const positional = []
let originalName = ''
let codec = ROM_PACK_CODEC.ZSTD
let level = 19
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--name') originalName = args[++i] || ''
  else if (args[i] === '--codec') codec = args[++i] || ''
  else if (args[i] === '--level') level = Number(args[++i])
  else positional.push(args[i])
}

if (!positional[0]) {
  console.error('用法：npm run rompack -- <输入 ROM> [输出.8bg] [--name 原文件名] [--codec zstd|store] [--level 19]')
  process.exit(2)
}
if (codec === ROM_PACK_CODEC.ZSTD && (!Number.isInteger(level) || level < 1 || level > 22)) throw new Error('Zstd 等级必须是 1..22')

const input = path.resolve(positional[0])
const output = path.resolve(positional[1] || `${input}.8bg`)
const tempId = `${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`
const payloadTemp = `${output}.payload-${tempId}`
const outputTemp = `${output}.tmp-${tempId}`
const inputInfo = await stat(input)
if (!inputInfo.isFile() || inputInfo.size <= 0) throw new Error('输入必须是非空文件')
originalName ||= path.basename(input)

const CODECS = {
  [ROM_PACK_CODEC.STORE]: {
    version: 1,
    init: async () => {},
    encode: (source) => source,
  },
  [ROM_PACK_CODEC.ZSTD]: {
    version: 1,
    init: () => zstd.init(),
    encode: (source) => zstd.compress(source, level),
  },
  // 后续 LZMA2 只在这里注册；容器、加密、上传、数据库和播放器入口都不需要改。
}
const codecImpl = CODECS[codec]
if (!codecImpl) throw new Error(`当前打包器没有 ${codec} 编码器`)
await codecImpl.init()

const packageId = randomBytes(16).toString('hex')
const keyId = activeRomPackKeyId()
const key = deriveRomPackKey(packageId, keyId)
const noncePrefix = randomBytes(8)
const chunks = []
const wholeHash = createHash('sha256')
let payloadSize = 0
let inputHandle
let payloadHandle

/** FileHandle.write 允许短写；8MB 密文只调一次会在极端 I/O 压力下悄悄留下截断 payload。 */
async function writeAll(handle, data) {
  let offset = 0
  while (offset < data.byteLength) {
    const { bytesWritten } = await handle.write(data, offset, data.byteLength - offset)
    if (bytesWritten <= 0) throw new Error('写入 ROM 包临时文件时没有取得进展')
    offset += bytesWritten
  }
}

try {
  // 输出目录以前到最后拼文件时才创建；指定一个尚不存在的目录会先在这里开临时文件失败。
  await mkdir(path.dirname(output), { recursive: true })
  inputHandle = await open(input, 'r')
  payloadHandle = await open(payloadTemp, 'wx')
  let at = 0
  for (let index = 0; at < inputInfo.size; index++) {
    const size = Math.min(ROM_PACK_CHUNK_BYTES, inputInfo.size - at)
    const source = Buffer.allocUnsafe(size)
    const { bytesRead } = await inputHandle.read(source, 0, size, at)
    if (bytesRead !== size) throw new Error(`读取不完整：${at} 处期望 ${size}，实际 ${bytesRead}`)
    wholeHash.update(source)
    const encoded = Buffer.from(codecImpl.encode(source))
    const chunk = {
      sourceSize: source.byteLength,
      encodedSize: encoded.byteLength,
      cipherSize: encoded.byteLength + 16,
      sha256: createHash('sha256').update(source).digest('hex'),
    }
    chunks.push(chunk)

    // AAD 需要完整文件头形状，但只读取当前块和不会再变化的字段。
    const aadHeader = {
      version: ROM_PACK_VERSION, packageId, keyId, codec,
      codecVersion: codecImpl.version,
      ...(codec === ROM_PACK_CODEC.ZSTD ? { compressionLevel: level } : {}),
      codecOptions: {},
      cipher: 'aes-256-gcm', originalName,
      originalSize: inputInfo.size, chunkSize: ROM_PACK_CHUNK_BYTES,
      noncePrefix: bytesToBase64Url(noncePrefix), chunks,
    }
    const cipher = createCipheriv('aes-256-gcm', key, romPackIv(aadHeader, index))
    cipher.setAAD(Buffer.from(romPackAad(aadHeader, index)))
    const encrypted = Buffer.concat([cipher.update(encoded), cipher.final(), cipher.getAuthTag()])
    await writeAll(payloadHandle, encrypted)
    payloadSize += encrypted.byteLength
    at += size
    process.stdout.write(`\r${Math.round((at / inputInfo.size) * 100)}%  ${Math.round(at / 1048576)} / ${Math.round(inputInfo.size / 1048576)} MB`)
  }
  await inputHandle.close()
  inputHandle = undefined
  await payloadHandle.close()
  payloadHandle = undefined

  const header = {
    version: ROM_PACK_VERSION,
    packageId,
    keyId,
    codec,
    codecVersion: codecImpl.version,
    ...(codec === ROM_PACK_CODEC.ZSTD ? { compressionLevel: level } : {}),
    codecOptions: {},
    cipher: 'aes-256-gcm',
    originalName,
    originalSize: inputInfo.size,
    originalSha256: wholeHash.digest('hex'),
    chunkSize: ROM_PACK_CHUNK_BYTES,
    noncePrefix: bytesToBase64Url(noncePrefix),
    chunks,
    payloadSize,
    createdAt: new Date().toISOString(),
  }

  /*
    先在同目录拼成完整临时文件，再一次 rename。原实现直接用 'w' 截断正式输出：磁盘满、
    进程被杀或 payload 读取失败时，会把上一份可用包变成半截文件。rename 在同一文件系统内
    是原子的，失败时旧包仍完整存在。
  */
  await writeFile(outputTemp, encodeRomPackPrefix(header), { flag: 'wx' })
  await pipeline(createReadStream(payloadTemp), createWriteStream(outputTemp, { flags: 'a' }))
  await rename(outputTemp, output)
} finally {
  await Promise.allSettled([
    inputHandle?.close(),
    payloadHandle?.close(),
    rm(payloadTemp, { force: true }),
    rm(outputTemp, { force: true }),
  ])
}

const outputInfo = await stat(output)
process.stdout.write('\n')
console.log(`完成：${output}`)
console.log(`codec=${codec}${codec === ROM_PACK_CODEC.ZSTD ? ` level=${level}` : ''}  ${inputInfo.size} -> ${outputInfo.size} 字节（${(outputInfo.size / inputInfo.size * 100).toFixed(1)}%）`)
