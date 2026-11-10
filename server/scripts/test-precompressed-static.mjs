/**
 * 预压缩静态运行时文件（server/src/precompressed-static.js）。
 *
 * 起一个真的 Express：precompressedStatic 在前、express.static 在后，和 index.js 的注册顺序一致。
 * 锁住：接受 br 才给压缩字节、Range / 不接受 br / 没有 .br 时退回原文件、两条路都带
 * Vary: Accept-Encoding、跨源隔离与缓存头和原文件一致、白名单外的路径不碰、路径穿越不出根目录。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'
import express from 'express'
import { staticCacheHeaders } from '../src/cache.js'
import { precompressedStatic, PRECOMPRESSED_STATIC_PATTERNS } from '../src/precompressed-static.js'

let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ❌ ${name}\n     ${error?.stack ?? error}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'precompressed-'))
const dir = join(root, 'ppsspp', 'v0dbfaca', 'v15')
mkdirSync(dir, { recursive: true })
const data = Buffer.from('PPSSPP data '.repeat(4096))
writeFileSync(join(dir, 'PPSSPPSDL.data'), data)
writeFileSync(join(dir, 'PPSSPPSDL.data.br'), brotliCompressSync(data))
// 没有 .br 的另一代：必须原样退回
mkdirSync(join(root, 'ppsspp', 'v0dbfaca', 'v16'), { recursive: true })
writeFileSync(join(root, 'ppsspp', 'v0dbfaca', 'v16', 'PPSSPPSDL.data'), data)
writeFileSync(join(dir, 'host.js'), 'console.log(1)')
// 2026-11-09：构建时生成的 wasm 压缩版，带 .br.json 旁注
const wasm = Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), Buffer.from('ruffle core '.repeat(4096))])
const ruffleDir = join(root, 'ruffle', 'v0.7.1')
mkdirSync(ruffleDir, { recursive: true })
writeFileSync(join(ruffleDir, 'core.wasm'), wasm)
writeFileSync(join(ruffleDir, 'core.wasm.br'), brotliCompressSync(wasm))
writeFileSync(join(ruffleDir, 'core.wasm.br.json'), JSON.stringify({ bytes: wasm.length, sha256: 'x', brBytes: 0 }))
// 旁注字节数对不上（原文件换过、压缩版过期）：不能吐
writeFileSync(join(ruffleDir, 'stale.wasm'), wasm)
writeFileSync(join(ruffleDir, 'stale.wasm.br'), brotliCompressSync(Buffer.from('old')))
writeFileSync(join(ruffleDir, 'stale.wasm.br.json'), JSON.stringify({ bytes: 3, sha256: 'x', brBytes: 0 }))
// 没有旁注：不能吐
writeFileSync(join(ruffleDir, 'bare.wasm'), wasm)
writeFileSync(join(ruffleDir, 'bare.wasm.br'), brotliCompressSync(wasm))

const app = express()
app.use(precompressedStatic(root, { setHeaders: staticCacheHeaders }))
app.use(express.static(root, { index: false, redirect: false, setHeaders: staticCacheHeaders }))
const server = app.listen(0)
await new Promise((r) => server.once('listening', r))
const port = server.address().port

/** 原始 http：fetch 会自动解压，看不到真实的 Content-Encoding */
const get = (path, headers = {}, method = 'GET') =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })

const DATA = '/ppsspp/v0dbfaca/v15/PPSSPPSDL.data'

await check('⚠️ 接受 br：给 .br 字节 + Content-Encoding: br，解开就是原文件', async () => {
  const r = await get(DATA, { 'accept-encoding': 'gzip, deflate, br, zstd' })
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-encoding'], 'br')
  assert.equal(r.headers['content-type'], 'application/octet-stream')
  assert.ok(r.body.length < data.length / 10, `压缩后 ${r.body.length}`)
  assert.deepEqual(brotliDecompressSync(r.body), data)
  assert.match(r.headers.vary, /Accept-Encoding/i)
  assert.equal(r.headers['accept-ranges'], undefined, '压缩字节不能宣称支持 Range')
})

await check('跨源隔离头和长缓存与原文件那条路一致', async () => {
  const br = await get(DATA, { 'accept-encoding': 'br' })
  const plain = await get(DATA, { 'accept-encoding': 'identity' })
  for (const name of ['cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy', 'cache-control']) {
    assert.equal(br.headers[name], plain.headers[name], name)
  }
  assert.equal(br.headers['cross-origin-embedder-policy'], 'require-corp')
  assert.match(br.headers['cache-control'], /immutable/)
})

await check('不接受 br（含 br;q=0）：原文件，但同样带 Vary', async () => {
  for (const ae of ['gzip', 'br;q=0, gzip', '']) {
    const r = await get(DATA, ae ? { 'accept-encoding': ae } : {})
    assert.equal(r.headers['content-encoding'], undefined, ae)
    assert.deepEqual(r.body, data)
    assert.match(r.headers.vary, /Accept-Encoding/i)
  }
})

await check('Range：退回原文件的 206（偏移是针对未编码内容的）', async () => {
  const r = await get(DATA, { 'accept-encoding': 'br', range: 'bytes=0-11' })
  assert.equal(r.status, 206)
  assert.equal(r.headers['content-encoding'], undefined)
  assert.equal(r.body.toString(), 'PPSSPP data ')
})

await check('HEAD 也走压缩那条，且不带包体', async () => {
  const r = await get(DATA, { 'accept-encoding': 'br' }, 'HEAD')
  assert.equal(r.headers['content-encoding'], 'br')
  assert.equal(r.body.length, 0)
})

await check('条件请求：带上次的 ETag 回 304', async () => {
  const first = await get(DATA, { 'accept-encoding': 'br' })
  const again = await get(DATA, { 'accept-encoding': 'br', 'if-none-match': first.headers.etag })
  assert.equal(again.status, 304)
})

await check('没有 .br 的实体目录：原样交给 express.static', async () => {
  const r = await get('/ppsspp/v0dbfaca/v16/PPSSPPSDL.data', { 'accept-encoding': 'br' })
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-encoding'], undefined)
  assert.deepEqual(r.body, data)
})

await check('白名单外不碰：host.js 不加 Vary、不找 .br', async () => {
  const r = await get('/ppsspp/v0dbfaca/v15/host.js', { 'accept-encoding': 'br' })
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-encoding'], undefined)
  assert.doesNotMatch(String(r.headers.vary || ''), /Accept-Encoding/i)
})

await check('⚠️ wasm 压缩版：Content-Type 必须是 application/wasm（否则流式编译直接失败）', async () => {
  const r = await get('/ruffle/v0.7.1/core.wasm', { 'accept-encoding': 'br, zstd' })
  assert.equal(r.headers['content-encoding'], 'br')
  assert.equal(r.headers['content-type'], 'application/wasm')
  assert.deepEqual(brotliDecompressSync(r.body), wasm)
})

await check('旁注字节数对不上 / 没有旁注：退回原文件', async () => {
  for (const name of ['stale.wasm', 'bare.wasm']) {
    const r = await get(`/ruffle/v0.7.1/${name}`, { 'accept-encoding': 'br' })
    assert.equal(r.headers['content-encoding'], undefined, name)
    assert.deepEqual(r.body, wasm, name)
  }
})

await check('构建脚本与中间件的名单一一对应', async () => {
  const { RUNTIME_PRECOMPRESS_PATTERNS } = await import('../../scripts/precompress-runtimes.mjs')
  const served = (p) => PRECOMPRESSED_STATIC_PATTERNS.some((r) => r.test(p))
  for (const rel of ['ruffle/v0.7.1/172de42e6619eac8f371.wasm', 'jsdos/v8.5.3-8bitgo.4/emulators/wdosbox-x.wasm',
    'dolphin/v7e38409/cores/dolphin/dolphin-core-upstream.wasm', 'play/20261026-system2x6-v1/Play.wasm', 'play/Play.wasm',
    'ppsspp/v0dbfaca/v19/PPSSPPSDL.wasm', 'emulatorjs/emulator.min.js']) {
    assert.ok(RUNTIME_PRECOMPRESS_PATTERNS.some((r) => r.test(rel)), `构建脚本漏了 ${rel}`)
    assert.ok(served(`/${rel}`), `中间件漏了 ${rel}`)
  }
  assert.ok(!served('/emulatorjs/cores/fbneo-legacy-wasm.data'), '7z 核心不预压')
  assert.ok(!served('/jsdos/v8.5.3-8bitgo.4/emulators/wdosbox-x-dbg.wasm'), '调试版不用')
})

await check('白名单只认实体运行时目录里的 PPSSPPSDL.data', () => {
  const ok = (p) => PRECOMPRESSED_STATIC_PATTERNS.some((r) => r.test(p))
  assert.ok(ok('/ppsspp/v0dbfaca/v15/PPSSPPSDL.data'))
  assert.ok(!ok('/ppsspp/v0dbfaca/v15/PPSSPPSDL.data.br'))
  assert.ok(!ok('/ppsspp/v0dbfaca/../../etc/PPSSPPSDL.data'))
  assert.ok(!ok('/ppsspp/v0dbfaca/v15/x/PPSSPPSDL.data'))
})

server.close()
rmSync(root, { recursive: true, force: true })
console.log(failed === 0 ? '\n预压缩静态运行时文件回归通过\n' : `\n失败 ${failed} 项\n`)
process.exit(failed === 0 ? 0 : 1)
