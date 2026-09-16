#!/usr/bin/env node

/**
 * 在受信任服务器上把 8BG 还原成普通 ROM。cloud-game/libretro 不认识浏览器容器，
 * sync-roms.sh 会在同步 R2 后调用这里；逐块解密解压，峰值内存约一个分块。
 */
import { createDecipheriv, createHash } from 'node:crypto'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import zstd from '@bokuweb/zstd-wasm'
import { deriveRomPackKey } from '../server/src/rom-pack-key.js'
import {
  ROM_PACK_CODEC,
  ROM_PACK_HEADER_PREFIX_BYTES,
  assertZstdFrameContentSize,
  parseRomPackHeader,
  romPackAad,
  romPackHeaderLength,
  romPackIv,
} from '../shared/rom-pack-format.js'

try { process.loadEnvFile(path.resolve('server/.env')) } catch { /* 云联机机由 deploy/cloudgame/.env 导出。 */ }

const inputArg = process.argv[2]
if (!inputArg) {
  console.error('用法：npm run romunpack -- <输入.8bg> [输出 ROM]')
  process.exit(2)
}

const input = path.resolve(inputArg)
const defaultOutput = /\.8bg$/i.test(input) ? input.replace(/\.8bg$/i, '') : `${input}.unpacked`
const output = path.resolve(process.argv[3] || defaultOutput)
if (input === output) throw new Error('输入和输出不能是同一个文件')
const inputInfo = await stat(input)
if (!inputInfo.isFile() || inputInfo.size <= ROM_PACK_HEADER_PREFIX_BYTES) throw new Error('输入必须是非空 8BG 文件')

const temp = `${output}.tmp-${process.pid}-${Date.now()}`
let inputHandle
let outputHandle

async function readExactly(handle, size, position) {
  const out = Buffer.allocUnsafe(size)
  let offset = 0
  while (offset < size) {
    const { bytesRead } = await handle.read(out, offset, size - offset, position + offset)
    if (bytesRead <= 0) throw new Error(`8BG 文件在 ${position + offset} 处提前结束`)
    offset += bytesRead
  }
  return out
}

async function writeAll(handle, data) {
  let offset = 0
  while (offset < data.byteLength) {
    const { bytesWritten } = await handle.write(data, offset, data.byteLength - offset)
    if (bytesWritten <= 0) throw new Error('写入还原 ROM 时没有取得进展')
    offset += bytesWritten
  }
}

try {
  await mkdir(path.dirname(output), { recursive: true })
  inputHandle = await open(input, 'r')
  const prefix = await readExactly(inputHandle, ROM_PACK_HEADER_PREFIX_BYTES, 0)
  const headerLength = romPackHeaderLength(prefix)
  const head = Buffer.concat([
    prefix,
    await readExactly(inputHandle, headerLength, ROM_PACK_HEADER_PREFIX_BYTES),
  ])
  const { header, dataOffset } = parseRomPackHeader(head)
  if (dataOffset + header.payloadSize !== inputInfo.size) throw new Error('8BG 文件长度与文件头不一致')
  if (header.codecVersion !== 1) throw new Error(`当前解包器不支持 ${header.codec} codec v${header.codecVersion}`)
  if (header.codec === ROM_PACK_CODEC.ZSTD) await zstd.init()
  else if (header.codec !== ROM_PACK_CODEC.STORE) throw new Error(`当前解包器没有安装 ${header.codec} 解码器`)

  const key = deriveRomPackKey(header.packageId, header.keyId)
  outputHandle = await open(temp, 'wx')
  const wholeHash = header.originalSha256 ? createHash('sha256') : null
  let cipherAt = dataOffset
  let restored = 0

  for (let index = 0; index < header.chunks.length; index++) {
    const meta = header.chunks[index]
    const encrypted = await readExactly(inputHandle, meta.cipherSize, cipherAt)
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
    if (header.codec === ROM_PACK_CODEC.ZSTD) assertZstdFrameContentSize(encoded, meta.sourceSize)
    const source = header.codec === ROM_PACK_CODEC.ZSTD ? Buffer.from(zstd.decompress(encoded)) : encoded
    if (source.byteLength !== meta.sourceSize) throw new Error(`ROM 包第 ${index + 1} 块解压大小不符`)
    if (createHash('sha256').update(source).digest('hex') !== meta.sha256) throw new Error(`ROM 包第 ${index + 1} 块校验失败`)
    await writeAll(outputHandle, source)
    wholeHash?.update(source)
    cipherAt += meta.cipherSize
    restored += source.byteLength
    process.stdout.write(`\r${Math.round(restored / header.originalSize * 100)}%  ${Math.round(restored / 1048576)} / ${Math.round(header.originalSize / 1048576)} MB`)
  }

  if (wholeHash && wholeHash.digest('hex') !== header.originalSha256) throw new Error('ROM 包整文件校验失败')
  await inputHandle.close()
  inputHandle = undefined
  await outputHandle.close()
  outputHandle = undefined
  await rename(temp, output)
  process.stdout.write('\n')
  console.log(`完成：${output}（容器内原文件名：${header.originalName}）`)
} finally {
  await Promise.allSettled([inputHandle?.close(), outputHandle?.close(), rm(temp, { force: true })])
}
