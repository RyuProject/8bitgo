#!/usr/bin/env node
/**
 * 把 npm 包 @ruffle-rs/ruffle 复制到带版本号的 public/ruffle/v<version>/。
 *
 * 这里不能只判断 ruffle.js 是否存在：npm 依赖升级后，旧脚本会继续复用上一次的 wasm，
 * 形成「新 JS + 旧 wasm」或反过来的混合部署。runtime.json 记录每个文件的摘要，
 * `--if-missing` 只有在版本、文件列表和字节都完全一致时才会跳过。
 *
 *   npm run ruffle                              强制同步当前 npm 版本
 *   node scripts/copy-ruffle.mjs --if-missing  完整一致时跳过
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'node_modules', '@ruffle-rs', 'ruffle')
const ifMissing = process.argv.includes('--if-missing')
const packageFile = join(src, 'package.json')

if (!existsSync(join(src, 'ruffle.js')) || !existsSync(packageFile)) {
  const msg = '未找到 node_modules/@ruffle-rs/ruffle，请先 npm install'
  if (ifMissing) {
    console.warn(`⚠ ${msg}；Flash 游戏暂不可用`)
    process.exit(0)
  }
  console.error(`✖ ${msg}`)
  process.exit(1)
}

const { version } = JSON.parse(readFileSync(packageFile, 'utf8'))
if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) {
  console.error(`✖ Ruffle 包版本格式异常：${String(version)}`)
  process.exit(1)
}

const publicRoot = join(root, 'public', 'ruffle')
const out = join(publicRoot, `v${version}`)
const manifestFile = join(out, 'runtime.json')
const sourceNames = readdirSync(src)
  .filter((name) => !name.endsWith('.map') && name !== 'package.json' && name !== 'README.md')
  .sort()

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const sourceFiles = sourceNames.map((name) => ({
  name,
  size: statSync(join(src, name)).size,
  sha256: sha256(join(src, name)),
}))

function outputIsCurrent() {
  if (!existsSync(manifestFile)) return false
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    if (manifest.version !== version || !Array.isArray(manifest.files)) return false
    if (JSON.stringify(manifest.files) !== JSON.stringify(sourceFiles)) return false
    return sourceFiles.every((file) => {
      const output = join(out, file.name)
      return existsSync(output) && statSync(output).size === file.size && sha256(output) === file.sha256
    })
  } catch {
    return false
  }
}

if (ifMissing && outputIsCurrent()) process.exit(0)

mkdirSync(publicRoot, { recursive: true })
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
for (const file of sourceFiles) copyFileSync(join(src, file.name), join(out, file.name))
writeFileSync(manifestFile, `${JSON.stringify({ version, files: sourceFiles }, null, 2)}\n`, 'utf8')

console.log(`✔ Ruffle ${version} 已同步 ${sourceFiles.length} 个文件到 public/ruffle/v${version}/`)
