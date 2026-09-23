/*
 * CS1.5 / Half-Life（Xash3D-FWGS WASM）产品页加载器。
 * 资源全部走相对路径（本目录下的 engine/ lib/ packs/），所以放到 /web/cs15/ 即可运行，
 * 不依赖任何外部 CDN。照 PvZ 的方式接入：public/web/cs15/index.html + 本文件。
 *
 * 已知限制（来自 1.5 资产 + 1.6 wasm 模块的版本错配）：
 *   - 启动期已用 compatPatch() 补掉致命项（狙击镜贴图 + 本地化 + HUD 字体），CS1.5 可正常进图。
 *   - CS 必须选队伍（T/CT）才会 spawn：拿到刀/武器、激活 HUD 血量子弹、雷达与武器切换。
 *     CS1.5 资产没有 CS1.6 的完整 VGUI2 资源，所以默认用 `_vgui_menus 0` 的兼容菜单；
 *     同时本地监听服必须显式给出 maxplayers，否则两队都会报 team is full，玩家永远停在观察状态，
 *     表面上就像「刀、雷达和 slot 命令全坏了」。
 *   - 雷达依赖 overviews/<地图>.txt(+.bmp) 与 radar640.spr 的 radaropaque 帧；换基础包时必须
 *     在出生状态验收，观察视角本来就不会显示雷达，不能据此判断资源缺失。
 *
 * ⚠️ 2026-09-23 重新核对客户端 wasm：它实际导出了 `CHudAmmo::UserCmd_Slot1..10`、
 *   `CHudAmmo::SlotInput` 与 `g_weaponselect`，槽位实现没有在构建时丢失。此前无头测试虽然能移动
 *   观察视角，却一直没成功加入队伍；在没有 WeaponList/CurWeapon 状态时，SlotInput 会按设计
 *   直接返回。不要拿观察状态下画面不变作为客户端缺少 slot 实现的证据。
 */
import { Xash3D } from './engine/dist/index.js'
import { unpackStoredZipStream } from './zip-stream.js'

const BASE = '/rodir/'
// 资产版本号：换基础包 / 引擎后 bump 它，强制浏览器与 CDN 重新拉取。
// cs16-client 不会自己加缓存破坏版本号，但浏览器/边缘会把旧的 base.zip.gz 缓存住，
// 换包后不刷新就加载到旧资产（表现为地图或 HUD 异常）。改这一位即全局 cache-bust。
const ASSET_VERSION = '20260923-packs2'
const Q = new URLSearchParams(location.search)
// CS1.5 没有完整的 CS1.6 VGUI2 资源，默认用触屏/旧式菜单；保留 ?vgui=1 仅供排查。
const VGUI_MENUS = Q.get('vgui') || '0'
// 服务器 wasm 内置了 CZ Bot；默认自动加一个，?bots=0 才关闭。基础包没有默认地图的 nav，
// 首次运行由内置分析器生成并缓存到 IndexedDB，之后直接恢复，不必每次重新分析。
const BOTS_ENABLED = Q.get('bots') !== '0'
// 资产根目录：CS 页默认 '.'（相对本页），HL 独立页通过 ?root=../cs15/ 复用 cs15 的资源，
// 避免重复拷贝几百 MB 的 engine/lib/packs。解析为绝对 URL，兼容 dev 与线上。
// 必须从 document.baseURI 算：生产路由会把 `/web/cs15/` 规范化成无尾斜杠的 `/web/cs15`，
// 只看 location.href 会把相对资源误算到 `/web/`；页面里的 <base> 才是稳定目录锚点。
const PAGE_ROOT = new URL('./', document.baseURI)
const ASSET_ROOT = new URL(Q.get('root') || './', PAGE_ROOT).href.replace(/\/$/, '')
// 分组包放在 R2：生产环境默认走公开资产域，本地开发仍读本目录，?packsroot= 可临时覆盖。
// v2 主包是 Brotli 11 + HTTP Content-Encoding: br，浏览器网络层会原生流式解码成 store ZIP；
// 若 R2 元数据/代理配置错误，清单里的 gzip 包会自动兜底，不把玩家留在黑屏里。
const LOCAL_PACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])
const DEFAULT_PACKS_ROOT = LOCAL_PACK_HOSTS.has(location.hostname)
  ? ASSET_ROOT + '/packs'
  : 'https://assets.8bitgo.com/web/cs15/packs'
const PACKS_ROOT = (Q.get('packsroot')
  ? new URL(Q.get('packsroot'), PAGE_ROOT).href
  : DEFAULT_PACKS_ROOT).replace(/\/$/, '')

const MAP_OPTIONS = {
  cs: [
    ['de_dust2', 'de_dust2'],
    ['de_dust', 'de_dust'],
    ['cs_office', 'cs_office'],
  ],
  hl: [
    ['crossfire', 'crossfire'],
    ['boot_camp', 'boot_camp'],
    ['c0a0', 'c0a0（开篇）'],
    ['ofboot1', 'ofboot1（蓝色偏移）'],
  ],
}

const $ = (id) => document.getElementById(id)
const t0 = performance.now()
const marks = {}
window.__probe = { marks, log: [], errors: [], info: {}, xash: null, net: { total: 0, byUrl: {} } }
window.__probe.keys = []
// 键盘探针：确认数字键/字母键的按键事件到底有没有进到页面。
// 关游戏控制台后，在浏览器 devtools Console 里看 KEY 日志；同时最近 30 个键会存到 __probe.keys。
// 按 2/3 能看到 KEY 日志 → 按键进来了（问题在引擎内部 slot 命令）。
// 看不到 → 浏览器/页面把数字键吞了（焦点或某 handler 拦截）。
window.addEventListener('keydown', (e) => {
  const rec = { t: 'down', key: e.key, code: e.code, keyCode: e.keyCode, defaultPrevented: e.defaultPrevented }
  window.__probe.keys.push(rec)
  if (window.__probe.keys.length > 30) window.__probe.keys.shift()
  console.log('KEY', rec)
  // GoldSrc 对浏览器的小键盘映射并不稳定，直接在页面层接住两种“+”，保证和 PC 版手感一致。
  if (BOTS_ENABLED && activeLaunch?.game === 'cs' && (e.code === 'NumpadAdd' || e.key === '+')) {
    e.preventDefault()
    e.stopImmediatePropagation()
    window.__probe.xash?.Cmd_ExecuteString('bot_add')
    botLog('[bots] 已请求增加一个 Bot。')
  }
})
window.addEventListener('keyup', (e) => {
  const rec = { t: 'up', key: e.key, code: e.code, keyCode: e.keyCode }
  window.__probe.keys.push(rec)
  if (window.__probe.keys.length > 30) window.__probe.keys.shift()
  console.log('KEY', rec)
})

/* 网络字节记账：按 content-length 累加（gzip 后 = 真实传输字节） */
const origFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const res = await origFetch(input, init)
  try {
    const len = Number(res.headers.get('content-length') || 0)
    const url = (typeof input === 'string' ? input : input?.url || '').replace(/^https?:\/\/[^/]+/, '')
    window.__probe.net.total += len
    const key = url.split('?')[0]
    window.__probe.net.byUrl[key] = (window.__probe.net.byUrl[key] || 0) + len
  } catch { /* 不影响主流程 */ }
  return res
}

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
function botLog(message, cls) {
  window.__probe.log.push(message)
  log(message, cls)
}
function setPhase(text) {
  const p = $('phase'); if (p) p.textContent = text
  const n = $('net'); if (n) n.textContent = `已下载 ${(window.__probe.net.total / 1048576).toFixed(1)} MB`
  const bar = document.querySelector('#bar > i')
  // Brotli 主包 + 最大地图约 100MB；这是网络级估算，真实完成状态仍以逐文件 CRC 为准。
  if (bar) bar.style.width = Math.min(100, (window.__probe.net.total / 1048576 / 100) * 100).toFixed(1) + '%'
}

let missingNavWarned = false
function engineOutput(message, isError = false) {
  const text = String(message)
  // 服务器模块即使带 -nobots 也会在地图初始化时探测一次 nav，并把“没有可选机器人导航”
  // 打成 ERROR。它不影响真人/本地游戏，原样展示会让玩家误以为进图失败。
  if (/Failed to load .*\.nav.*navigation map/i.test(text) || /Navigation file not found/i.test(text)) {
    if (!missingNavWarned) {
      missingNavWarned = true
      const warning = BOTS_ENABLED
        ? '[bots] 首次运行正在生成机器人导航，通常约 20 秒；完成后会自动加入 Bot。'
        : '[bots] 当前地图没有机器人导航，机器人已停用；正常游戏不受影响。'
      window.__probe.info.bots = BOTS_ENABLED ? 'generating-nav' : 'disabled-missing-nav'
      botLog(warning)
    }
    return
  }
  const output = isError ? '[err] ' + text : text
  window.__probe.log.push(output)
  log(output, isError ? 'err' : undefined)
  if (BOTS_ENABLED && text.includes('Custom resource propagation complete.')) startAutomaticBot()
}

const ENGINE = ASSET_ROOT + '/engine/dist'
const locateFile = (path) => {
  const map = {
    'xash.wasm': `${ENGINE}/xash.wasm`,
    'filesystem_stdio.wasm': `${ENGINE}/filesystem_stdio.wasm`,
    'libref_webgl2.wasm': `${ENGINE}/libref_webgl2.wasm`,
    'libref_soft.wasm': `${ENGINE}/libref_soft.wasm`,
    'libmenu.wasm': `${ENGINE}/libmenu.wasm`,
    'libvgui_support.wasm': `${ENGINE}/libmenu.wasm`,
    'cl_dlls/menu_emscripten_wasm32.wasm': ASSET_ROOT + '/lib/cstrike/cl_dlls/menu_emscripten_wasm32.wasm',
    'cl_dlls/client_emscripten_wasm32.wasm': ASSET_ROOT + '/lib/cstrike/cl_dlls/client_emscripten_wasm32.wasm',
    'dlls/cs_emscripten_wasm32.wasm': ASSET_ROOT + '/lib/cstrike/dlls/cs_emscripten_wasm32.wasm',
    'dlls/mp_emscripten_wasm32.wasm': ASSET_ROOT + '/lib/cstrike/dlls/cs_emscripten_wasm32.wasm',
    'dlls/yapb_emscripten_wasm32.wasm': ASSET_ROOT + '/lib/cstrike/dlls/yapb_emscripten_wasm32.wasm',
    'dlls/hl_emscripten_wasm32.wasm': ASSET_ROOT + '/lib/valve/dlls/hl_emscripten_wasm32.wasm',
    'dlls/bshift_emscripten_wasm32.wasm': ASSET_ROOT + '/lib/valve/dlls/hl_emscripten_wasm32.wasm',
    'dlls/opfor_emscripten_wasm32.wasm': ASSET_ROOT + '/lib/valve/dlls/hl_emscripten_wasm32.wasm',
  }
  if (map[path]) return map[path]
  if (path.startsWith('/')) return path
  return `${ENGINE}/${path}`
}

/* 只取当前游戏需要的游戏端模块（修掉 probe 里 CS 误下 HL 模块的问题）。
 * 不能在模块加载时根据下拉框生成：用户改完模式再点开始时，旧实现仍然使用页面初始值。 */
function libFilesFor(libs) {
  const files = {
    'xash.wasm': `${ENGINE}/xash.wasm`,
    'filesystem_stdio.wasm': `${ENGINE}/filesystem_stdio.wasm`,
    'libref_webgl2.wasm': `${ENGINE}/libref_webgl2.wasm`,
    'libref_soft.wasm': `${ENGINE}/libref_soft.wasm`,
  }
  if (libs === 'hl') {
    return Object.assign(files, {
      'cl_dlls/menu_emscripten_wasm32.wasm': `${ENGINE}/libmenu.wasm`,
      'cl_dlls/client_emscripten_wasm32.wasm': ASSET_ROOT + '/lib/valve/cl_dlls/client_emscripten_wasm32.wasm',
      'dlls/hl_emscripten_wasm32.wasm': ASSET_ROOT + '/lib/valve/dlls/hl_emscripten_wasm32.wasm',
    })
  }
  return Object.assign(files, {
    'cl_dlls/menu_emscripten_wasm32.wasm': ASSET_ROOT + '/lib/cstrike/cl_dlls/menu_emscripten_wasm32.wasm',
    'cl_dlls/client_emscripten_wasm32.wasm': ASSET_ROOT + '/lib/cstrike/cl_dlls/client_emscripten_wasm32.wasm',
    'dlls/cs_emscripten_wasm32.wasm': ASSET_ROOT + '/lib/cstrike/dlls/cs_emscripten_wasm32.wasm',
    'dlls/mp_emscripten_wasm32.wasm': ASSET_ROOT + '/lib/cstrike/dlls/cs_emscripten_wasm32.wasm',
  })
}

const LIBS_MAP = {
  cs: {
    filesystem: `${ENGINE}/filesystem_stdio.wasm`, xash: `${ENGINE}/xash.wasm`,
    menu: ASSET_ROOT + '/lib/cstrike/cl_dlls/menu_emscripten_wasm32.wasm',
    client: ASSET_ROOT + '/lib/cstrike/cl_dlls/client_emscripten_wasm32.wasm',
    server: ASSET_ROOT + '/lib/cstrike/dlls/cs_emscripten_wasm32.wasm',
    render: { gl4es: `${ENGINE}/libref_webgl2.wasm`, gles3compat: `${ENGINE}/libref_webgl2.wasm`, soft: `${ENGINE}/libref_soft.wasm` },
  },
  hl: {
    filesystem: `${ENGINE}/filesystem_stdio.wasm`, xash: `${ENGINE}/xash.wasm`,
    menu: `${ENGINE}/libmenu.wasm`,
    client: ASSET_ROOT + '/lib/valve/cl_dlls/client_emscripten_wasm32.wasm',
    server: ASSET_ROOT + '/lib/valve/dlls/hl_emscripten_wasm32.wasm',
    render: { gl4es: `${ENGINE}/libref_webgl2.wasm`, gles3compat: `${ENGINE}/libref_webgl2.wasm`, soft: `${ENGINE}/libref_soft.wasm` },
  },
}

async function placeLibs(xash, libFiles) {
  for (const [name, url] of Object.entries(libFiles)) {
    const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'v=' + ASSET_VERSION)
    if (!res.ok) { log(`⚠️ 取不到 ${name}（HTTP ${res.status}）`, 'err'); continue }
    const buf = new Uint8Array(await res.arrayBuffer())
    for (const dir of ['/', BASE]) {
      const full = dir + name
      const cut = full.lastIndexOf('/')
      if (cut > 0) xash.em.FS.mkdirTree(full.slice(0, cut))
      xash.em.FS.writeFile(full, buf)
    }
  }
}

function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

function isZip(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

/** 把探测格式时先读出的首块重新放回流里。 */
function prependChunk(head, reader) {
  return new ReadableStream({
    start(controller) { controller.enqueue(head) },
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) controller.close()
      else controller.enqueue(value)
    },
    cancel(reason) { return reader.cancel(reason) },
  })
}

/** 读取至少 4 字节再判格式，不能假定网络首块一定大于 ZIP 魔数。 */
async function readStreamHead(reader) {
  const parts = []
  let length = 0
  while (length < 4) {
    const next = await reader.read()
    if (next.done) break
    if (next.value?.length) {
      parts.push(next.value)
      length += next.value.length
    }
  }
  const head = new Uint8Array(length)
  let at = 0
  for (const part of parts) { head.set(part, at); at += part.length }
  return head
}

function safePackObject(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ? value : null
}

function packPlan(index, game, map) {
  if (index?.schema === 2 && index.profiles?.[game] && index.packs) {
    const profile = index.profiles[game]
    const keys = [profile.base, profile.maps?.[map]].filter(Boolean)
    return keys.map((key) => {
      const item = index.packs[key]
      const file = safePackObject(item?.file)
      const fallback = item?.fallback ? safePackObject(item.fallback) : null
      if (!file) throw new Error(`资源索引里的 ${key} 文件名无效`)
      return {
        name: key,
        file,
        fallback,
        files: Number.isSafeInteger(item.files) ? item.files : undefined,
        bytes: Number.isSafeInteger(item.bytes) ? item.bytes : undefined,
      }
    })
  }

  // 兼容尚未重新打包的部署：旧 index.json 的统计曾经失真，所以这里只认文件名、不拿它限大小。
  const legacy = [{ name: 'base.zip', file: 'base.zip.gz' }]
  if (index?.maps?.[map]) legacy.push({ name: `map-${map}.zip`, file: `map-${map}.zip.gz` })
  return legacy
}

async function openPackStream(file, packName) {
  const res = await fetch(`${PACKS_ROOT}/${file}?v=${encodeURIComponent(ASSET_VERSION)}`)
  if (!res.ok) throw new Error(`取不到 ${packName}（HTTP ${res.status}）`)
  if (!res.body) throw new Error('当前浏览器不支持流式读取，无法安全加载大型资源包')

  const reader = res.body.getReader()
  const head = await readStreamHead(reader)
  if (!head.length) throw new Error(`${packName} 是空文件`)
  let stream = prependChunk(head, reader)
  if (isGzip(head)) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前浏览器不支持 gzip 流式解压，请升级 Chrome、Edge 或 Safari')
    }
    stream = stream.pipeThrough(new DecompressionStream('gzip'))
  } else if (!isZip(head)) {
    await reader.cancel().catch(() => {})
    if (file.endsWith('.br')) {
      throw new Error(`${file} 没有被浏览器解成 ZIP；请给 R2 对象设置 Content-Encoding: br`)
    }
    throw new Error(`${file} 既不是 store ZIP，也不是 gzip`)
  }
  return stream
}

async function loadPack(xash, pack) {
  let stream
  try {
    stream = await openPackStream(pack.file, pack.name)
  } catch (primaryError) {
    if (!pack.fallback) throw primaryError
    log(`⚠️ ${pack.name} 的 Brotli 主包不可用，改用 gzip 兜底`, 'err')
    stream = await openPackStream(pack.fallback, `${pack.name}（gzip 兜底）`)
  }

  const FS = xash.em.FS
  return unpackStoredZipStream(stream, {
    mkdir(name) { FS.mkdirTree(BASE + name) },
    open(name) {
      const full = BASE + name
      const cut = full.lastIndexOf('/')
      if (cut > 0) FS.mkdirTree(full.slice(0, cut))
      const target = FS.open(full, 'w')
      return {
        write(part) {
          const written = FS.write(target, part, 0, part.length)
          if (written !== part.length) throw new Error(`${name} 只写入 ${written}/${part.length} 字节`)
        },
        close() { FS.close(target) },
      }
    },
  }, pack)
}

/* ---------------------------------------------------------------------------
 * CS16 兼容补丁 —— cs16-client（1.6 代码的 wasm 模块）启动时硬性要求几个
 * CS1.6 才有的小文件，1.5 资产里没有。缺它们的症状：
 *   - sprites/scope_arc*.tga：进图时 Host_Error「Cannot load Sniper Scope arcs」，
 *     服务器被直接杀掉（这里是 Training Room / +map 进图崩溃的直接死因）。
 *   - resource/*_english.txt：菜单/本地化全是 GameUI_* 原始 token。
 * 狙击镜贴图就是「黑色遮罩、角上挖一个透明四分之一圆」的 TGA，直接运行时合成，
 * 不用下载任何 1.6 资产。这只是让 1.5 资产能通过 1.6 模块的启动检查；
 * 协议层若仍不匹配（svc_bad），则必须换 1.6 资产，见文件头「已知限制」。
 * ------------------------------------------------------------------------- */
function makeScopeTga(corner) {
  // corner = 透明圆孔位于贴图的哪个角（'tl'/'tr'/'bl'/'br'），对应它被拉伸到
  // 屏幕哪个象限：screen 中心永远落在贴图的那个角上（见 cs16-client sniperscope.cpp）。
  const W = 64, H = 64, R = 40
  const buf = new Uint8Array(18 + W * H * 4)
  const dv = new DataView(buf.buffer)
  dv.setUint16(12, W, true); dv.setUint16(14, H, true)
  buf[2] = 2        // 未压缩 true-color
  buf[16] = 32      // 32bpp
  buf[17] = 0x28    // 顶部为第一行(0x20) + 8 位 alpha(0x08)
  const cx = corner[1] === 'l' ? 0 : W - 1
  const cy = corner[0] === 't' ? 0 : H - 1
  let p = 18
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // TGA 像素是 BGRA；黑遮罩 alpha=255，圆孔 alpha=0
      buf[p + 3] = Math.hypot(x - cx, y - cy) < R ? 0 : 255
      p += 4
    }
  }
  return buf
}

const COMPAT_TXT = (tokens) => `"lang"\n{\n"Language" "english"\n"Tokens"\n{\n${tokens}}\n}\n`
// GameUI 主菜单那几个 token 的原文取自 cs16-client GameUI 源码里 Localize 的 key
const COMPAT_RESOURCE = {
  'gameui_english.txt': COMPAT_TXT([
    '"GameUI_Console"\t\t"Console"',
    '"GameUI_TrainingRoom"\t"Training Room"',
    '"GameUI_Options"\t\t"Options"',
    '"GameUI_LoadGame"\t\t"Load Game"',
    '"GameUI_Multiplayer"\t"Multiplayer"',
    '"GameUI_ChangeGame"\t\t"Change Game"',
    '"GameUI_StartNewGame"\t"New Game"',
    '"GameUI_GameMenu_Quit"\t"Quit"',
    '"GameUI_CreateServer"\t"Create Server"',
    '"GameUI_FindServers"\t"Find Servers"',
    '"GameUI_SpectateGame"\t"Spectate"',
    '"GameUI_PlayerList"\t\t"Player List"',
  ].join('\n')),
  'valve_english.txt': COMPAT_TXT(''),
  'cstrike_english.txt': COMPAT_TXT(''),
  'mainui_english.txt': COMPAT_TXT(''),
}

function compatPatch(xash) {
  const FS = xash.em.FS
  FS.mkdirTree(BASE + 'cstrike/sprites')
  // 象限→圆孔角：scope_arc=右下、_ne=右上、_nw=左上、_sw=左下
  for (const [f, corner] of [
    ['scope_arc', 'tl'], ['scope_arc_ne', 'bl'], ['scope_arc_nw', 'br'], ['scope_arc_sw', 'tr'],
  ]) {
    FS.writeFile(`${BASE}cstrike/sprites/${f}.tga`, makeScopeTga(corner))
  }
  FS.mkdirTree(BASE + 'cstrike/resource')
  // 仅当 1.6 资产里已经缺这个本地化文件时才补（CS1.6 自带真实 resource/，不能被占位文件覆盖）。
  for (const [f, text] of Object.entries(COMPAT_RESOURCE)) {
    const p = `${BASE}cstrike/resource/${f}`
    if (!FS.analyzePath(p).exists) FS.writeFile(p, new TextEncoder().encode(text))
  }
  return loadHudFont(xash)
}

/* 数字键 → 武器槽位绑定。cs16-client 默认 config 不绑数字键（Q/lastinv 是引擎内置所以能用），
 * 且命令行 +bind 会被引擎启动时 exec 的 config.cfg 覆盖。autoexec.cfg 在 config 之后执行，
 * 引擎会自动 exec 它，这里写进虚拟文件系统、再用 +exec 强制跑一次，确保绑定生效。 */
async function ensureBinds(xash) {
  const FS = xash.em.FS
  const cfg = [
    // 诊断探针：若 __probe.log 里出现这行，说明 autoexec.cfg 已被引擎执行（绑定机制本身没问题）。
    'echo "AUTOEXEC_LOADED"',
    // 客户端 wasm 已确认导出 SlotInput/UserCmd_Slot1..10；玩家出生、收到 WeaponList 后这些绑定才生效。
    'bind 1 slot1', 'bind 2 slot2', 'bind 3 slot3',
    'bind 4 slot4', 'bind 5 slot5', 'bind 6 slot6',
    // hud_fastswitch 1 = 按数字键直接切换武器；0 会先弹选择菜单且不立即换，
    // 表现像「按 2/3 没反应」。CS 默认是 0，这里强制改成直接切换。
    'hud_fastswitch 1',
    // 诊断别名：游戏控制台输不了下划线，用短命令代替
    'alias fs hud_fastswitch',
    'alias vm0 "_vgui_menus 0"',
    'alias vm1 "_vgui_menus 1"',
    'alias in invnext',
    'alias ip invprev',
    'alias li lastinv',
    'alias dv developer 1',
    // 页面层还会接住 NumpadAdd / Shift+=；这里保留引擎原生绑定，方便实体键盘和控制台使用。
    'bind KP_PLUS bot_add',
    'alias addbot bot_add',
    'alias delbot bot_kick',
  ].join('\n') + '\n'
  const buf = new TextEncoder().encode(cfg)
  for (const dir of ['', 'cstrike/', 'valve/']) {
    try { FS.writeFile(BASE + dir + 'autoexec.cfg', buf) } catch { /* 目录可能不存在，忽略 */ }
  }
  mark('键位绑定就位 (autoexec.cfg)')
}

/* cs16-client 的 HUD 数字/血量/文字是用 TTF 字体（gfx/fonts/）渲染的，CS1.5 资产里没有，
 * 缺了就只看到空 HUD。FiraSans 是 cs16-client 自带的开源（OFL）字体，单独随站点分发。 */
async function loadHudFont(xash) {
  const FS = xash.em.FS
  try {
    const res = await fetch(ASSET_ROOT + '/gfx/fonts/FiraSans-Regular.ttf')
    if (!res.ok) { log('⚠️ 取不到 HUD 字体（HTTP ' + res.status + '）', 'err'); return }
    const buf = new Uint8Array(await res.arrayBuffer())
    // cs16-client 的菜单/HUD 字体加载同时请求 gfx/fonts/FiraSans-Regular.ttf 与 gfx/fonts/tahoma.ttf
    // （见 menu wasm 字面量）。1.5/1.6 资产都不带 tomahawk.ttf，缺失会让 HUD 数字/文字所在的 Tahoma
    // 字体槽加载失败 → 整个 HUD 空白。站点只分发 FiraSans（OFL 开源），故用同一份内容补齐 tomahawk.ttf。
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

const BOT_NAV_DB = '8bitgo-cs15-bot-nav'
const BOT_NAV_STORE = 'maps'
let activeLaunch = null
let automaticBotRequested = false

function openBotNavDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    const request = indexedDB.open(BOT_NAV_DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(BOT_NAV_STORE)
    request.onsuccess = () => resolve(request.result)
    // 隐私模式禁用 IndexedDB 时仍能玩，只是下次要重新生成导航。
    request.onerror = () => resolve(null)
  })
}

async function readBotNavCache(map) {
  const db = await openBotNavDb()
  if (!db) return null
  return new Promise((resolve) => {
    const request = db.transaction(BOT_NAV_STORE, 'readonly').objectStore(BOT_NAV_STORE).get(`${ASSET_VERSION}:${map}`)
    request.onsuccess = () => {
      const value = request.result
      resolve(value ? new Uint8Array(value) : null)
      db.close()
    }
    request.onerror = () => { resolve(null); db.close() }
  })
}

async function writeBotNavCache(map, bytes) {
  const db = await openBotNavDb()
  if (!db) return false
  return new Promise((resolve) => {
    const tx = db.transaction(BOT_NAV_STORE, 'readwrite')
    // readFile 返回的视图可能挂在整个 wasm 内存上，必须 slice 后再交给 IndexedDB。
    tx.objectStore(BOT_NAV_STORE).put(bytes.slice().buffer, `${ASSET_VERSION}:${map}`)
    tx.oncomplete = () => { resolve(true); db.close() }
    tx.onerror = () => { resolve(false); db.close() }
    tx.onabort = () => { resolve(false); db.close() }
  })
}

async function restoreBotNav(xash, map) {
  const path = `${BASE}cstrike/maps/${map}.nav`
  if (xash.em.FS.analyzePath(path).exists) {
    window.__probe.info.botNav = 'pack'
    return true
  }
  const bytes = await readBotNavCache(map)
  if (!bytes || bytes.length < 1024) return false
  xash.em.FS.mkdirTree(`${BASE}cstrike/maps`)
  xash.em.FS.writeFile(path, bytes)
  window.__probe.info.botNav = 'cache'
  botLog(`[bots] 已恢复 ${map}.nav（${(bytes.length / 1024).toFixed(0)} KB）。`)
  return true
}

function watchGeneratedBotNav(xash, map) {
  const path = `${BASE}cstrike/maps/${map}.nav`
  const deadline = performance.now() + 120000
  const timer = setInterval(async () => {
    const found = xash.em.FS.analyzePath(path)
    if (found.exists && xash.em.FS.stat(path).size >= 1024) {
      clearInterval(timer)
      const bytes = xash.em.FS.readFile(path)
      const saved = await writeBotNavCache(map, bytes)
      window.__probe.info.botNav = saved ? 'generated-cached' : 'generated-memory-only'
      window.__probe.info.bots = 'ready'
      botLog(saved
        ? `[bots] ${map}.nav 已生成并缓存；以后进入该地图会直接加载。`
        : `[bots] ${map}.nav 已生成，但浏览器拒绝持久缓存；本局仍可正常使用。`)
      return
    }
    if (performance.now() >= deadline) {
      clearInterval(timer)
      botLog('[bots] 导航生成超过 120 秒，自动加 Bot 已停止；正常游戏不受影响。', 'err')
    }
  }, 1000)
}

function startAutomaticBot() {
  if (automaticBotRequested || activeLaunch?.game !== 'cs') return
  const xash = window.__probe.xash
  if (!xash) return
  automaticBotRequested = true
  // 等本次引擎日志回调退栈再执行命令；同步重入服务器回调会让部分旧 GameDLL 丢命令。
  setTimeout(() => {
    xash.Cmd_ExecuteString('bot_join_after_player 1')
    xash.Cmd_ExecuteString('bot_auto_vacate 1')
    xash.Cmd_ExecuteString('bot_add')
    window.__probe.info.bots = activeLaunch.botNavReady ? 'joining' : 'generating-nav'
    botLog('[bots] 已自动请求加入一个 Bot；按 + 可继续增加。')
    if (!activeLaunch.botNavReady) watchGeneratedBotNav(xash, activeLaunch.map)
  }, 0)
}

function readLaunchOptions() {
  const game = Q.get('game') || $('game')?.value || 'cs'
  const map = Q.get('map') || $('map')?.value || (game === 'hl' ? 'crossfire' : 'de_dust2')
  const libs = Q.get('libs') || (game === 'hl' ? 'hl' : 'cs')
  if (!LIBS_MAP[libs]) throw new Error(`不支持的运行库：${libs}`)
  return { game, map, libs }
}

function syncMapOptions(preferredMap) {
  const gameSelect = $('game')
  const mapSelect = $('map')
  if (!gameSelect || !mapSelect) return
  const options = MAP_OPTIONS[gameSelect.value] || MAP_OPTIONS.cs
  const wanted = preferredMap || mapSelect.value
  mapSelect.replaceChildren(...options.map(([value, label]) => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    return option
  }))
  if (options.some(([value]) => value === wanted)) mapSelect.value = wanted
}

let startRequested = false
async function start() {
  // 一次启动会下载并展开数百 MB；双击按钮不能再造第二个引擎和第二份资源树。
  if (startRequested) return
  startRequested = true
  const { game, map, libs } = readLaunchOptions()
  activeLaunch = { game, map, libs, botNavReady: false }
  for (const id of ['start', 'game', 'map']) {
    const control = $(id)
    if (control) control.disabled = true
  }
  const overlay = $('overlay'); if (overlay) overlay.classList.remove('hidden')
  const args = [
    '-windowed', '-console', '-ref', 'webgl2',
    '-game', game === 'hl' ? 'valve' : 'cstrike',
    // `+map` 会直接拉起本地监听服。若不先扩大 maxplayers，唯一客户端会把服务器槽位占满，
    // CS 的队伍检查随后把 T/CT 都判成 team is full，玩家只能停在无刀、无雷达的观察状态。
    ...(game === 'hl' ? [] : [...(BOTS_ENABLED ? [] : ['-nobots']), '+maxplayers', '8']),
    '+volume', '0', '+hud_scale', '2.5',
    // 数字键绑定与 hud_fastswitch 改由 autoexec.cfg 负责（见 ensureBinds）：
    // 命令行 +bind 会被引擎启动时 exec 的 config.cfg 覆盖（config 在 + 命令之后执行），
    // 而 autoexec.cfg 在 config 之后执行，绑定才真正生效。Q(lastinv) 能切枪说明切换机制本身正常。
    '+exec', 'autoexec.cfg',
    // CS1.5 资产缺 CS1.6 的完整 VGUI2 菜单，默认走兼容菜单；HL 同样保持关闭。
    '+_vgui_menus', game === 'hl' ? '0' : VGUI_MENUS,
    ...(map ? ['+map', map] : []),
  ]
  window.__probe.args = args
  window.__probe.info.launch = activeLaunch

  const xash = new Xash3D({
    module: {
      arguments: args,
      print: (s) => engineOutput(s),
      printErr: (s) => engineOutput(s, true),
      locateFile,
    },
    canvas: $('canvas'),
    libraries: LIBS_MAP[libs],
  })
  window.__probe.xash = xash

  await xash.init()
  mark('引擎初始化完成')
  await placeLibs(xash, libFilesFor(libs))
  mark('引擎动态库就位')

  // index.json 很小且负责把内容哈希文件名指向当前版本；禁止浏览器拿旧清单拼新代码。
  const indexResponse = await fetch(PACKS_ROOT + '/index.json?v=' + ASSET_VERSION, { cache: 'no-store' })
  if (!indexResponse.ok) throw new Error(`取不到资源索引（HTTP ${indexResponse.status}）`)
  const index = await indexResponse.json()
  window.__probe.info.packIndex = index
  const wanted = packPlan(index, game, map)
  if (wanted.length === 1 && game !== 'hl') log(`（没有 ${map} 的独立地图包，图在基础包内）`)
  window.__probe.info.packs = wanted.map((pack) => pack.file)

  let files = 0, raw = 0
  for (const pack of wanted) {
    const r = await loadPack(xash, pack)
    files += r.files; raw += r.bytes
    mark(`写入 ${pack.name}`, `${r.files} 个文件 / ${(r.bytes / 1048576).toFixed(1)} MB 原始`)
  }
  window.__probe.info.assetCount = files
  window.__probe.info.assetBytes = raw

  if (game === 'cs' && BOTS_ENABLED) {
    activeLaunch.botNavReady = await restoreBotNav(xash, map)
  }

  const extrasUrl = game === 'hl' ? `${ENGINE}/valve/extras.pk3` : ASSET_ROOT + '/lib/cstrike/extras.pk3'
  const extras = await fetch(extrasUrl + '?v=' + ASSET_VERSION)
  if (!extras.ok) throw new Error(`取不到 extras.pk3（HTTP ${extras.status}）`)
  xash.em.FS.writeFile(BASE + 'extras.pk3', new Uint8Array(await extras.arrayBuffer()))
  mark('extras.pk3 就位')

  if (game !== 'hl') {
    await compatPatch(xash)
    mark('CS16 兼容补丁')
  }
  await ensureBinds(xash)

  xash.em.FS.chdir(BASE)
  xash.main()
  mark('引擎主循环启动')
  if (overlay) setTimeout(() => overlay.classList.add('hidden'), 1200)
}

function showError(e) {
  const msg = String((e && e.stack) || e)
  window.__probe.errors.push(msg)
  mark('失败')
  const box = $('errbox'); if (box) box.textContent = '❌ ' + (e && e.message ? e.message : msg) + '\n请刷新页面后重试。'
  log('❌ ' + (e && e.message ? e.message : msg), 'err')
  console.error(e)
}

const gameSelect = $('game')
if (gameSelect) {
  const queryGame = Q.get('game')
  if (queryGame && [...gameSelect.options].some((option) => option.value === queryGame)) {
    gameSelect.value = queryGame
  }
  syncMapOptions(Q.get('map'))
  gameSelect.addEventListener('change', () => syncMapOptions())
}

// 允许 ?game/&map 直开，也允许页面上的「开始」按钮
if (Q.has('game') || Q.has('map')) {
  start().catch(showError)
} else {
  $('start')?.addEventListener('click', () => start().catch(showError), { once: true })
}
