import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = process.argv.includes('--dist')
const root = resolve(repo, dist ? 'dist/client/web/undertale' : 'public/web/undertale')
const expectedCommit = '54e10ec4e4a5713130675c7719dda7c437b4f849'

assert.ok(existsSync(root), `UNDERTALE 本地运行端不存在：${root}`)

function walk(directory) {
  const files = []
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, item.name)
    if (item.isDirectory()) files.push(...walk(path))
    else if (item.isFile()) files.push(path)
  }
  return files
}

function digest(path) {
  const bytes = readFileSync(path)
  return {
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

const manifest = JSON.parse(readFileSync(resolve(root, 'runtime-manifest.json'), 'utf8'))
assert.equal(manifest.format, '8bitgo.undertale-runtime.v1')
assert.equal(manifest.commit, expectedCommit)
assert.equal(manifest.license, 'MPL-2.0')
assert.equal(manifest.gameDataIncluded, false)

for (const [name, expected] of Object.entries(manifest.files)) {
  assert.deepEqual(digest(resolve(root, name)), expected, `${name} 与核验过的上游构建不一致`)
}

const files = walk(root)
const relativeFiles = files.map((path) => relative(root, path).replaceAll('\\', '/'))
for (const name of relativeFiles) {
  assert.ok(statSync(resolve(root, name)).size <= 25 * 1024 * 1024, `${name} 超过 Pages 单文件上限`)
  assert.doesNotMatch(name, /(?:^|\/)(?:data\.win|game\.(?:unx|ios|droid)|[^/]+\.(?:ogg|rar|zip|7z))$/i,
    `不得把商业游戏数据或归档发布到 Pages：${name}`)
}

const index = readFileSync(resolve(root, 'index.html'), 'utf8')
const app = readFileSync(resolve(root, 'app.js'), 'utf8')
const serviceWorker = readFileSync(resolve(root, 'sw.js'), 'utf8')
const distribution = JSON.parse(readFileSync(resolve(root, 'distribution-manifest.json'), 'utf8'))

assert.match(index, /<progress id="progress"[^>]+aria-label="游戏加载进度"/)
assert.equal((index.match(/<progress\b/g) || []).length, 1, '首页只能有一个进度条')
assert.match(index, /Butterscotch 实验性开源运行端/)
assert.match(index, /非 Toby Fox、GameMaker 或其关联方的官方产品/)
assert.doesNotMatch(index, /下载授权版并启动|准备授权版游戏资源/, '启动页不得展示下载按钮或说明文案')
assert.ok(existsSync(resolve(root, 'LICENSE.butterscotch.txt')), '缺少 Butterscotch MPL-2.0 许可证')
assert.ok(existsSync(resolve(root, 'UPSTREAM.md')), '缺少来源、版权边界与更新说明')

assert.match(app, /navigator\.storage\.getDirectory/)
assert.match(app, /file\.stream\(\)\.getReader\(\)/, '大文件必须流式写入 OPFS')
assert.match(app, /createWritable\(\{ keepExistingData: false \}\)/)
assert.match(app, /magic !== 'FORM'/, '必须先验证 GameMaker 文件头')
assert.match(app, /WebAssembly\.Suspending/)
assert.match(app, /_mountOpfs\(\)/)
assert.match(app, /_startRunner/)
assert.match(app, /--save-folder/)
assert.match(app, /navigator\.getGamepads/)
const keydownHandlerStart = app.indexOf("window.addEventListener('keydown'")
const keydownHandlerEnd = app.indexOf("window.addEventListener('keyup'", keydownHandlerStart)
const keydownHandler = app.slice(keydownHandlerStart, keydownHandlerEnd)
assert.match(keydownHandler, /event\.key === 'Escape' \|\| event\.keyCode === 27 \? 90 : event\.keyCode/,
  'Esc 应映射为确认键，避免 Butterscotch 将长按误判为退出')
assert.match(keydownHandler, /runtime\._onKeyDown\(keyCode\)/,
  '映射后的确认键必须传给游戏运行端')
assert.equal(distribution.format, '8bitgo.undertale.distribution.v1')
assert.equal(distribution.resourceBase, 'https://html5.8bitgo.com/undertale/')
assert.deepEqual(distribution.allowedPageOrigins, ['https://8bitgo.com', 'https://*.8bitgo.com'])
assert.match(distribution.sourceArchiveSha256, /^[0-9a-f]{64}$/)
assert.ok(distribution.excludedFiles?.some((item) => item.path === 'splash.png'), '未说明分发包中不需要的桌面启动图')
for (const name of ['D3DX9_43.dll', 'steam_api.dll', 'UNDERTALE.exe']) {
  assert.ok(distribution.excludedFiles.some((item) => item.path === name), `未记录跳过的桌面文件：${name}`)
}
assert.ok(distribution.files.length > 0)
assert.equal(distribution.files.reduce((sum, item) => sum + item.bytes, 0), distribution.totalBytes)
assert.ok(distribution.files.some((item) => item.path === 'data.win'))
for (const item of distribution.files) {
  assert.ok(!item.path.startsWith('/') && !item.path.split('/').includes('..'), `授权清单存在不安全路径：${item.path}`)
  assert.ok(Number.isSafeInteger(item.bytes) && item.bytes >= 0, `授权清单文件大小无效：${item.path}`)
  assert.match(item.crc32, /^[0-9a-f]{8}$/, `授权清单缺少 ZIP CRC-32：${item.path}`)
}
assert.match(app, /DISTRIBUTION_RESOURCE_BASE = 'https:\/\/html5\.8bitgo\.com\/undertale\//)
assert.match(app, /DISTRIBUTION_ALLOWED_PAGE_ORIGINS = \['https:\/\/8bitgo\.com', 'https:\/\/\*\.8bitgo\.com'\]/)
assert.match(app, /host === '8bitgo\.com' \|\| host\.endsWith\('\.8bitgo\.com'\)/, '只允许主站与 HTTPS 子域启动远端授权包')
assert.match(app, /mode: 'cors'/)
assert.match(app, /credentials: 'omit'/, '远端游戏资源请求不得携带站点 Cookie')
assert.match(app, /DISTRIBUTION_CHUNK_BYTES = 8 \* 1024 \* 1024/, '大文件必须分段下载，便于断点续传')
assert.match(app, /await startAuthorizedGame\(\)/, '主站打开后应自动下载授权资源并启动')
assert.match(app, /function updateProgress\(done, total\)/, '启动页只按资源总字节更新单条进度')
assert.match(app, /function installFogUniformPrecisionCompat\(\)/, 'WebGL 雾颜色 uniform 必须显式统一精度')
assert.ok(app.includes('uniform highp vec4 uFogColor'), '必须把两个着色器阶段的 uFogColor 精度统一为 highp')
const runtimeLoader = app.indexOf('async function loadRuntime()')
const compatInstall = app.indexOf('installFogUniformPrecisionCompat()', runtimeLoader)
const runtimeImport = app.indexOf("await import('/web/undertale/runtime/butterscotch.mjs')", runtimeLoader)
assert.ok(runtimeLoader >= 0 && compatInstall > runtimeLoader && runtimeImport > compatInstall,
  'WebGL 精度兼容层必须在运行端创建前安装')
assert.match(app, /installFogUniformPrecisionCompat\(\)\s*initialize\(\)\.catch\(/,
  'WebGL 精度兼容层必须在页面初始化与运行端预热之前安装')
assert.doesNotMatch(app, /https?:\/\/(?:steamrip|dos\.zone|github\.com\/ThePenguin-developer)/i,
  '本地运行端不得含第三方游戏数据或未授权仓库地址')
assert.doesNotMatch(app, /https?:\/\/(?!html5\.8bitgo\.com\/undertale\/)[^'"\s]*undertale/i,
  '授权游戏数据只能从指定分发主机读取')

assert.match(serviceWorker, /distribution-manifest\.json/, 'Service Worker 应缓存小型资源清单，离线时仍可启动本机副本')
assert.ok(serviceWorker.includes("if (url.pathname === `${BASE}distribution-manifest.json`)") &&
  serviceWorker.indexOf('fetch(request)') < serviceWorker.indexOf('caches.match(request)'),
  '授权包版本清单联网时必须先取最新版，断网时才使用缓存')
assert.doesNotMatch(serviceWorker, /html5\.8bitgo\.com|data\.win|game\.unx|\.ogg/i, 'Service Worker 不得代理或缓存商业游戏数据')
assert.match(serviceWorker, /runtime\/butterscotch\.wasm/)

console.log(`UNDERTALE ${dist ? 'dist' : 'source'} 本地运行端完整：${relativeFiles.length} 个文件，未包含游戏数据`)
