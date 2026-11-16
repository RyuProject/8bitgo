#!/usr/bin/env node
/**
 * 构建后核对坏 chunk 自修复要用的两样东西（postbuild:client）：
 *   1. dist/client/index.html 入口对应的 assets/integrity-<入口哈希>.json 存在，
 *      里面每个文件都在磁盘上、SHA-256 对得上，且入口和它静态引用的 chunk 都在清单里；
 *   2. 修复脚本 assets/asset-repair-v4.js 已经复制进 dist，和 public/ 那份逐字节一致。
 * 清单错了的后果是「好文件被判成坏的」：修复脚本会反复重取、刷新，还会请求清边缘缓存，所以宁可构建失败。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { integrityManifestName } from './lib/vite-asset-integrity.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist', 'client')
const REPAIR_SCRIPT = 'asset-repair-v4.js'

function fail(message) {
  console.error(`✗ 资源校验清单：${message}`)
  process.exit(1)
}

const html = readFileSync(path.join(dist, 'index.html'), 'utf8')
const entry = /<script[^>]*type="module"[^>]*src="\/assets\/(index-[A-Za-z0-9_-]+\.js)"/.exec(html)?.[1]
if (!entry) fail('index.html 里找不到现代版入口脚本')
const manifestName = integrityManifestName(entry)
if (!manifestName) fail(`认不出入口文件名 ${entry}`)
const manifestPath = path.join(dist, 'assets', manifestName)
if (!existsSync(manifestPath)) fail(`缺 assets/${manifestName}（vite.config.ts 的 assetIntegrityPlugin 没跑？）`)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (manifest.v !== 1 || manifest.alg !== 'sha256' || manifest.entry !== entry) fail(`${manifestName} 的版本 / 算法 / 入口不对`)

const names = Object.keys(manifest.files)
for (const name of names) {
  const file = path.join(dist, 'assets', name)
  if (!existsSync(file)) fail(`清单里的 ${name} 不在 dist/client/assets`)
  const digest = createHash('sha256').update(readFileSync(file)).digest('base64')
  if (digest !== manifest.files[name]) fail(`${name} 的 SHA-256 和清单不一致`)
}
if (!manifest.files[entry]) fail(`入口 ${entry} 不在清单里`)
const entrySource = readFileSync(path.join(dist, 'assets', entry), 'utf8')
for (const m of entrySource.matchAll(/from"\.\/([^"]+\.js)"/g)) {
  if (!manifest.files[m[1]]) fail(`入口静态引用的 ${m[1]} 不在清单里`)
}

const repairDist = path.join(dist, 'assets', REPAIR_SCRIPT)
const repairPublic = path.join(root, 'public', 'assets', REPAIR_SCRIPT)
if (!existsSync(repairDist)) fail(`dist/assets 里缺 ${REPAIR_SCRIPT}`)
if (!readFileSync(repairDist).equals(readFileSync(repairPublic))) {
  fail(`dist/assets/${REPAIR_SCRIPT} 和 public/assets/ 不一致`)
}
if (!html.includes(REPAIR_SCRIPT)) fail(`index.html 的内联钩子没有指向 ${REPAIR_SCRIPT}`)

console.log(`✓ 资源校验清单：${manifestName} 覆盖 ${names.length} 个文件，SHA-256 全部一致；${REPAIR_SCRIPT} 已发布`)
