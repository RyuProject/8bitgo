/** 大型 DOS bundle：分片、缓存与坏缓存自愈的接线回归。 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'

globalThis.__dosBlobCache = new Map()
globalThis.__dosBlobFetches = []
globalThis.__dosBlobResumeClears = []
globalThis.__dosBlobDeletes = []
globalThis.__dosBlobFailDecode = false
globalThis.__dosBlobAbortDecode = false
globalThis.__dosBlobDecodeStarted = false
globalThis.__dosBlobAbortReady = false
globalThis.__dosBlobReadyStarted = false
globalThis.__dosBlobUnreadable = false
globalThis.__dosBlobProbeUnreadable = false
globalThis.__dosBlobPrewarms = []
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
      // 换线路（assets ↔ cn-assets）由 romHosts 决定；这里只验证下载器确实拿到了备用地址。
      fake(/^@\/services\/romHosts$/, 'hosts')
      api.onLoad({ filter: /.*/, namespace: 'dos-blob-test' }, (args) => ({
        loader: 'js',
        contents: args.path === 'resume'
          ? `export const downloadResumeStore = { clear: async k => { globalThis.__dosBlobResumeClears.push(k) } }`
          : args.path === 'progress'
            ? `export const fetchBlobWithProgress = async (u, o) => { globalThis.__dosBlobFetches.push({ u, resumeKey: o.resumeKey, alternateUrls: o.alternateUrls }); return globalThis.__dosBlobStored };
               export const withResumeTimeout = async (task) => task;`
            : args.path === 'hosts'
              ? `export const alternateRomUrls = u => [u.replace('https://assets.example/', 'https://cn-assets.example/')]`
            : args.path === 'cache'
              ? `export const romCacheKey = u => /[?&]romv=/.test(u) ? u : '';
                 export const romCacheGetBlob = async k => globalThis.__dosBlobCache.get(k) ?? null;
                 export const romCachePutBlob = async (k, b) => { globalThis.__dosBlobCache.set(k, b) };
                 export const romCacheDelete = async k => { globalThis.__dosBlobDeletes.push(k); globalThis.__dosBlobCache.delete(k) };`
              : args.path === 'bundle'
                ? `export const isReadyJsdosBundleBlob = async (blob, timeout, signal) => {
                     if (globalThis.__dosBlobAbortReady) {
                       globalThis.__dosBlobAbortReady = false
                       globalThis.__dosBlobReadyStarted = true
                       if (!signal) throw new Error('ZIP 校验必须收到启动取消信号')
                       await new Promise(resolve => {
                         if (signal.aborted) resolve()
                         else signal.addEventListener('abort', resolve, { once: true })
                       })
                       throw signal.reason ?? new DOMException('已取消', 'AbortError')
                     }
                     return globalThis.__dosBlobReady
                   }`
              : `export const isRomPackBytes = b => b[0] === 0x38 && b[1] === 0x42 && b[2] === 0x47 && b[3] === 0x31;
                   export const readBlobRange = async (blob, start, end) => {
                     if (globalThis.__dosBlobProbeUnreadable) {
                       globalThis.__dosBlobProbeUnreadable = false
                       const e = new Error('blob probe stuck'); e.name = 'NotReadableError'; throw e
                     }
                     return blob.slice(start, end).arrayBuffer()
                   };
                   export const isRomPackUrl = u => /\\.8bg(?:[?#]|$)/i.test(u);
                   export const prewarmRomPackDecoder = u => { globalThis.__dosBlobPrewarms.push(u) };
                   export const isBlobReadError = e => Boolean(e && e.name === 'NotReadableError');
                   export const unpackRomPackBlob = async (stored, onChunk, signal) => {
                     if (globalThis.__dosBlobAbortDecode) {
                       globalThis.__dosBlobAbortDecode = false
                       globalThis.__dosBlobDecodeStarted = true
                       if (!signal) throw new Error('解包必须收到启动取消信号')
                       await new Promise(resolve => {
                         if (signal.aborted) resolve()
                         else signal.addEventListener('abort', resolve, { once: true })
                       })
                       throw signal.reason ?? new DOMException('已取消', 'AbortError')
                     }
                     if (globalThis.__dosBlobUnreadable) {
                       globalThis.__dosBlobUnreadable = false
                       const e = new Error('blob store broken'); e.name = 'NotReadableError'; throw e
                     }
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
assert.deepEqual(
  globalThis.__dosBlobFetches[0].alternateUrls,
  ['https://cn-assets.example/roms/dos/fallout.en.zip.8bg?romv=v1'],
  '当前线路重试用光后必须能换另一条 CDN 线路（AGENTS §2.12）',
)
assert.deepEqual(globalThis.__dosBlobPrewarms, [url], '8BG 包的解码器与密钥必须和下载并行预热（AGENTS §2.24.0c）')
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

// 玩家离开页面时，缓存解包必须中止，且不能把有效密文缓存当成坏包删除。
const abortUrl = 'https://assets.example/roms/dos/fallout.en.zip.8bg?romv=abort'
globalThis.__dosBlobCache.set(abortUrl, globalThis.__dosBlobStored)
globalThis.__dosBlobAbortDecode = true
globalThis.__dosBlobDecodeStarted = false
const abortController = new AbortController()
const abortFetchesBefore = globalThis.__dosBlobFetches.length
const pendingAbort = prepareRemoteDosBundle(abortUrl, undefined, abortController.signal)
for (let attempt = 0; attempt < 20 && !globalThis.__dosBlobDecodeStarted; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
assert.equal(globalThis.__dosBlobDecodeStarted, true, '测试需等到缓存包体解码已开始再取消')
abortController.abort(new DOMException('game changed', 'AbortError'))
await assert.rejects(pendingAbort, (error) => error?.name === 'AbortError')
assert.equal(globalThis.__dosBlobCache.get(abortUrl), globalThis.__dosBlobStored, '取消解包不能清除有效 ROM 缓存')
assert.ok(!globalThis.__dosBlobDeletes.includes(abortUrl), '用户取消不能进入坏缓存自愈')
assert.equal(globalThis.__dosBlobFetches.length, abortFetchesBefore, '缓存解包取消后不应额外下载游戏包')

// 普通 ZIP 的目录检查也必须听从本局取消信号，不能在切换游戏后继续扫 Blob。
const abortZipUrl = 'https://assets.example/roms/dos/fallout.en.zip?romv=abort-zip'
globalThis.__dosBlobCache.set(abortZipUrl, globalThis.__dosBlobPlain)
globalThis.__dosBlobAbortReady = true
globalThis.__dosBlobReadyStarted = false
const zipAbortController = new AbortController()
const zipAbortFetchesBefore = globalThis.__dosBlobFetches.length
const pendingZipAbort = prepareRemoteDosBundle(abortZipUrl, undefined, zipAbortController.signal)
for (let attempt = 0; attempt < 20 && !globalThis.__dosBlobReadyStarted; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
assert.equal(globalThis.__dosBlobReadyStarted, true, '测试需等到缓存 ZIP 目录检查已开始再取消')
zipAbortController.abort(new DOMException('game changed', 'AbortError'))
await assert.rejects(pendingZipAbort, (error) => error?.name === 'AbortError')
assert.equal(globalThis.__dosBlobCache.get(abortZipUrl), globalThis.__dosBlobPlain, '取消 ZIP 校验不能清除有效缓存')
assert.ok(!globalThis.__dosBlobDeletes.includes(abortZipUrl), '取消 ZIP 校验不能触发坏缓存自愈')
assert.equal(globalThis.__dosBlobFetches.length, zipAbortFetchesBefore, '取消 ZIP 校验后不应发起重新下载')

const unversioned = 'https://assets.example/roms/dos/fallout.en.zip.8bg'
await prepareRemoteDosBundle(unversioned, undefined, new AbortController().signal)
await prepareRemoteDosBundle(unversioned, undefined, new AbortController().signal)
assert.equal(globalThis.__dosBlobFetches.length, 4, '无版本 URL 不得缓存或续传，避免两代 ROM 拼包')
assert.equal(globalThis.__dosBlobFetches.at(-1).resumeKey, undefined)

// 续传片拼出的包读不出来（NotReadableError）：作废续传片，不带续传整包重下一次（AGENTS §2.8.4）。
const url3 = 'https://assets.example/roms/dos/fallout.en.zip.8bg?romv=v3'
globalThis.__dosBlobUnreadable = true
const fetchesBefore = globalThis.__dosBlobFetches.length
const clearsBefore = globalThis.__dosBlobResumeClears.length
let reread
try {
  console.warn = () => {}
  reread = await prepareRemoteDosBundle(url3, undefined, new AbortController().signal)
} finally {
  console.warn = originalWarn
}
assert.equal(reread.name, 'fallout.en.zip')
assert.equal(globalThis.__dosBlobFetches.length, fetchesBefore + 2, '读不出来时必须重下一次')
assert.equal(globalThis.__dosBlobFetches.at(-2).resumeKey, url3, '第一次仍带续传')
assert.equal(globalThis.__dosBlobFetches.at(-1).resumeKey, undefined, '重下那次不能再拼旧续传片')
assert.ok(globalThis.__dosBlobResumeClears.slice(clearsBefore).includes(url3), '重下前必须作废这组续传片')

// 解密前的四字节魔数探测本身也可能遇到坏 Blob；它必须走同一条有界读取 / 续传作废恢复。
const url4 = 'https://assets.example/roms/dos/fallout.en.zip.8bg?romv=v4'
globalThis.__dosBlobProbeUnreadable = true
const probeFetchesBefore = globalThis.__dosBlobFetches.length
const probeClearsBefore = globalThis.__dosBlobResumeClears.length
let probeRecovered
try {
  console.warn = () => {}
  probeRecovered = await prepareRemoteDosBundle(url4, undefined, new AbortController().signal)
} finally {
  console.warn = originalWarn
}
assert.equal(probeRecovered.name, 'fallout.en.zip')
assert.equal(globalThis.__dosBlobFetches.length, probeFetchesBefore + 2, '魔数读取失败后必须重下而不是停在 100%')
assert.ok(globalThis.__dosBlobResumeClears.slice(probeClearsBefore).includes(url4), '魔数读取失败时必须作废续传片')

globalThis.__dosBlobStored = globalThis.__dosBlobPlain
globalThis.__dosBlobReady = false
const plain = await prepareRemoteDosBundle('https://assets.example/game.zip?romv=plain', undefined, new AbortController().signal)
assert.equal(plain.name, 'game.zip')
assert.equal(plain.ready, false, '没有 dosbox.conf 的普通 ZIP 必须回旧逻辑补配置')

console.log('DOS Blob：分片续传、换线路、并行预热、版本缓存、密文落盘、坏缓存与读不出包自愈、普通 ZIP 回退通过')
