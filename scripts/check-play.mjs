#!/usr/bin/env node
/**
 * 构建前校验 Play! 官方 Web 运行时。
 *
 * PS2 的开关一旦写进 `.env.production`，缺 Play.js / Play.wasm 时 TypeScript 和 Vite
 * 仍会照常成功，只有玩家打开 ISO 才看到 404。更隐蔽的是只更新其中一个文件：
 * Emscripten glue 与 wasm 导出不匹配，通常只剩一句 `Aborted()`，和 ROM 坏了很像。
 * 所以这里按下载时记录的长度与 SHA-256 锁住整套文件，并核对这版适配器依赖的特征。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = join(root, 'public', 'play')
const checkDist = process.argv.includes('--dist')
const dir = checkDist ? join(root, 'dist', 'client', 'play') : sourceDir
const manifestPath = join(sourceDir, 'runtime.json')

const fail = (message) => {
  console.error(`✖ ${message}`)
  process.exit(1)
}

if (!existsSync(manifestPath)) fail('public/play/runtime.json 不存在，无法确认 Play.js 与 Play.wasm 是否配套')
if (!existsSync(dir)) fail(`${checkDist ? 'dist/client/play' : 'public/play'} 不存在`)
if (checkDist) {
  const copiedManifest = join(dir, 'runtime.json')
  if (!existsSync(copiedManifest) || !readFileSync(copiedManifest).equals(readFileSync(manifestPath))) {
    fail('dist/client/play/runtime.json 缺失或落后于 public/，请重新构建客户端')
  }
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
for (const [name, expected] of Object.entries(manifest.files ?? {})) {
  const path = join(dir, name)
  if (!existsSync(path)) fail(`public/play/${name} 不存在`)
  const data = readFileSync(path)
  if (data.byteLength !== expected.bytes) {
    fail(`public/play/${name} 大小不对：记录 ${expected.bytes} 字节，实际 ${data.byteLength} 字节`)
  }
  const actual = createHash('sha256').update(data).digest('hex')
  if (actual !== expected.sha256) {
    fail(`public/play/${name} 的 SHA-256 不匹配；Play.js 与 Play.wasm 不能分开升级`)
  }
}

const js = readFileSync(join(dir, 'Play.js'), 'utf8')
const wasm = readFileSync(join(dir, 'Play.wasm'))
if (!js.includes('export default Play')) fail('Play.js 不是当前适配器需要的 ES module 构建')
if (!js.includes('mainScriptUrlOrBlob') || !js.includes('new Worker')) {
  fail('Play.js 缺 pthread Worker 特征；跨源隔离和加载方式可能已经变化')
}
if (!js.includes('discImageDevice')) fail('Play.js 缺 DiscImageDevice 接口，ISO 分段读取无法工作')
if (!wasm.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))) fail('Play.wasm 文件头无效')
for (const marker of ['#outputCanvas', 'bootDiscImage', 'getFrames', 'KeyZ']) {
  if (!wasm.includes(Buffer.from(marker))) fail(`Play.wasm 缺关键特征 ${marker}，上游接口可能已经变化`)
}

const targetLabel = checkDist ? 'dist/client/play/ 产物' : 'Play! Web 运行时'
console.log(`✔ ${targetLabel}完整（JS / WASM / 许可证哈希一致，ISO 流式接口与 pthread 特征在位）`)
