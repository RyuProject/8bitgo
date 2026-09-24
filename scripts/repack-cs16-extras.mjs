#!/usr/bin/env node

/**
 * 把 CS1.6 的 extras.pk3 重写成标准 ZIP/Deflate。
 *
 * 上游包的 738 个成员全部使用 Store，25MB 的 BMP/WAV/配置因此原样传输。PK3 本来就是
 * ZIP，Xash 也原生支持 Deflate；这里只改变每个成员的压缩方法，不删除或转码任何游戏内容。
 * 自己写这个很小的重打包器，是为了不让生产/构建机依赖系统 zip/unzip（此前检查已经因此挂过）。
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const input = process.argv[2] || join(root, 'public/web/cs16/lib/cstrike/extras.pk3')
const data = readFileSync(input)

function fail(message) {
  throw new Error(`extras.pk3 重打包失败：${message}`)
}

function findEocd(bytes) {
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65535); at -= 1) {
    if (bytes.readUInt32LE(at) === 0x06054b50) return at
  }
  fail('找不到 ZIP 中央目录结束记录')
}

const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n += 1) {
  let value = n
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  crcTable[n] = value >>> 0
}
function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function readEntries(bytes) {
  const eocd = findEocd(bytes)
  const disk = bytes.readUInt16LE(eocd + 4)
  const centralDisk = bytes.readUInt16LE(eocd + 6)
  const diskEntries = bytes.readUInt16LE(eocd + 8)
  const count = bytes.readUInt16LE(eocd + 10)
  const centralBytes = bytes.readUInt32LE(eocd + 12)
  let at = bytes.readUInt32LE(eocd + 16)
  const end = at + centralBytes
  if (disk || centralDisk || diskEntries !== count || count === 0xffff) fail('不支持分卷 ZIP 或 ZIP64')
  if (end > eocd || end > bytes.length) fail('中央目录越界')

  const entries = []
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) fail(`第 ${index + 1} 个中央目录项损坏`)
    const madeBy = bytes.readUInt16LE(at + 4)
    const flags = bytes.readUInt16LE(at + 8)
    const method = bytes.readUInt16LE(at + 10)
    const time = bytes.readUInt16LE(at + 12)
    const date = bytes.readUInt16LE(at + 14)
    const crc = bytes.readUInt32LE(at + 16)
    const compressedBytes = bytes.readUInt32LE(at + 20)
    const rawBytes = bytes.readUInt32LE(at + 24)
    const nameBytes = bytes.readUInt16LE(at + 28)
    const extraBytes = bytes.readUInt16LE(at + 30)
    const commentBytes = bytes.readUInt16LE(at + 32)
    const internalAttributes = bytes.readUInt16LE(at + 36)
    const externalAttributes = bytes.readUInt32LE(at + 38)
    const localOffset = bytes.readUInt32LE(at + 42)
    const next = at + 46 + nameBytes + extraBytes + commentBytes
    if (next > end) fail(`第 ${index + 1} 个中央目录项越界`)
    if (flags & 1) fail(`第 ${index + 1} 个成员被加密`)
    if (method !== 0 && method !== 8) fail(`第 ${index + 1} 个成员使用不支持的压缩方法 ${method}`)
    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      fail(`第 ${index + 1} 个本地文件头损坏`)
    }
    const localNameBytes = bytes.readUInt16LE(localOffset + 26)
    const localExtraBytes = bytes.readUInt16LE(localOffset + 28)
    const payloadAt = localOffset + 30 + localNameBytes + localExtraBytes
    if (payloadAt + compressedBytes > bytes.length) fail(`第 ${index + 1} 个成员数据越界`)

    const name = Buffer.from(bytes.subarray(at + 46, at + 46 + nameBytes))
    const compressed = bytes.subarray(payloadAt, payloadAt + compressedBytes)
    const raw = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed)
    if (raw.length !== rawBytes) fail(`${name.toString()} 解压长度不符`)
    if (crc32(raw) !== crc) fail(`${name.toString()} CRC-32 不符`)
    entries.push({ madeBy, flags: flags & 0x800, time, date, crc, name, raw, internalAttributes, externalAttributes })
    at = next
  }
  if (at !== end) fail('中央目录长度不一致')
  return entries
}

function writeZip(entries) {
  const localParts = []
  const centralParts = []
  let localOffset = 0
  let rawTotal = 0
  let compressedTotal = 0

  for (const entry of entries) {
    const deflated = entry.raw.length ? deflateRawSync(entry.raw, { level: 9 }) : Buffer.alloc(0)
    const useDeflate = deflated.length < entry.raw.length
    const payload = useDeflate ? deflated : entry.raw
    const method = useDeflate ? 8 : 0
    const needed = useDeflate ? 20 : 10
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(needed, 4)
    local.writeUInt16LE(entry.flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(entry.time, 10)
    local.writeUInt16LE(entry.date, 12)
    local.writeUInt32LE(entry.crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(entry.raw.length, 22)
    local.writeUInt16LE(entry.name.length, 26)
    localParts.push(local, entry.name, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(entry.madeBy, 4)
    central.writeUInt16LE(needed, 6)
    central.writeUInt16LE(entry.flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(entry.time, 12)
    central.writeUInt16LE(entry.date, 14)
    central.writeUInt32LE(entry.crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(entry.raw.length, 24)
    central.writeUInt16LE(entry.name.length, 28)
    central.writeUInt16LE(entry.internalAttributes, 36)
    central.writeUInt32LE(entry.externalAttributes, 38)
    central.writeUInt32LE(localOffset, 42)
    centralParts.push(central, entry.name)

    localOffset += local.length + entry.name.length + payload.length
    rawTotal += entry.raw.length
    compressedTotal += payload.length
  }

  const centralOffset = localOffset
  const central = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(centralOffset, 16)
  return { bytes: Buffer.concat([...localParts, central, eocd]), rawTotal, compressedTotal }
}

const entries = readEntries(data)
const result = writeZip(entries)
const temp = `${input}.tmp`
writeFileSync(temp, result.bytes)
// 重读一次再验 CRC，避免重打包器本身写出只能“列目录”、却不能真实解压的包。
readEntries(readFileSync(temp))
renameSync(temp, input)

const saved = data.length - result.bytes.length
console.log(`✔ extras.pk3：${entries.length} 项，${data.length} → ${result.bytes.length} 字节，减少 ${saved} 字节（${(saved / data.length * 100).toFixed(1)}%）`)
