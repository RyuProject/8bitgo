#!/usr/bin/env node

/**
 * 把 Celeste 的 `_framework/`（130MiB，不进 git）传到 R2。
 *
 * 与 `upload-terraria-r2.mjs` 同一套取舍：单个 wasm 虽然被上游切成 5 片 20MiB，
 * 但整套 130MiB 也不能进 git（同 qemu-wasm、cs15 packs 的规矩）。线上由
 * `server/src/celeste.js` 代理回源；本机想离线跑就把这份放进 `public/web/celeste/_framework/`。
 *
 * 与 terraria 的差异：.NET 10 产物没有 `blazor.boot.json`，唯一不带内容哈希的入口
 * 是 `dotnet.js`（启动清单并进了 native 胶水），所以「最后上传」的只有它一个。
 *
 * 用法：
 *   npm run celeste:upload -- --bucket <R2桶名>                 # 从 .celeste-framework 上传
 *   npm run celeste:upload -- --bucket <桶名> --src <解压目录>    # 指定已解压的上游产物
 *   npm run celeste:upload -- --bucket <桶名> --dry-run          # 只压缩并打印体积，不上传
 *
 * 需要 wrangler 已经登录（`npx wrangler login`）或已配 CLOUDFLARE_API_TOKEN。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { celesteFrameworkAsset } from '../server/src/celeste.js'
import {
  mib,
  prepareBrotli,
  readCompressionManifest,
  writeCompressionManifest,
} from './lib/precompress-r2.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : ''
}
const bucket = arg('bucket')
const prefix = (arg('prefix') || 'web/celeste/_framework').replace(/^\/+|\/+$/g, '')
const staging = arg('src') || join(root, '.celeste-framework')
const compressedDir = arg('br-stage') || join(root, '.celeste-framework-br')
const dryRun = process.argv.includes('--dry-run')
const skipPublicCheck = process.argv.includes('--skip-public-check')

if (!dryRun && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bucket || '')) {
  console.error('用法：npm run celeste:upload -- --bucket <R2桶名> [--src .celeste-framework] [--dry-run] [--br-stage <目录>]')
  process.exit(2)
}

/** 上游把整个构建目录打包，运行时在 `_framework/` 下，是平铺的一层。 */
const frameworkDir = join(staging, '_framework')
if (!existsSync(frameworkDir)) {
  throw new Error(`缺少 ${frameworkDir}：请先解压 webleste-loader.tar.zst（--src 指定解压目录）`)
}

const files = readdirSync(frameworkDir).filter((name) => {
  const info = statSync(join(frameworkDir, name))
  return info.isFile() && info.size > 0
})
for (const required of ['dotnet.js']) {
  if (!files.includes(required)) throw new Error(`_framework/ 里缺少 ${required}`)
}
// wasm 分片（dotnet.native.<hash>.wasm0..4）是运行时的本体，一份都不能少
const wasmChunks = files.filter((name) => /\.wasm\d$/.test(name))
if (wasmChunks.length === 0) throw new Error('_framework/ 里没有任何 dotnet.native.<hash>.wasm<N> 分片，像是解压错了目录')

/*
  入口必须**最后**上传：它是唯一不带内容哈希的文件，浏览器先读它、再按里面的名字
  去取哈希文件；先传入口就意味着有一段时间清单指向还不存在的对象。
*/
const ENTRY_FILES = ['dotnet.js']
const ordered = [...files.filter((f) => !ENTRY_FILES.includes(f)), ...ENTRY_FILES.filter((f) => files.includes(f))]

const total = ordered.reduce((sum, name) => sum + statSync(join(frameworkDir, name)).size, 0)
console.log(`· ${ordered.length} 个文件，共 ${(total / 1048576).toFixed(1)} MiB → ${bucket}/${prefix}/`)

/*
  预压缩对象独立保存成 `<原名>.br`，R2 元数据不设 Content-Encoding。
  服务端才能拿到未经 Node 自动解压的字节，再把 `Content-Encoding: br` 正确交给浏览器。
*/
const TEXT_EXTS = new Set(['js', 'mjs', 'json'])
const COMPRESS_EXTS = new Set(['wasm', 'dll', 'dat', 'js', 'mjs', 'json'])
const compressionManifestFile = join(compressedDir, 'compression-manifest.json')
const previousCompression = readCompressionManifest(compressionManifestFile)
const compression = { version: 1, generatedAt: new Date().toISOString(), assets: {} }
let compressedTotal = 0
for (const name of ordered) {
  // 与 server/src/celeste.js 的 extensionOf 同一归一化：.wasm0..4 分片按 .wasm 压缩
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase().replace(/^wasm\d$/, 'wasm')
  if (!COMPRESS_EXTS.has(ext)) continue
  const prepared = await prepareBrotli({
    source: join(frameworkDir, name),
    target: join(compressedDir, `${name}.br`),
    cached: previousCompression.assets?.[name],
    text: TEXT_EXTS.has(ext),
  })
  compression.assets[name] = prepared
  compressedTotal += prepared.compressedSize
  console.log(`${prepared.reused ? '复用' : '压缩'} ${name}: ${mib(prepared.sourceSize)} → ${mib(prepared.compressedSize)} (${(prepared.ratio * 100).toFixed(1)}%)`)
}
writeCompressionManifest(compressionManifestFile, compression)

const compressedSourceTotal = Object.values(compression.assets).reduce((sum, asset) => sum + asset.sourceSize, 0)
console.log(`· Brotli q11 合计：${mib(compressedSourceTotal)} → ${mib(compressedTotal)}，节省 ${mib(compressedSourceTotal - compressedTotal)}`)
if (dryRun) {
  console.log(`✔ 已准备到 ${compressedDir}；--dry-run 未上传`)
  process.exit(0)
}

const wrangler = join(root, 'node_modules/.bin/wrangler')
for (const name of ordered) {
  const asset = celesteFrameworkAsset(name)
  if (!asset) throw new Error(`文件名不合法：${name}`)
  console.log(`上传原始回退 ${prefix}/${name}…`)
  execFileSync(wrangler, [
    'r2', 'object', 'put', `${bucket}/${prefix}/${name}`,
    '--file', join(frameworkDir, name),
    '--content-type', asset.contentType,
    '--cache-control', asset.cacheControl,
    '--remote', '--force',
  ], { cwd: root, stdio: 'inherit' })

  if (compression.assets[name]) {
    console.log(`上传 Brotli ${prefix}/${name}.br…`)
    execFileSync(wrangler, [
      'r2', 'object', 'put', `${bucket}/${prefix}/${name}.br`,
      '--file', join(compressedDir, `${name}.br`),
      // 这里故意不写 Content-Encoding；由同源代理在发给浏览器时补，避免 Node fetch 自动解压。
      '--content-type', 'application/octet-stream',
      '--cache-control', asset.cacheControl,
      '--remote', '--force',
    ], { cwd: root, stdio: 'inherit' })
  }
}

execFileSync(wrangler, [
  'r2', 'object', 'put', `${bucket}/${prefix}/compression-manifest.json`,
  '--file', compressionManifestFile,
  '--content-type', 'application/json',
  '--cache-control', 'no-cache',
  '--remote', '--force',
], { cwd: root, stdio: 'inherit' })

if (!skipPublicCheck) {
  const base = (arg('public-base') || 'https://assets.8bitgo.com').replace(/\/+$/, '')
  for (const name of ['dotnet.js']) {
    for (const suffix of ['', '.br']) {
      const url = `${base}/${prefix}/${name}${suffix}`
      const res = await fetch(url, { method: 'HEAD' })
      console.log(`${res.ok ? '✔' : '✖'} ${url} → ${res.status} ${res.headers.get('content-type') || ''}`)
      if (!res.ok) process.exitCode = 1
    }
  }
}
console.log('✔ 原始回退与 Brotli 均已上传。线上由同源代理优先流式发送 `.br`；改了构建请连页面一起重新部署。')
