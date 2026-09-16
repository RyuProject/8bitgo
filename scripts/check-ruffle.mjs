#!/usr/bin/env node
/**
 * 检查 Ruffle 的 npm 版本、前端默认路径和真正要部署的文件是否属于同一批产物。
 * 固定文件名的运行时一旦被浏览器或 CDN 混缓存，表现通常只是黑屏，构建时拦住最容易排查。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const distMode = process.argv.includes('--dist')
const pkgFile = join(root, 'node_modules', '@ruffle-rs', 'ruffle', 'package.json')
const pathsFile = join(root, 'src', 'emulator', 'paths.ts')

const fail = (message) => {
  console.error(`✖ Ruffle 检查失败：${message}`)
  process.exit(1)
}
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

if (!existsSync(pkgFile)) fail('npm 包不存在，请先 npm install')
const { version } = JSON.parse(readFileSync(pkgFile, 'utf8'))
const pathsSource = readFileSync(pathsFile, 'utf8')
const declared = pathsSource.match(/export const RUFFLE_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1]
if (declared !== version) {
  fail(`src/emulator/paths.ts 声明 ${declared || '空'}，npm 安装的是 ${version}`)
}

const base = distMode ? join(root, 'dist', 'client') : join(root, 'public')
const runtimeDir = join(base, 'ruffle', `v${version}`)
const manifestFile = join(runtimeDir, 'runtime.json')
if (!existsSync(manifestFile)) fail(`${manifestFile} 不存在；先运行 npm run ruffle`)

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
} catch {
  fail('runtime.json 不是合法 JSON')
}
if (manifest.version !== version || !Array.isArray(manifest.files) || !manifest.files.length) {
  fail('runtime.json 的版本或文件列表不正确')
}

for (const file of manifest.files) {
  if (!/^[\w.-]+$/.test(file.name)) fail(`runtime.json 含非法文件名：${String(file.name)}`)
  const target = join(runtimeDir, file.name)
  if (!existsSync(target)) fail(`缺文件 ${file.name}`)
  if (statSync(target).size !== file.size) fail(`${file.name} 长度不符`)
  if (sha256(target) !== file.sha256) fail(`${file.name} 摘要不符`)
}

if (!manifest.files.some((file) => file.name === 'ruffle.js')) fail('清单里没有 ruffle.js')
if (!manifest.files.some((file) => file.name.endsWith('.wasm'))) fail('清单里没有 wasm 核心')
console.log(`✔ Ruffle ${version} ${distMode ? '部署产物' : '公开目录'}完整且版本一致`)
