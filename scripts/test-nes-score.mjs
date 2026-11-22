#!/usr/bin/env node
/** NES 分数配置：ROM 精确匹配、字节解码和安全失败边界。 */
import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { decodeNesScore, findNesScoreProfile, hashNesRomInFs } from '../src/emulator/nesScore.ts'

const hash = 'a'.repeat(64)
const base = { gameSlug: 'sample-game', romSha256: hash, version: 'US Rev 1', byteOffsets: [0x10, 0x11] }
const profile = (encoding, updates = {}) => ({ ...base, encoding, ...updates })

assert.equal(findNesScoreProfile([profile({ kind: 'binary', byteOrder: 'little' })], 'sample-game', hash)?.version, 'US Rev 1')
assert.equal(findNesScoreProfile([
  profile({ kind: 'binary', byteOrder: 'little' }),
  profile({ kind: 'binary', byteOrder: 'big' }, { version: 'duplicate' }),
], 'sample-game', hash), null, '同一 ROM 的重复配置必须拒绝，不能按顺序猜')
assert.equal(findNesScoreProfile([profile({ kind: 'binary', byteOrder: 'little' })], 'other-game', hash), null)
assert.equal(findNesScoreProfile([profile({ kind: 'binary', byteOrder: 'little' })], 'sample-game', 'b'.repeat(64)), null, '同一游戏的其他 ROM 修订版不能复用旧地址')
assert.equal(findNesScoreProfile([profile({ kind: 'binary', byteOrder: 'little' })], 'sample-game', 'not-a-hash'), null)

const ram = new Uint8Array(0x800)
ram[0x10] = 0x34
ram[0x11] = 0x12
assert.equal(decodeNesScore(ram, profile({ kind: 'binary', byteOrder: 'little' })), '4660')
assert.equal(decodeNesScore(ram, profile({ kind: 'binary', byteOrder: 'big' })), '13330')
assert.equal(decodeNesScore(ram, profile({ kind: 'packed-bcd', byteOrder: 'little', nibbleOrder: 'high-first' })), '1234')
assert.equal(decodeNesScore(ram, profile({ kind: 'packed-bcd', byteOrder: 'little', nibbleOrder: 'low-first' })), '2143')
assert.equal(decodeNesScore(ram, profile({ kind: 'decimal-digits', byteOrder: 'big' })), null, '十进制数字字节只接受 0–9')
assert.equal(decodeNesScore(ram, profile({ kind: 'ascii-decimal' })), null, 'ASCII 编码只接受数字字符')

ram[0x10] = 0x30
ram[0x11] = 0x37
assert.equal(decodeNesScore(ram, profile({ kind: 'ascii-decimal' })), '07', 'ASCII 分数保留前导零')
ram[0x10] = 0x1a
assert.equal(decodeNesScore(ram, profile({ kind: 'packed-bcd', byteOrder: 'little', nibbleOrder: 'high-first' })), null, '非法 BCD 半字节拒绝解码')

assert.equal(decodeNesScore(null, profile({ kind: 'binary', byteOrder: 'little' })), null)
assert.equal(decodeNesScore(new Uint8Array(0x20), profile({ kind: 'binary', byteOrder: 'little' }, { byteOffsets: [0x1f, 0x20] })), null, 'RAM 越界安全失败')
assert.equal(decodeNesScore(ram, profile({ kind: 'binary', byteOrder: 'little' }, { byteOffsets: [1, 1] })), null, '重复地址拒绝配置')

const rom = new Uint8Array([0x4e, 0x45, 0x53, 0x1a, ...Array.from({ length: 32 }, (_, i) => i)])
const expected = createHash('sha256').update(rom).digest('hex')
assert.equal(await hashNesRomInFs({ readFile: (path) => {
  assert.equal(path, '/sample.nes')
  return rom
} }, 'sample.nes', webcrypto.subtle), expected)
const iframeRom = runInNewContext('new Uint8Array([78, 69, 83, 26, ...Array.from({ length: 32 }, (_, i) => i)])')
assert.equal(await hashNesRomInFs({ readFile: () => iframeRom }, 'sample.nes', webcrypto.subtle), expected, '跨 iframe TypedArray 不能依赖 instanceof')
assert.equal(await hashNesRomInFs({ readFile: () => { throw new Error('not found') } }, 'missing.nes', webcrypto.subtle), null)
assert.equal(await hashNesRomInFs({ readFile: () => rom }, '../escape.nes', webcrypto.subtle), null, '路径异常不能读取 MEMFS 外的内容')

console.log('[ok] NES 分数按游戏与 ROM SHA-256 精确匹配，支持二进制 / BCD / 数字字节 / ASCII 解码并安全拒绝坏配置')
