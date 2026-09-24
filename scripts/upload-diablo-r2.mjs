#!/usr/bin/env node

/** 把 Diablo 的三个 wasm 预压成 Brotli q11；上传压缩首选和原始兼容回退。 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { diabloCoreAsset } from '../server/src/diablo.js'
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
const prefix = (arg('prefix') || 'web/diablo/runtime').replace(/^\/+|\/+$/g, '')
const sourceDir = arg('src') || join(root, 'diabloweb/build/static/media')
const stageDir = arg('stage') || join(root, '.diablo-runtime-r2')
const dryRun = process.argv.includes('--dry-run')
const skipPublicCheck = process.argv.includes('--skip-public-check')

if (!dryRun && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bucket || '')) {
  console.error('用法：npm run diablo:upload -- --bucket <R2桶名> [--dry-run] [--src <目录>]')
  process.exit(2)
}
if (!existsSync(sourceDir)) throw new Error(`缺少 ${sourceDir}：请先 npm run diablo:build`)

const publicManifestFile = join(root, 'public/web/diablo/runtime-manifest.json')
if (!existsSync(publicManifestFile)) throw new Error(`缺少 ${publicManifestFile}：请重新 npm run diablo:build`)
const publicManifest = JSON.parse(readFileSync(publicManifestFile, 'utf8'))
const manifestFile = join(stageDir, 'manifest.json')
const previous = readCompressionManifest(manifestFile)
const manifest = { version: 1, generatedAt: new Date().toISOString(), assets: {} }
mkdirSync(stageDir, { recursive: true })

for (const asset of publicManifest.assets || []) {
  const source = join(sourceDir, asset.file)
  if (!existsSync(source)) throw new Error(`构建目录缺少 ${asset.file}`)
  if (!diabloCoreAsset(asset.file)) throw new Error(`不接受的 Diablo 核心名：${asset.file}`)
  const target = join(stageDir, `${asset.file}.br`)
  const prepared = await prepareBrotli({ source, target, cached: previous.assets?.[asset.file] })
  if (prepared.sourceSha256 !== asset.sha256 || prepared.sourceSize !== asset.size) {
    throw new Error(`${asset.file} 与 public/runtime-manifest.json 不一致，请重新构建`)
  }
  manifest.assets[asset.file] = prepared
  console.log(`${prepared.reused ? '复用' : '压缩'} ${asset.file}: ${mib(prepared.sourceSize)} → ${mib(prepared.compressedSize)} (${(prepared.ratio * 100).toFixed(1)}%)`)
}
writeCompressionManifest(manifestFile, manifest)

if (dryRun) {
  console.log(`✔ 已准备到 ${stageDir}；--dry-run 未上传`)
  process.exit(0)
}

const wrangler = join(root, 'node_modules/.bin/wrangler')
for (const [file] of Object.entries(manifest.assets)) {
  // 不支持 Brotli 的旧浏览器和 HTTP Range 必须拿原始对象；正常 HTTPS 浏览器仍优先取下面的 .br。
  execFileSync(wrangler, [
    'r2', 'object', 'put', `${bucket}/${prefix}/${file}`,
    '--file', join(sourceDir, file),
    '--content-type', 'application/wasm',
    '--cache-control', 'public, max-age=31536000, immutable',
    '--remote', '--force',
  ], { cwd: root, stdio: 'inherit' })
  execFileSync(wrangler, [
    'r2', 'object', 'put', `${bucket}/${prefix}/${file}.br`,
    '--file', join(stageDir, `${file}.br`),
    '--content-type', 'application/octet-stream',
    '--cache-control', 'public, max-age=31536000, immutable',
    '--remote', '--force',
  ], { cwd: root, stdio: 'inherit' })
}
execFileSync(wrangler, [
  'r2', 'object', 'put', `${bucket}/${prefix}/manifest.json`,
  '--file', manifestFile,
  '--content-type', 'application/json',
  '--cache-control', 'no-cache',
  '--remote', '--force',
], { cwd: root, stdio: 'inherit' })

if (!skipPublicCheck) {
  const base = (arg('public-base') || 'https://assets.8bitgo.com').replace(/\/+$/, '')
  for (const file of Object.keys(manifest.assets)) {
    for (const suffix of ['', '.br']) {
      const url = `${base}/${prefix}/${file}${suffix}`
      const response = await fetch(url, { method: 'HEAD' })
      console.log(`${response.ok ? '✔' : '✖'} ${url} → ${response.status} ${response.headers.get('content-length') || '?'} bytes`)
      if (!response.ok) process.exitCode = 1
    }
  }
}
console.log('✔ Diablo Brotli 首选与原始兼容核心均已上传；请部署服务端代理后再验收游戏启动。')
