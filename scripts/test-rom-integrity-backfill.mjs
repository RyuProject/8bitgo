import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./backfill-rom-integrity.mjs', import.meta.url))
const objectKeys = Array.from({ length: 10 }, (_, index) => `roms/test/${index}.nes`)
const manifests = new Set()
const manifestReads = new Set()
let active = 0
let maximumActive = 0
let retryableHashResponses = 0
let retryableHtml503Responses = 0
let droppedNetworkRequests = 0
let invalidPublishResponses = 0
let largestHashBatch = 0
let missingLengthHeadResponses = 0
let missingEtagHeadResponses = 0
let retriedMissingEtagMetadata = 0
let versionConflictResponses = 0
let versionChanged = false
const retriedKeys = new Set()
const invalidPublishKeys = new Set()
const publishedSizes = new Map()
const publishedEtags = new Map()

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
      send(response, 200, { objects: objectKeys.map((key, index) => ({
        key,
        size: index === 2 || (index === 4 && versionChanged) ? 1536 : 1024,
        bucket: 'ROMS',
      })), truncated: false })
      return
    }
    if (url.pathname === '/integrity' && request.method === 'GET') {
      const key = url.searchParams.get('key')
      manifestReads.add(key)
      const index = objectKeys.indexOf(key)
      const currentEtag = index === 4 && versionChanged ? '"fixture-new-4"' : `"fixture-${index}"`
      const currentSize = index === 2 || (index === 4 && versionChanged) ? 1536 : 1024
      if (manifests.has(key)) {
        send(response, 200, { ok: true, etag: publishedEtags.get(key), size: publishedSizes.get(key) })
      } else {
        const body = { error: 'not found' }
        // 模拟旧 Worker 缺少元数据的响应，覆盖 HEAD / 列表回退；其它响应返回同次 R2 head 的 ETag + 长度。
        if (index !== 2 && index !== 3) Object.assign(body, { etag: currentEtag, size: currentSize })
        send(response, 404, body)
      }
      return
    }
    if (url.pathname.startsWith('/roms/') && request.method === 'HEAD') {
      const index = objectKeys.indexOf(url.pathname.slice(1))
      if (index < 0) { send(response, 404); return }
      if (index === 2) {
        missingLengthHeadResponses++
        response.writeHead(200, { 'Cache-Control': 'no-store', ETag: `"fixture-${index}"` })
        response.end()
        return
      }
      if (index === 3 && missingEtagHeadResponses === 0) {
        missingEtagHeadResponses++
        response.writeHead(200, { 'Cache-Control': 'no-store' })
        response.end()
        return
      }
      if (index === 3) retriedMissingEtagMetadata++
      const currentEtag = index === 4 && versionChanged ? '"fixture-new-4"' : `"fixture-${index}"`
      const currentSize = index === 4 && versionChanged ? '1536' : '1024'
      response.writeHead(200, { ETag: currentEtag, 'Content-Length': currentSize })
      response.end()
      return
    }
    if (url.pathname === '/integrity' && request.method === 'POST') {
      let text = ''
      for await (const chunk of request) text += chunk
      const body = JSON.parse(text)
      if (body.action === 'hash-blocks') {
        largestHashBatch = Math.max(largestHashBatch, body.batchBlocks)
        if (body.key === objectKeys[0] && !retriedKeys.has(body.key)) {
          retriedKeys.add(body.key)
          retryableHashResponses++
          send(response, 502, { error: 'transient fixture failure' })
          return
        }
        if (body.key === objectKeys[4] && !versionChanged) {
          versionChanged = true
          versionConflictResponses++
          send(response, 412, { error: 'fixture version changed', code: 'integrity_object_changed' })
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
      if (body.key === objectKeys[5] && retryableHtml503Responses < 3) {
        retryableHtml503Responses++
        response.writeHead(503, { 'Cache-Control': 'no-store', 'Content-Type': 'text/html' })
        response.end('<html>temporary edge response</html>')
        return
      }
      if (body.key === objectKeys[6] && droppedNetworkRequests < 4) {
        droppedNetworkRequests++
        response.destroy()
        return
      }
      publishedSizes.set(body.key, body.size)
      publishedEtags.set(body.key, body.etag)
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
  const applied = await run(['--prefix=roms/', '--apply', '--concurrency=4', '--batch-blocks=4'])
  assert.equal(applied.code, 0, applied.output)
  assert.match(applied.output, /本次补齐 10/)
  assert.equal(manifests.size, objectKeys.length, '每个对象都应发布绑定清单')
  assert.equal(retryableHashResponses, 1, '瞬态 HTTP 502 应重试一次后恢复')
  assert.equal(retryableHtml503Responses, 3, 'HTML 503 应用有界退避重试后恢复')
  assert.equal(droppedNetworkRequests, 4, '短暂网络断开应有界退避重试后恢复')
  assert.equal(invalidPublishResponses, 1, 'HTTP 200 非 JSON 的歧义响应应安全重试已提交的幂等清单')
  assert.equal(missingLengthHeadResponses, 1, '夹具应模拟 HEAD 保留 ETag 却省略长度')
  assert.equal(publishedSizes.get(objectKeys[2]), 1536, 'HEAD 缺长度时应使用 R2 列表长度并经 Worker 复核')
  assert.equal(missingEtagHeadResponses, 1, '夹具应模拟一次 HTTP 200 缺 ETag 的 HEAD')
  assert.equal(retriedMissingEtagMetadata, 1, '缺 ETag 时应有限重试后再回填')
  assert.equal(versionConflictResponses, 1, '夹具应模拟回填期间对象版本变化')
  assert.equal(publishedSizes.get(objectKeys[4]), 1536, '对象版本变化后应使用新长度重新计算全部摘要')
  assert.equal(publishedEtags.get(objectKeys[4]), '"fixture-new-4"', '旧版本摘要不能混入新版本清单')
  assert.ok(largestHashBatch <= 4, '实际 R2 分块批次不能超过显式内存预算')
  assert.ok(maximumActive > 1, '对象处理应能有界并发')
  assert.ok(maximumActive <= 4, '并发不能超过显式上限')

  manifests.delete(objectKeys[2])
  const singleKeyFallback = await run([`--key=${objectKeys[2]}`, '--apply'])
  assert.equal(singleKeyFallback.code, 0, singleKeyFallback.output)
  assert.equal(publishedSizes.get(objectKeys[2]), 1536, '单对象回填在 HEAD 缺长度时应重新从 R2 列表取长度')
  assert.equal(missingLengthHeadResponses, 2, '前缀和单对象两种模式都应覆盖 HEAD 缺长度')

  manifests.delete(objectKeys[8])
  manifests.delete(objectKeys[9])
  manifestReads.clear()
  const resumed = await run(['--prefix=roms/', '--apply', '--start-index=9', '--limit=2'])
  assert.equal(resumed.code, 0, resumed.output)
  assert.match(resumed.output, /本次补齐 2/)
  assert.deepEqual([...manifestReads].sort(), [objectKeys[8], objectKeys[9]].sort(), '分段续跑不能重扫起始序号之前的对象')

  const checked = await run(['--prefix=roms/', '--require-complete', '--concurrency=3'])
  assert.equal(checked.code, 0, checked.output)
  assert.match(checked.output, /已有 10，缺少 0/)

  const invalid = await run(['--prefix=roms/', '--concurrency=17'])
  assert.notEqual(invalid.code, 0, '超出安全上限的并发配置必须拒绝')
  assert.match(invalid.output, /--concurrency 必须是 1\.\.16 的整数/)
  const invalidStart = await run(['--prefix=roms/', '--start-index=0'])
  assert.notEqual(invalidStart.code, 0, '无效的分段续跑起点必须拒绝')
  assert.match(invalidStart.output, /--start-index 必须是从 1 开始的正整数/)
  const partialGate = await run(['--prefix=roms/', '--require-complete', '--start-index=2'])
  assert.notEqual(partialGate.code, 0, '覆盖率门禁不能接受分段范围')
  assert.match(partialGate.output, /不能用 --key、--limit 或 --start-index/)
  const unsafeMemory = await run(['--prefix=roms/', '--apply', '--concurrency=8', '--batch-blocks=8'])
  assert.notEqual(unsafeMemory.code, 0, '过大的并发 Range 缓冲区预算必须拒绝')
  assert.match(unsafeMemory.output, /安全内存预算/)
  console.log('ROM integrity backfill: bounded apply, full read-only gate, and concurrency validation passed.')
} finally {
  server.close()
  await once(server, 'close')
}
