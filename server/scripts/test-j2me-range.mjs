import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { finished } from 'node:stream/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'

const root = fileURLToPath(new URL('../..', import.meta.url))
const directory = await mkdtemp(path.join(os.tmpdir(), '8bitgo-j2me-range-'))
process.env.J2ME_TMP_DIR = directory
process.env.J2ME_TMP_TOTAL_MB = '1'

const fixture = await readFile(new URL('./fixtures/minimal.jar', import.meta.url))
let upstreamHeaders = { etag: '"jar-v1"', 'content-length': String(fixture.length), 'x-8bg-integrity-verified': 'sha256-v1' }
let upstreamRangeVerified = true
let lastUpstreamRequest
globalThis.fetch = async (url, init = {}) => {
  lastUpstreamRequest = { url: String(url), headers: init.headers || {} }
  if (init.headers?.range) {
    const match = /^bytes=(\d+)-(\d+)$/.exec(init.headers.range)
    assert.ok(match, 'test range request must be a single explicit byte range')
    const start = Number(match[1])
    const end = Math.min(Number(match[2]), fixture.length - 1)
    return new Response(fixture.subarray(start, end + 1), { status: 206, headers: {
      etag: upstreamHeaders.etag,
      'content-range': `bytes ${start}-${end}/${fixture.length}`,
      'content-length': String(end - start + 1),
      ...(upstreamRangeVerified ? { 'x-8bitgo-integrity-required': 'sha256-v1' } : {}),
    } })
  }
  if (init.headers?.['if-none-match'] === upstreamHeaders.etag) {
    return new Response(null, { status: 304, headers: { etag: upstreamHeaders.etag } })
  }
  return new Response(fixture, { status: 200, headers: upstreamHeaders })
}

register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier.endsWith('site-urls.js')) {
      return { url: 'data:text/javascript,' + encodeURIComponent("export const assetBaseUrl = () => 'https://assets.invalid'"), shortCircuit: true };
    }
    return next(specifier, context);
  }
`))

const { uploadJar, j2meJarProxy } = await import(
  pathToFileURL(path.join(root, 'server/src/j2me.js')).href,
)

function uploadResponse() {
  return {
    destroyed: false,
    headersSent: false,
    statusCode: 200,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; this.headersSent = true; return this },
  }
}

async function request(name, { range, method = 'GET', ifNoneMatch } = {}) {
  const res = new PassThrough()
  const chunks = []
  const headers = new Map()
  let statusCode = 200
  res.on('data', (chunk) => chunks.push(chunk))
  res.status = (code) => { statusCode = code; return res }
  res.setHeader = (key, value) => { headers.set(key.toLowerCase(), String(value)); return res }
  res.removeHeader = (key) => { headers.delete(key.toLowerCase()); return res }
  res.send = (body) => { if (body != null) res.write(body); res.end(); return res }
  const req = { params: { name }, headers: range ? { range } : {}, method }
  if (ifNoneMatch) req.headers['if-none-match'] = ifNoneMatch
  await j2meJarProxy(req, res)
  await finished(res)
  return { statusCode, headers, body: Buffer.concat(chunks) }
}

try {
  const upload = uploadResponse()
  await uploadJar({ body: fixture }, upload)
  assert.equal(upload.statusCode, 200, '测试 JAR 应可上传到临时目录')
  const { name } = upload.body
  assert.match(name, /^tmp-[a-f0-9]{32}\.jar$/)

  const full = await request(name)
  assert.equal(full.statusCode, 200)
  assert.equal(full.headers.get('accept-ranges'), 'bytes')
  assert.equal(Number(full.headers.get('content-length')), fixture.length)
  assert.deepEqual(full.body, fixture)

  const partial = await request(name, { range: 'bytes=0-15' })
  assert.equal(partial.statusCode, 206)
  assert.equal(partial.headers.get('content-range'), `bytes 0-15/${fixture.length}`)
  assert.equal(partial.headers.get('content-length'), '16')
  assert.deepEqual(partial.body, fixture.subarray(0, 16))

  const suffix = await request(name, { range: 'bytes=-7' })
  assert.equal(suffix.statusCode, 206)
  assert.deepEqual(suffix.body, fixture.subarray(-7))

  const head = await request(name, { method: 'HEAD', range: 'bytes=1-3' })
  assert.equal(head.statusCode, 206)
  assert.equal(head.headers.get('content-range'), `bytes 1-3/${fixture.length}`)
  assert.equal(head.headers.get('content-length'), '3')
  assert.equal(head.body.length, 0)

  const unsatisfied = await request(name, { range: `bytes=${fixture.length}-` })
  assert.equal(unsatisfied.statusCode, 416)
  assert.equal(unsatisfied.headers.get('content-range'), `bytes */${fixture.length}`)

  const multi = await request(name, { range: 'bytes=0-1,4-5' })
  assert.equal(multi.statusCode, 416, '不支持的多段 Range 必须显式拒绝，不能假装完整文件已返回')

  const remote = await request('remote.jar')
  assert.equal(remote.statusCode, 200)
  assert.equal(lastUpstreamRequest.headers['X-8BG-Verify-Full'], 'sha256-v1', '整份远端 JAR 必须要求 Worker 先验 SHA-256')
  assert.equal(lastUpstreamRequest.headers['X-8BG-Require-Integrity'], 'sha256-v1')
  assert.deepEqual(remote.body, fixture)
  const expectedProxyEtag = `"8bg-sha256-v1-${Buffer.from(upstreamHeaders.etag).toString('base64url')}"`
  assert.equal(remote.headers.get('etag'), expectedProxyEtag)

  const legacyCache = await request('remote.jar', { ifNoneMatch: upstreamHeaders.etag })
  assert.equal(legacyCache.statusCode, 200, '旧版原始 ETag 缓存必须重取完整 JAR，不能直接 304')
  assert.equal(lastUpstreamRequest.headers['if-none-match'], undefined)
  assert.deepEqual(legacyCache.body, fixture)

  const verifiedCache = await request('remote.jar', { ifNoneMatch: expectedProxyEtag })
  assert.equal(verifiedCache.statusCode, 304, '新代缓存可以通过已验证 ETag 复用')
  assert.equal(verifiedCache.headers.get('etag'), expectedProxyEtag)
  assert.equal(lastUpstreamRequest.headers['if-none-match'], upstreamHeaders.etag)

  const remoteRange = await request('remote.jar', { range: 'bytes=1-4' })
  assert.equal(remoteRange.statusCode, 206)
  assert.equal(lastUpstreamRequest.headers['X-8BG-Require-Integrity'], 'sha256-v1', 'JAR Range 也必须强制要求当前版本清单')
  assert.deepEqual(remoteRange.body, fixture.subarray(1, 5))

  upstreamRangeVerified = false
  const unverifiedRange = await request('remote.jar', { range: 'bytes=1-4' })
  assert.equal(unverifiedRange.statusCode, 502, '旧 Worker 未验证 JAR Range 时代理必须失败关闭')
  upstreamRangeVerified = true

  upstreamHeaders = { etag: '"jar-v1"', 'content-length': String(fixture.length) }
  const unverified = await request('unverified.jar')
  assert.equal(unverified.statusCode, 502, '缺少 Worker 全量校验结果时不得把 JAR 交给模拟器')
  assert.match(unverified.body.toString(), /SHA-256/)

  console.log('✅ J2ME 临时与远端 JAR：完整性校验、Range/HEAD、后缀范围与 416 响应通过')
} finally {
  await rm(directory, { recursive: true, force: true })
}
