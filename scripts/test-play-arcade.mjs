#!/usr/bin/env node
import assert from 'node:assert/strict'
import { appendZipEntries } from '../src/lib/unzip.ts'
import { inspectPlayArcadeBundle, PLAY_ARCADE_BUNDLE_FORMAT } from '../src/lib/playArcadeBundle.ts'
import { isIsolatedRuntimePlatform, isolatedRuntimeRoute } from '../shared/isolated-runtime-platforms.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { CACHE, staticCacheHeaders } from '../server/src/cache.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const detailPage = readFileSync(join(root, 'src/pages/GameDetailPage.tsx'), 'utf8')
const embedPage = readFileSync(join(root, 'src/pages/EmbedPage.tsx'), 'utf8')
const routes = readFileSync(join(root, 'src/AppRoutes.tsx'), 'utf8')
const playAdapter = readFileSync(join(root, 'src/emulator/adapters/play.ts'), 'utf8')

function headersFor(url, file) {
  const headers = new Map()
  staticCacheHeaders({ req: { originalUrl: url }, setHeader: (name, value) => headers.set(name, value) }, file)
  return headers
}

const playHeaders = headersFor('/play/20261026-system2x6-v1/Play.js', '/srv/public/play/20261026-system2x6-v1/Play.js')
assert.equal(playHeaders.get('Cross-Origin-Embedder-Policy'), 'require-corp')
assert.equal(playHeaders.get('Cache-Control'), CACHE.engineVersioned, '版本化 Play! JS 必须可长期缓存且保留 pthread 响应头')
const wasmHeaders = headersFor('/play/20261026-system2x6-v1/Play.wasm', '/srv/public/play/20261026-system2x6-v1/Play.wasm')
assert.equal(wasmHeaders.get('Cache-Control'), CACHE.engineVersioned, '版本化 Play! WASM 与胶水文件必须一同换代')

function makeZip(files) {
  const empty = new Uint8Array(22)
  new DataView(empty.buffer).setUint32(0, 0x06054b50, true)
  return appendZipEntries(empty.buffer, files.map(([name, data]) => ({
    name,
    data: data instanceof Uint8Array ? data : new TextEncoder().encode(data),
  })))
}

const dongle = makeZip([['te51verb.ic002', 'dongle']])
const definition = JSON.stringify({
  id: 'tekken51',
  driver: 'sys246',
  dongle: { name: 'te51verb.ic002' },
  cdvd: { name: 'te51-dvd0.chd' },
})
const manifest = JSON.stringify({
  format: PLAY_ARCADE_BUNDLE_FORMAT,
  id: 'tekken51',
  definition: 'arcadedefs/tekken51.arcadedef',
  dongleArchive: 'arcaderoms/tekken51.zip',
  discs: ['arcaderoms/tekken51/te51-dvd0.chd'],
})

assert.equal(isIsolatedRuntimePlatform('arcade'), false, '普通街机仍可留在详情页运行 EmulatorJS')
assert.deepEqual(isolatedRuntimeRoute('/play/arcade/tekken51'), { platform: 'arcade', slug: 'tekken51' })
assert.match(detailPage, /game\?\.platform === 'arcade'[\s\S]*?game\.runtime === 'play'/, '只有显式选用 Play! 的街机才显示独立启动页')
assert.match(embedPage, /runtime=\{game\.runtime\}/, '隔离路由必须把逐游戏运行时交给播放器')
assert.match(routes, /path="\/play\/arcade\/:slug"/, 'Play! 街机必须有客户端隔离页路由')
console.log('✅ Play! 街机有独立隔离路由，但普通街机不会被全局改成隔离页')

const pack = (nextManifest = manifest, nextDefinition = definition) => makeZip([
  ['8bitgo-play-arcade.json', nextManifest],
  ['arcadedefs/tekken51.arcadedef', nextDefinition],
  ['arcaderoms/tekken51.zip', new Uint8Array(dongle)],
  ['arcaderoms/tekken51/te51-dvd0.chd', 'fake-chd-bytes'],
])

const good = await inspectPlayArcadeBundle(new Blob([pack()]))
assert.equal(good.manifest.id, 'tekken51')
assert.equal(good.discEntries.length, 1)
console.log('✅ 正确的 System 2x6 包、定义、dongle 和镜像可配对')

await assert.rejects(inspectPlayArcadeBundle(new Blob([pack(manifest.replace('arcaderoms/tekken51/', 'arcaderoms/../'))])), /discs 清单无效|镜像路径/)
console.log('✅ 路径穿越的镜像引用被拒绝')

await assert.rejects(inspectPlayArcadeBundle(new Blob([pack(manifest, definition.replace('sys246', 'unknown'))])), /驱动/)
console.log('✅ 未实现的 Play! 驱动被拒绝')

assert.match(playAdapter, /if \(fatalRuntime\) options\.onError\?\.\(message, 'runtime'\)/, '游戏中 Range 读盘失败必须进入可见错误状态，不能让核心永久轮询')
assert.match(playAdapter, /fail\(fmt\(rt\.playDiscFailed, \{ msg: e\.message \}\), true\)/, '流式盘读失败必须标记为致命运行时错误')
assert.match(playAdapter, /signal: requestController\.signal,[\s\S]*?maxBytes: PLAY_ARCADE_BUNDLE_MAX_BYTES/, '离开页面时必须取消街机包下载')
console.log('✅ PS2 流式读盘失败可见且可收场；离开页面会取消 ROM 请求')

await assert.rejects(inspectPlayArcadeBundle(new Blob([makeZip([
  ['8bitgo-play-arcade.json', manifest],
  ['arcadedefs/tekken51.arcadedef', definition],
  ['arcaderoms/tekken51.zip', new Uint8Array(dongle)],
  ['arcaderoms/tekken51/te51-dvd0.chd', 'fake-chd-bytes'],
  ['unexpected.bin', 'extra'],
])])), /清单之外/)
console.log('✅ 清单未列出的包成员被拒绝')
