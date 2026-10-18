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
import { createCs16RelayNet, createCs16RoomNet, validRelayServer, validRoomDescriptor } from './cs16-net.js'
import {
  MAX_BUFFERED_RESOURCE_BYTES,
  MAX_CATALOG_BYTES,
  MAX_ZSTD_CHUNK_COMPRESSED_BYTES,
  packLimits,
  validatePackCatalog,
} from './pack-guards.js'

const BASE = '/rodir/'
const ASSET_VERSION = '20261018-botvoice-safe1'
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
const DEFAULT_BOT_DIFFICULTY = 3
const MAX_BOT_DIFFICULTY = 3
// 12 张公开地图都随发布物带 YaPB 自己生成的可见性表；IDB 仍作为缺文件/未来新增地图的回退。
const PREBUILT_VIS_MAPS = new Set(SUPPORTED_MAPS)
// 只有 graph / YaPB 数据格式变化时才递增，不能跟着纯 UI 版本变化白白废掉玩家已算好的缓存。
const BOT_VIS_GENERATION = 'yapb-4.5-vis-v1'
const AUTO_JOIN = Q.get('autojoin') !== '0'

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

function parseBotDifficulty(value) {
  if (!/^\d$/.test(String(value ?? ''))) return DEFAULT_BOT_DIFFICULTY
  const difficulty = Number(value)
  return Number.isInteger(difficulty) && difficulty >= 0 && difficulty <= MAX_BOT_DIFFICULTY
    ? difficulty
    : DEFAULT_BOT_DIFFICULTY
}

function selectedBotDifficulty() {
  const requested = Q.has('difficulty') ? Q.get('difficulty') : document.getElementById('difficulty')?.value
  return parseBotDifficulty(requested)
}

// 自动启动链接也要让控件显示真实配置，方便问题现场一眼看出这局加载了什么。
const queryMap = Q.get('map')
if (SUPPORTED_MAPS.has(queryMap)) document.getElementById('map').value = queryMap
if (Q.has('bots')) document.getElementById('bots').value = String(parseBotCount(Q.get('bots')))
if (Q.has('difficulty')) document.getElementById('difficulty').value = String(parseBotDifficulty(Q.get('difficulty')))
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
let phase = 'Ready'
let started = false
let firstFrameReady = false
let failureReported = false
let pageUnloading = false
let engineFatalError = null
let activeRelay = null
let pendingHostedRoom = null

window.addEventListener('beforeunload', () => { pageUnloading = true; activeRelay?.close() })
window.addEventListener('pagehide', () => { pageUnloading = true; activeRelay?.close() })
window.addEventListener('pageshow', () => { pageUnloading = false })

/**
 * Emscripten 的 onAbort/onExit 接不到从浏览器事件回调里冒出的 WASM trap；这类异常过去会
 * 让主循环停掉却继续露着最后一张黑帧。只认 WebAssembly.RuntimeError 或明确的 trap 文案，
 * 避免把 MetaMask 等扩展抛到页面上的普通异常误报成游戏崩溃。
 */
function wasmRuntimeFailure(value) {
  const error = value?.error || value?.reason || value
  if (error instanceof WebAssembly.RuntimeError) return error
  const text = String(error?.stack || error?.message || error || '')
  if (!/(?:remainder|divide) by zero|memory access out of bounds|unreachable|table index is out of bounds|indirect call|null function/i.test(text)) {
    return null
  }
  return /wasm|WebAssembly|RuntimeError/i.test(text) ? error : null
}

function captureWasmRuntimeFailure(event) {
  if (!started || pageUnloading || failureReported) return
  const error = wasmRuntimeFailure(event)
  if (!error) return
  const reason = error instanceof Error ? error.message : String(error)
  reportEngineFailure(`WebAssembly runtime crashed: ${reason || 'unknown fatal error'}`)
}

window.addEventListener('error', captureWasmRuntimeFailure)
window.addEventListener('unhandledrejection', captureWasmRuntimeFailure)

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
  const n = $('net'); if (n) n.textContent = `Received / processed ${(window.__probe.net.total / 1048576).toFixed(1)} MB`
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
    throw new Error(`${label} connection failed: ${error instanceof Error && error.name === 'AbortError' ? 'no response within 30s' : error}`)
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) throw new Error(`${label} unavailable (HTTP ${res.status}): ${new URL(url, location.href).pathname}`)
  if (!res.body) throw new Error(`${label} has no response body`)
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
            timer = setTimeout(() => reject(new Error(`${label} stalled for over 30s`)), 30_000)
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

async function fetchBytes(url, label, options = {}) {
  const { maxBytes = MAX_BUFFERED_RESOURCE_BYTES, ...fetchOptions } = options
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error(`${label} has an invalid download limit`)
  const res = await fetchRequired(url, label, fetchOptions)
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    void res.body.cancel().catch(() => {})
    throw new Error(`${label} is unexpectedly large (${declared} bytes; limit ${maxBytes})`)
  }
  const stream = guardStream(res.body, label, url)
  const reader = stream.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (total + value.byteLength > maxBytes) throw new Error(`${label} exceeded its ${maxBytes}-byte download limit`)
      chunks.push(value)
      total += value.byteLength
    }
  } catch (error) {
    void reader.cancel(error).catch(() => {})
    throw error
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength }
  return bytes
}

async function fetchBytesWithRetry(url, label, options = {}) {
  const { validate, attempts = 3, ...fetchOptions } = options
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const attemptUrl = new URL(url, location.href)
    if (attempt) attemptUrl.searchParams.set('retry', String(attempt))
    try {
      const bytes = await fetchBytes(attemptUrl.href, label, {
        ...fetchOptions,
        ...(attempt ? { cache: 'reload' } : {}),
      })
      if (validate && !validate(bytes)) throw new Error(`${label} failed content validation`)
      return bytes
    } catch (error) {
      lastError = error
      if (attempt < attempts - 1) log(`⚠️ ${label} failed, retrying ${attempt + 2}/${attempts}: ${error}`, 'err')
    }
  }
  throw lastError
}

const isWasm = (bytes) => bytes.byteLength >= 8 && bytes[0] === 0 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d
const isZip = (bytes) => bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
const isTtf = (bytes) => bytes.byteLength >= 4 &&
  ((bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) ||
    new TextDecoder().decode(bytes.subarray(0, 4)) === 'OTTO')

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

async function getPackCatalog() {
  if (!catalogPromise) {
    catalogPromise = (async () => {
      let lastError
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const url = new URL('catalog.json', PACKS_ROOT)
        url.searchParams.set('v', ASSET_VERSION)
        if (attempt) url.searchParams.set('retry', String(attempt))
        try {
          const bytes = await fetchBytes(url.href, 'CS1.6 chunk manifest', {
            maxBytes: MAX_CATALOG_BYTES,
            ...(attempt ? { cache: 'reload' } : {}),
          })
          let catalog
          try { catalog = JSON.parse(new TextDecoder().decode(bytes)) } catch { throw new Error('CS1.6 chunk manifest is not valid JSON') }
          return validatePackCatalog(catalog)
        } catch (error) {
          lastError = error
          if (attempt < 2) log(`⚠️ CS1.6 chunk manifest failed, retrying ${attempt + 2}/3: ${error}`, 'err')
        }
      }
      throw lastError
    })()
  }
  const pending = catalogPromise
  try {
    return await pending
  } catch (error) {
    // 失败 Promise 不能永久钉住本页；预热失败后，正式加载仍应有一次重新建连的机会。
    // 只清自己等待的那一代，避免另一个调用已经发起的新请求被迟到的 catch 抹掉。
    if (catalogPromise === pending) catalogPromise = null
    throw error
  }
}

async function ensureWasmZstd() {
  if (!wasmZstdPromise) {
    wasmZstdPromise = (async () => {
      const bytes = await fetchBytesWithRetry(`${ASSET_ROOT}/zstd.wasm?v=${ASSET_VERSION}`, 'Zstd decoder', {
        maxBytes: 1024 * 1024,
        validate: isWasm,
      })
      // 先把 WASM 字节可靠地拿到手再初始化；传 URL 会让第三方胶水层做一次不可重试的内部 fetch。
      await initZstd(bytes)
    })()
  }
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
      log(`Native Zstd unavailable, using compatible decoder: ${error}`)
    }
  }
  if (!raw) {
    await ensureWasmZstd()
    raw = decompressZstd(compressed)
  }
  if (raw.byteLength !== chunk.rawBytes) throw new Error(`${label} decompressed length mismatch`)
  if (await digestHex(raw) !== chunk.rawSha256) throw new Error(`${label} SHA-256 mismatch after decompression`)
  return raw
}

async function fetchChunkOnce(chunk, label, attempt) {
  const chunkUrl = new URL(chunk.path, PACKS_ROOT)
  // Worker 也按查询串识别不可变对象；哈希既在路径里又在 v 里，换内容必然换 URL。
  chunkUrl.searchParams.set('v', chunk.compressedSha256)
  // cache:reload 只约束浏览器缓存；重试换查询串还能绕开偶发的边缘坏缓存。
  if (attempt) chunkUrl.searchParams.set('retry', String(attempt))
  const url = chunkUrl.href
  const compressed = await fetchBytes(url, label, {
    ...(attempt ? { cache: 'reload' } : {}),
    maxBytes: MAX_ZSTD_CHUNK_COMPRESSED_BYTES,
  })
  if (compressed.byteLength !== chunk.compressedBytes) throw new Error(`${label} download length mismatch`)
  if (await digestHex(compressed) !== chunk.compressedSha256) throw new Error(`${label} SHA-256 mismatch`)
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
          if (attempt < 2) log(`⚠️ ${label} failed, retrying ${attempt + 2}/3: ${error}`, 'err')
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
      inFlight.set(index, fetchChunk(pack.chunks[index], `${key} chunk ${index + 1}/${pack.chunks.length}`))
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
  for (const key of keys) if (!catalog.packs[key]) throw new Error(`Zstd manifest is missing ${key}`)
  const total = keys.reduce((sum, key) => sum + catalog.packs[key].compressedBytes, 0)
  // extras 改成 Deflate 后，进 git 的引擎 / 客户端库 / 字体 / extras 实际约 30MB。
  expectedProgressBytes = total + 32 * 1024 * 1024
  // 地图包都只有一片且最大约十几 MB；和公共包第一片同时预热，可以把地图下载藏在公共包写盘时间里。
  // 这里不预热公共包第二片，仍把额外解压内存限制在「基础 16MB + 当前地图一片」。
  for (const key of keys) {
    const first = catalog.packs[key].chunks[0]
    void fetchChunk(first, `${key} chunk 1/${catalog.packs[key].chunks.length}`).catch(() => {})
  }
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
  // 同一份 CS GameDLL 要写到多个兼容路径，但下载一次就够；旧实现把相同 URL 并发取了 2–3 次，
  // 即使命中 HTTP 缓存也会重复复制 ArrayBuffer，白耗启动时间和 JS 堆。
  const downloads = new Map()
  const files = await Promise.all(Object.entries(LIB_FILES).map(async ([name, url]) => {
    const assetUrl = versioned(url)
    if (!downloads.has(assetUrl)) downloads.set(assetUrl, fetchBytesWithRetry(assetUrl, `library ${name}`, { validate: isWasm }))
    const buf = await downloads.get(assetUrl)
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
  if (!headBytes) throw new Error(`${label} is empty`)
  const head = new Uint8Array(headBytes)
  let at = 0
  for (const chunk of chunks) { head.set(chunk, at); at += chunk.byteLength }
  const stream = prependChunk(head, reader)
  if (!isGzip(head)) return stream
  if (typeof DecompressionStream === 'undefined') throw new Error('Streaming gzip is not supported in this browser')
  return stream.pipeThrough(new DecompressionStream('gzip'))
}

async function writePack(xash, stream, maxTotalBytes) {
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
      if (files % 100 === 0) setPhase(`Extracting assets: ${files} files / ${(bytes / 1048576).toFixed(0)} MB`)
    },
    { maxTotalBytes },
  )
}

async function loadPack(xash, file) {
  const limits = packLimits(file)
  if (!FORCE_GZIP) {
    try {
      const catalog = await getPackCatalog()
      const pack = catalog.packs[file]
      if (!pack) throw new Error(`Zstd manifest is missing ${file}`)
      const result = await writePack(xash, zstdPackStream(pack, file), limits.rawBytes)
      window.__probe.info.packFormat = nativeZstd ? 'zstd-native' : 'zstd-wasm'
      log(`[cs16] ${file} via ${nativeZstd ? 'native Zstd' : 'Zstd WASM'}, ${pack.chunks.length} verified chunks`)
      return result
    } catch (zstdError) {
      // R2 临时不可用时，保留同源旧包作为应急兜底；已写入的同名文件会被完整 gzip 包覆盖。
      log(`⚠️ Zstd chunks for ${file} unavailable, trying gzip fallback: ${zstdError}`, 'err')
      try {
        const stream = await fetchPackBytes(`${LEGACY_PACKS_ROOT}${file}.tar.gz?v=${ASSET_VERSION}`, `${file} gzip fallback`)
        const result = await writePack(xash, stream, limits.rawBytes)
        window.__probe.info.packFormat = 'gzip-fallback'
        return result
      } catch (gzipError) {
        throw new Error(`${file} failed to load; zstd: ${zstdError}; gzip fallback: ${gzipError}`)
      }
    }
  }
  const stream = await fetchPackBytes(`${FORCE_GZIP_ROOT}${file}.tar.gz?v=${ASSET_VERSION}`, `${file} gzip pack`)
  window.__probe.info.packFormat = 'gzip-forced'
  return writePack(xash, stream, limits.rawBytes)
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
async function loadHudFont(xash, fontPromise) {
  const FS = xash.em.FS
  const buf = await (fontPromise || fetchBytesWithRetry(`${ASSET_ROOT}/gfx/fonts/FiraSans-Regular.ttf?v=` + ASSET_VERSION, 'HUD font', { validate: isTtf }))
  for (const dir of ['gfx/fonts', 'cstrike/gfx/fonts']) {
    FS.mkdirTree(`${BASE}${dir}`)
    FS.writeFile(`${BASE}${dir}/FiraSans-Regular.ttf`, buf)
    FS.writeFile(`${BASE}${dir}/tahoma.ttf`, buf)
  }
  // 缺字体会让雷达、血量、弹药和武器名整体消失，不能把这种残局伪装成启动成功。
  mark('HUD font ready')
}

function waitForFirstFrame(canvas, xash, timeoutMs = 60_000) {
  const fatal = /(?:can't initialize any renderer|version check failed|failed to asynchronously prepare wasm|abort\(|host_error:)/i
  const gameReady = /(?:custom resource propagation complete|execing touch\/chooseteam\.cfg)/i
  const startedAt = performance.now()
  return new Promise((resolve, reject) => {
    const check = () => {
      if (engineFatalError) return reject(engineFatalError)
      if (xash.exited) return reject(new Error('Engine exited before the first frame'))
      const fatalLine = window.__probe.log.find((line) => fatal.test(line))
      if (fatalLine) return reject(new Error(`Engine failed to start: ${fatalLine}`))
      // WebGL 默认缓冲通常没有 preserveDrawingBuffer，合成后 readPixels 可能永远读到全黑。
      // 服务器、客户端和渲染器走完初始化并进入选队脚本时，画面循环已经真实启动，可作为兜底判据。
      if (window.__probe.log.some((line) => gameReady.test(line))) return resolve()
      if (performance.now() - startedAt > timeoutMs) return reject(new Error('No frame after 60s of map startup'))
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
    // 子站的 Permissions-Policy 明确禁用麦克风；继续初始化采集只会产生拒绝异常和无效主线程工作。
    'voice_enable 0',
    // YaPB 的服务端命令以 yb 开头；旧的 bot_add/bot_kill 是另一套 Bot API，在这里无效。
    'alias addbot "yb add"',
    'alias delbot "yb kick"',
  ].join('\n') + '\n'
  const buf = new TextEncoder().encode(cfg)
  for (const dir of ['', 'cstrike/', 'valve/']) {
    try { FS.writeFile(BASE + dir + 'autoexec.cfg', buf) } catch { /* 目录可能不存在，忽略 */ }
  }
  mark('Key bindings written (autoexec.cfg)')
}

/**
 * 在地图级配置里精确覆盖 extras.pk3 自带的 9 Bot 默认值。
 * 地图级配置由 YaPB 在图数据加载前执行；画面出来后还会再设一次 cvar，抵御不同引擎版本的
 * ServerCommand 队列时序差异。
 */
function configureBots(xash, map, count, difficulty) {
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
  if (patchedLiblist === originalLiblist) throw new Error('cstrike/liblist.gam lacks gamedll_linux; cannot enable YaPB')
  FS.writeFile(liblistPath, encoder.encode(patchedLiblist))

  const mapConfig = [
    '// Generated by the 8BitGo launcher; overrides the fixed 9-bot defaults baked into the YaPB pack.',
    'yb_quota_mode "normal"',
    `yb_quota "${count}"`,
    'yb_autovacate "0"',
    'yb_kick_after_player_connect "0"',
    'yb_join_after_player "0"',
    'yb_join_team "any"',
    'yb_join_delay "1.0"',
    // 旧 cs16-client 的 BotVoice HUD 路径会偶发 remainder-by-zero；保留短电台指令，禁用语音 chatter。
    'yb_radio_mode "1"',
    // 难度必须和 quota 一起落到地图级配置；等画面出来再改会让首批 Bot 沿用包内固定的 Expert。
    `yb_difficulty "${difficulty}"`,
  ].join('\n') + '\n'
  const configDir = `${BASE}cstrike/addons/yapb/conf/maps`
  FS.mkdirTree(configDir)
  FS.writeFile(`${configDir}/${map}.cfg`, encoder.encode(mapConfig))
  window.__probe.info.botCount = count
  window.__probe.info.botDifficulty = difficulty
  window.__probe.info.botGameDll = `${BASE}cstrike/${GAME_SERVER_LIB}`
  mark('Bot config ready', count ? `${count} YaPB` : 'no bots')
}

function enforceBotCount(xash, count, difficulty) {
  xash.Cmd_ExecuteString([
    'yb_quota_mode normal',
    'yb_autovacate 0',
    'yb_kick_after_player_connect 0',
    'yb_join_after_player 0',
    'yb_radio_mode 1',
    `yb_difficulty ${difficulty}`,
    `yb_quota ${count}`,
  ].join(';'))
}

const BOT_VIS_DB = '8bitgo-cs16-yapb-vis'
const BOT_VIS_STORE = 'maps'

function botVisPath(map) {
  return `${BASE}cstrike/addons/yapb/data/train/${map}.vis`
}

/**
 * YaPB v4 的 .vis 是 24 字节 StorageHeader + ULZ 数据 + 每节点 4 字节统计。
 * 只看文件存在会把中途写了一半的缓存留到下次，随后 YaPB 仍会重建；这里把格式和总长一起验掉。
 */
function validBotVis(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 24) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = view.getUint32(0, true)
  const version = view.getInt32(4, true)
  const options = view.getInt32(8, true)
  const nodes = view.getInt32(12, true)
  const compressed = view.getInt32(16, true)
  const raw = view.getInt32(20, true)
  return (magic === 0x59415042 || magic === 0x544f4255) && version === 4 && (options & 4) === 4 &&
    nodes >= 8 && nodes <= 8192 && compressed > 0 && raw === nodes * nodes &&
    bytes.byteLength === 24 + compressed + nodes * 4
}

function openBotVisDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    const request = indexedDB.open(BOT_VIS_DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(BOT_VIS_STORE)
    request.onsuccess = () => resolve(request.result)
    // Safari 私密模式等环境会禁用 IDB；游戏仍能运行，只是该地图下次需要重新计算。
    request.onerror = () => resolve(null)
  })
}

async function readBotVisCache(map) {
  const db = await openBotVisDb()
  if (!db) return null
  try {
    return await new Promise((resolve) => {
      const request = db.transaction(BOT_VIS_STORE, 'readonly').objectStore(BOT_VIS_STORE).get(`${BOT_VIS_GENERATION}:${map}`)
      request.onsuccess = () => {
        const value = request.result
        const bytes = value ? new Uint8Array(value) : null
        resolve(validBotVis(bytes) ? bytes : null)
        db.close()
      }
      request.onerror = () => { resolve(null); db.close() }
    })
  } catch {
    db.close()
    return null
  }
}

async function writeBotVisCache(map, bytes) {
  if (!validBotVis(bytes)) return false
  const db = await openBotVisDb()
  if (!db) return false
  try {
    return await new Promise((resolve) => {
      const tx = db.transaction(BOT_VIS_STORE, 'readwrite')
      // FS.readFile 的视图可能挂着整个 WASM 内存，必须 slice 后再交给 IndexedDB。
      tx.objectStore(BOT_VIS_STORE).put(bytes.slice().buffer, `${BOT_VIS_GENERATION}:${map}`)
      tx.oncomplete = () => { resolve(true); db.close() }
      tx.onerror = () => { resolve(false); db.close() }
      tx.onabort = () => { resolve(false); db.close() }
    })
  } catch {
    db.close()
    return false
  }
}

async function loadBotVis(map) {
  if (Q.get('novis') === '1') return null
  if (PREBUILT_VIS_MAPS.has(map)) {
    try {
      const bytes = await fetchBytes(`${ASSET_ROOT}/vis/${map}.vis?v=${ASSET_VERSION}`, `YaPB visibility table for ${map}`)
      if (!validBotVis(bytes)) throw new Error('invalid YaPB visibility table')
      return { bytes, source: 'prebuilt' }
    } catch (error) {
      // 发布时漏文件不该阻断整局；退回浏览器缓存/本局重建，同时把真正原因留在现场日志。
      log(`⚠️ Prebuilt YaPB visibility table unavailable: ${error}`, 'err')
    }
  }
  const cached = await readBotVisCache(map)
  return cached ? { bytes: cached, source: 'cache' } : null
}

function restoreBotVis(xash, map, prepared) {
  if (!prepared) {
    window.__probe.info.botVis = 'rebuilding'
    return false
  }
  const path = botVisPath(map)
  xash.em.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')))
  xash.em.FS.writeFile(path, prepared.bytes)
  window.__probe.info.botVis = prepared.source
  mark('YaPB visibility ready', `${map} · ${prepared.source}`)
  return true
}

function watchGeneratedBotVis(xash, map) {
  const path = botVisPath(map)
  const deadline = performance.now() + 240_000
  let saving = false
  const timer = setInterval(async () => {
    if (saving) return
    try {
      const found = xash.em.FS.analyzePath(path)
      if (found.exists) {
        const bytes = xash.em.FS.readFile(path)
        if (validBotVis(bytes)) {
          saving = true
          clearInterval(timer)
          const saved = await writeBotVisCache(map, bytes)
          window.__probe.info.botVis = saved ? 'generated-cached' : 'generated-memory-only'
          log(saved
            ? `[bots] ${map}.vis generated and cached; future launches skip the visibility rebuild.`
            : `[bots] ${map}.vis generated, but the browser refused persistent storage.`)
          return
        }
      }
    } catch { /* 文件可能正处于写入过程，下一轮再验完整长度。 */ }
    if (performance.now() >= deadline) {
      clearInterval(timer)
      window.__probe.info.botVis = 'generation-timeout'
      log('[bots] YaPB visibility generation exceeded 240 seconds; gameplay can continue.', 'err')
    }
  }, 1000)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function autoJoinPlayer(xash) {
  if (!AUTO_JOIN) {
    window.__probe.info.autoJoin = 'disabled'
    return
  }
  setPhase('Joining Counter-Terrorists…')
  // 三条命令不能塞进同一个分号串：jointeam 会先切菜单状态，同一帧紧跟 joinclass 偶尔会被旧客户端丢掉。
  xash.Cmd_ExecuteString('jointeam 2')
  await delay(180)
  xash.Cmd_ExecuteString('joinclass 1')
  await delay(320)
  // 监听服已经开始首回合时，单纯入队仍会等下一轮；重开一次确保玩家立刻拿到 HUD、武器和控制权。
  xash.Cmd_ExecuteString('sv_restart 1')
  await delay(1150)
  window.__probe.info.autoJoin = 'counter-terrorists'
}

function updateBotHint(count) {
  const hint = $('bot-hint')
  if (!hint) return
  const difficulty = $('difficulty')
  if (difficulty && !started) difficulty.disabled = count === 0
  const summary = count === 0
    ? 'No BOTs. Ideal for exploring the map and practicing grenades.'
    : count === 7
      ? 'You and 7 BOTs make a classic 4v4 match.'
      : `Train with ${count} BOTs.`
  hint.textContent = `${summary} You will join Counter-Terrorists automatically; press M to switch teams.`
}

$('bots')?.addEventListener('change', () => updateBotHint(selectedBotCount()))
updateBotHint(selectedBotCount())

let serverDirectory = []
let selectedServerId = ''
let serverDirectoryPromise = null

function setConnectStatus(message, kind = '') {
  const status = $('server-connect-status')
  if (!status) return
  status.textContent = message
  status.style.color = kind === 'error' ? '#ff7b5d' : kind === 'ready' ? '#a8d56a' : ''
}

async function readJsonResponse(response) {
  let body = null
  try { body = await response.json() } catch { /* 反代错误页不是 JSON 时仍保留 HTTP 状态 */ }
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`)
  return body
}

function normalizedRoomCode(value) {
  const code = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  return /^[A-HJ-NP-Z2-9]{6}$/.test(code) ? code : ''
}

async function findRoom(code) {
  const normalized = normalizedRoomCode(code)
  if (!normalized) throw new Error('Enter a valid 6-character room code')
  const response = await fetch(`/api/cs16/rooms/${encodeURIComponent(normalized)}`, { cache: 'no-store' })
  const room = await readJsonResponse(response)
  if (!validRoomDescriptor(room) || !SUPPORTED_MAPS.has(room.map)) throw new Error('The room returned invalid connection settings')
  return room
}

function setServerStatus(message, kind = '') {
  const status = $('server-status')
  if (!status) return
  status.textContent = message
  status.className = `server-status${kind ? ` ${kind}` : ''}`
}

function selectedServer() {
  return serverDirectory.find((server) => server.id === selectedServerId) || null
}

function updateServerJoinButton() {
  const server = selectedServer()
  const join = $('server-join')
  if (!join) return
  join.disabled = started || !server || server.joinable === false
  join.title = server?.unavailableReason || ''
}

function renderServerDirectory() {
  const list = $('server-list')
  if (!list) return
  list.replaceChildren()
  for (const server of serverDirectory) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = `server-row${server.online ? '' : ' is-unreachable'}`
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', String(server.id === selectedServerId))
    row.disabled = started

    const name = document.createElement('span')
    name.className = 'server-name'
    name.textContent = server.name
    const map = document.createElement('span')
    map.textContent = server.map
    const players = document.createElement('span')
    players.textContent = server.players == null ? '—' : `${server.players}/${server.maxPlayers}`
    const ping = document.createElement('span')
    ping.textContent = server.pingMs == null ? '—' : `${server.pingMs} ms`
    row.append(name, map, players, ping)
    row.title = server.unavailableReason || server.description || (server.online ? 'Double-click to join' : 'The status probe did not respond; you can still try to join')
    row.addEventListener('click', () => {
      selectedServerId = server.id
      renderServerDirectory()
      updateServerJoinButton()
    })
    row.addEventListener('dblclick', () => {
      if (server.joinable !== false) start({ server }).catch(showError)
    })
    list.appendChild(row)
  }
  updateServerJoinButton()
}

async function loadServerDirectory(force = false) {
  if (!force && serverDirectoryPromise) return serverDirectoryPromise
  setServerStatus('Refreshing the verified server directory…')
  const controller = new AbortController()
  // 首次打开需要先取外部公共目录，再由本站并发做 A2S 复检；弱网下给它完整的一轮时间。
  const timer = setTimeout(() => controller.abort(), 15_000)
  serverDirectoryPromise = (async () => {
    try {
      const response = await fetch('/api/cs16/servers', { cache: 'no-store', signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const directory = await response.json()
      if (!directory?.enabled) {
        serverDirectory = []
        selectedServerId = ''
        setServerStatus('Online play: the automatic directory is disabled and no fixed servers are configured.', 'is-empty')
        renderServerDirectory()
        return serverDirectory
      }
      serverDirectory = Array.isArray(directory.servers)
        ? directory.servers.filter((server) => validRelayServer(server) && SUPPORTED_MAPS.has(server.map) && typeof server.name === 'string')
        : []
      if (!serverDirectory.some((server) => server.id === selectedServerId)) {
        selectedServerId = serverDirectory.find((server) => server.joinable !== false)?.id || ''
      }
      const online = serverDirectory.filter((server) => server.online).length
      setServerStatus(
        serverDirectory.length
          ? `${serverDirectory.length} joinable server${serverDirectory.length === 1 ? '' : 's'} · ${online} online`
          : 'Online play: the directory is enabled, but no compatible servers are currently available.',
        serverDirectory.length ? 'is-ready' : 'is-empty',
      )
      renderServerDirectory()
      return serverDirectory
    } catch (error) {
      serverDirectory = []
      selectedServerId = ''
      renderServerDirectory()
      const loopback = ['127.0.0.1', 'localhost', '::1'].includes(location.hostname)
      const detail = error instanceof Error && error.name === 'AbortError'
        ? 'Request timed out'
        : error instanceof TypeError
          ? loopback
            ? 'The local online backend is not connected. Restart npm run dev.'
            : 'Network connection failed. Please try again later.'
          : error instanceof Error
            ? error.message
            : 'Unknown network error'
      // 浏览器原始异常只留给控制台排查，不能把 `TypeError: Failed to fetch` 直接甩给玩家。
      console.warn('[cs16] Failed to refresh the server directory:', error)
      setServerStatus(`The server directory is temporarily unavailable (${detail}). BOT training is unaffected.`, 'is-error')
      return serverDirectory
    } finally {
      clearTimeout(timer)
    }
  })()
  return serverDirectoryPromise
}

function showLauncherMode(mode) {
  const practice = mode !== 'servers'
  const practicePanel = $('practice-panel')
  const serverPanel = $('server-panel')
  const practiceButton = $('show-practice')
  const serverButton = $('show-servers')
  if (practicePanel) practicePanel.hidden = !practice
  if (serverPanel) serverPanel.hidden = practice
  practiceButton?.setAttribute('aria-selected', String(practice))
  serverButton?.setAttribute('aria-selected', String(!practice))
  if (!practice) void loadServerDirectory()
}

$('show-practice')?.addEventListener('click', () => showLauncherMode('practice'))
$('show-servers')?.addEventListener('click', () => showLauncherMode('servers'))
$('server-back')?.addEventListener('click', () => showLauncherMode('practice'))
$('server-refresh')?.addEventListener('click', () => {
  serverDirectoryPromise = null
  void loadServerDirectory(true)
})
$('server-join')?.addEventListener('click', () => {
  const server = selectedServer()
  if (server) start({ server }).catch(showError)
})

$('direct-connect')?.addEventListener('click', async () => {
  if (started) return
  const button = $('direct-connect')
  try {
    if (button) button.disabled = true
    setConnectStatus('Verifying that this is a compatible public CS1.6 server…')
    const response = await fetch('/api/cs16/servers/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: $('direct-address')?.value || '' }),
    })
    const server = await readJsonResponse(response)
    if (!validRelayServer(server) || !SUPPORTED_MAPS.has(server.map) || server.joinable === false) {
      throw new Error(server?.unavailableReason || 'This address is not a compatible CS1.6 server')
    }
    setConnectStatus(`Verified ${server.name} · ${server.map}. Connecting…`, 'ready')
    await start({ server })
  } catch (error) {
    if (started) showError(error)
    else setConnectStatus(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    if (button && !started) button.disabled = false
  }
})

$('room-connect')?.addEventListener('click', async () => {
  if (started) return
  const button = $('room-connect')
  try {
    if (button) button.disabled = true
    setConnectStatus('Finding the room…')
    const room = await findRoom($('room-code-input')?.value)
    setConnectStatus(room.hostReady ? `Host ready · ${room.map}` : `Host is still loading · ${room.map}. You can load the game now.`, 'ready')
    await start({ room: { ...room, role: 'guest' } })
  } catch (error) {
    if (started) showError(error)
    else setConnectStatus(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    if (button && !started) button.disabled = false
  }
})

$('room-code-input')?.addEventListener('input', (event) => {
  event.currentTarget.value = String(event.currentTarget.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
})

$('create-room')?.addEventListener('click', async () => {
  if (started) return
  const button = $('create-room')
  if (pendingHostedRoom) {
    start({ room: pendingHostedRoom }).catch(showError)
    return
  }
  try {
    if (button) {
      button.disabled = true
      button.textContent = 'Creating…'
    }
    const response = await fetch('/api/cs16/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        map: selectedMap(),
        botCount: selectedBotCount(),
        difficulty: selectedBotDifficulty(),
      }),
    })
    const room = await readJsonResponse(response)
    if (!validRoomDescriptor(room) || !SUPPORTED_MAPS.has(room.map) || typeof room.hostToken !== 'string') {
      throw new Error('The room service returned invalid settings')
    }
    pendingHostedRoom = { ...room, role: 'host' }
    for (const id of ['map', 'bots', 'difficulty', 'start']) {
      const control = $(id)
      if (control) control.disabled = true
    }
    const code = $('created-room-code')
    if (code) code.textContent = room.code
    const box = $('room-created')
    if (box) box.hidden = false
    if (button) {
      button.disabled = false
      button.textContent = 'Start Room'
    }
    const sub = $('sub')
    if (sub) sub.textContent = 'Send the room code to your friends, then click Start Room. They can enter the code and load the game while you prepare.'
  } catch (error) {
    if (button) {
      button.disabled = false
      button.textContent = 'Create Room'
    }
    const errbox = $('errbox')
    if (errbox) errbox.textContent = `ERROR · ${error instanceof Error ? error.message : String(error)}`
  }
})

$('copy-room-code')?.addEventListener('click', async () => {
  if (!pendingHostedRoom) return
  const shareUrl = new URL(location.href)
  shareUrl.search = ''
  shareUrl.searchParams.set('room', pendingHostedRoom.code)
  try {
    await navigator.clipboard.writeText(`${pendingHostedRoom.code}\n${shareUrl.href}`)
    const button = $('copy-room-code')
    if (button) button.textContent = 'Copied'
  } catch {
    const errbox = $('errbox')
    if (errbox) errbox.textContent = `Room Code: ${pendingHostedRoom.code} · Invite Link: ${shareUrl.href}`
  }
})

function reportEngineFailure(message) {
  if (pageUnloading || failureReported) return
  engineFatalError = new Error(message)
  queueMicrotask(() => showError(engineFatalError))
}

async function start({ server = null, room = null } = {}) {
  if (started) return
  if (server && room) throw new Error('You cannot join a public server and a temporary room at the same time')
  if (server && (!validRelayServer(server) || !SUPPORTED_MAPS.has(server.map) || server.joinable === false)) {
    throw new Error(server?.unavailableReason || 'This server cannot currently be joined from the web version')
  }
  if (room && (!validRoomDescriptor(room) || !SUPPORTED_MAPS.has(room.map) || !['host', 'guest'].includes(room.role))) {
    throw new Error('This temporary room has invalid connection settings')
  }
  started = true
  const startButton = $('start')
  if (startButton) startButton.disabled = true
  const mapSelect = $('map')
  const botSelect = $('bots')
  const difficultySelect = $('difficulty')
  if (mapSelect) mapSelect.disabled = true
  if (botSelect) botSelect.disabled = true
  if (difficultySelect) difficultySelect.disabled = true
  for (const id of ['show-practice', 'show-servers', 'server-back', 'server-refresh', 'server-join', 'create-room', 'direct-connect', 'room-connect']) {
    const button = $(id)
    if (button) button.disabled = true
  }
  for (const row of document.querySelectorAll('.server-row')) row.disabled = true
  const remoteClient = !!server || room?.role === 'guest'
  const listenServer = !remoteClient
  const map = server?.map || room?.map || selectedMap()
  const botCount = room?.role === 'host' ? room.botCount : selectedBotCount()
  const botDifficulty = room?.role === 'host' ? room.difficulty : selectedBotDifficulty()
  const overlay = $('overlay')
  if (overlay) {
    overlay.classList.remove('hidden')
    overlay.classList.add('is-loading')
  }
  const canvasEl = $('canvas')
  if (!(canvasEl instanceof HTMLCanvasElement)) throw new Error('Game canvas missing; the page files may be incomplete')
  let restoreTimer = 0
  let webglContextLost = false

  /*
    黑屏的常见元凶是 WebGL 上下文丢失（GPU 显存 / 内存压力）。
    preventDefault() 是为了让浏览器尝试 restore，不写就彻底没救；
    同时记进日志，免得现场只看到「黑了」却没有任何线索。
  */
  canvasEl?.addEventListener('webglcontextlost', (e) => {
    e.preventDefault()
    webglContextLost = true
    if (overlay) overlay.classList.remove('hidden')
    setPhase('WebGL context lost, attempting restore…')
    log('⚠️ WebGL context lost (usually GPU/memory pressure) — screen goes black', 'err')
    restoreTimer = setTimeout(() => showError(new Error('WebGL context not restored within 10s; reload the page to retry')), 10_000)
  })
  canvasEl?.addEventListener('webglcontextrestored', () => {
    clearTimeout(restoreTimer)
    webglContextLost = false
    log('WebGL context restored')
    // 超时已经进入终态后不能再把错误层藏回去，否则玩家又只剩黑屏。
    if (firstFrameReady && !failureReported && overlay) overlay.classList.add('hidden')
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
    ...(listenServer ? ['+maxplayers', '32'] : []),
    '+volume', '0.7', '+hud_scale', '2.5',
    '+exec', 'autoexec.cfg',
    // CS 必须选队伍才会 spawn；队伍选择 / 购买是 VGUI 菜单，显式开启。
    '+_vgui_menus', VGUI_MENUS,
    ...(listenServer && map ? ['+map', map] : []),
    ...(server ? ['+connect', `webxash3d.${server.netId}:${server.port}`] : []),
    ...(room?.role === 'guest' ? ['+connect', `webxash3d.${room.server.netId}:${room.server.port}`] : []),
  ]
  window.__probe.args = args
  window.__probe.info.mode = server ? 'server' : room ? `room-${room.role}` : 'practice'
  if (server) window.__probe.info.server = { id: server.id, name: server.name, map: server.map }
  if (room) {
    window.__probe.info.room = { code: room.code, role: room.role, map: room.map }
    const hud = $('hud')
    if (hud) hud.textContent = `ROOM ${room.code} · ${room.role === 'host' ? 'HOST' : 'PLAYER'}`
  }

  // 先取 14KB 清单并预热基础包/地图首片，让 R2 握手和引擎初始化并行。
  const wanted = ['base', `maps/${map}`]
  const packWarmup = FORCE_GZIP
    ? Promise.resolve(null)
    : prepareZstdPacks(wanted).catch((error) => {
        log(`⚠️ Zstd prewarm failed, will try fallback pack later: ${error}`, 'err')
        return null
      })
  // 这三份小资源原来都排在 60MB+ 公共包之后串行下载。现在与引擎/数据包并行，写盘顺序仍保持不变。
  const extrasPromise = fetchBytesWithRetry(`${LIB}/cstrike/extras.pk3?v=${ASSET_VERSION}`, 'cs16 client extras.pk3', { validate: isZip })
  const fontPromise = fetchBytesWithRetry(`${ASSET_ROOT}/gfx/fonts/FiraSans-Regular.ttf?v=${ASSET_VERSION}`, 'HUD font', { validate: isTtf })
  const botVisPromise = (listenServer ? loadBotVis(map) : Promise.resolve(null)).catch((error) => {
    log(`⚠️ YaPB visibility cache unavailable: ${error}`, 'err')
    return null
  })
  // 提前挂拒绝处理器，避免慢包写盘期间某个预取先失败而触发 unhandledrejection；真正错误仍在 await 时抛出。
  void extrasPromise.catch(() => {})
  void fontPromise.catch(() => {})

  const xash = new Xash3D({
    module: {
      arguments: args,
      // YaPB 是 GameDLL 代理层，必须由它再加载真正的 CS 服务端库。使用绝对 MEMFS 路径，
      // 避免 Xash/side-module 对当前工作目录认知不一致时误报“不支持 cstrike”。
      ENV: { XASH3D_GAMELIBPATH: `${BASE}cstrike/${GAME_SERVER_LIB}` },
      // 包装器的 xash.exited 只会在主动 quit() 时变化；WASM 自己 abort/exit 必须从 Emscripten 回调接住。
      onAbort: (reason) => reportEngineFailure(`Engine aborted: ${reason || 'unknown fatal error'}`),
      onExit: (status) => reportEngineFailure(`Engine exited unexpectedly (code ${status})`),
      print: (s) => { window.__probe.log.push(s); log(s) },
      printErr: (s) => { window.__probe.log.push('[err] ' + s); log('[err] ' + s, 'err') },
      locateFile,
    },
    canvas: canvasEl,
    libraries: LIBS_MAP,
  })
  if (server) {
    activeRelay = createCs16RelayNet(server, {
      onDisconnect: (message) => reportEngineFailure(message),
    })
    // runEm 在初始化 WASM 时读取 xash.net；晚到 init() 之后再赋值，网络 syscall 会永远回 -1。
    xash.net = activeRelay.net
  } else if (room) {
    activeRelay = createCs16RoomNet(room, room.role, {
      onDisconnect: (message) => reportEngineFailure(message),
      onStatus: (message) => setPhase(message),
    })
    // 房主也要挂虚拟 UDP，外部玩家的数据报才能进入浏览器里的监听服。
    xash.net = activeRelay.net
  }
  window.__probe.xash = xash
  // 保留包装器状态作为第二道兜底；真正的 WASM 退出由上面的 onAbort/onExit 接住。
  setInterval(() => {
    if (xash.exited && !window.__probe.exited) {
      window.__probe.exited = true
      reportEngineFailure('Engine exited unexpectedly')
    }
  }, 3000)

  await xash.init()
  mark('Engine initialized')
  await Promise.all([placeLibs(xash), packWarmup])
  mark('Engine libraries ready')

  // 公共运行时和当前地图分开，不能再把 300 多 MB 的其它地图写进 MEMFS 后才启动。
  window.__probe.info.packs = wanted
  let files = 0, raw = 0
  for (const pack of wanted) {
    const r = await loadPack(xash, pack)
    files += r.files; raw += r.bytes
    mark(`Wrote ${pack}`, `${r.files} files / ${(r.bytes / 1048576).toFixed(1)} MB raw`)
  }
  window.__probe.info.assetCount = files
  window.__probe.info.assetBytes = raw

  // extras.pk3 是 cstrike 的游戏包（含 YaPB 配置、导航图和语音），必须放进 cstrike/。
  // 放在 /rodir 根目录时 Xash 不会把它加入 cstrike 搜索路径，表面能进图但 Bot 永远找不到 graph。
  const extras = await extrasPromise
  xash.em.FS.mkdirTree(BASE + 'cstrike')
  xash.em.FS.writeFile(BASE + 'cstrike/extras.pk3', extras)
  mark('extras.pk3 ready')

  await loadHudFont(xash, fontPromise)
  ensureBinds(xash)
  if (listenServer) configureBots(xash, map, botCount, botDifficulty)
  const botVisReady = remoteClient ? true : restoreBotVis(xash, map, await botVisPromise)

  if (server || room) {
    setPhase(server ? `Connecting to ${server.name}…` : room.role === 'host' ? `Opening room ${room.code}…` : `Joining room ${room.code}…`)
    await activeRelay.connect()
    mark(room ? 'Room relay connected' : 'Server relay connected', room?.code || server.name)
  }

  xash.em.FS.chdir(BASE)
  xash.main()
  if (listenServer && !botVisReady) watchGeneratedBotVis(xash, map)
  mark('Engine main loop started')
  await waitForFirstFrame(canvasEl, xash)
  // YaPB 已完成 GameDLL/地图初始化；再次执行能保证最终数量严格等于启动页选择值。
  if (listenServer) {
    enforceBotCount(xash, botCount, botDifficulty)
    await autoJoinPlayer(xash)
  }
  if (engineFatalError) throw engineFatalError
  firstFrameReady = true
  mark('Game ready', server?.name || room?.code)
  if (overlay && !webglContextLost && !failureReported) overlay.classList.add('hidden')
}

function showError(e) {
  if (failureReported) return
  failureReported = true
  activeRelay?.close()
  const raw = String((e && e.stack) || e)
  // Emscripten 有些致命错误只 throw `Infinity`，真正原因只写在上一行控制台里。
  const engineReason = [...window.__probe.log].reverse().find((line) => /(?:host_|error|failed|couldn't|abort)/i.test(line))
  const msg = (e instanceof Error && e.message) || (engineReason ? `Engine failed to start: ${engineReason}` : raw)
  window.__probe.errors.push(msg)
  const overlay = $('overlay')
  overlay?.classList.remove('hidden', 'is-loading')
  showLauncherMode('practice')
  mark('Failed')
  const box = $('errbox'); if (box) box.textContent = 'ERROR · ' + msg
  const startButton = $('start')
  if (startButton) {
    startButton.disabled = false
    startButton.textContent = 'Reload'
    startButton.onclick = () => location.reload()
  }
  log('ERROR · ' + msg, 'err')
  console.error(e)
}

if (Q.has('room')) {
  showLauncherMode('servers')
  const input = $('room-code-input')
  if (input) input.value = String(Q.get('room') || '').toUpperCase()
  setConnectStatus('Loading the invited room…')
  findRoom(Q.get('room')).then((room) => start({ room: { ...room, role: 'guest' } })).catch(showError)
} else if (Q.has('server')) {
  showLauncherMode('servers')
  loadServerDirectory().then((servers) => {
    const server = servers.find((entry) => entry.id === Q.get('server'))
    if (!server) throw new Error('The server in this shared link does not exist or is not currently available')
    selectedServerId = server.id
    return start({ server })
  }).catch(showError)
} else if (Q.has('map')) {
  start().catch(showError)
} else {
  $('start')?.addEventListener('click', () => start().catch(showError))
}
