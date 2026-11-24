/**
 * 预压缩静态运行时文件（server/src/precompressed-static.js）。
 *
 * 起一个真的 Express：precompressedStatic 在前、express.static 在后，和 index.js 的注册顺序一致。
 * 锁住：接受 br 才给压缩字节、Range / 不接受 br / 没有 .br 时退回原文件、两条路都带
 * Vary: Accept-Encoding、跨源隔离与缓存头和原文件一致、白名单外的路径不碰、路径穿越不出根目录。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'
import express from 'express'
import cors from 'cors'
import { gzipResponse } from '../src/compress.js'
import { createCnEdgeMiddleware } from '../src/cn-edge.js'
import { staticCacheHeaders } from '../src/cache.js'
import { precompressedStatic, PRECOMPRESSED_STATIC_PATTERNS } from '../src/precompressed-static.js'
import { contentHashOfVersion, runtimeVersionGuard } from '../src/runtime-version-guard.js'

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
const sha = (b) => createHash('sha256').update(b).digest('hex')
const sidecar = (original, encoded) => JSON.stringify({ bytes: original.length, sha256: sha(original), brBytes: encoded.length })
const wasmBr = brotliCompressSync(wasm)
writeFileSync(join(ruffleDir, 'core.wasm.br'), wasmBr)
writeFileSync(join(ruffleDir, 'core.wasm.br.json'), sidecar(wasm, wasmBr))
// 旁注字节数对不上（原文件换过、压缩版过期）：不能吐
writeFileSync(join(ruffleDir, 'stale.wasm'), wasm)
writeFileSync(join(ruffleDir, 'stale.wasm.br'), brotliCompressSync(Buffer.from('old')))
writeFileSync(join(ruffleDir, 'stale.wasm.br.json'), JSON.stringify({ bytes: 3, sha256: 'x', brBytes: 0 }))
// ⚠️ 原文件改了、长度却没变（补丁改一个字符）：旁注字节数照样对得上，只有 sha256 能拦住过期压缩版
const sameSizeOld = Buffer.from(wasm)
sameSizeOld[sameSizeOld.length - 1] ^= 1
const sameSizeOldBr = brotliCompressSync(sameSizeOld)
writeFileSync(join(ruffleDir, 'samesize.wasm'), wasm)
writeFileSync(join(ruffleDir, 'samesize.wasm.br'), sameSizeOldBr)
writeFileSync(join(ruffleDir, 'samesize.wasm.br.json'), sidecar(sameSizeOld, sameSizeOldBr))
// .br 文件本身被换过（字节数与旁注的 brBytes 不符）：不能吐
writeFileSync(join(ruffleDir, 'brswap.wasm'), wasm)
writeFileSync(join(ruffleDir, 'brswap.wasm.br'), brotliCompressSync(Buffer.concat([wasm, Buffer.from('x')])))
writeFileSync(join(ruffleDir, 'brswap.wasm.br.json'), sidecar(wasm, wasmBr))
// EmulatorJS：同一路径、版本只在查询串（?v=<sha256 前 16 位>.e1）
const engine = Buffer.from('export default class EmulatorJS {}\n'.repeat(2048))
const engineBr = brotliCompressSync(engine)
const ejsDir = join(root, 'emulatorjs')
mkdirSync(ejsDir, { recursive: true })
writeFileSync(join(ejsDir, 'emulator.min.js'), engine)
writeFileSync(join(ejsDir, 'emulator.min.js.br'), engineBr)
writeFileSync(join(ejsDir, 'emulator.min.js.br.json'), sidecar(engine, engineBr))
writeFileSync(join(ejsDir, 'loader.js'), 'var x = 1\n')
const ENGINE_V = sha(engine).slice(0, 16)
const coreDir = join(ejsDir, 'cores')
mkdirSync(coreDir)
const core = Buffer.from('versioned emulator core bytes '.repeat(4096))
writeFileSync(join(coreDir, 'fbneo-wasm.data'), core)
const CORE_SHA = sha(core)
const CORE_V = CORE_SHA.slice(0, 16)
// 没有旁注：不能吐
writeFileSync(join(ruffleDir, 'bare.wasm'), wasm)
writeFileSync(join(ruffleDir, 'bare.wasm.br'), brotliCompressSync(wasm))

const app = express()
const guardLog = []
// 与 server/src/index.js 的注册顺序一致：CORS / gzip → /_cn 改写 → 版本守卫 → 静态服务。
app.use(cors({ origin: true, exposedHeaders: ['x-save-updated-at'] }))
app.use((req, res, next) => gzipResponse(req, res, next))
app.use(createCnEdgeMiddleware({ clientDir: root, siteOrigin: 'https://8bitgo.com', socketIoClientDir: '' }))
app.use(runtimeVersionGuard(root, { log: (line) => guardLog.push(line) }))
app.use(precompressedStatic(root, { setHeaders: staticCacheHeaders }))
app.use(express.static(root, { index: false, redirect: false, setHeaders: staticCacheHeaders }))
const server = app.listen(0, '127.0.0.1')
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

await check('旁注字节数对不上 / 没有旁注 / ⚠️ 等长但内容变了 / .br 被换过：退回原文件', async () => {
  for (const name of ['stale.wasm', 'bare.wasm', 'samesize.wasm', 'brswap.wasm']) {
    const r = await get(`/ruffle/v0.7.1/${name}`, { 'accept-encoding': 'br' })
    assert.equal(r.headers['content-encoding'], undefined, name)
    assert.deepEqual(r.body, wasm, name)
  }
})

await check('⚠️ EmulatorJS 版本号与内容一致：immutable 长缓存（预压缩与原文件两条路都是）', async () => {
  for (const enc of ['br', 'identity']) {
    const r = await get(`/emulatorjs/emulator.min.js?v=${ENGINE_V}.e1`, { 'accept-encoding': enc })
    assert.equal(r.status, 200)
    assert.match(String(r.headers['cache-control']), /immutable/, enc)
    assert.equal(r.headers['cdn-cache-control'], undefined, enc)
  }
})

await check('⚠️ 版本核验通过的 EmulatorJS 核心提供强 ETag，Range / If-Range 返回精确字节', async () => {
  const path = `/emulatorjs/cores/fbneo-wasm.data?v=${CORE_V}`
  const first = await get(path, { range: 'bytes=0-127', 'accept-encoding': 'br' })
  assert.equal(first.status, 206)
  assert.equal(first.headers.etag, `"sha256-${CORE_SHA}"`, '强校验器必须由已核验的完整文件哈希生成')
  assert.equal(first.headers['content-range'], `bytes 0-127/${core.length}`)
  assert.equal(first.headers['content-encoding'], undefined, 'Range 偏移必须针对 identity 字节')
  assert.deepEqual(first.body, core.subarray(0, 128))
  const resumed = await get(path, { range: 'bytes=128-255', 'if-range': first.headers.etag })
  assert.equal(resumed.status, 206, '强 ETag 匹配时服务端应接受 If-Range')
  assert.equal(resumed.headers.etag, first.headers.etag)
  assert.equal(resumed.headers['content-range'], `bytes 128-255/${core.length}`)
  assert.deepEqual(resumed.body, core.subarray(128, 256))
})

await check('⚠️ 大陆 /_cn 核心 Range 暴露强 ETag、Content-Range，If-Range 续接精确字节', async () => {
  const path = `/_cn/emulatorjs/cores/fbneo-wasm.data?v=${CORE_V}.range1`
  const origin = 'https://8bitgo.com'
  const first = await get(path, { origin, range: 'bytes=0-127', 'accept-encoding': 'br' })
  assert.equal(first.status, 206)
  assert.equal(first.headers.etag, `"sha256-${CORE_SHA}"`, '边缘缓存换代后源站必须返回完整 SHA-256 强 ETag')
  assert.equal(first.headers['content-range'], `bytes 0-127/${core.length}`)
  assert.equal(first.headers['content-encoding'], undefined, 'Range 偏移必须针对 identity 字节')
  assert.deepEqual(first.body, core.subarray(0, 128))
  const exposed = String(first.headers['access-control-expose-headers'] || '').toLowerCase()
  for (const name of ['content-range', 'etag', 'content-encoding', 'content-length']) assert.ok(exposed.includes(name), `${name} 必须可被跨源页面读取`)
  const resumed = await get(path, { origin, range: 'bytes=128-255', 'if-range': first.headers.etag })
  assert.equal(resumed.status, 206, '强 ETag 匹配时服务端应接受 If-Range')
  assert.equal(resumed.headers.etag, first.headers.etag)
  assert.equal(resumed.headers['content-range'], `bytes 128-255/${core.length}`)
  assert.deepEqual(resumed.body, core.subarray(128, 256))
})

await check('⚠️ EmulatorJS 版本号与内容不一致：照常给当前文件，但 no-store，边缘与浏览器都不许缓存', async () => {
  const wrong = '0123456789abcdef'
  for (const [enc, v] of [['br', `${wrong}.e1`], ['identity', `${wrong}.e1`], ['br', `${wrong}.e1&fallback=1`], ['identity', wrong]]) {
    const r = await get(`/emulatorjs/emulator.min.js?v=${v}`, { 'accept-encoding': enc })
    assert.equal(r.status, 200, `${enc} ${v}`)
    assert.equal(r.headers['cache-control'], 'no-store', `${enc} ${v}`)
    assert.equal(r.headers['cdn-cache-control'], 'no-store', `${enc} ${v}`)
    assert.equal(r.headers['cloudflare-cdn-cache-control'], 'no-store', `${enc} ${v}`)
    assert.match(r.headers.etag, /^W\//, '版本不匹配时不得发出可用于续传的强 ETag')
    const body = r.headers['content-encoding'] === 'br' ? brotliDecompressSync(r.body) : r.body
    assert.deepEqual(body, engine, '仍然返回当前文件（可用性优先）')
  }
  assert.ok(guardLog.some((line) => line.includes(wrong)), '要在服务端日志里留一行，部署窗口外出现说明版本表过期')
})

await check('EmulatorJS 不是内容哈希格式的版本号 / 没有 v：保持原来的缓存档位', async () => {
  const legacy = await get('/emulatorjs/loader.js?v=r27', { 'accept-encoding': 'identity' })
  assert.match(String(legacy.headers['cache-control']), /immutable/)
  const bare = await get('/emulatorjs/loader.js', { 'accept-encoding': 'identity' })
  assert.doesNotMatch(String(bare.headers['cache-control']), /immutable|no-store/)
  assert.equal(contentHashOfVersion('1183825bab02ab07.e1'), '1183825bab02ab07')
  assert.equal(contentHashOfVersion('1183825BAB02AB07'), '1183825bab02ab07')
  assert.equal(contentHashOfVersion('r27'), '')
  assert.equal(contentHashOfVersion('1183825bab02ab07.e1.x'), '')
})

await check('版本守卫不出根目录、只管 /emulatorjs/', async () => {
  const r = await get('/emulatorjs/../ruffle/v0.7.1/core.wasm?v=0123456789abcdef', { 'accept-encoding': 'identity' })
  assert.notEqual(r.headers['cache-control'], 'no-store')
  const other = await get('/ruffle/v0.7.1/core.wasm?v=0123456789abcdef', { 'accept-encoding': 'identity' })
  assert.notEqual(other.headers['cache-control'], 'no-store')
})

await check('构建脚本与中间件的名单一一对应', async () => {
  const { RUNTIME_PRECOMPRESS_PATTERNS } = await import('../../scripts/precompress-runtimes.mjs')
  const served = (p) => PRECOMPRESSED_STATIC_PATTERNS.some((r) => r.test(p))
  for (const rel of ['ruffle/v0.7.1/172de42e6619eac8f371.wasm', 'jsdos/v8.5.3-8bitgo.9/emulators/wdosbox-x.wasm',
    'dolphin/v7e38409/cores/dolphin/dolphin-core-upstream.wasm', 'play/20261026-system2x6-v1/Play.wasm', 'play/Play.wasm',
    'ppsspp/v0dbfaca/v19/PPSSPPSDL.wasm', 'emulatorjs/emulator.min.js', 'eka2l1/v0123456789ab/eka2l1.wasm',
    'eka2l1/v0123456789ab/eka2l1.data']) {
    assert.ok(RUNTIME_PRECOMPRESS_PATTERNS.some((r) => r.test(rel)), `构建脚本漏了 ${rel}`)
    assert.ok(served(`/${rel}`), `中间件漏了 ${rel}`)
  }
  assert.ok(!served('/emulatorjs/cores/fbneo-legacy-wasm.data'), '7z 核心不预压')
  assert.ok(!served('/jsdos/v8.5.3-8bitgo.9/emulators/wdosbox-x-dbg.wasm'), '调试版不用')
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
