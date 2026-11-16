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
const upstreamCommit = '5c6cccc56c1df5c3717c0b39953d5fe833f97b73'

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
const actualFiles = currentFiles()
// dist/client 是线上服务目录，Vite 故意不清空它，以免旧页面延迟加载的哈希资源在部署时 404。
// 因此 --dist 会包含早期版本留下的文件；只核对当前清单中的资源，public 源目录仍要求完全一致。
const filesToCompare = dist
  ? Object.fromEntries(Object.entries(actualFiles).filter(([name]) => Object.hasOwn(manifest.files, name)))
  : actualFiles
assert.deepEqual(filesToCompare, manifest.files, 'GTA VC 运行时文件与哈希清单不一致')

const index = readFileSync(resolve(root, 'index.html'), 'utf8')
const serviceWorker = readFileSync(resolve(root, 'sw.js'), 'utf8')
const hostedImporter = readFileSync(resolve(root, 'gta-vc-7z-import.js'), 'utf8')
const sevenZipWorker = readFileSync(resolve(root, '7z-extractor.worker.js'), 'utf8')
const fileNames = Object.keys(manifest.files)
const scriptFile = fileNames.find((path) => /^assets\/index-[A-Za-z0-9_-]+\.js$/.test(path))
const workerFile = fileNames.find((path) => /^assets\/worker-[A-Za-z0-9_-]+\.js$/.test(path))
assert.ok(scriptFile, 'GTA VC 缺少带哈希的应用入口')
assert.ok(workerFile, 'GTA VC 缺少 PC 安装目录转换 Worker')
const worker = readFileSync(resolve(root, workerFile), 'utf8')

assert.match(index, /<meta name="robots" content="noindex,nofollow" \/>/, '运行端页面不得被搜索引擎收录')
assert.ok(index.includes(`/web/gta-vc/${scriptFile}`), '应用入口没有带 /web/gta-vc/ 基址')
assert.match(index, /\/web\/gta-vc\/manifest\.json/)
assert.doesNotMatch(index, /\/gta-vice-city-wasm\//, '仍引用上游 GitHub Pages 路径')
assert.match(index, /start-container/, 'Pages 运行桥依赖 .start-container')
assert.ok(existsSync(resolve(root, 'engine/vc-sky-en-v6.wasm')), 'GTA VC 缺少引擎 wasm')
assert.ok(existsSync(resolve(root, 'revc/revc.ini')), 'GTA VC 缺少 reVC 默认配置')

// 上游转换器：ZIP 按中央目录懒读、大文件流式写 OPFS，不能退回整包读内存。
assert.match(worker, /DecompressionStream\(["'`]deflate-raw["'`]\)/, '转换器必须流式解压 ZIP 成员')
assert.match(worker, /createSyncAccessHandle/, '转换结果必须直接写入 OPFS')
assert.match(worker, /vc-sky-en-v6\.data/)
assert.match(worker, /__8bgExpandedImg/, '转换器必须识别 gta3.img 与 cuts.img 的展开目录')
assert.match(worker, /expanded:(?:Boolean\(i\)|i)/, 'IMG 目录成员必须直接从独立文件读取')
assert.match(worker, /expandedContainerFiles=a/, '展开的 IMG / SFX 容器必须跳过容器文件哈希校验')
assert.match(worker, /__8bgExpandedRawAudio/, '转换器必须复用展开目录中的 SFX MP3')
assert.match(worker, /n\[0\]===73&&n\[1\]===68&&n\[2\]===51/, 'WAV 扩展名下的 ID3 / MP3 资源必须直接复制')
assert.match(worker, /cleanupRoot/, '导入失败或完成后必须清除临时 7z 解包目录')
assert.match(index, /gta-vc-7z-import\.js/, '页面缺少 .7z / R2 导入入口')
assert.match(index, /class="loading-screen"/, '启动页必须以统一加载遮罩展示进度')
assert.match(index, /id="spinner"[^>]*role="progressbar"/, '唯一加载条缺少进度语义')
assert.match(index, /\.start-container\s*\{\s*display:\s*none\s*!important/, '启动页必须隐藏多余设置与说明')
assert.match(index, /game-7z-input[\s\S]*?accept="\.7z,application\/x-7z-compressed"/, '本地 7z 选择器缺失')
assert.match(hostedImporter, /\/game-data\/revcdoseng\.7z/, 'R2 导入必须走本站固定同源地址')
assert.match(hostedImporter, /8bg-gta-vc-setup/, '已有资源与初次导入都必须由启动器接管')
assert.match(hostedImporter, /tryAutoStart/, '资源完成后必须自动启动游戏')
assert.match(hostedImporter, /8bg-gta-vc-import-folder/, '解包结果没有接入上游目录转换器')
assert.match(sevenZipWorker, /createSyncAccessHandle/, '7z 输入与解包必须流式写入 OPFS')
assert.match(sevenZipWorker, /MAX_EXTRACTED_BYTES/, '7z 解包必须限制总大小')
assert.ok(existsSync(resolve(root, 'vendor/un7z-opfs/License.txt')), '7z WASM 缺少许可证')
assert.ok(existsSync(resolve(root, 'vendor/un7z-opfs/src-glue/opfs_fs.js')), '7z WASM 缺少对应构建源码')
assert.ok(existsSync(resolve(root, 'vendor/un7z-opfs/dist/7zz.wasm')), 'GTA VC 缺少浏览器 7z 解码器')

assert.match(serviceWorker, /path\.startsWith\('\/vcsky\/'\)/)
assert.match(serviceWorker, /path\.startsWith\('\/vcbr\/'\)/)
assert.match(serviceWorker, /Accept-Ranges/)
assert.ok(existsSync(resolve(root, 'LICENSE.upstream.txt')), 'GTA VC 缺少上游 MIT 许可证')
assert.ok(existsSync(resolve(root, 'UPSTREAM.md')), 'GTA VC 缺少来源与版权说明')

for (const path of walk(root)) {
  const name = relative(root, path).replaceAll('\\', '/')
  assert.ok(statSync(path).size <= 25 * 1024 * 1024, `${name} 超过 Pages 单文件 25 MiB 上限`)
  assert.doesNotMatch(name, /(?:^|\/)(?:game\.tar\.gz|gta3\.img|[^/]+\.(?:7z|rar))$/i, '仓库和 Pages 不得包含游戏数据')
}

console.log(`GTA VC ${dist ? 'dist' : 'source'} 运行时完整：${Object.keys(manifest.files).length} 个文件`)
