/**
 * 8BG 正式 JAR 由服务端解包（2026-11-10）：
 * 以前浏览器要下载 → 解密 → 再 POST 回本站，大陆实测光上传就 23 秒。现在 /j2me/jar/X.8bg.jar
 * 由 j2me.js 从 R2 取 roms/java/X.jar.8bg、解密、校验，并在内存里给 CheerpJ 的几次 Range 复用。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { finished } from 'node:stream/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'

const root = fileURLToPath(new URL('../..', import.meta.url))
const directory = await mkdtemp(path.join(os.tmpdir(), '8bitgo-j2me-packed-'))
const SECRET = 'test-secret-for-j2me-packed-jar-0123456789abcdef'
process.env.J2ME_TMP_DIR = directory
process.env.ROM_PACK_SECRET = SECRET
delete process.env.ROM_PACK_KEY_ID

register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier.endsWith('site-urls.js')) {
      return { url: 'data:text/javascript,' + encodeURIComponent("export const assetBaseUrl = () => 'https://assets.invalid'"), shortCircuit: true };
    }
    return next(specifier, context);
  }
`))

const fixture = await readFile(new URL('./fixtures/minimal.jar', import.meta.url))
const source = path.join(directory, 'minimal.jar')
const packedPath = path.join(directory, 'minimal.jar.8bg')
await writeFile(source, fixture)
execFileSync(process.execPath, [path.join(root, 'scripts/pack-rom.mjs'), source, packedPath], {
  cwd: directory,
  env: { ...process.env, ROM_PACK_SECRET: SECRET },
  stdio: 'ignore',
})
const packed = await readFile(packedPath)

let fetches = 0
let etag = '"v1"'
globalThis.fetch = async (url, init = {}) => {
  fetches++
  assert.equal(String(url), 'https://assets.invalid/roms/java/minimal.jar.8bg', '只去 R2 的 roms/java/<名>.jar.8bg 取')
  if (init.headers?.['if-none-match'] === etag) return new Response(null, { status: 304, headers: { etag } })
  return new Response(packed, { status: 200, headers: { etag, 'content-length': String(packed.length) } })
}

const { j2meJarProxy, packedJarKeyName } = await import(pathToFileURL(path.join(root, 'server/src/j2me.js')).href)

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
  const reqHeaders = {}
  if (range) reqHeaders.range = range
  if (ifNoneMatch) reqHeaders['if-none-match'] = ifNoneMatch
  await j2meJarProxy({ params: { name }, headers: reqHeaders, method }, res)
  await finished(res)
  return { statusCode, headers, body: Buffer.concat(chunks) }
}

try {
  assert.equal(packedJarKeyName('silent-hill-2.zh-Hans.8bg.jar'), 'silent-hill-2.zh-Hans.jar.8bg')
  assert.equal(packedJarKeyName('plain.jar'), '', '明文 JAR 不走解包')

  const head = await request('minimal.8bg.jar', { method: 'HEAD' })
  assert.equal(head.statusCode, 200)
  assert.equal(head.headers.get('content-length'), String(fixture.length))
  assert.equal(head.headers.get('accept-ranges'), 'bytes')

  const whole = await request('minimal.8bg.jar')
  assert.ok(whole.body.equals(fixture), '解包后与原 JAR 逐字节一致')

  const part = await request('minimal.8bg.jar', { range: 'bytes=10-29' })
  assert.equal(part.statusCode, 206)
  assert.equal(part.headers.get('content-range'), `bytes 10-29/${fixture.length}`)
  assert.ok(part.body.equals(fixture.subarray(10, 30)))
  assert.equal(fetches, 1, 'CheerpJ 的多次 Range 复用同一份解包结果，不重复回源')

  const notModified = await request('minimal.8bg.jar', { ifNoneMatch: head.headers.get('etag') })
  assert.equal(notModified.statusCode, 304)

  // 包坏了：不能把垃圾交给 JVM
  etag = '"v2"'
  const broken = Buffer.from(packed)
  broken[broken.length - 5] ^= 0xff
  globalThis.fetch = async () => new Response(broken, { status: 200, headers: { etag } })
  const bad = await request('other.8bg.jar')
  assert.equal(bad.statusCode, 502, '解密 / 校验失败回 502')

  globalThis.fetch = async () => new Response('nope', { status: 404 })
  const missing = await request('missing.8bg.jar')
  assert.equal(missing.statusCode, 404)

  console.log('✔ J2ME 8BG 服务端解包：HEAD / 整包 / Range / 304 / 缓存复用 / 坏包 / 缺失')
} finally {
  await rm(directory, { recursive: true, force: true })
}
