import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib'
import { brotliQualityFor, generate, runtimeTargets } from './precompress-runtimes.mjs'

const tempRoot = mkdtempSync(join(tmpdir(), '8bitgo-precompress-test-'))
try {
  const appAsset = join(tempRoot, 'assets', 'PlayerChunk-AbCd1234.js')
  const existingAppAsset = join(tempRoot, 'assets', 'OldChunk-AbCd1234.js')
  const runtimeAsset = join(tempRoot, 'ruffle', 'v1.0.0', 'core.wasm')
  const bytes = Buffer.from('function startGame(){return "ready"}\n'.repeat(4096))
  const existingBytes = Buffer.from('const alreadyCompressed = true;\n'.repeat(2048))
  mkdirSync(join(tempRoot, 'assets'), { recursive: true })
  mkdirSync(join(tempRoot, 'ruffle', 'v1.0.0'), { recursive: true })
  writeFileSync(appAsset, bytes)
  const existingBrotli = brotliCompressSync(existingBytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_LGWIN]: 24,
      [constants.BROTLI_PARAM_SIZE_HINT]: existingBytes.byteLength,
    },
  })
  writeFileSync(existingAppAsset, existingBytes)
  writeFileSync(`${existingAppAsset}.br`, existingBrotli)
  writeFileSync(`${existingAppAsset}.br.json`, `${JSON.stringify({
    bytes: existingBytes.byteLength,
    sha256: createHash('sha256').update(existingBytes).digest('hex'),
    brBytes: existingBrotli.byteLength,
    quality: 11,
  })}\n`)
  // 两类资源使用相同字节，确保压缩结果缓存会把档位也纳入键，不能让 JS 的 q6 污染运行时 q11。
  writeFileSync(runtimeAsset, bytes)

  assert.equal(brotliQualityFor('assets/PlayerChunk-AbCd1234.js'), 6)
  assert.equal(brotliQualityFor('assets/site-AbCd1234.css'), 6)
  assert.equal(brotliQualityFor('ruffle/v1.0.0/core.wasm'), 11)
  assert.deepEqual(runtimeTargets(tempRoot), [existingAppAsset, appAsset, runtimeAsset])

  await generate(tempRoot)
  for (const [path, quality] of [[appAsset, 6], [runtimeAsset, 11]]) {
    const encoded = readFileSync(`${path}.br`)
    const sidecar = JSON.parse(readFileSync(`${path}.br.json`, 'utf8'))
    assert.equal(sidecar.quality, quality)
    assert.equal(sidecar.bytes, bytes.byteLength)
    assert.equal(sidecar.brBytes, encoded.byteLength)
    assert.deepEqual(brotliDecompressSync(encoded), bytes)
    assert.deepEqual(encoded, brotliCompressSync(bytes, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: quality,
        [constants.BROTLI_PARAM_LGWIN]: 24,
        [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
      },
    }))
  }
  assert.equal(JSON.parse(readFileSync(`${existingAppAsset}.br.json`, 'utf8')).quality, 11)
  assert.deepEqual(brotliDecompressSync(readFileSync(`${existingAppAsset}.br`)), existingBytes)

  console.log('✔ 应用 JS/CSS 使用 Brotli 6，模拟器大文件保持 Brotli 11，复用旧压缩件且缓存档位隔离')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
