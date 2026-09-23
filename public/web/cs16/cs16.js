/*
 * CS1.6（Xash3D-FWGS + cs16-client）产品页加载器。
 *
 * 组成（全部自托管在本目录下，不引用 cs15、不依赖任何 CDN）：
 *   · engine/   —— 官方 npm 包 xash3d-fwgs@1.2.2（与 cs15 目录那份逐字节相同）
 *   · lib/      —— cs16-client 的客户端 / 菜单 / 服务端 wasm，含 cstrike/ 与 valve/ 两套
 *   · lib-new/  —— 官方 cs16-client@0.0.2（?client=new 启用，当前引擎跑不起来，见下）
 *   · packs/    —— 从 SteamCMD app 90 资产裁出的浏览器运行时 + 12 张单地图包
 *
 * ⚠️⚠️ 用 TS 封装（engine/dist/index.js）而不是官方 raw.js。
 *   dos.zone 模板用的是 raw.js + 显式 dynamicLibraries，照搬到本引擎版本（1.2.2）会卡死在
 *   `Host_ErrorInit: Xash3D version check failed! Please update your Xash3D!`
 *   —— 换回旧客户端、换旧服务端、去掉 /rwdir/filesystem_stdio.so 都试过，仍然失败；
 *   同一套库走 TS 封装就能正常起来。所以 raw.js 那条路属于另一个引擎版本，这里不照搬。
 *
 * ⚠️⚠️ 客户端构建的选择 —— 当前唯一无法两全的点，改之前先读完。
 *   默认 lib/ 是能与引擎 1.2.2 配套跑起来的构建；官方最新那个（lib-new/）要求的引擎
 *   比 1.2.2 新，一跑就是上面的 version check 失败。而更新的引擎拿不到：
 *     · npm 上 xash3d-fwgs 最新就是 1.2.2（2026-01-19），jsdelivr 也没有其它版本
 *       （@1.2.3 / @1.3 / @2 / @next 全 404）；
 *     · 上游 FWGS/xash3d-fwgs 的 continuous 发布只有原生构建（AppImage / apk / tar.gz），
 *       没有 emscripten wasm；
 *     · 封装仓库 yohimik/webxash3d-fwgs 在 GitHub 已 404；cs16-client 于 2026-09-08
 *       从 npm 下架，jsdelivr 只缓存了 0.0.2 一个版本。
 *   将来出现更新的引擎时，把 ?client=new 转成默认即可。
 *
 * ⚠️ 本文件必须经 esbuild 打包成 cs16.bundle.js 才能被页面加载：引擎 dist 里是
 *   `export * from './net'` 这类「目录 + 无扩展名」的裸模块写法，浏览器原生 ESM 解析不了
 *   （dev 服务器会把 .../dist/net 兜底成根 index.html，返回 text/html）。改完重新打包：
 *   ./node_modules/.bin/esbuild public/web/cs16/cs16.js --bundle --format=esm \
 *     --platform=browser --target=es2022 --outfile=public/web/cs16/cs16.bundle.js
 */
import { Xash3D } from './engine/dist/index.js'
import { decompress as decompressZstd, init as initZstd } from '@bokuweb/zstd-wasm'
import { unpackTarStream } from './tar-stream.js'

const BASE = '/rodir/'
const ASSET_VERSION = '20260923-bots1'
// 清单返回后会换成当前地图的真实压缩体积；这里仅用于清单到达前，避免进度条跳满。
let expectedProgressBytes = 128 * 1024 * 1024
const Q = new URLSearchParams(location.search)
const SUPPORTED_MAPS = new Set([
  'de_dust2', 'de_dust', 'de_inferno', 'de_nuke', 'de_aztec', 'de_train',
  'de_cbble', 'cs_office', 'cs_italy', 'cs_assault', 'cs_militia', 'de_vertigo',
])
const DEFAULT_MAP = 'de_dust2'
const DEFAULT_BOT_COUNT = 7
const MAX_BOT_COUNT = 15

// 查询参数最终会进入包路径和引擎参数；只接受已经打包并在页面公开的地图名。
function selectedMap() {
  const requested = Q.has('map') ? Q.get('map') : document.getElementById('map')?.value
  return SUPPORTED_MAPS.has(requested) ? requested : DEFAULT_MAP
}

function parseBotCount(value) {
  if (!/^\d{1,2}$/.test(String(value ?? ''))) return DEFAULT_BOT_COUNT
  const count = Number(value)
  return Number.isInteger(count) && count >= 0 && count <= MAX_BOT_COUNT ? count : DEFAULT_BOT_COUNT
}

function selectedBotCount() {
  const requested = Q.has('bots') ? Q.get('bots') : document.getElementById('bots')?.value
  return parseBotCount(requested)
}

// 自动启动链接也要让控件显示真实配置，方便问题现场一眼看出这局加载了什么。
const queryMap = Q.get('map')
if (SUPPORTED_MAPS.has(queryMap)) document.getElementById('map').value = queryMap
if (Q.has('bots')) document.getElementById('bots').value = String(parseBotCount(Q.get('bots')))
// 队伍选择 / 购买是 VGUI 菜单，CS 必须选队才会 spawn。留 ?vgui=0 便于对照排查。
const VGUI_MENUS = Q.get('vgui') || '1'
const USE_NEW_LIBS = Q.get('client') === 'new'

// 必须从 document.baseURI 算：生产路由会把 `/web/cs16/` 规范化成无尾斜杠的
// `/web/cs16`。若从 location.href 算 `./`，浏览器会退到 `/web/`，随后引擎、WASM、
// 字体全部 404。入口页的 <base> 固定目录，这里和浏览器加载 bundle 使用同一个根。
const PAGE_ROOT = new URL('./', document.baseURI)
const ASSET_ROOT = new URL(Q.get('root') || './', PAGE_ROOT).href.replace(/\/$/, '')
/*
 * 生产默认从 R2 的自定义域名下载 Zstd 分片；本机则读 public 里的同一份产物。
 * 内容分片以 SHA-256 命名，能放心设一年 immutable；catalog 只短缓存，发新版无需清旧分片。
 * ?packsroot= 可验收临时桶，?packformat=gzip 保留旧包应急通道。
 */
const productionHost = location.hostname === '8bitgo.com' || location.hostname.endsWith('.8bitgo.com')
const DEFAULT_ZSTD_ROOT = productionHost
  ? 'https://assets.8bitgo.com/web/cs16/zstd-v1/'
  : new URL('./packs/zstd-v1/', PAGE_ROOT).href
const PACKS_ROOT = Q.get('packsroot')
  ? new URL(Q.get('packsroot'), PAGE_ROOT).href.replace(/\/?$/, '/')
  : DEFAULT_ZSTD_ROOT
const LEGACY_PACKS_ROOT = Q.get('legacyroot')
  ? new URL(Q.get('legacyroot'), PAGE_ROOT).href.replace(/\/?$/, '/')
  : new URL('./packs/', PAGE_ROOT).href
const FORCE_GZIP = Q.get('packformat') === 'gzip'
const FORCE_GZIP_ROOT = Q.has('packsroot') ? PACKS_ROOT : LEGACY_PACKS_ROOT

const ENGINE = `${ASSET_ROOT}/engine/dist`
const LIB = `${ASSET_ROOT}/lib`
// lib/ 下有 cstrike/ 与 valve/ 两套 dll；lib-new/cstrike 是官方 0.0.2（只有 cstrike）
const CS = USE_NEW_LIBS ? `${ASSET_ROOT}/lib-new/cstrike` : `${LIB}/cstrike`
const GAME_SERVER_LIB = USE_NEW_LIBS
  ? 'dlls/cs_emscripten_wasm32.so'
  : 'dlls/cs_emscripten_wasm32.wasm'
const versioned = (url) => url + (url.includes('?') ? '&' : '?') + 'v=' + ASSET_VERSION

const $ = (id) => document.getElementById(id)
const t0 = performance.now()
const marks = {}
window.__probe = { marks, log: [], errors: [], info: {}, xash: null, net: { total: 0, byUrl: {} } }
window.__probe.keys = []
let phase = '待开始'
let started = false
let firstFrameReady = false

window.addEventListener('keydown', (e) => {
  const rec = { t: 'down', key: e.key, code: e.code, keyCode: e.keyCode }
  window.__probe.keys.push(rec)
  if (window.__probe.keys.length > 30) window.__probe.keys.shift()
})
window.addEventListener('keyup', (e) => {
  const rec = { t: 'up', key: e.key, code: e.code, keyCode: e.keyCode }
  window.__probe.keys.push(rec)
  if (window.__probe.keys.length > 30) window.__probe.keys.shift()
})

function mark(name, extra) {
  const t = ((performance.now() - t0) / 1000).toFixed(2)
  if (!(name in marks)) marks[name] = Number(t)
  log(`[${t}s] ${name}${extra ? ' — ' + extra : ''}`)
  setPhase(name)
}
function log(msg, cls) {
  const line = document.createElement('div')
  if (cls) line.className = cls
  line.textContent = msg
  $('log')?.appendChild(line)
  const box = $('log'); if (box) box.scrollTop = box.scrollHeight
}
function setPhase(text) {
  phase = text
  const p = $('phase'); if (p) p.textContent = text
  const n = $('net'); if (n) n.textContent = `已接收/处理 ${(window.__probe.net.total / 1048576).toFixed(1)} MB`
  const bar = document.querySelector('#bar > i')
  if (bar) {
    bar.style.width = Math.min(100, (window.__probe.net.total / expectedProgressBytes) * 100).toFixed(1) + '%'
  }
}

async function fetchRequired(url, label, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  let res
  try {
    res = await fetch(url, { ...options, signal: controller.signal })
  } catch (error) {
    throw new Error(`${label}连接失败：${error instanceof Error && error.name === 'AbortError' ? '30 秒内没有响应' : error}`)
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) throw new Error(`${label}不可用（HTTP ${res.status}）：${new URL(url, location.href).pathname}`)
  if (!res.body) throw new Error(`${label}没有响应体`)
  return res
}

/** 单条下载 30 秒没有任何新字节就中止；大包下载很久没关系，只要数据仍在流动。 */
function guardStream(stream, label, url) {
  const reader = stream.getReader()
  const key = new URL(url, location.href).pathname
  return new ReadableStream({
    async pull(controller) {
      let timer
      try {
        const next = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label}下载停滞超过 30 秒`)), 30_000)
          }),
        ])
        if (next.done) return controller.close()
        window.__probe.net.total += next.value.byteLength
        window.__probe.net.byUrl[key] = (window.__probe.net.byUrl[key] || 0) + next.value.byteLength
        setPhase(phase)
        controller.enqueue(next.value)
      } catch (error) {
        void reader.cancel(error).catch(() => {})
        controller.error(error)
      } finally {
        clearTimeout(timer)
      }
    },
    cancel(reason) { return reader.cancel(reason) },
  })
}

async function fetchBytes(url, label, options) {
  const res = await fetchRequired(url, label, options)
  return new Uint8Array(await new Response(guardStream(res.body, label, url)).arrayBuffer())
}

const ZSTD_FORMAT = '8bitgo.cs16.zstd-chunks.v1'
const SHA256_RE = /^[a-f0-9]{64}$/
const chunkPromises = new Map()
let catalogPromise
let wasmZstdPromise
let nativeZstd = (() => {
  try {
    // Zstd 是 Compression Streams 后加的格式，不能只判断类存在；旧版会在构造时抛 TypeError。
    return typeof DecompressionStream !== 'undefined' && !!new DecompressionStream('zstd')
  } catch {
    return false
  }
})()

async function digestHex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function validatePackCatalog(catalog) {
  if (!catalog || catalog.format !== ZSTD_FORMAT || !catalog.packs || typeof catalog.packs !== 'object') {
    throw new Error('CS1.6 Zstd 清单格式不兼容')
  }
  if (catalog.compression?.algorithm !== 'zstd' || catalog.compression?.chunkRawBytes !== 16 * 1024 * 1024) {
    throw new Error('CS1.6 Zstd 清单的压缩参数不兼容')
  }
  for (const [key, pack] of Object.entries(catalog.packs)) {
    if (!(key === 'base' || /^maps\/[a-z0-9_]+$/.test(key))) throw new Error(`Zstd 清单含非法包名：${key}`)
    if (!Number.isSafeInteger(pack.rawBytes) || pack.rawBytes <= 0 || !Number.isSafeInteger(pack.compressedBytes) || pack.compressedBytes <= 0 || !SHA256_RE.test(pack.rawSha256) || !Array.isArray(pack.chunks) || !pack.chunks.length) {
      throw new Error(`Zstd 清单中的 ${key} 元数据无效`)
    }
    let rawBytes = 0, compressedBytes = 0
    pack.chunks.forEach((chunk, index) => {
      if (chunk.index !== index || chunk.path !== `chunks/${chunk.compressedSha256}.zst` || !SHA256_RE.test(chunk.compressedSha256) || !SHA256_RE.test(chunk.rawSha256) || !Number.isSafeInteger(chunk.rawBytes) || chunk.rawBytes <= 0 || chunk.rawBytes > 16 * 1024 * 1024 || !Number.isSafeInteger(chunk.compressedBytes) || chunk.compressedBytes <= 0) {
        throw new Error(`Zstd 清单中的 ${key} 第 ${index + 1} 片无效`)
      }
      rawBytes += chunk.rawBytes
      compressedBytes += chunk.compressedBytes
    })
    if (rawBytes !== pack.rawBytes || compressedBytes !== pack.compressedBytes) {
      throw new Error(`Zstd 清单中的 ${key} 汇总长度不符`)
    }
  }
  return catalog
}

async function getPackCatalog() {
  if (!catalogPromise) {
    catalogPromise = (async () => {
      const bytes = await fetchBytes(`${PACKS_ROOT}catalog.json?v=${ASSET_VERSION}`, 'CS1.6 分片清单')
      let catalog
      try { catalog = JSON.parse(new TextDecoder().decode(bytes)) } catch { throw new Error('CS1.6 分片清单不是合法 JSON') }
      return validatePackCatalog(catalog)
    })()
  }
  return catalogPromise
}

async function ensureWasmZstd() {
  if (!wasmZstdPromise) wasmZstdPromise = initZstd(`${ASSET_ROOT}/zstd.wasm?v=${ASSET_VERSION}`)
  await wasmZstdPromise
}

async function decompressChunk(compressed, chunk, label) {
  let raw
  if (nativeZstd) {
    try {
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('zstd'))
      raw = new Uint8Array(await new Response(stream).arrayBuffer())
    } catch (error) {
      // 有的浏览器暴露构造器但实现还不能解完整帧；一次失败后固定走兼容 WASM，避免每片都试错。
      nativeZstd = false
      log(`浏览器原生 Zstd 不可用，改用兼容解码器：${error}`)
    }
  }
  if (!raw) {
    await ensureWasmZstd()
    raw = decompressZstd(compressed)
  }
  if (raw.byteLength !== chunk.rawBytes) throw new Error(`${label}解压长度错误`)
  if (await digestHex(raw) !== chunk.rawSha256) throw new Error(`${label}解压后 SHA-256 校验失败`)
  return raw
}

async function fetchChunkOnce(chunk, label, attempt) {
  const chunkUrl = new URL(chunk.path, PACKS_ROOT)
  // Worker 也按查询串识别不可变对象；哈希既在路径里又在 v 里，换内容必然换 URL。
  chunkUrl.searchParams.set('v', chunk.compressedSha256)
  const url = chunkUrl.href
  const compressed = await fetchBytes(url, label, attempt ? { cache: 'reload' } : undefined)
  if (compressed.byteLength !== chunk.compressedBytes) throw new Error(`${label}下载长度错误`)
  if (await digestHex(compressed) !== chunk.compressedSha256) throw new Error(`${label}SHA-256 校验失败`)
  return decompressChunk(compressed, chunk, label)
}

async function fetchChunk(chunk, label) {
  const key = chunk.compressedSha256
  if (!chunkPromises.has(key)) {
    chunkPromises.set(key, (async () => {
      let lastError
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try { return await fetchChunkOnce(chunk, label, attempt) } catch (error) {
          lastError = error
          if (attempt < 2) log(`⚠️ ${label}失败，正在重试 ${attempt + 2}/3：${error}`, 'err')
        }
      }
      throw lastError
    })())
  }
  try {
    return await chunkPromises.get(key)
  } catch (error) {
    chunkPromises.delete(key)
    throw error
  }
}

/** 最多同时保留两片解压结果，下载能并行，内存峰值仍被压在约 32MB。 */
function zstdPackStream(pack, key) {
  let next = 0
  const inFlight = new Map()
  const schedule = () => {
    while (inFlight.size < 2 && next + inFlight.size < pack.chunks.length) {
      const index = next + inFlight.size
      inFlight.set(index, fetchChunk(pack.chunks[index], `${key} 分片 ${index + 1}/${pack.chunks.length}`))
    }
  }
  schedule()
  return new ReadableStream({
    async pull(controller) {
      try {
        if (next >= pack.chunks.length) return controller.close()
        const chunk = pack.chunks[next]
        const raw = await inFlight.get(next)
        inFlight.delete(next)
        // 预热缓存只负责跨过初始化阶段；交给 TAR 解析器后立即放引用，避免整包常驻 JS 堆。
        chunkPromises.delete(chunk.compressedSha256)
        next += 1
        controller.enqueue(raw)
        schedule()
      } catch (error) {
        controller.error(error)
      }
    },
  })
}

async function prepareZstdPacks(keys) {
  const catalog = await getPackCatalog()
  for (const key of keys) if (!catalog.packs[key]) throw new Error(`Zstd 清单缺少 ${key}`)
  const total = keys.reduce((sum, key) => sum + catalog.packs[key].compressedBytes, 0)
  // 另加约 48MB 引擎 / 客户端库 / extras，进度条按实际地图调整，不再长期卡在 60%。
  expectedProgressBytes = total + 48 * 1024 * 1024
  // 只预热公共包第一片；若连地图也预热，公共包的双缓冲之外会再常驻 16MB，移动端得不偿失。
  const firstKey = keys[0]
  const first = catalog.packs[firstKey].chunks[0]
  void fetchChunk(first, `${firstKey} 分片 1/${catalog.packs[firstKey].chunks.length}`).catch(() => {})
  return catalog
}

/**
 * ⚠️ 用 gzip 魔数判断「现在这份字节还是不是 gzip」，不要假设服务端行为。
 * 分组包在磁盘上是 .gz，但服务端有两种下发方式：
 *   · Vite dev（sirv）会给 .gz 自动加 `Content-Encoding: gzip` —— 浏览器在 fetch 阶段
 *     就**透明解压**了，这里拿到的已经是解压后的 zip；
 *   · 生产（R2/对象存储）按原始 gzip 字节下发 —— 这里拿到的仍是 gzip。
 * 若不看魔数、无条件再解一次，第一种情况下 DecompressionStream 对非 gzip 数据解包会失败，
 * 且浏览器把该流错误报成 `TypeError: Failed to fetch`，看上去像网络问题，极难定位。
 */
function isGzip(b) {
  return b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b
}

/**
 * 引擎 / 游戏端的 wasm：引擎自己会按 dynamicLibraries 加载一份，
 * 这里额外按游戏的标准路径再写一份（/ 与 /rodir/ 两处），确保找得到。
 */
const LIB_FILES = {
  'xash.wasm': `${ENGINE}/xash.wasm`,
  'filesystem_stdio.wasm': `${ENGINE}/filesystem_stdio.wasm`,
  'libref_webgl2.wasm': `${ENGINE}/libref_webgl2.wasm`,
  'libref_soft.wasm': `${ENGINE}/libref_soft.wasm`,
  'cl_dlls/menu_emscripten_wasm32.wasm': `${CS}/cl_dlls/menu_emscripten_wasm32.wasm`,
  'cl_dlls/client_emscripten_wasm32.wasm': `${CS}/cl_dlls/client_emscripten_wasm32.wasm`,
  'dlls/cs_emscripten_wasm32.wasm': `${CS}/dlls/cs_emscripten_wasm32.wasm`,
  'dlls/mp_emscripten_wasm32.wasm': `${CS}/dlls/cs_emscripten_wasm32.wasm`,
  // YaPB 的 Emscripten 独立模式在没有 launcher 环境变量时，会回退到游戏目录下查找此路径。
  'cstrike/dlls/cs_emscripten_wasm32.wasm': `${CS}/dlls/cs_emscripten_wasm32.wasm`,
  'dlls/yapb_emscripten_wasm32.wasm': `${LIB}/cstrike/dlls/yapb_emscripten_wasm32.wasm`,
  'cstrike/dlls/yapb_emscripten_wasm32.wasm': `${LIB}/cstrike/dlls/yapb_emscripten_wasm32.wasm`,
}
if (USE_NEW_LIBS) {
  LIB_FILES['dlls/cs_emscripten_wasm32.so'] = `${CS}/dlls/cs_emscripten_wasm32.so`
  LIB_FILES['cstrike/dlls/cs_emscripten_wasm32.so'] = `${CS}/dlls/cs_emscripten_wasm32.so`
}

/**
 * locateFile：引擎要的每个库都指到自托管地址。
 * ⚠️ valve 那份 hl / bshift / opfor 服务端也要给，否则 `-game` 相关的库解析会走到
 * 引擎默认路径上去（表现为莫名其妙的库加载失败）。
 */
const locateFile = (path) => {
  const map = {
    'xash.wasm': `${ENGINE}/xash.wasm`,
    'filesystem_stdio.wasm': `${ENGINE}/filesystem_stdio.wasm`,
    'libref_webgl2.wasm': `${ENGINE}/libref_webgl2.wasm`,
    'libref_soft.wasm': `${ENGINE}/libref_soft.wasm`,
    'libmenu.wasm': `${ENGINE}/libmenu.wasm`,
    'libvgui_support.wasm': `${ENGINE}/libmenu.wasm`,
    'cl_dlls/menu_emscripten_wasm32.wasm': `${CS}/cl_dlls/menu_emscripten_wasm32.wasm`,
    'cl_dlls/client_emscripten_wasm32.wasm': `${CS}/cl_dlls/client_emscripten_wasm32.wasm`,
    'dlls/cs_emscripten_wasm32.wasm': `${CS}/dlls/cs_emscripten_wasm32.wasm`,
    'dlls/mp_emscripten_wasm32.wasm': `${CS}/dlls/cs_emscripten_wasm32.wasm`,
    'dlls/yapb_emscripten_wasm32.wasm': `${LIB}/cstrike/dlls/yapb_emscripten_wasm32.wasm`,
    'dlls/hl_emscripten_wasm32.wasm': `${LIB}/valve/dlls/hl_emscripten_wasm32.wasm`,
    'dlls/bshift_emscripten_wasm32.wasm': `${LIB}/valve/dlls/hl_emscripten_wasm32.wasm`,
    'dlls/opfor_emscripten_wasm32.wasm': `${LIB}/valve/dlls/hl_emscripten_wasm32.wasm`,
  }
  if (USE_NEW_LIBS) map['dlls/cs_emscripten_wasm32.so'] = `${CS}/dlls/cs_emscripten_wasm32.so`
  if (map[path]) return versioned(map[path])
  if (path.startsWith('/')) return path
  return `${ENGINE}/${path}`
}

const LIBS_MAP = {
  filesystem: versioned(`${ENGINE}/filesystem_stdio.wasm`),
  xash: versioned(`${ENGINE}/xash.wasm`),
  menu: versioned(`${CS}/cl_dlls/menu_emscripten_wasm32.wasm`),
  client: versioned(`${CS}/cl_dlls/client_emscripten_wasm32.wasm`),
  server: versioned(`${CS}/${GAME_SERVER_LIB}`),
  render: {
    // 1.2.2 里 gles3compat 与 gl4es 是同一个文件（见 engine/dist/constants.js）
    gl4es: versioned(`${ENGINE}/libref_webgl2.wasm`),
    gles3compat: versioned(`${ENGINE}/libref_webgl2.wasm`),
    soft: versioned(`${ENGINE}/libref_soft.wasm`),
  },
}

async function placeLibs(xash) {
  // HTTP/2 下并发取库能把多个往返重叠；全部验完后再写 MEMFS，失败时不会留下半套运行库。
  const files = await Promise.all(Object.entries(LIB_FILES).map(async ([name, url]) => {
    const assetUrl = versioned(url)
    const buf = await fetchBytes(assetUrl, `动态库 ${name}`)
    if (name.endsWith('.wasm') && !(buf[0] === 0 && buf[1] === 0x61 && buf[2] === 0x73 && buf[3] === 0x6d)) {
      throw new Error(`动态库 ${name} 不是有效 WASM（可能拿到了 404 HTML）`)
    }
    return [name, buf]
  }))
  for (const [name, buf] of files) {
    for (const dir of ['/', BASE]) {
      const full = dir + name
      const cut = full.lastIndexOf('/')
      if (cut > 0) xash.em.FS.mkdirTree(full.slice(0, cut))
      xash.em.FS.writeFile(full, buf)
    }
  }
}

/** 把已读出的首个分片拼回流前面（用于先探魔数、再决定要不要解压）。 */
function prependChunk(head, reader) {
  return new ReadableStream({
    start(c) { c.enqueue(head) },
    async pull(c) {
      const { done, value } = await reader.read()
      if (done) { c.close(); return }
      c.enqueue(value)
    },
  })
}

/**
 * 取分组包字节。
 *
 * ⚠️ 走**流式**解压而不是 `arrayBuffer()` 后再解：后者会让「压缩包 447MB」和
 * 「解压后 784MB」同时驻留在内存里（峰值接近 1.3GB，再写进虚拟文件系统就是 2GB+），
 * 渲染进程很容易因此被系统杀掉 —— 表现就是玩着玩着**黑屏重启**。
 * 流式只在内存里留解压后的那一份。
 */
async function fetchPackBytes(url, label) {
  const res = await fetchRequired(url, label)
  const reader = guardStream(res.body, label, url).getReader()
  const chunks = []
  let headBytes = 0
  // 流的首个分片理论上可能只有 1 字节；读够魔数再判断，不能把 gzip 误当裸 TAR。
  while (headBytes < 2) {
    const { value, done } = await reader.read()
    if (done) break
    if (value?.byteLength) {
      chunks.push(value)
      headBytes += value.byteLength
    }
  }
  if (!headBytes) throw new Error(`${label}是空文件`)
  const head = new Uint8Array(headBytes)
  let at = 0
  for (const chunk of chunks) { head.set(chunk, at); at += chunk.byteLength }
  const stream = prependChunk(head, reader)
  if (!isGzip(head)) return stream
  if (typeof DecompressionStream === 'undefined') throw new Error('浏览器不支持流式 gzip 解压，请升级浏览器')
  return stream.pipeThrough(new DecompressionStream('gzip'))
}

async function writePack(xash, stream) {
  let yieldBytes = 0
  return unpackTarStream(
    stream,
    async (name, data) => {
      const full = BASE + name
      const cut = full.lastIndexOf('/')
      if (cut > 0) xash.em.FS.mkdirTree(full.slice(0, cut))
      xash.em.FS.writeFile(full, data)
      yieldBytes += data.byteLength
      // 连续写几百 MB 会让页面被判“无响应”；按字节预算让出一帧，文件多少不影响节奏。
      if (yieldBytes >= 16 * 1024 * 1024) {
        yieldBytes = 0
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    },
    ({ files, bytes }) => {
      if (files % 100 === 0) setPhase(`正在展开资源：${files} 个文件 / ${(bytes / 1048576).toFixed(0)} MB`)
    },
  )
}

async function loadPack(xash, file) {
  if (!FORCE_GZIP) {
    try {
      const catalog = await getPackCatalog()
      const pack = catalog.packs[file]
      if (!pack) throw new Error(`Zstd 清单缺少 ${file}`)
      const result = await writePack(xash, zstdPackStream(pack, file))
      window.__probe.info.packFormat = nativeZstd ? 'zstd-native' : 'zstd-wasm'
      log(`[cs16] ${file} 使用 ${nativeZstd ? '浏览器原生 Zstd' : 'Zstd WASM'}，${pack.chunks.length} 个校验分片`)
      return result
    } catch (zstdError) {
      // R2 临时不可用时，保留同源旧包作为应急兜底；已写入的同名文件会被完整 gzip 包覆盖。
      log(`⚠️ ${file} 的 Zstd 分片不可用，尝试 gzip 备用包：${zstdError}`, 'err')
      try {
        const stream = await fetchPackBytes(`${LEGACY_PACKS_ROOT}${file}.tar.gz?v=${ASSET_VERSION}`, `${file} gzip 备用包`)
        const result = await writePack(xash, stream)
        window.__probe.info.packFormat = 'gzip-fallback'
        return result
      } catch (gzipError) {
        throw new Error(`${file} 加载失败；Zstd：${zstdError}；gzip 备用：${gzipError}`)
      }
    }
  }
  const stream = await fetchPackBytes(`${FORCE_GZIP_ROOT}${file}.tar.gz?v=${ASSET_VERSION}`, `${file} gzip 包`)
  window.__probe.info.packFormat = 'gzip-forced'
  return writePack(xash, stream)
}

/**
 * ⚠️⚠️ HUD 字体**必须**补，否则整个 HUD 是空的（小地图 / 血量弹药 / 武器名全看不到）。
 *
 * cs16-client 的菜单与 HUD 会同时请求 `gfx/fonts/FiraSans-Regular.ttf` 和
 * `gfx/fonts/tahoma.ttf`（menu wasm 里的字面量）。真实 CS1.6 资产里**不带**这两个文件，
 * 缺了就是引擎日志里那几行
 *   `Unable to read font file gfx/fonts/FiraSans-Regular.ttf!`
 *   `Unable to read font file gfx/fonts/tahoma.ttf!`
 * —— Tahoma 字体槽加载失败会让整个 HUD 空白，表现为「没有小地图」。
 * 站点只分发 FiraSans（OFL 开源），故用同一份内容补齐 tahoma.ttf 那个槽位。
 */
async function loadHudFont(xash) {
  const FS = xash.em.FS
  try {
    const buf = await fetchBytes(`${ASSET_ROOT}/gfx/fonts/FiraSans-Regular.ttf?v=` + ASSET_VERSION, 'HUD 字体')
    for (const dir of ['gfx/fonts', 'cstrike/gfx/fonts']) {
      FS.mkdirTree(`${BASE}${dir}`)
      FS.writeFile(`${BASE}${dir}/FiraSans-Regular.ttf`, buf)
      FS.writeFile(`${BASE}${dir}/tahoma.ttf`, buf)
    }
    mark('HUD 字体就位')
  } catch (e) {
    log('⚠️ HUD 字体加载失败：' + e, 'err')
  }
}

function waitForFirstFrame(canvas, xash, timeoutMs = 60_000) {
  const fatal = /(?:can't initialize any renderer|version check failed|failed to asynchronously prepare wasm|abort\(|host_error:)/i
  const gameReady = /(?:custom resource propagation complete|execing touch\/chooseteam\.cfg)/i
  const startedAt = performance.now()
  return new Promise((resolve, reject) => {
    const check = () => {
      if (xash.exited) return reject(new Error('引擎在显示第一帧前已经退出'))
      const fatalLine = window.__probe.log.find((line) => fatal.test(line))
      if (fatalLine) return reject(new Error(`引擎启动失败：${fatalLine}`))
      // WebGL 默认缓冲通常没有 preserveDrawingBuffer，合成后 readPixels 可能永远读到全黑。
      // 服务器、客户端和渲染器走完初始化并进入选队脚本时，画面循环已经真实启动，可作为兜底判据。
      if (window.__probe.log.some((line) => gameReady.test(line))) return resolve()
      if (performance.now() - startedAt > timeoutMs) return reject(new Error('地图启动超过 60 秒仍没有画面'))
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
      if (gl && !gl.isContextLost() && canvas.width >= 64 && canvas.height >= 64) {
        const pixel = new Uint8Array(4)
        const points = [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]]
        for (const [xp, yp] of points) {
          gl.readPixels(Math.floor(canvas.width * xp), Math.floor(canvas.height * yp), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
          if (pixel[0] > 8 || pixel[1] > 8 || pixel[2] > 8) return resolve()
        }
      }
      setTimeout(check, 400)
    }
    check()
  })
}

/* 数字键 → 武器槽位绑定。命令行 +bind 会被启动时 exec 的 config.cfg 覆盖，
 * 故写入 autoexec.cfg（在 config 之后执行）。 */
function ensureBinds(xash) {
  const FS = xash.em.FS
  const cfg = [
    'echo "AUTOEXEC_LOADED"',
    'bind 1 slot1', 'bind 2 slot2', 'bind 3 slot3',
    'bind 4 slot4', 'bind 5 slot5', 'bind 6 slot6',
    'hud_fastswitch 1',
    // YaPB 的服务端命令以 yb 开头；旧的 bot_add/bot_kill 是另一套 Bot API，在这里无效。
    'alias addbot "yb add"',
    'alias delbot "yb kick"',
  ].join('\n') + '\n'
  const buf = new TextEncoder().encode(cfg)
  for (const dir of ['', 'cstrike/', 'valve/']) {
    try { FS.writeFile(BASE + dir + 'autoexec.cfg', buf) } catch { /* 目录可能不存在，忽略 */ }
  }
  mark('键位绑定就位 (autoexec.cfg)')
}

/**
 * 在地图级配置里精确覆盖 extras.pk3 自带的 9 Bot 默认值。
 * 地图级配置由 YaPB 在图数据加载前执行；画面出来后还会再设一次 cvar，抵御不同引擎版本的
 * ServerCommand 队列时序差异。
 */
function configureBots(xash, map, count) {
  const FS = xash.em.FS
  const liblistPath = `${BASE}cstrike/liblist.gam`
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const originalLiblist = decoder.decode(FS.readFile(liblistPath))
  // Xash 在 Emscripten 上以 gamedll_linux 的 basename 推导
  // yapb_emscripten_wasm32.wasm；只预加载 YaPB 并不会改变实际 GameDLL。
  const patchedLiblist = originalLiblist.replace(
    /^gamedll_linux\s+"[^"]+"\s*$/m,
    'gamedll_linux "dlls/yapb.so"',
  )
  if (patchedLiblist === originalLiblist) throw new Error('cstrike/liblist.gam 缺少 gamedll_linux，无法启用 YaPB')
  FS.writeFile(liblistPath, encoder.encode(patchedLiblist))

  const mapConfig = [
    '// 由 8BitGo 启动界面生成；覆盖 YaPB 包内固定的 9 Bot 默认值。',
    'yb_quota_mode "normal"',
    `yb_quota "${count}"`,
    'yb_autovacate "0"',
    'yb_kick_after_player_connect "0"',
    'yb_join_after_player "0"',
    'yb_join_team "any"',
    'yb_join_delay "1.0"',
  ].join('\n') + '\n'
  const configDir = `${BASE}cstrike/addons/yapb/conf/maps`
  FS.mkdirTree(configDir)
  FS.writeFile(`${configDir}/${map}.cfg`, encoder.encode(mapConfig))
  window.__probe.info.botCount = count
  window.__probe.info.botGameDll = `${BASE}cstrike/${GAME_SERVER_LIB}`
  mark('BOT 配置就位', count ? `${count} 个 YaPB` : '不加入 BOT')
}

function enforceBotCount(xash, count) {
  xash.Cmd_ExecuteString([
    'yb_quota_mode normal',
    'yb_autovacate 0',
    'yb_kick_after_player_connect 0',
    'yb_join_after_player 0',
    `yb_quota ${count}`,
  ].join(';'))
}

async function start() {
  if (started) return
  started = true
  const startButton = $('start')
  if (startButton) startButton.disabled = true
  const mapSelect = $('map')
  const botSelect = $('bots')
  if (mapSelect) mapSelect.disabled = true
  if (botSelect) botSelect.disabled = true
  const map = selectedMap()
  const botCount = selectedBotCount()
  const overlay = $('overlay'); if (overlay) overlay.classList.remove('hidden')
  const canvasEl = $('canvas')
  if (!(canvasEl instanceof HTMLCanvasElement)) throw new Error('游戏画布不存在，页面文件可能不完整')
  let restoreTimer = 0

  /*
    黑屏的常见元凶是 WebGL 上下文丢失（GPU 显存 / 内存压力）。
    preventDefault() 是为了让浏览器尝试 restore，不写就彻底没救；
    同时记进日志，免得现场只看到「黑了」却没有任何线索。
  */
  canvasEl?.addEventListener('webglcontextlost', (e) => {
    e.preventDefault()
    if (overlay) overlay.classList.remove('hidden')
    setPhase('WebGL 上下文丢失，正在尝试恢复…')
    log('⚠️ WebGL 上下文丢失（多为 GPU/内存压力）——画面会变黑', 'err')
    restoreTimer = setTimeout(() => showError(new Error('WebGL 上下文 10 秒内未恢复，请刷新页面重试')), 10_000)
  })
  canvasEl?.addEventListener('webglcontextrestored', () => {
    clearTimeout(restoreTimer)
    log('WebGL 上下文已恢复')
    if (firstFrameReady && overlay) overlay.classList.add('hidden')
  })

  /*
    ⚠️ 必须显式带上 `-ref webgl2`：wrapper 内部是 `...(this.opts.module ?? {})` 展开在
    `arguments: args` **之后**，所以 module.arguments 会整体覆盖它算出来的 args（含 -ref），
    不写就会「Can't initialize any renderer. Check your video drivers!」。
  */
  const args = [
    '-windowed', '-console',
    '-ref', 'webgl2',
    '-game', 'cstrike',
    /*
      ⚠️ 监听服必须调大 maxplayers，否则 host 自己占掉唯一的槽位，T/CT 两队都报
      `team is full`，玩家永远卡在观察（spectator）状态 —— 没有刀、没有 HUD/雷达、
      没有武器状态。必须在 `+map` 之前设置（map 启动时才读这个 cvar）。
    */
    '+maxplayers', '32',
    '+volume', '0.7', '+hud_scale', '2.5',
    '+exec', 'autoexec.cfg',
    // CS 必须选队伍才会 spawn；队伍选择 / 购买是 VGUI 菜单，显式开启。
    '+_vgui_menus', VGUI_MENUS,
    ...(map ? ['+map', map] : []),
  ]
  window.__probe.args = args

  // 先取 14KB 清单并预热基础包/地图首片，让 R2 握手和引擎初始化并行。
  const wanted = ['base', `maps/${map}`]
  const packWarmup = FORCE_GZIP
    ? Promise.resolve(null)
    : prepareZstdPacks(wanted).catch((error) => {
        log(`⚠️ Zstd 预热失败，稍后会尝试备用包：${error}`, 'err')
        return null
      })

  const xash = new Xash3D({
    module: {
      arguments: args,
      // YaPB 是 GameDLL 代理层，必须由它再加载真正的 CS 服务端库。使用绝对 MEMFS 路径，
      // 避免 Xash/side-module 对当前工作目录认知不一致时误报“不支持 cstrike”。
      ENV: { XASH3D_GAMELIBPATH: `${BASE}cstrike/${GAME_SERVER_LIB}` },
      print: (s) => { window.__probe.log.push(s); log(s) },
      printErr: (s) => { window.__probe.log.push('[err] ' + s); log('[err] ' + s, 'err') },
      locateFile,
    },
    canvas: canvasEl,
    libraries: LIBS_MAP,
  })
  window.__probe.xash = xash
  // 引擎自己退出（黑屏的另一种形态）时留一条记录，否则现场没有任何线索
  setInterval(() => {
    if (xash.exited && !window.__probe.exited) {
      window.__probe.exited = true
      log('⚠️ 引擎已退出', 'err')
    }
  }, 3000)

  await xash.init()
  mark('引擎初始化完成')
  await Promise.all([placeLibs(xash), packWarmup])
  mark('引擎动态库就位')

  // 公共运行时和当前地图分开，不能再把 300 多 MB 的其它地图写进 MEMFS 后才启动。
  window.__probe.info.packs = wanted
  let files = 0, raw = 0
  for (const pack of wanted) {
    const r = await loadPack(xash, pack)
    files += r.files; raw += r.bytes
    mark(`写入 ${pack}`, `${r.files} 个文件 / ${(r.bytes / 1048576).toFixed(1)} MB 原始`)
  }
  window.__probe.info.assetCount = files
  window.__probe.info.assetBytes = raw

  // extras.pk3 是 cstrike 的游戏包（含 YaPB 配置、导航图和语音），必须放进 cstrike/。
  // 放在 /rodir 根目录时 Xash 不会把它加入 cstrike 搜索路径，表面能进图但 Bot 永远找不到 graph。
  const extras = await fetchBytes(`${LIB}/cstrike/extras.pk3?v=${ASSET_VERSION}`, 'CS 客户端 extras.pk3')
  if (!(extras[0] === 0x50 && extras[1] === 0x4b)) throw new Error('extras.pk3 不是有效 ZIP')
  xash.em.FS.mkdirTree(BASE + 'cstrike')
  xash.em.FS.writeFile(BASE + 'cstrike/extras.pk3', extras)
  mark('extras.pk3 就位')

  await loadHudFont(xash)
  ensureBinds(xash)
  configureBots(xash, map, botCount)

  xash.em.FS.chdir(BASE)
  xash.main()
  mark('引擎主循环启动')
  await waitForFirstFrame(canvasEl, xash)
  // YaPB 已完成 GameDLL/地图初始化；再次执行能保证最终数量严格等于启动页选择值。
  enforceBotCount(xash, botCount)
  firstFrameReady = true
  mark('游戏画面就绪')
  if (overlay) overlay.classList.add('hidden')
}

function showError(e) {
  const raw = String((e && e.stack) || e)
  // Emscripten 有些致命错误只 throw `Infinity`，真正原因只写在上一行控制台里。
  const engineReason = [...window.__probe.log].reverse().find((line) => /(?:host_|error|failed|couldn't|abort)/i.test(line))
  const msg = (e instanceof Error && e.message) || (engineReason ? `引擎启动失败：${engineReason}` : raw)
  window.__probe.errors.push(msg)
  mark('失败')
  const box = $('errbox'); if (box) box.textContent = '❌ ' + msg
  const startButton = $('start')
  if (startButton) {
    startButton.disabled = false
    startButton.textContent = '刷新后重试'
    startButton.onclick = () => location.reload()
  }
  log('❌ ' + msg, 'err')
  console.error(e)
}

if (Q.has('map')) {
  start().catch(showError)
} else {
  $('start')?.addEventListener('click', () => start().catch(showError))
}
