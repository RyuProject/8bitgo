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

assert.match(index, /本站不提供或上传游戏内容/)
assert.match(index, /type="file"[^>]+webkitdirectory/)
assert.match(index, /ButterscotchRunner\/Butterscotch/)
assert.match(index, /非 Toby Fox、GameMaker 或其关联方的官方产品/)
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
assert.doesNotMatch(app, /https?:\/\/(?:steamrip|dos\.zone|github\.com\/ThePenguin-developer)/i,
  '本地运行端不得含第三方游戏数据或未授权仓库地址')
assert.doesNotMatch(app, /fetch\([^)]*(?:data\.win|game\.unx)/i,
  '游戏文件只能从玩家本机导入，不能通过网络下载')

assert.doesNotMatch(serviceWorker, /data\.win|game\.unx|\.ogg/i, 'Service Worker 不得缓存商业游戏数据')
assert.match(serviceWorker, /runtime\/butterscotch\.wasm/)

console.log(`UNDERTALE ${dist ? 'dist' : 'source'} 本地运行端完整：${relativeFiles.length} 个文件，未包含游戏数据`)
