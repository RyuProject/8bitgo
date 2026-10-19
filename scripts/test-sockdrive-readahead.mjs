#!/usr/bin/env node
/**
 * 在真实生成的 js-dos worker 里模拟四块流式盘：源码特征存在不代表预读结果能被客体复用。
 * 本测试不联网、不启动 DOSBox，只验证 Sockdrive 请求、回调与降级行为。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const paths = readFileSync(join(root, 'src/emulator/paths.ts'), 'utf8')
const assetVersion = paths.match(/export const JSDOS_ASSET_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1]
assert.ok(assetVersion, '找不到 js-dos 资源版本')
const code = readFileSync(join(root, 'public/jsdos', `v${assetVersion}`, 'emulators/emulators.js'), 'utf8')
const base = 'https://sockdrive.test/disk'
const metadata = {
  size: 1024,
  ahead_read: 262144,
  range_count: 4,
  sector_size: 512,
  dropped_ranges: [],
  small_ranges: [],
  preload_ranges: [],
}

async function until(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`${label} 未在 500ms 内发生`)
}

async function scenario({ mode = 'default', connection = { effectiveType: '3g' }, failPrefetch = false } = {}) {
  const requests = []
  const delivered = []
  let failed = false
  const fetch = async (url, options) => {
    const name = String(url).slice(base.length + 1)
    requests.push({ name, priority: options?.priority })
    if (name === 'sockdrive.metaj') return Response.json(metadata)
    if (name === 'preload_ranges.metaj') return Response.json([])
    const range = Number(name.match(/^(\d+)\.raw$/)?.[1])
    assert.ok(Number.isInteger(range), `意外的请求 ${name}`)
    if (failPrefetch && range === 2 && options?.priority === 'low' && !failed) {
      failed = true
      return new Response('', { status: 503 })
    }
    return new Response(new Uint8Array(metadata.ahead_read).fill(range))
  }
  const self = {}
  vm.runInNewContext(code, {
    self, console, TextDecoder, TextEncoder, Uint8Array, ArrayBuffer, Blob, URL,
    AbortController, setTimeout, clearTimeout, fetch, navigator: { connection },
  })
  const disk = await self.sockdrive(base, null, mode, (range, bytes) => {
    delivered.push({ range, first: bytes[0], length: bytes.length })
  }, false)
  const read = async (range) => {
    await disk.readRangeAsync(range)
    await until(() => delivered.some((entry) => entry.range === range), `分块 ${range} 回调`)
  }
  return { requests, delivered, read }
}

const normal = await scenario()
await normal.read(0)
await normal.read(1)
await until(() => normal.requests.some((request) => request.name === '2.raw' && request.priority === 'low'), '顺序预读')
await normal.read(2)
assert.equal(normal.requests.filter((request) => request.name === '2.raw').length, 1, '真实读取复用预读，不能再次 GET')
assert.deepEqual(normal.delivered.map(({ range, first, length }) => [range, first, length]), [
  [0, 0, 262144], [1, 1, 262144], [2, 2, 262144],
])

const noProfile = await scenario({ mode: 'none' })
await noProfile.read(0)
await noProfile.read(1)
assert.equal(noProfile.requests.some((request) => request.name === '2.raw'), false, '未完整预热时不抢流量')

const saveData = await scenario({ connection: { effectiveType: '3g', saveData: true } })
await saveData.read(0)
await saveData.read(1)
assert.equal(saveData.requests.some((request) => request.name === '2.raw'), false, '省流量时不投机下载')

const slow = await scenario({ connection: { effectiveType: '2g' } })
await slow.read(0)
await slow.read(1)
assert.equal(slow.requests.some((request) => request.name === '2.raw'), false, '2G 时不投机下载')

const random = await scenario()
await random.read(0)
await random.read(2)
assert.equal(random.requests.some((request) => request.name === '3.raw'), false, '非连续读盘不猜下一个块')

const fallback = await scenario({ failPrefetch: true })
await fallback.read(0)
await fallback.read(1)
await until(() => fallback.requests.some((request) => request.name === '2.raw' && request.priority === 'low'), '失败的投机读取')
await fallback.read(2)
assert.equal(fallback.requests.filter((request) => request.name === '2.raw').length, 2, '预读失败后真实读取仍能重试')

console.log('✔ Sockdrive 顺序预读：复用、限流与失败回退通过')
