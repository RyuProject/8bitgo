/** 外层 ZIP → 单个 ROM → 玩家缓存；测试只用自造的假 ROM，不访问外网。 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { build } from 'esbuild'

globalThis.__archiveCache = new Map()
const built = await build({
  stdin: {
    contents: "export { loadRemoteArchiveRom } from './src/emulator/remoteArchive.ts'; export { crc32, appendZipEntries } from './src/lib/unzip.ts'",
    resolveDir: process.cwd(), sourcefile: 'remote-archive-test-entry.ts', loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
  plugins: [{
    name: 'memory-cache',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^@\// }, (args) => ({ path: path.join(process.cwd(), 'src', `${args.path.slice(2)}.ts`) }))
      buildApi.onResolve({ filter: /^\.\/romCache$/ }, (args) =>
        args.importer.endsWith('/remoteArchive.ts') ? { path: 'fake', namespace: 'cache-test' } : undefined)
      buildApi.onLoad({ filter: /.*/, namespace: 'cache-test' }, () => ({
        contents: `export const romCacheKey = u => /[?&]romv=/.test(u.split('#')[0]) || /[&#](?:v|romv)=/.test(u) ? u : '';
          export const romCacheGetBlob = async k => globalThis.__archiveCache.get(k) ?? null;
          export const romCachePutBlob = async (k, b) => { globalThis.__archiveCache.set(k, b) };`,
        loader: 'js',
      }))
    },
  }],
})
const { loadRemoteArchiveRom, crc32, appendZipEntries } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`)

function zip(name, body, method = 8, badCrc = false, declaredSize = body.length) {
  const label = Buffer.from(name)
  const payload = method === 8 ? deflateRawSync(body) : body
  const checksum = badCrc ? 1 : crc32(body)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(method, 8)
  local.writeUInt32LE(checksum, 14)
  local.writeUInt32LE(payload.length, 18)
  local.writeUInt32LE(declaredSize, 22)
  local.writeUInt16LE(label.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(method, 10)
  central.writeUInt32LE(checksum, 16)
  central.writeUInt32LE(payload.length, 20)
  central.writeUInt32LE(declaredSize, 24)
  central.writeUInt16LE(label.length, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + label.length, 12)
  end.writeUInt32LE(local.length + label.length + payload.length, 16)
  return Buffer.concat([local, label, payload, central, label, end])
}

const rom = Buffer.from([0x4e, 0x45, 0x53, 0x1a, ...Array(12).fill(0)])
let body = zip('folder/game.nes', rom)
const requests = []
globalThis.fetch = async (url, options) => {
  requests.push({ url, cache: options?.cache })
  return new Response(body, { headers: { 'content-type': 'application/zip', 'content-length': String(body.length) } })
}
const base = 'https://files.example.com/outer.zip?token=abc#rom=folder%2Fgame.nes'
const first = await loadRemoteArchiveRom(`${base}&v=1`)
assert.equal(first.name, 'game.nes')
assert.equal(first.fromCache, false)
assert.deepEqual(Buffer.from(await first.blob.arrayBuffer()), rom)
assert.deepEqual(requests, [{ url: 'https://files.example.com/outer.zip?token=abc', cache: 'no-store' }], 'fragment 不能发给外站，外层 ZIP 也不留 HTTP 缓存')
const second = await loadRemoteArchiveRom(`${base}&v=1`)
assert.equal(second.fromCache, true)
assert.equal(requests.length, 1, '命中玩家缓存不能再次下载外层 ZIP')
await loadRemoteArchiveRom(`${base}&v=2`)
assert.equal(requests.length, 2, '版本变更必须重新下载')
await loadRemoteArchiveRom(base)
await loadRemoteArchiveRom(base)
assert.equal(requests.length, 4, '无 ETag/手工版本时不能留下无法失效的缓存')
await assert.rejects(loadRemoteArchiveRom(`${base.replace('game.nes', 'missing.nes')}&v=3`), /找不到 ROM/)
body = zip('folder/game.nes', rom, 8, true)
await assert.rejects(loadRemoteArchiveRom(`${base}&v=4`), /校验失败/)
body = zip('folder/game.nes', rom, 8, false, 513 * 1024 * 1024)
await assert.rejects(loadRemoteArchiveRom(`${base}&v=5`), /过大/)
await assert.rejects(loadRemoteArchiveRom('https://files.example.com/outer.zip#rom=../bad.nes'), /路径无效/)
body = zip('folder/actual.nds', rom)
const auto = 'https://files.example.com/hash.nds.zip#rom=auto&v=1'
const autoFirst = await loadRemoteArchiveRom(auto)
assert.equal(autoFirst.name, 'hash.nds', '自动模式的运行时文件名从外层双后缀稳定推导')
assert.equal((await loadRemoteArchiveRom(auto)).name, 'hash.nds', '缓存命中后文件名不能漂移')
const raw = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
body = Buffer.from(appendZipEntries(raw, [{ name: 'other.nds', data: new Uint8Array(rom) }]))
await assert.rejects(loadRemoteArchiveRom('https://files.example.com/hash.nds.zip#rom=auto&v=2'), /多个 \.nds/)
await assert.rejects(loadRemoteArchiveRom('https://files.example.com/outer.zip#rom=auto&v=1'), /自动识别需要/)
globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
await assert.rejects(loadRemoteArchiveRom(`${base}&v=6`), /跨域 GET/)
console.log('remote archive: 解包、CRC、缓存命中与失效、大小限制通过')
