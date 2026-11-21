#!/usr/bin/env node

/*
  Gamblers Table 的 Godot WASM/PCK 均超过 Cloudflare Pages 25 MiB 单文件上限。
  Pages Worker 只允许同源读取这两个固定路径；这里把原文件传入公共网页游戏桶。
*/
import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : ''
}
const bucket = arg('bucket') || process.env.WEBGAME_R2_BUCKET || ''
const prefix = (arg('prefix') || 'web/gamblers-table/runtime').replace(/^\/+|\/+$/g, '')
const source = arg('src') || join(root, 'public/web/gamblers-table')
const publicBase = (arg('public-base') || 'https://assets.8bitgo.com').replace(/\/+$/, '')
const dryRun = process.argv.includes('--dry-run')
const skipPublicCheck = process.argv.includes('--skip-public-check')

if (!dryRun && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bucket)) {
  console.error('用法：npm run gamblers-table:upload -- --bucket <R2桶名> [--src <目录>]')
  process.exit(2)
}

const assets = [
  { file: 'index.wasm', contentType: 'application/wasm' },
  { file: 'index.pck', contentType: 'application/octet-stream' },
]
for (const asset of assets) {
  const path = join(source, asset.file)
  if (!existsSync(path) || statSync(path).size === 0) throw new Error(`缺少 Gamblers Table 运行时文件：${path}`)
}

for (const asset of assets) {
  const path = join(source, asset.file)
  console.log(`${asset.file}: ${(statSync(path).size / 1048576).toFixed(1)} MiB → ${bucket || '(dry-run)'}/${prefix}/`)
}
if (dryRun) process.exit(0)

const wrangler = join(root, 'node_modules/.bin/wrangler')
for (const asset of assets) {
  execFileSync(wrangler, [
    'r2', 'object', 'put', `${bucket}/${prefix}/${asset.file}`,
    '--file', join(source, asset.file),
    '--content-type', asset.contentType,
    // 文件名不是内容哈希；更新时浏览器和边缘必须向源站重验证。
    '--cache-control', 'public, max-age=300, s-maxage=600, must-revalidate',
    '--remote', '--force',
  ], { cwd: root, stdio: 'inherit' })
}

if (!skipPublicCheck) {
  for (const asset of assets) {
    const response = await fetch(`${publicBase}/${prefix}/${asset.file}`, { method: 'HEAD' })
    const expected = statSync(join(source, asset.file)).size
    const actual = Number(response.headers.get('content-length') || 0)
    console.log(`${response.ok && actual === expected ? '✔' : '✖'} ${asset.file} → ${response.status} ${actual || '?'} bytes`)
    if (!response.ok || actual !== expected) process.exitCode = 1
  }
}
