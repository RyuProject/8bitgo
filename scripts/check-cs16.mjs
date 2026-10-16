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
import { inflateRawSync } from 'node:zlib'

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
const netSource = readFileSync(join(publicDir, 'cs16-net.js'), 'utf8')
const index = readFileSync(join(publicDir, 'index.html'), 'utf8')
const relaySource = readFileSync(join(root, 'server/src/cs16-relay.js'), 'utf8')
const roomSource = readFileSync(join(root, 'server/src/cs16-rooms.js'), 'utf8')
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
if (!index.includes('<select id="difficulty">') || !index.includes('id="show-servers"') ||
    !index.includes('./ui/original-menu-background.png') || !index.includes('./ui/original-counter-strike-logo.png')) {
  fail('开始界面缺少原版风格资源、BOT 难度或联机状态入口')
}
if (!index.includes('id="server-list"') || !index.includes('id="server-refresh"') || !index.includes('id="server-join"')) {
  fail('Find Servers 缺少真实目录、刷新或加入控件')
}
if (!index.includes('id="create-room"') || !index.includes('id="room-code-input"') ||
    !index.includes('id="direct-address"') || !index.includes('id="direct-connect"')) {
  fail('CS1.6 启动页缺少临时房间码或经验证的 IP 直连入口')
}
if (!source.includes("fetch('/api/cs16/servers'") || !source.includes('xash.net = activeRelay.net') ||
    !source.includes("['+connect', `webxash3d.${server.netId}:${server.port}`]")) {
  fail('启动器没有把安全目录、Xash 虚拟网络层和 connect 命令接成完整联机路径')
}
if (!source.includes("fetch('/api/cs16/servers/resolve'") || !source.includes("fetch('/api/cs16/rooms'") ||
    !source.includes('createCs16RoomNet(room, room.role') || !source.includes("Q.has('room')")) {
  fail('IP 直连、创建房间、房间虚拟网络或邀请链接没有接成完整路径')
}
if (!netSource.includes("new URL('/api/cs16/relay'") || !netSource.includes("ccall?.('getErrnoLocation'") ||
    !netSource.includes('net.sendto_batch = net.sendtoBatch.bind(net)') || !netSource.includes('new Uint8Array(packet.data).slice()')) {
  fail('CS1.6 WSS 适配器缺少固定同源端点、errno/sendto_batch 兼容或 WASM 数据复制')
}
if (!netSource.includes("new URL('/api/cs16/room'") || !netSource.includes('ROOM_GUEST_IP_PREFIX') ||
    !netSource.includes('createCs16RoomNet') || !netSource.includes('roomConnectTimeoutMs')) {
  fail('CS1.6 房间适配器缺少固定同源端点、独立访客虚拟地址或建房网络层')
}
if (!relaySource.includes('serverById.get(serverId)') || !relaySource.includes('isPublicIpv4(server.host)') ||
    !relaySource.includes('udp.connect(server.port, server.host)') || relaySource.includes("url.searchParams.get('host')")) {
  fail('CS1.6 后端没有把 UDP 目标严格锁在服务端注册并验证的目标表')
}
if (!relaySource.includes("router.post('/servers/resolve'") || !relaySource.includes('parseDirectAddress') ||
    !relaySource.includes('compatiblePublicServer(info)') || !relaySource.includes('withinRate(serverRate') ||
    !relaySource.includes('CS1.6 server changed or failed revalidation')) {
  fail('CS1.6 手输 IP 没有经过公网地址、A2S 协议与兼容地图复检')
}
if (!roomSource.includes("const ROOM_PATH = '/api/cs16/room'") || !roomSource.includes('timingSafeEqual') ||
    !roomSource.includes('message.readUInt16BE(0)') || !roomSource.includes("removeRoom(room, 1012, 'Host left the room')") ||
    !roomSource.includes('hostWaitMsRemaining')) {
  fail('CS1.6 临时房间缺少固定路径、房主凭证、peer 路由或房主退出回收')
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
if (!source.includes('`yb_difficulty "${difficulty}"`') || !source.includes('`yb_difficulty ${difficulty}`')) {
  fail('启动页 BOT 难度没有同时写入地图配置与运行时兜底命令')
}
if (source.includes('alias addbot "bot_add"') || source.includes('alias delbot "bot_kill"')) {
  fail('autoexec.cfg 仍在使用非 YaPB 的无效 BOT 命令')
}

const supportedMaps = [
  'de_dust2', 'de_dust', 'de_inferno', 'de_nuke', 'de_aztec', 'de_train',
  'de_cbble', 'cs_office', 'cs_italy', 'cs_assault', 'cs_militia', 'de_vertigo',
]

const required = [
  'index.html',
  'cs16.js',
  'cs16.bundle.js',
  'cs16-net.js',
  'pack-guards.js',
  'tar-stream.js',
  'zstd.wasm',
  'ui/original-menu-background.png',
  'ui/original-counter-strike-logo.png',
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
  ...supportedMaps.map((map) => `vis/${map}.vis`),
]
for (const name of required) if (!existsSync(join(publicDir, name))) fail(`缺少 public/web/cs16/${name}`)

/**
 * 只读 ZIP/PK3 中央目录，不解压成员。
 *
 * 构建机不保证安装系统 unzip；为了列十几个文件名要求整台机器多一个包，既脆弱又没有
 * 必要。extras.pk3 只有普通单卷 ZIP，中央目录已经包含完整成员名，直接解析即可。
 */
const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n += 1) {
  let value = n
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  crcTable[n] = value >>> 0
}
function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function zipEntries(file) {
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

  const result = []
  for (let i = 0; i < entries; i++) {
    if (at + 46 > centralEnd || data.readUInt32LE(at) !== 0x02014b50) {
      throw new Error(`ZIP 第 ${i + 1} 个目录项损坏`)
    }
    const flags = data.readUInt16LE(at + 8)
    const method = data.readUInt16LE(at + 10)
    const crc = data.readUInt32LE(at + 16)
    const compressedBytes = data.readUInt32LE(at + 20)
    const rawBytes = data.readUInt32LE(at + 24)
    const nameLength = data.readUInt16LE(at + 28)
    const extraLength = data.readUInt16LE(at + 30)
    const commentLength = data.readUInt16LE(at + 32)
    const localOffset = data.readUInt32LE(at + 42)
    const next = at + 46 + nameLength + extraLength + commentLength
    if (next > centralEnd) throw new Error(`ZIP 第 ${i + 1} 个目录项越界`)
    const encoding = flags & 0x800 ? 'utf8' : 'latin1'
    const name = data.toString(encoding, at + 46, at + 46 + nameLength).replace(/\\/g, '/')
    if (flags & 1 || (method !== 0 && method !== 8)) throw new Error(`${name} 使用不支持的 ZIP 加密/压缩方法`)
    if (localOffset + 30 > data.length || data.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`${name} 本地文件头损坏`)
    const localNameLength = data.readUInt16LE(localOffset + 26)
    const localExtraLength = data.readUInt16LE(localOffset + 28)
    const payloadAt = localOffset + 30 + localNameLength + localExtraLength
    if (payloadAt + compressedBytes > data.length) throw new Error(`${name} 数据越界`)
    const compressed = data.subarray(payloadAt, payloadAt + compressedBytes)
    const raw = method === 0 ? compressed : inflateRawSync(compressed)
    if (raw.byteLength !== rawBytes || crc32(raw) !== crc) throw new Error(`${name} 解压后长度或 CRC-32 不符`)
    result.push({ name, method, compressedBytes, rawBytes, raw })
    at = next
  }
  if (at !== centralEnd) throw new Error('ZIP 中央目录长度不一致')
  return result
}

// 没有导航图时 YaPB 会拒绝创建 Bot；每张启动页地图都必须在同一份 extras.pk3 里有图。
let extrasEntries
try {
  extrasEntries = zipEntries(join(publicDir, 'lib/cstrike/extras.pk3'))
} catch (error) {
  fail(`无法读取 extras.pk3：${error instanceof Error ? error.message : String(error)}`)
}
const extrasByName = new Map(extrasEntries.map((entry) => [entry.name, entry]))
for (const map of supportedMaps) {
  if (!extrasByName.has(`addons/yapb/data/graph/${map}.graph`)) fail(`extras.pk3 缺少 ${map} 的 YaPB 导航图`)
}
const deflatedEntries = extrasEntries.filter((entry) => entry.method === 8).length
if (deflatedEntries < 500 || statSync(join(publicDir, 'lib/cstrike/extras.pk3')).size > 16 * 1024 * 1024) {
  fail('extras.pk3 退回了 Store 大包；运行 npm run cs16:extras')
}

// 每张可见性表都来自当前 YaPB 在真实引擎里生成；格式、节点平方矩阵和尾部统计必须自洽。
for (const map of supportedMaps) {
  const vis = readFileSync(join(publicDir, `vis/${map}.vis`))
  if (vis.length < 24) fail(`${map}.vis 太短`)
  const magic = vis.readUInt32LE(0)
  const version = vis.readInt32LE(4)
  const options = vis.readInt32LE(8)
  const nodes = vis.readInt32LE(12)
  const compressed = vis.readInt32LE(16)
  const raw = vis.readInt32LE(20)
  const graph = extrasByName.get(`addons/yapb/data/graph/${map}.graph`)?.raw
  if ((magic !== 0x59415042 && magic !== 0x544f4255) || version !== 4 || (options & 4) !== 4 ||
      nodes < 8 || raw !== nodes * nodes || vis.length !== 24 + compressed + nodes * 4 ||
      !graph || graph.length < 24 || graph.readInt32LE(12) !== nodes) {
    fail(`${map}.vis 不是完整的 YaPB v4 可见性表`)
  }
}

if (!source.includes('const PREBUILT_VIS_MAPS = new Set(SUPPORTED_MAPS)')) {
  fail('启动器没有给全部 12 张公开地图加载预生成可见性表')
}

if (!source.includes("xash.Cmd_ExecuteString('jointeam 2')") || !source.includes("xash.Cmd_ExecuteString('joinclass 1')") || !source.includes("xash.Cmd_ExecuteString('sv_restart 1')")) {
  fail('启动器没有自动入队并重开首回合，玩家会停在观察视角')
}
if (!source.includes('const downloads = new Map()') || !source.includes('for (const key of keys)')) {
  fail('启动关键路径没有保留动态库去重或当前地图预取')
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
if (!source.includes('maxBytes: MAX_ZSTD_CHUNK_COMPRESSED_BYTES') || !source.includes('maxBytes: MAX_CATALOG_BYTES')) {
  fail('CS16 清单或分片下载缺少运行时硬上限，异常响应可能在校验前耗尽内存')
}
if (!source.includes("fetchBytesWithRetry(`${ASSET_ROOT}/zstd.wasm") || !source.includes('await initZstd(bytes)')) {
  fail('Zstd 解码器仍由第三方胶水层单次下载，瞬时断网会让全部分片重试失效')
}
if (!source.includes("'HUD font', { validate: isTtf }") || source.includes('HUD font failed to load')) {
  fail('必需 HUD 字体失败仍会被吞掉，玩家会进入没有雷达/血量/弹药的残局')
}
if (!source.includes('onAbort: (reason) => reportEngineFailure') || !source.includes('onExit: (status) => reportEngineFailure')) {
  fail('WASM 首帧后异常退出不会显示给玩家')
}
if (!source.includes("overlay?.classList.remove('hidden', 'is-loading')")) fail('首帧后错误不会重新显示故障层')
if (!source.includes('firstFrameReady && !failureReported && overlay')) fail('WebGL 迟到恢复会错误隐藏终态故障层')
if (!source.includes('overlay && !webglContextLost && !failureReported')) fail('WebGL 丢失期间仍会撤掉加载层并露出黑屏')
if (!source.includes("FS.writeFile(BASE + 'cstrike/extras.pk3', extras)")) {
  fail('extras.pk3 没放进 cstrike 搜索路径，YaPB 配置和导航图不会被挂载')
}

console.log(`✔ CS16 ${assetVersion} ${distMode ? '部署产物' : '公开目录'}完整（${manifest.files.length} 个文件）`)
