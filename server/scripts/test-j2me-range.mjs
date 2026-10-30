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

async function request(name, { range, method = 'GET' } = {}) {
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
  await j2meJarProxy(req, res)
  await finished(res)
  return { statusCode, headers, body: Buffer.concat(chunks) }
}

try {
  const fixture = await readFile(new URL('./fixtures/minimal.jar', import.meta.url))
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

  console.log('✅ J2ME 临时 JAR：完整读取、Range/HEAD、后缀范围与 416 响应通过')
} finally {
  await rm(directory, { recursive: true, force: true })
}
