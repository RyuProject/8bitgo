#!/usr/bin/env node

/**
 * 把 Terraria 的 `_framework/`（134.9MiB，不进 git）传到 R2。
 *
 * 它太大，也不该进 git：单个 `dotnet.native.<hash>.wasm` 就是 100,104,513 字节，
 * 贴着 GitHub 的单文件上限；而每次 clone / pull 搬 135MB 也没有道理（同 qemu-wasm、cs15 的取舍）。
 * 线上由 `server/src/terraria.js` 代理回源，本机想离线跑就把这份放进 `public/web/terraria/_framework/`。
 *
 * 类型与缓存策略**直接复用代理模块里的 `frameworkAsset()`**：
 * 抄一份到脚本里迟早会和线上分叉（类型不对 → `.wasm` 被拒收；缓存档位不对 → 换了构建边缘还在发旧的），
 * 所以这里宁可 import 服务端代码。
 *
 * 用法：
 *   npm run terraria:upload -- --bucket <R2桶名>                 # 从 .terraria-framework 上传
 *   npm run terraria:upload -- --bucket <桶名> --zip <构建zip>     # 顺带解压
 *   npm run terraria:upload -- --bucket <桶名> --dry-run           # 只列清单
 *
 * 需要 wrangler 已经登录（`npx wrangler login`）或已配 CLOUDFLARE_API_TOKEN。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { frameworkAsset } from '../server/src/terraria.js'
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
const prefix = (arg('prefix') || 'web/terraria/_framework').replace(/^\/+|\/+$/g, '')
const staging = arg('src') || join(root, '.terraria-framework')
const compressedDir = arg('br-stage') || join(root, '.terraria-framework-br')
const zip = arg('zip')
const dryRun = process.argv.includes('--dry-run')
const skipPublicCheck = process.argv.includes('--skip-public-check')

if (!dryRun && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bucket || '')) {
  console.error('用法：npm run terraria:upload -- --bucket <R2桶名> [--src .terraria-framework] [--zip <构建zip>] [--dry-run] [--br-stage <目录>]')
  process.exit(2)
}

/** 上游把整个构建目录打包，运行时在 `_framework/` 下，是平铺的一层。 */
const frameworkDir = join(staging, '_framework')
if (zip && !existsSync(frameworkDir)) {
  if (!existsSync(zip)) throw new Error(`找不到 ${zip}`)
  console.log(`· 解压 ${zip} → ${staging}`)
  mkdirSync(staging, { recursive: true })
  execFileSync('unzip', ['-q', '-o', zip, '-d', staging], { stdio: 'inherit' })
}
if (!existsSync(frameworkDir)) {
  throw new Error(`缺少 ${frameworkDir}：请先解压上游构建包（--zip），或把 _framework/ 放进去`)
}
rmSync(join(staging, '__MACOSX'), { recursive: true, force: true })

const files = readdirSync(frameworkDir).filter((name) => {
  const info = statSync(join(frameworkDir, name))
  return info.isFile() && info.size > 0
})
for (const required of ['dotnet.js', 'blazor.boot.json']) {
  if (!files.includes(required)) throw new Error(`_framework/ 里缺少 ${required}`)
}

/*
  两个入口必须**最后**上传。它们是唯一不带内容哈希的文件，浏览器先读它们、
  再按里面的名字去取哈希文件；先传入口就意味着有一段时间清单指向还不存在的对象
  （cs15 的 index.json 同理，见 upload-cs15-r2.mjs 头注释）。
*/
const ENTRY_FILES = ['dotnet.js', 'blazor.boot.json']
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
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
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
  const asset = frameworkAsset(name)
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
  for (const name of ['dotnet.js', 'blazor.boot.json']) {
    for (const suffix of ['', '.br']) {
      const url = `${base}/${prefix}/${name}${suffix}`
      const res = await fetch(url, { method: 'HEAD' })
      console.log(`${res.ok ? '✔' : '✖'} ${url} → ${res.status} ${res.headers.get('content-type') || ''}`)
      if (!res.ok) process.exitCode = 1
    }
  }
}
console.log('✔ 原始回退与 Brotli 核心均已上传。线上由同源代理优先流式发送 `.br`；改了构建请连页面一起重新部署。')
