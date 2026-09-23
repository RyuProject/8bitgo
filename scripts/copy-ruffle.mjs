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
const bootstrapFile = join(out, 'bootstrap.json')
const sourceNames = readdirSync(src)
  .filter((name) => !name.endsWith('.map') && name !== 'package.json' && name !== 'README.md')
  .sort()

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const sourceFiles = sourceNames.map((name) => ({
  name,
  size: statSync(join(src, name)).size,
  sha256: sha256(join(src, name)),
}))

/**
 * Ruffle 会按浏览器的 WASM 扩展能力选择两套 core JS / WASM 之一。
 * 把这张对应关系在同步时从官方 loader 里取出来，前端悬停预热才能只下载正确的约 14 MB，
 * 而不是为了省启动时间反倒把两份核心都下了。升级后 loader 形状若变就明确失败，不能猜。
 */
function extractBootstrap(source) {
  const wasmByModule = new Map(
    [...source.matchAll(/(\d+)\(e,n,a\)\{e\.exports=a\.p\+"([^"]+\.wasm)"\}/g)]
      .map((match) => [match[1], match[2]]),
  )
  const chunkTable = source.match(/a\.u=e=>"core\.ruffle\."\+\{([^}]+)\}\[e\]\+"\.js"/)?.[1]
  const chunkById = new Map(
    [...(chunkTable || '').matchAll(/(\d+):"([a-f0-9]+)"/g)]
      .map((match) => [match[1], `core.ruffle.${match[2]}.js`]),
  )
  const chunks = source.match(
    /await\(n\?a\.e\((\d+)\)\.then\(\(\)=>a\(\1\)\):a\.e\((\d+)\)\.then\(\(\)=>a\(\2\)\)\)/,
  )
  const wasm = source.match(/const s=n\?new URL\(a\((\d+)\),a\.b\):new URL\(a\((\d+)\),a\.b\)/)
  const modern = chunks && wasm ? [chunkById.get(chunks[1]), wasmByModule.get(wasm[1])] : []
  const fallback = chunks && wasm ? [chunkById.get(chunks[2]), wasmByModule.get(wasm[2])] : []
  const all = [...modern, ...fallback]
  if (all.some((name) => !name || !sourceNames.includes(name)) || new Set(all).size !== 4) {
    console.error('✖ 无法从 ruffle.js 解析增强版 / 兼容版启动文件；Ruffle loader 结构可能已更新')
    process.exit(1)
  }
  return { modern, fallback }
}

const bootstrap = extractBootstrap(readFileSync(join(src, 'ruffle.js'), 'utf8'))

function outputIsCurrent() {
  if (!existsSync(manifestFile) || !existsSync(bootstrapFile)) return false
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    const bootstrapManifest = JSON.parse(readFileSync(bootstrapFile, 'utf8'))
    if (manifest.version !== version || !Array.isArray(manifest.files)) return false
    if (JSON.stringify(manifest.files) !== JSON.stringify(sourceFiles)) return false
    if (bootstrapManifest.version !== version) return false
    if (JSON.stringify(bootstrapManifest.bootstrap) !== JSON.stringify(bootstrap)) return false
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
/*
 * runtime.json 已经在同一个版本目录下长期缓存过，不能给它原地加字段：旧访客会一直拿不到预热入口。
 * bootstrap.json 是首次发布的新 URL，仍可跟版本目录一起 immutable，并且不会污染运行时完整性清单。
 */
writeFileSync(bootstrapFile, `${JSON.stringify({ version, bootstrap }, null, 2)}\n`, 'utf8')

console.log(`✔ Ruffle ${version} 已同步 ${sourceFiles.length} 个文件到 public/ruffle/v${version}/`)
