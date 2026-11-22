#!/usr/bin/env node
/** 标记 RAM 样本的候选编码预筛：命中只是线索，不代表分数布局已确认。 */
import assert from 'node:assert/strict'
import { analyzeNesRamTrace } from '../src/emulator/nesRamTraceAnalysis.ts'

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const scores = ['001234', '001235', '001240']
const samples = scores.map((score) => {
  const ram = new Uint8Array(0x800)
  const digits = score
  ram[0x21] = Number.parseInt(digits.slice(4, 6), 16)
  ram[0x22] = Number.parseInt(digits.slice(2, 4), 16)
  ram[0x23] = Number.parseInt(digits.slice(0, 2), 16)
  return { ramHex: hex(ram) }
})
const labels = scores.map((score, sampleIndex) => ({ score, sampleIndex }))
const report = analyzeNesRamTrace(labels, samples)
assert.equal(report.status, 'scanned')
assert.equal(report.distinctScores, 3)
assert.ok(report.exactCandidateCount > 0)
assert.ok(report.candidates.some((candidate) =>
  candidate.byteOffsets.join(',') === '33,34,35' &&
  candidate.encoding.kind === 'packed-bcd' &&
  candidate.encoding.byteOrder === 'little' &&
  candidate.encoding.nibbleOrder === 'high-first' &&
  candidate.matchMode === 'display-exact' &&
  candidate.decodedScores.join(',') === scores.join(','),
), '要列出能精确还原三份分数的 BCD 字段和原始字节')

const repeated = analyzeNesRamTrace(
  [{ score: '100', sampleIndex: 0 }, { score: '100', sampleIndex: 1 }],
  [{ ramHex: hex(new Uint8Array(0x800)) }, { ramHex: hex(new Uint8Array(0x800)) }],
)
assert.equal(repeated.status, 'insufficient-labels', '没有分数变化时不能给出候选')

assert.equal(analyzeNesRamTrace([{ score: '10', sampleIndex: 3 }], samples).status, 'invalid-labels')
console.log('[ok] RAM trace 预筛会给出精确解码候选，并在分数没有变化时拒绝推断')
