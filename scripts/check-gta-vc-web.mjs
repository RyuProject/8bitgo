import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = process.argv.includes('--dist')
const writeManifest = process.argv.includes('--write-manifest')
const root = resolve(repo, dist ? 'dist/client/web/gta-vc' : 'public/web/gta-vc')
const manifestPath = resolve(root, 'runtime-manifest.json')
const upstreamCommit = '10dd677cc55574da98e9be2433a3c5c668b39954'

assert.ok(existsSync(root), `GTA VC 运行时不存在：${root}`)

function walk(directory) {
  const result = []
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, item.name)
    if (item.isDirectory()) result.push(...walk(path))
    else if (item.isFile()) result.push(path)
  }
  return result
}

function digest(path) {
  const bytes = readFileSync(path)
  return {
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

function currentFiles() {
  return Object.fromEntries(walk(root)
    .filter((path) => path !== manifestPath && !path.endsWith('.DS_Store'))
    .map((path) => [relative(root, path).replaceAll('\\', '/'), digest(path)])
    .sort(([left], [right]) => left.localeCompare(right)))
}

if (writeManifest) {
  assert.equal(dist, false, '--write-manifest 只能更新 public 源运行时')
  writeFileSync(manifestPath, `${JSON.stringify({
    format: '8bitgo.gta-vc-runtime.v1',
    source: 'https://github.com/joncodeofficial/gta-vice-city-wasm',
    commit: upstreamCommit,
    base: '/web/gta-vc/',
    gameDataIncluded: false,
    files: currentFiles(),
  }, null, 2)}\n`)
}

assert.ok(existsSync(manifestPath), 'GTA VC 缺少 runtime-manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
assert.equal(manifest.format, '8bitgo.gta-vc-runtime.v1')
assert.equal(manifest.commit, upstreamCommit)
assert.equal(manifest.base, '/web/gta-vc/')
assert.equal(manifest.gameDataIncluded, false)
assert.deepEqual(currentFiles(), manifest.files, 'GTA VC 运行时文件与哈希清单不一致')

const index = readFileSync(resolve(root, 'index.html'), 'utf8')
const runtimeConfig = readFileSync(resolve(root, 'runtime-config.js'), 'utf8')
const extractor = readFileSync(resolve(root, 'extract-worker.js'), 'utf8')
const serviceWorker = readFileSync(resolve(root, 'sw.js'), 'utf8')
const scriptFile = Object.keys(manifest.files).find((path) => /^assets\/index-[A-Za-z0-9_-]+\.js$/.test(path))
assert.ok(scriptFile, 'GTA VC 缺少带哈希的应用入口')
const appScript = readFileSync(resolve(root, scriptFile), 'utf8')

assert.match(index, /\/web\/gta-vc\/runtime-config\.js/)
assert.match(index, /<meta name="robots" content="noindex,nofollow" \/>/, '未核验游戏数据来源前不得允许搜索引擎收录')
assert.ok(index.indexOf('/web/gta-vc/runtime-config.js') < index.indexOf(scriptFile), '运行配置必须早于应用入口加载')
assert.match(index, /\/web\/gta-vc\/manifest\.json/)
assert.match(index, /\/web\/gta-vc\/intro\.mp4/)
assert.doesNotMatch(index, /\/gta-vice-city-wasm\//)
assert.match(runtimeConfig, /__GTA_VC_ASSET_URL__\s*=\s*["']{2}/, '未核验归档地址时必须保持空配置')
assert.doesNotMatch(runtimeConfig, /https?:\/\//, '运行配置不能提交未经核验的游戏归档地址')
assert.match(appScript, /__GTA_VC_ASSET_URL__/)
assert.match(appScript, /archive URL must be HTTPS/)

assert.match(extractor, /file\.stream\(\)/, 'game.tar.gz 必须流式读取')
assert.match(extractor, /DecompressionStream\(["']gzip["']\)/, 'game.tar.gz 必须流式解压')
assert.match(extractor, /createSyncAccessHandle|createWritable/, '解压结果必须直接写入 OPFS')
assert.match(extractor, /MAX_EXPANDED_BYTES/)
assert.match(extractor, /assertHeaderChecksum/)
assert.match(extractor, /ALLOWED_ROOTS/)
assert.match(extractor, /cleanupFailedImport/)
assert.doesNotMatch(extractor, /await\s+file\.arrayBuffer\(/, '禁止把完整压缩包读进 JS 内存')
assert.doesNotMatch(extractor, /tarBuffer/, '禁止在内存中拼出完整 TAR')

assert.match(serviceWorker, /path\.startsWith\('\/vcsky\/'\)/)
assert.match(serviceWorker, /path\.startsWith\('\/vcbr\/'\)/)
assert.match(serviceWorker, /Accept-Ranges/)
assert.ok(existsSync(resolve(root, 'LICENSE.upstream.txt')), 'GTA VC 缺少上游 MIT 许可证')
assert.ok(existsSync(resolve(root, 'UPSTREAM.md')), 'GTA VC 缺少来源与版权说明')

for (const path of walk(root)) {
  const name = relative(root, path).replaceAll('\\', '/')
  assert.ok(statSync(path).size <= 25 * 1024 * 1024, `${name} 超过 Pages 单文件 25 MiB 上限`)
  assert.doesNotMatch(name, /(?:^|\/)game\.tar\.gz$/i, '仓库和 Pages 不得包含游戏数据归档')
}

console.log(`GTA VC ${dist ? 'dist' : 'source'} 运行时完整：${Object.keys(manifest.files).length} 个文件`)
