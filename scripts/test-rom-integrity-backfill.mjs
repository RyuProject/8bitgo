import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./backfill-rom-integrity.mjs', import.meta.url))
const objectKeys = Array.from({ length: 10 }, (_, index) => `roms/test/${index}.nes`)
const manifests = new Set()
let active = 0
let maximumActive = 0
let retryableHashResponses = 0
let invalidPublishResponses = 0
const retriedKeys = new Set()
const invalidPublishKeys = new Set()

function send(response, status, body = null, headers = {}) {
  response.writeHead(status, { 'Cache-Control': 'no-store', ...headers })
  response.end(body === null ? '' : JSON.stringify(body))
}

const server = createServer(async (request, response) => {
  active++
  maximumActive = Math.max(maximumActive, active)
  try {
    await new Promise((resolve) => setTimeout(resolve, 20))
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/ping') {
      send(response, 200, { writable: true, features: { integrityManifest: true, integrityBackfill: true } })
      return
    }
    if (url.pathname === '/list') {
      send(response, 200, { objects: objectKeys.map((key) => ({ key, bucket: 'ROMS' })), truncated: false })
      return
    }
    if (url.pathname === '/integrity' && request.method === 'GET') {
      const key = url.searchParams.get('key')
      send(response, manifests.has(key) ? 200 : 404, manifests.has(key) ? { ok: true } : { error: 'not found' })
      return
    }
    if (url.pathname.startsWith('/roms/') && request.method === 'HEAD') {
      const index = objectKeys.indexOf(url.pathname.slice(1))
      if (index < 0) { send(response, 404); return }
      response.writeHead(200, { ETag: `"fixture-${index}"`, 'Content-Length': '1024' })
      response.end()
      return
    }
    if (url.pathname === '/integrity' && request.method === 'POST') {
      let text = ''
      for await (const chunk of request) text += chunk
      const body = JSON.parse(text)
      if (body.action === 'hash-blocks') {
        if (body.key === objectKeys[0] && !retriedKeys.has(body.key)) {
          retriedKeys.add(body.key)
          retryableHashResponses++
          send(response, 502, { error: 'transient fixture failure' })
          return
        }
        send(response, 200, {
          ok: true,
          key: body.key,
          etag: body.etag,
          size: body.size,
          blockBytes: 2 * 1024 * 1024,
          startIndex: body.startIndex,
          nextIndex: body.startIndex + 1,
          totalBlocks: 1,
          blocks: ['a'.repeat(64)],
        })
        return
      }
      manifests.add(body.key)
      if (body.key === objectKeys[1] && !invalidPublishKeys.has(body.key)) {
        invalidPublishKeys.add(body.key)
        invalidPublishResponses++
        response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'text/html' })
        response.end('<html>temporary edge response</html>')
        return
      }
      send(response, 200, { ok: true, key: body.key, etag: body.etag, size: body.size })
      return
    }
    send(response, 404, { error: 'not found' })
  } catch (error) {
    send(response, 500, { error: error instanceof Error ? error.message : String(error) })
  } finally {
    active--
  }
})

server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
assert.ok(address && typeof address === 'object')
const api = `http://127.0.0.1:${address.port}`

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, `--api=${api}`, ...args], {
      env: { ...process.env, ROM_INTEGRITY_TOKEN: 'fixture-token' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, output }))
  })
}

try {
  const applied = await run(['--prefix=roms/', '--apply', '--concurrency=4'])
  assert.equal(applied.code, 0, applied.output)
  assert.match(applied.output, /本次补齐 10/)
  assert.equal(manifests.size, objectKeys.length, '每个对象都应发布绑定清单')
  assert.equal(retryableHashResponses, 1, '瞬态 HTTP 502 应重试一次后恢复')
  assert.equal(invalidPublishResponses, 1, 'HTTP 200 非 JSON 的歧义响应应安全重试已提交的幂等清单')
  assert.ok(maximumActive > 1, '对象处理应能有界并发')
  assert.ok(maximumActive <= 4, '并发不能超过显式上限')

  const checked = await run(['--prefix=roms/', '--require-complete', '--concurrency=3'])
  assert.equal(checked.code, 0, checked.output)
  assert.match(checked.output, /已有 10，缺少 0/)

  const invalid = await run(['--prefix=roms/', '--concurrency=17'])
  assert.notEqual(invalid.code, 0, '超出安全上限的并发配置必须拒绝')
  assert.match(invalid.output, /--concurrency 必须是 1\.\.16 的整数/)
  console.log('ROM integrity backfill: bounded apply, full read-only gate, and concurrency validation passed.')
} finally {
  server.close()
  await once(server, 'close')
}
