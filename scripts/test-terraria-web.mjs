#!/usr/bin/env node

/**
 * `/web/terraria/_framework/*` 代理的回归测试（不联网）。
 *
 * 这段代理有 135MB 要从对象存储流过去，而它一旦错了，表现是**页面白屏 + 控制台一句
 * 含糊的模块加载失败**，非常难定位；所以把「上游请求长什么样、响应头怎么给」钉在这里。
 *
 * 用 node:http 起真服务、用 stub 的 fetch 冒充 R2，而不是 import express：
 * 根目录的脚本拿不到 server 的依赖，而且被测的是**处理函数自己的逻辑**
 * （路由匹配与 params 由 server/src/index.js 负责，不在这一层）。
 */
import { createServer, request } from 'node:http'
import assert from 'node:assert/strict'
import { brotliCompressSync } from 'node:zlib'
import { frameworkAsset, terrariaFrameworkProxy } from '../server/src/terraria.js'
import { acceptsBrotli, createR2RuntimeProxy } from '../server/src/r2-runtime-proxy.js'

const PREFIX = '/web/terraria/_framework/'
const SLOW_PREFIX = '/slow/'
const calls = []
let upstream = null

// ⚠️ 先把真 fetch 收好：本地那个 http 服务也要用它，否则测试客户端自己会被 stub 掉。
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init })
  if (typeof upstream === 'function') return upstream(String(url), init)
  return upstream
}

const server = createServer((req, res) => {
  /*
    ⚠️ 这里刻意**不用 `new URL()`**：它会把 `%2e%2e` 当成双点路径段规范化掉，
    于是「穿越」这类输入永远到不了处理函数，测试变成假绿。
    真实 Express 的路由是在**原始（未解码）路径**上匹配的，`:file` 不吃 `/`，
    但 `..` / `%2e%2e` 这种单段值是合法取值、会被解码后交给处理函数 ——
    所以名字校验才是唯一的防线，这里必须按同样的方式还原。
  */
  const rawPath = String(req.url || '').split('?')[0]
  const routePrefix = rawPath.startsWith(SLOW_PREFIX) ? SLOW_PREFIX : PREFIX
  const at = rawPath.startsWith(routePrefix) ? rawPath.slice(routePrefix.length) : null
  if (at == null || at.includes('/')) {
    res.statusCode = 404
    return res.end('no route')
  }
  // express 的两个便利方法，被测处理函数用到了；这里补上最简实现。
  res.status = (code) => { res.statusCode = code; return res }
  res.send = (body) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(String(body)) }
  req.params = { file: decodeURIComponent(at) }
  const handler = routePrefix === SLOW_PREFIX ? slowProxy : terrariaFrameworkProxy
  handler(req, res).catch((e) => { console.error(e); res.destroy() })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const get = async (path, headers = {}) => {
  const res = await realFetch(`${base}${path}`, { headers, redirect: 'manual' })
  const body = new Uint8Array(await res.arrayBuffer())
  return { status: res.status, headers: res.headers, body }
}

/**
 * 绕过 URL 规范化的原始请求。
 *
 * `fetch`（以及任何浏览器）会在发请求之前把 `%2e%2e` 这类「双点路径段」规范化掉，
 * 于是穿越用的路径**根本到不了服务端** —— 用 fetch 测这一条只会得到
 * 「路由不匹配」的假绿。node:http 的 path 原样发送，才是真正要防的那种输入。
 */
const rawGet = (path) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port: server.address().port, path, method: 'GET' }, (res) => {
    const chunks = []
    res.on('data', (c) => chunks.push(c))
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }))
  })
  req.on('error', reject)
  req.end()
})

const PASS = (label) => console.log(`✔ ${label}`)

const slowProxy = createR2RuntimeProxy({
  label: 'slow-test',
  resolveAsset: (file) => ({
    url: `https://assets.8bitgo.com/slow/${file}`,
    contentType: 'application/octet-stream',
    cacheControl: 'no-store',
  }),
  maxProxies: 1,
  timeoutMs: 10_000,
})

try {
  /* ---------- 纯函数：文件名 → 上游地址 / 类型 / 缓存档 ---------- */
  const wasm = frameworkAsset('dotnet.native.6p12adq9gl.wasm')
  assert.equal(wasm.url, 'https://assets.8bitgo.com/web/terraria/_framework/dotnet.native.6p12adq9gl.wasm')
  assert.equal(wasm.contentType, 'application/wasm', '.wasm 必须是 application/wasm，否则 instantiateStreaming 拒收')
  assert.match(wasm.cacheControl, /immutable/, '带内容哈希的文件应当长期缓存')
  assert.equal(frameworkAsset('dotnet.js').cacheControl.includes('immutable'), false, 'dotnet.js 是入口，必须短缓存')
  assert.equal(frameworkAsset('blazor.boot.json').cacheControl.includes('immutable'), false, 'boot.json 是清单，必须短缓存')
  assert.equal(frameworkAsset('terraria.htgijktbe2.dll').contentType, 'application/octet-stream')
  for (const bad of ['..', '.', '../../etc/passwd', 'a/b', '', '-x.dll']) {
    assert.equal(frameworkAsset(bad), null, `${JSON.stringify(bad)} 不该通过校验`)
  }
  PASS('frameworkAsset：类型、缓存档与非法名字')

  /* ---------- 正常转发 ---------- */
  const payload = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
  calls.length = 0
  upstream = new Response(payload, {
    status: 200,
    headers: { 'content-length': String(payload.length), etag: 'W/"abc"', 'content-type': 'application/wasm' },
  })
  const ok = await get(`${PREFIX}dotnet.native.6p12adq9gl.wasm`)
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body, payload, '字节必须一模一样')
  assert.equal(ok.headers.get('content-type'), 'application/wasm')
  assert.equal(ok.headers.get('content-length'), String(payload.length), 'content-length 要透传，进度条才有数')
  assert.equal(ok.headers.get('etag'), 'W/"abc"')
  assert.match(ok.headers.get('cache-control'), /immutable/)
  assert.equal(ok.headers.get('cross-origin-resource-policy'), 'same-origin', 'COEP 页面里要 CORP')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://assets.8bitgo.com/web/terraria/_framework/dotnet.native.6p12adq9gl.wasm')
  assert.equal(calls[0].init.headers['accept-encoding'], 'identity', '必须让 R2 别压缩，否则 content-length 会对不上')
  PASS('转发 200：字节、content-length、CORP 与上游请求头')

  /* ---------- 预压缩对象：代理不解压，浏览器边收边解 ---------- */
  assert.equal(acceptsBrotli('gzip, br'), true)
  assert.equal(acceptsBrotli('gzip, br;q=0'), false)
  calls.length = 0
  const compressedPayload = brotliCompressSync(payload)
  upstream = (url) => {
    assert.ok(url.endsWith('.br'), '支持 br 时必须优先请求独立的 .br 对象')
    return new Response(compressedPayload, {
      status: 200,
      headers: { 'content-length': String(compressedPayload.length), etag: '"br-1"' },
    })
  }
  const brotli = await get(`${PREFIX}dotnet.native.6p12adq9gl.wasm`, { 'accept-encoding': 'br' })
  assert.deepEqual(brotli.body, payload, '客户端拿到的应是浏览器解码后的原始 wasm 字节')
  assert.equal(brotli.headers.get('content-encoding'), 'br')
  assert.match(brotli.headers.get('vary'), /Accept-Encoding/i)
  assert.equal(calls.length, 1)
  PASS('Brotli 对象原样流转，浏览器按 Content-Encoding 边收边解码')

  /* ---------- 旧桶还没传 .br 时退回原始对象 ---------- */
  calls.length = 0
  upstream = (url) => url.endsWith('.br')
    ? new Response(null, { status: 404 })
    : new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } })
  const fallback = await get(`${PREFIX}terraria.legacy.dll`, { 'accept-encoding': 'br' })
  assert.deepEqual(fallback.body, payload)
  assert.equal(fallback.headers.get('content-encoding'), null)
  assert.equal(calls.length, 2, '先探 .br，再兼容旧的原始对象')
  PASS('压缩对象缺失时兼容原始 R2 文件')

  /* ---------- 入口文件短缓存 ---------- */
  upstream = new Response('export{}', { status: 200, headers: { 'content-type': 'text/javascript' } })
  const entry = await get(`${PREFIX}dotnet.js`)
  assert.equal(entry.headers.get('content-type'), 'text/javascript; charset=utf-8')
  assert.match(entry.headers.get('cache-control'), /max-age=300/)
  PASS('dotnet.js 走短缓存（换了构建不会被边缘钉住）')

  /* ---------- pthread Worker 入口要带 COEP ---------- */
  upstream = new Response('export{}', { status: 200, headers: { 'content-type': 'text/javascript' } })
  const worker = await get(`${PREFIX}dotnet.native.worker.ratb5i3t1q.mjs`)
  assert.equal(worker.headers.get('cross-origin-embedder-policy'), 'require-corp')
  PASS('pthread Worker 入口自带 COEP')

  /* ---------- 非法名字：根本不许打到 R2 ---------- */
  calls.length = 0
  for (const path of [`${PREFIX}%2e%2e`, `${PREFIX}..%2f..%2fetc%2fpasswd`, `${PREFIX}.`]) {
    const res = await rawGet(path)
    assert.equal(res.status, 400, `${path} 应当被名字校验挡住`)
  }
  assert.equal(calls.length, 0, '非法名字不该产生任何上游请求')
  PASS('非法文件名（含编码后的 `..` 穿越）一律 400，且不触达对象存储')

  /* ---------- 上游 404 原样透出 ---------- */
  upstream = new Response('not found', { status: 404 })
  const missing = await get(`${PREFIX}terraria.deadbeef.dll`)
  assert.equal(missing.status, 404)
  PASS('R2 上没有的文件返回 404（不编一个 200 空响应）')

  /* ---------- Range 与 206 透传 ---------- */
  calls.length = 0
  upstream = new Response(payload.subarray(0, 4), {
    status: 206,
    headers: { 'content-range': `bytes 0-3/${payload.length}`, 'accept-ranges': 'bytes' },
  })
  const partial = await get(`${PREFIX}dotnet.native.6p12adq9gl.wasm`, { range: 'bytes=0-3' })
  assert.equal(partial.status, 206)
  assert.equal(partial.headers.get('content-range'), `bytes 0-3/${payload.length}`)
  assert.equal(calls[0].init.headers.range, 'bytes=0-3')
  PASS('Range 请求与 206 响应原样透传')

  /* ---------- 并发名额必须占到响应流真正结束 ---------- */
  calls.length = 0
  let finishSlow
  upstream = () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1]))
      finishSlow = () => controller.close()
    },
  }), { status: 200 })
  const firstSlow = await realFetch(`${base}${SLOW_PREFIX}core.wasm`)
  const rejectedSlow = await realFetch(`${base}${SLOW_PREFIX}other.wasm`)
  assert.equal(rejectedSlow.status, 503, '第一条流没结束时第二条必须被并发闸门挡住')
  finishSlow()
  await firstSlow.arrayBuffer()
  PASS('流未结束前不释放并发名额（修复 pipe 后提前 finally）')

  console.log('✔ terraria web 代理全部通过')
} finally {
  server.close()
}
