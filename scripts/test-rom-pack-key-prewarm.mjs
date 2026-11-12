/**
 * 8BG 数据密钥与 ROM 下载并行预取（2026-11-12《凯撒大帝》：ROM 下完才要密钥、密钥回来才取解码器，
 * 高 RTT 线路上串行多走两趟往返）。
 * 运行：node --experimental-strip-types --import ./scripts/helpers/ts-register.mjs scripts/test-rom-pack-key-prewarm.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

globalThis.__viteEnv = { VITE_API_URL: 'https://api.example.test' }
const { prewarmRomPackKey } = await import('../src/services/romPack.ts')

const header = {
  version: 1, packageId: '2045423a260afd9a0c20021664b9ce3f', keyId: 'v1', codec: 'zstd', codecVersion: 1,
  compressionLevel: 19, codecOptions: {}, cipher: 'aes-256-gcm', originalName: 'caesar-1992.en.zip',
  originalSize: 752174, originalSha256: null, chunkSize: 8388608, noncePrefix: '6OhYOVS8pZY',
  chunks: [{ sourceSize: 752174, encodedSize: 736401, cipherSize: 736417, sha256: 'f3e3c96bd5c64eaf8805c03d51c3b22afcd5b2ad0152e90d4e49e81ec1ff18aa' }],
  payloadSize: 736417, createdAt: '2026-09-17T06:19:17.843Z',
}
const json = new TextEncoder().encode(JSON.stringify(header))
const prefix = new Uint8Array(4096)
prefix.set(new TextEncoder().encode('8BG1'))
new DataView(prefix.buffer).setUint32(4, json.byteLength, true)
prefix.set(json, 8)
const key = Buffer.alloc(32, 7).toString('base64url')

const calls = []
const fakeFetch = (romStatus) => async (url, init = {}) => {
  calls.push({ url: String(url), range: init.headers?.Range })
  if (String(url).includes('/api/rom-pack/key')) {
    const q = new URL(String(url)).searchParams
    return new Response(JSON.stringify({ packageId: q.get('packageId'), keyId: q.get('keyId'), key }), { status: 200 })
  }
  return new Response(prefix, { status: romStatus, headers: { 'Content-Range': `bytes 0-4095/${8 + json.byteLength + 736417}` } })
}
const settle = () => new Promise((r) => setTimeout(r, 30))

console.log('── 读包头 Range，随后取密钥 ──')
const realFetch = globalThis.fetch
globalThis.fetch = fakeFetch(206)
const url = 'https://cn-assets.8bitgo.com/roms/dos/caesar.en.zip.8bg?romv=59d7'
prewarmRomPackKey(url, globalThis.fetch)
await settle()
assert.equal(calls[0].url, url)
assert.equal(calls[0].range, 'bytes=0-4095', '只读包头前缀，不重复下载整包')
const keyCalls = calls.filter((c) => c.url.includes('/api/rom-pack/key'))
assert.equal(keyCalls.length, 1)
assert.match(keyCalls[0].url, /packageId=2045423a260afd9a0c20021664b9ce3f/)
assert.match(keyCalls[0].url, /keyId=v1/)

console.log('── 同一地址只预取一次 ──')
prewarmRomPackKey(url, globalThis.fetch)
await settle()
assert.equal(calls.length, 2)

console.log('── 源站不支持 Range（回 200）时不取密钥 ──')
calls.length = 0
globalThis.fetch = fakeFetch(200)
prewarmRomPackKey('https://assets.8bitgo.com/roms/dos/other.zip.8bg', globalThis.fetch)
await settle()
assert.equal(calls.filter((c) => c.url.includes('/api/rom-pack/key')).length, 0)

console.log('── 非 8BG 地址不预取 ──')
calls.length = 0
prewarmRomPackKey('https://assets.8bitgo.com/roms/dos/plain.zip', globalThis.fetch)
await settle()
assert.equal(calls.length, 0)
globalThis.fetch = realFetch

console.log('── 各下载入口都与 ROM 并行预取密钥 ──')
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const dos = read('src/emulator/dosBundleSource.ts')
const warmAt = dos.indexOf('if (isRomPackUrl(url)) prewarmRomPackDecoder(url)')
assert.ok(warmAt > 0, '普通 DOS 包（不经 loadGameBytes）也要预热解码器和密钥')
assert.ok(warmAt < dos.indexOf('await romCacheGetBlob(cacheKey)'), '预热必须先于读缓存 / 下载发起')
assert.match(read('src/emulator/romLoader.ts'), /if \(isRomPackUrl\(game\)\) prewarmRomPackDecoder\(game\)/)
assert.equal((read('src/emulator/adapters/emulatorjs.ts').match(/if \(isRomPackUrl\(url\)\) prewarmRomPackDecoder\(url\)/g) ?? []).length, 2)

console.log('全部通过')
