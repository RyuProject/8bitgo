#!/usr/bin/env node

/**
 * CS16 是「小加载器 + 35MB 引擎 + R2 分片数据包」的混合部署，最容易出现页面 200、核心 404。
 * runtime.json 只锁进 git 的页面 / WASM / 字体；被忽略并上传 R2 的游戏包由 test-cs16-pack 单独验。
 */
import { createHash } from 'node:crypto'
import {
  closeSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = join(root, 'public/web/cs16')
const distMode = process.argv.includes('--dist')
const writeMode = process.argv.includes('--write-manifest')
const runtimeDir = distMode ? join(root, 'dist/client/web/cs16') : publicDir
const manifestPath = join(publicDir, 'runtime.json')
const targetManifest = join(runtimeDir, 'runtime.json')

const fail = (message) => {
  console.error(`✖ CS16 检查失败：${message}`)
  process.exit(1)
}
/** 数据包有 400MB+，校验时也必须流式读取，不能为了算哈希把整包塞进 Node 堆。 */
const sha256 = (file) => new Promise((resolve, reject) => {
  const hash = createHash('sha256')
  const stream = createReadStream(file)
  stream.on('data', (chunk) => hash.update(chunk))
  stream.on('error', reject)
  stream.on('end', () => resolve(hash.digest('hex')))
})

function readPrefix(file, length) {
  const fd = openSync(file, 'r')
  try {
    const out = Buffer.alloc(length)
    const read = readSync(fd, out, 0, length, 0)
    return out.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

function wasmMemoryLimits(file) {
  const data = readFileSync(file)
  const state = { at: 8 }
  const leb = () => {
    let value = 0
    let shift = 0
    for (;;) {
      const byte = data[state.at++]
      if (byte == null || shift > 35) throw new Error('WASM LEB128 损坏')
      value |= (byte & 0x7f) << shift
      if (!(byte & 0x80)) return value >>> 0
      shift += 7
    }
  }
  while (state.at < data.length) {
    const id = data[state.at++]
    const size = leb()
    const end = state.at + size
    if (id === 5) {
      if (leb() !== 1) throw new Error('WASM memory 数量不是 1')
      const flags = leb()
      const initial = leb()
      return { initial, maximum: flags & 1 ? leb() : null }
    }
    state.at = end
  }
  throw new Error('WASM 没有 memory section')
}

const included = (name) =>
  !name.endsWith('.map') &&
  !name.endsWith('.d.ts') &&
  name !== 'runtime.json' &&
  !name.startsWith('packs/')

function filesUnder(dir) {
  const files = []
  const walk = (folder) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name)
      if (lstatSync(path).isDirectory()) walk(path)
      else {
        const rel = relative(dir, path).replace(/\\/g, '/')
        if (included(rel)) files.push(rel)
      }
    }
  }
  walk(dir)
  return files.sort()
}

const source = readFileSync(join(publicDir, 'cs16.js'), 'utf8')
const index = readFileSync(join(publicDir, 'index.html'), 'utf8')
const assetVersion = source.match(/const ASSET_VERSION = ['"]([^'"]+)['"]/)?.[1]
if (!assetVersion) fail('cs16.js 没有 ASSET_VERSION')
if (!index.includes(`cs16.bundle.js?v=${assetVersion}`)) fail('index.html 没引用当前版本的 cs16.bundle.js')
if (!index.includes('<base href="/web/cs16/"')) fail('index.html 缺少固定 /web/cs16/ base，无尾斜杠路由会把 bundle 解析到 /web/')
const baseHref = index.match(/<base\s+href="([^"]+)"/)?.[1] || ''
const productionBase = new URL(baseHref, 'https://8bitgo.com/web/cs16')
if (new URL('./cs16.bundle.js', productionBase).pathname !== '/web/cs16/cs16.bundle.js') {
  fail('无尾斜杠生产 URL 仍会把 cs16.bundle.js 解析到错误目录')
}
if (index.includes('src="./cs16.js')) fail('index.html 仍在直接加载无法被浏览器解析的源码')
if (!source.includes("const PAGE_ROOT = new URL('./', document.baseURI)")) fail('cs16.js 没从 document.baseURI 计算资源根')
if (source.includes("new URL('./', location.href)")) fail('cs16.js 仍会在无尾斜杠页面把资源根算成 /web/')
if (!index.includes('<select id="bots">') || !index.includes('<option value="7" selected>')) {
  fail('开始界面缺少默认 7 人的 BOT 数量选择')
}
if (!source.includes("'cstrike/dlls/cs_emscripten_wasm32.wasm'") || !source.includes("'cstrike/dlls/yapb_emscripten_wasm32.wasm'") || !source.includes('\'gamedll_linux "dlls/yapb.so"\'')) {
  fail('liblist.gam 没有通过 YaPB 代理接入 cstrike/dlls 下真正的 CS 服务端库')
}
if (!source.includes('ENV: { XASH3D_GAMELIBPATH: `${BASE}cstrike/${GAME_SERVER_LIB}` }')) {
  fail('没有把真正的 CS GameDLL 绝对路径传给 YaPB')
}
const generatedXash = readFileSync(join(publicDir, 'engine/dist/generated/xash.js'), 'utf8')
if (!generatedXash.includes('var ENV = Module["ENV"] ?? {};')) {
  fail('Xash Emscripten 封装没有接收启动器环境变量，YaPB 会在开图时终止')
}
if (!source.includes('yb_quota_mode "normal"') || !source.includes('yb_autovacate "0"') || !source.includes('`yb_quota "${count}"`')) {
  fail('BOT 数量没有通过地图级配置精确覆盖 YaPB 默认值')
}
if (source.includes('alias addbot "bot_add"') || source.includes('alias delbot "bot_kill"')) {
  fail('autoexec.cfg 仍在使用非 YaPB 的无效 BOT 命令')
}

const required = [
  'index.html',
  'cs16.js',
  'cs16.bundle.js',
  'tar-stream.js',
  'zstd.wasm',
  'engine/dist/xash.wasm',
  'engine/dist/filesystem_stdio.wasm',
  'engine/dist/libmenu.wasm',
  'engine/dist/libref_webgl2.wasm',
  'engine/dist/libref_soft.wasm',
  'lib/cstrike/cl_dlls/menu_emscripten_wasm32.wasm',
  'lib/cstrike/cl_dlls/client_emscripten_wasm32.wasm',
  'lib/cstrike/dlls/cs_emscripten_wasm32.wasm',
  'lib/cstrike/dlls/yapb_emscripten_wasm32.wasm',
  'lib/valve/cl_dlls/client_emscripten_wasm32.wasm',
  'lib/valve/dlls/hl_emscripten_wasm32.wasm',
  'lib/cstrike/extras.pk3',
  'gfx/fonts/FiraSans-Regular.ttf',
]
for (const name of required) if (!existsSync(join(publicDir, name))) fail(`缺少 public/web/cs16/${name}`)

/**
 * 只读 ZIP/PK3 中央目录，不解压成员。
 *
 * 构建机不保证安装系统 unzip；为了列十几个文件名要求整台机器多一个包，既脆弱又没有
 * 必要。extras.pk3 只有普通单卷 ZIP，中央目录已经包含完整成员名，直接解析即可。
 */
function zipEntryNames(file) {
  const data = readFileSync(file)
  let eocd = -1
  for (let at = data.length - 22; at >= Math.max(0, data.length - 22 - 65535); at--) {
    if (data.readUInt32LE(at) === 0x06054b50) {
      eocd = at
      break
    }
  }
  if (eocd < 0) throw new Error('找不到 ZIP 中央目录结束记录')

  const disk = data.readUInt16LE(eocd + 4)
  const centralDisk = data.readUInt16LE(eocd + 6)
  const diskEntries = data.readUInt16LE(eocd + 8)
  const entries = data.readUInt16LE(eocd + 10)
  const centralSize = data.readUInt32LE(eocd + 12)
  let at = data.readUInt32LE(eocd + 16)
  const centralEnd = at + centralSize
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entries || entries === 0xffff) {
    throw new Error('不支持分卷 ZIP 或 ZIP64')
  }
  if (centralEnd > eocd || centralEnd > data.length) throw new Error('ZIP 中央目录越界')

  const names = []
  for (let i = 0; i < entries; i++) {
    if (at + 46 > centralEnd || data.readUInt32LE(at) !== 0x02014b50) {
      throw new Error(`ZIP 第 ${i + 1} 个目录项损坏`)
    }
    const flags = data.readUInt16LE(at + 8)
    const nameLength = data.readUInt16LE(at + 28)
    const extraLength = data.readUInt16LE(at + 30)
    const commentLength = data.readUInt16LE(at + 32)
    const next = at + 46 + nameLength + extraLength + commentLength
    if (next > centralEnd) throw new Error(`ZIP 第 ${i + 1} 个目录项越界`)
    const encoding = flags & 0x800 ? 'utf8' : 'latin1'
    names.push(data.toString(encoding, at + 46, at + 46 + nameLength).replace(/\\/g, '/'))
    at = next
  }
  if (at !== centralEnd) throw new Error('ZIP 中央目录长度不一致')
  return names
}

// 没有导航图时 YaPB 会拒绝创建 Bot；每张启动页地图都必须在同一份 extras.pk3 里有图。
let extrasEntries
try {
  extrasEntries = new Set(zipEntryNames(join(publicDir, 'lib/cstrike/extras.pk3')))
} catch (error) {
  fail(`无法读取 extras.pk3：${error instanceof Error ? error.message : String(error)}`)
}
for (const map of ['de_dust2', 'de_dust', 'de_inferno', 'de_nuke', 'de_aztec', 'de_train', 'de_cbble', 'cs_office', 'cs_italy', 'cs_assault', 'cs_militia', 'de_vertigo']) {
  if (!extrasEntries.has(`addons/yapb/data/graph/${map}.graph`)) fail(`extras.pk3 缺少 ${map} 的 YaPB 导航图`)
}

/* 源码和 bundle 必须逐字节对应；只改 cs16.js 忘记重打包，是这类独立页最常见的线上漂移。 */
const temp = mkdtempSync(join(tmpdir(), '8bitgo-cs16-check-'))
try {
  const generated = join(temp, 'cs16.bundle.js')
  execFileSync(join(root, 'node_modules/.bin/esbuild'), [
    join(publicDir, 'cs16.js'),
    '--bundle',
    '--format=esm',
    '--platform=browser',
    '--target=es2022',
    `--outfile=${generated}`,
  ], { stdio: 'pipe' })
  if (!readFileSync(generated).equals(readFileSync(join(publicDir, 'cs16.bundle.js')))) {
    fail('cs16.bundle.js 落后于 cs16.js；运行 npm run cs16:bundle')
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}

if (writeMode) {
  const files = []
  for (const name of filesUnder(publicDir)) {
    const file = join(publicDir, name)
    files.push({ name, size: statSync(file).size, sha256: await sha256(file) })
  }
  writeFileSync(manifestPath, `${JSON.stringify({ assetVersion, files }, null, 2)}\n`)
  console.log(`✔ 已写入 CS16 清单（${files.length} 个文件）`)
  process.exit(0)
}

if (!existsSync(manifestPath)) fail('runtime.json 不存在；运行 npm run cs16:manifest')
if (!existsSync(targetManifest)) fail(`${distMode ? 'dist/client' : 'public'}/web/cs16/runtime.json 不存在`)
if (distMode && lstatSync(runtimeDir).isSymbolicLink()) fail('dist/client/web/cs16 仍是旧版整目录软链')
if (distMode && !readFileSync(manifestPath).equals(readFileSync(targetManifest))) fail('dist 的 runtime.json 落后于 public')

let manifest
try {
  manifest = JSON.parse(readFileSync(targetManifest, 'utf8'))
} catch {
  fail('runtime.json 不是合法 JSON')
}
if (manifest.assetVersion !== assetVersion || !Array.isArray(manifest.files)) fail('runtime.json 版本或文件表无效')
const listed = new Set(manifest.files.map((file) => file.name))
for (const name of required) if (!listed.has(name)) fail(`runtime.json 没有 ${name}`)
for (const file of manifest.files) {
  if (!/^[\w./-]+$/.test(file.name) || file.name.includes('..')) fail(`清单含非法文件名：${file.name}`)
  const target = join(runtimeDir, file.name)
  if (!existsSync(target)) fail(`部署目录缺 ${file.name}`)
  if (statSync(target).size !== file.size) fail(`${file.name} 长度不符`)
  if (await sha256(target) !== file.sha256) fail(`${file.name} SHA-256 不符`)
}

for (const name of manifest.files.filter((file) => file.name.endsWith('.wasm')).map((file) => file.name)) {
  const magic = readPrefix(join(runtimeDir, name), 4)
  if (!magic.equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))) fail(`${name} 不是有效 WASM`)
}
const memory = wasmMemoryLimits(join(runtimeDir, 'engine/dist/xash.wasm'))
if (memory.initial !== 4096 || memory.maximum !== 8192) {
  fail(`xash.wasm 内存应为 initial=4096 / maximum=8192 页，实际 ${memory.initial}/${memory.maximum}；运行 npm run cs16:engine-patch`)
}
const xashGlue = readFileSync(join(runtimeDir, 'engine/dist/generated/xash.js'), 'utf8')
if (!xashGlue.includes('requestedSize > 536870912') || !xashGlue.includes('return growMemory(target)')) {
  fail('generated/xash.js 仍会在扩容请求上直接 OOM；运行 npm run cs16:engine-patch')
}
if (!source.includes('https://assets.8bitgo.com/web/cs16/zstd-v1/')) fail('生产 Zstd 包没有指向 R2 自定义域名')
if (!source.includes("crypto.subtle.digest('SHA-256'")) fail('Zstd 分片缺 SHA-256 完整性校验')
if (!source.includes('chunkPromises.delete(chunk.compressedSha256)')) fail('Zstd 解压缓存不会释放，整包会常驻 JS 堆')
if (!source.includes("FS.writeFile(BASE + 'cstrike/extras.pk3', extras)")) {
  fail('extras.pk3 没放进 cstrike 搜索路径，YaPB 配置和导航图不会被挂载')
}

console.log(`✔ CS16 ${assetVersion} ${distMode ? '部署产物' : '公开目录'}完整（${manifest.files.length} 个文件）`)
