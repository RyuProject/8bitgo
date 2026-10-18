/** 大型 DOS bundle：分片、缓存与坏缓存自愈的接线回归。 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { build } from 'esbuild'

globalThis.__dosBlobCache = new Map()
globalThis.__dosBlobFetches = []
globalThis.__dosBlobResumeClears = []
globalThis.__dosBlobDeletes = []
globalThis.__dosBlobFailDecode = false
globalThis.__dosBlobReady = true
globalThis.__dosBlobStored = new Blob([new Uint8Array([0x38, 0x42, 0x47, 0x31, 1, 2, 3])])
globalThis.__dosBlobPlain = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 8, 7])])

const built = await build({
  stdin: {
    contents: "export { prepareRemoteDosBundle } from './src/emulator/dosBundleSource.ts'",
    resolveDir: process.cwd(),
    sourcefile: 'dos-blob-source-test-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [{
    name: 'dos-blob-fakes',
    setup(api) {
      const fake = (filter, name) => api.onResolve({ filter }, () => ({ path: name, namespace: 'dos-blob-test' }))
      fake(/^\.\/downloadResume$/, 'resume')
      fake(/^\.\/loadProgress$/, 'progress')
      fake(/^\.\/romCache$/, 'cache')
      fake(/^@\/lib\/jsdosBundle$/, 'bundle')
      fake(/^@\/services\/romPack$/, 'pack')
      api.onLoad({ filter: /.*/, namespace: 'dos-blob-test' }, (args) => ({
        loader: 'js',
        contents: args.path === 'resume'
          ? `export const downloadResumeStore = { clear: async k => { globalThis.__dosBlobResumeClears.push(k) } }`
          : args.path === 'progress'
            ? `export const fetchBlobWithProgress = async (u, o) => { globalThis.__dosBlobFetches.push({ u, resumeKey: o.resumeKey }); return globalThis.__dosBlobStored }`
            : args.path === 'cache'
              ? `export const romCacheKey = u => /[?&]romv=/.test(u) ? u : '';
                 export const romCacheGetBlob = async k => globalThis.__dosBlobCache.get(k) ?? null;
                 export const romCachePutBlob = async (k, b) => { globalThis.__dosBlobCache.set(k, b) };
                 export const romCacheDelete = async k => { globalThis.__dosBlobDeletes.push(k); globalThis.__dosBlobCache.delete(k) };`
              : args.path === 'bundle'
                ? `export const isReadyJsdosBundleBlob = async () => globalThis.__dosBlobReady`
                : `export const isRomPackBytes = b => b[0] === 0x38 && b[1] === 0x42 && b[2] === 0x47 && b[3] === 0x31;
                   export const unpackRomPackBlob = async () => {
                     if (globalThis.__dosBlobFailDecode) { globalThis.__dosBlobFailDecode = false; throw new Error('bad cached key') }
                     return { name: 'fallout.en.zip', blob: globalThis.__dosBlobPlain, header: {} }
                   };`,
      }))
    },
  }],
})

const { prepareRemoteDosBundle } = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`
)

const url = 'https://assets.example/roms/dos/fallout.en.zip.8bg?romv=v1'
const progress = []
const first = await prepareRemoteDosBundle(url, (value) => progress.push(value), new AbortController().signal)
assert.equal(first.name, 'fallout.en.zip')
assert.equal(first.ready, true)
assert.equal(first.fromCache, false)
assert.equal(globalThis.__dosBlobFetches.length, 1)
assert.equal(globalThis.__dosBlobFetches[0].resumeKey, url, '版本化 URL 必须启用跨刷新分片续传')
assert.ok(progress.some((value) => value.detail === 'rom-pack'), '下载完成后的解密/解包必须显示真实状态')
await Promise.resolve()
assert.equal(globalThis.__dosBlobCache.get(url), globalThis.__dosBlobStored, '缓存保持 8BG 密文，不落明文游戏包')

const second = await prepareRemoteDosBundle(url, (value) => progress.push(value), new AbortController().signal)
assert.equal(second.fromCache, true)
assert.equal(globalThis.__dosBlobFetches.length, 1, '第二次开局不应重新下载 503MB')
assert.ok(progress.some((value) => value.cached === true && value.ratio === 1), '缓存命中必须告诉加载界面“无需下载”')
assert.ok(globalThis.__dosBlobResumeClears.includes(url), '完整缓存命中时清掉并发遗留的临时分片')

const url2 = 'https://assets.example/roms/dos/fallout.en.zip.8bg?romv=v2'
globalThis.__dosBlobCache.set(url2, globalThis.__dosBlobStored)
globalThis.__dosBlobFailDecode = true
const originalWarn = console.warn
let recovered
try {
  console.warn = () => {}
  recovered = await prepareRemoteDosBundle(url2, undefined, new AbortController().signal)
} finally {
  console.warn = originalWarn
}
assert.equal(recovered.fromCache, false)
assert.ok(globalThis.__dosBlobDeletes.includes(url2), '旧密钥/截断缓存必须删除后回网络自愈')
assert.equal(globalThis.__dosBlobFetches.length, 2)

const unversioned = 'https://assets.example/roms/dos/fallout.en.zip.8bg'
await prepareRemoteDosBundle(unversioned, undefined, new AbortController().signal)
await prepareRemoteDosBundle(unversioned, undefined, new AbortController().signal)
assert.equal(globalThis.__dosBlobFetches.length, 4, '无版本 URL 不得缓存或续传，避免两代 ROM 拼包')
assert.equal(globalThis.__dosBlobFetches.at(-1).resumeKey, undefined)

globalThis.__dosBlobStored = globalThis.__dosBlobPlain
globalThis.__dosBlobReady = false
const plain = await prepareRemoteDosBundle('https://assets.example/game.zip?romv=plain', undefined, new AbortController().signal)
assert.equal(plain.name, 'game.zip')
assert.equal(plain.ready, false, '没有 dosbox.conf 的普通 ZIP 必须回旧逻辑补配置')

console.log('DOS Blob：分片续传、版本缓存、密文落盘、坏缓存自愈与普通 ZIP 回退通过')
