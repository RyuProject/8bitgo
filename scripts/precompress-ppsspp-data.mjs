#!/usr/bin/env node
/**
 * 给当前 PPSSPP 实体运行时生成 `PPSSPPSDL.data.br`（Brotli 11）。
 *
 * 源站的 server/src/precompressed-static.js 会对接受 br 的浏览器直接吐它：19.4MB → 约 9.2MB。
 * 先按 runtime.json 核对原文件哈希再压，压完立刻解开比对；任何一步对不上都不落盘。
 * 换新实体目录（v18 …）后要重跑一次，scripts/check-ppsspp.mjs 会拦住缺失或过期的 .br。
 *
 * 用法：npm run ppsspp:precompress [-- <运行时目录>]
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dir = resolve(process.argv[2] || join(root, 'public', 'ppsspp', 'v0dbfaca', 'v18'))
const dataPath = join(dir, 'PPSSPPSDL.data')
const outPath = `${dataPath}.br`

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fail = (message) => {
  console.error(`✖ ${message}`)
  process.exit(1)
}

if (!existsSync(dataPath)) fail(`缺少 ${dataPath}`)
const manifest = JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8'))
const expected = manifest.artifacts?.['PPSSPPSDL.data']
const data = readFileSync(dataPath)
if (!expected || expected.bytes !== data.byteLength || expected.sha256 !== sha256(data)) {
  fail('PPSSPPSDL.data 与 runtime.json 的校验值不符，拒绝压一份不对的数据包')
}

if (existsSync(outPath)) {
  try {
    if (sha256(brotliDecompressSync(readFileSync(outPath))) === expected.sha256) {
      console.log(`✔ ${outPath} 已是当前数据包，不用重压`)
      process.exit(0)
    }
  } catch {
    /* 坏文件：下面重压覆盖 */
  }
}

const started = Date.now()
const encoded = brotliCompressSync(data, {
  params: {
    [constants.BROTLI_PARAM_QUALITY]: 11,
    [constants.BROTLI_PARAM_LGWIN]: 24,
    [constants.BROTLI_PARAM_SIZE_HINT]: data.byteLength,
  },
})
if (sha256(brotliDecompressSync(encoded)) !== expected.sha256) fail('压缩结果解不回原文件')
const temp = `${outPath}.tmp-${process.pid}`
writeFileSync(temp, encoded)
renameSync(temp, outPath)
const pct = ((1 - encoded.byteLength / data.byteLength) * 100).toFixed(1)
console.log(`✔ ${outPath}：${data.byteLength} → ${encoded.byteLength} 字节（-${pct}%，${Date.now() - started}ms）`)
