/*
 * CS1.6（Xash3D-FWGS WASM）产品页加载器。
 *
 * 资产全部走相对路径：本目录下的 packs/ 放「完整 CS1.6 基础包」（cstrike + valve + 全部地图），
 * 引擎与 cs16-client wasm 复用 cs15 的（通过 ?root 默认 ../cs15/，二者同源部署）。
 * 这套加载方式不依赖任何外部 CDN，照 PvZ / cs15 的接入形态：public/web/cs16/index.html + 本文件。
 *
 * 与 cs15 页的区别：cs15 用的是「CS1.5 资产 + 1.6 wasm 客户端」（版本错配，进图/菜单受限）；
 * 本页资产是 SteamCMD 拉取的**完整 CS1.6**（cstrike + valve + 全部 .bsp 地图），所以 VGUI 队伍菜单、
 * 雷达 overviews、本地化、狙击镜都齐全，进图即真 1.6。原生 SyPB 的 Windows DLL 在浏览器里加载不了，
 * 机器人改由仓库自带的 yapb wasm（lib/cstrike/dlls/yapb_emscripten_wasm32.wasm）提供，控制台 bot_add 加 bot。
 *
 * 资产版本号：换基础包后 bump ASSET_VERSION，强制浏览器与边缘重新拉取。
 */
const BASE = '/rodir/'
const ASSET_VERSION = '20260922'
const Q = new URLSearchParams(location.search)
const GAME = Q.get('game') || 'cs'
const MAP = Q.get('map') || (document.getElementById('map')?.value || 'de_dust2')
// 资产根目录：默认 ../cs15/ 复用同源部署的引擎与 cs16-client wasm，避免重复几百 MB 引擎文件。
// 也可 ?root=../cs15/ 显式指定；HL 独立页同理复用。
const ASSET_ROOT = Q.get('root') ? new URL(Q.get('root'), location.href).href : '../cs15/'
// 分组包（base.zip.gz 约数百 MB，占整车体积 99%）独立来源，用于挪到 R2/对象存储。
// 例：?packsroot=https://pub-xxx.r2.dev/web/cs16/packs
const PACKS_ROOT = Q.get('packsroot') ? new URL(Q.get('packsroot'), location.href).href : './packs'

const $ = (id) => document.getElementById(id)
const t0 = performance.now()
const marks = {}
window.__probe = { marks, log: [], errors: [], info: {}, xash: null, net: { total: 0, byUrl: {} } }
window.__probe.keys = []

window.addEventListener('keydown', (e) => {
  const rec = { t: 'down', key: e.key, code: e.code, keyCode: e.keyCode, defaultPrevented: e.defaultPrevented }
  window.__probe.keys.push(rec)
  if (window.__probe.keys.length > 30) window.__probe.keys.shift()
  console.log('KEY', rec)
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
function setPhase(text) {
  const p = $('phase'); if (p) p.textContent = text
  const n = $('net'); if (n) n.textContent = `已下载 ${(window.__probe.net.total / 1048576).toFixed(1)} MB`
  const bar = document.querySelector('#bar > i')
  if (bar) {
    // 基础包约 600MB：用已下载/650 估进度，仅展示用
    const mb = window.__probe.net.total / 1048576
    bar.style.width = Math.min(100, (mb / 650) * 100).toFixed(1) + '%'
  }
}

/* 极简 store 模式 ZIP 读取：资产包是 zip -0（store）后再 gzip，loader 先解 gzip 再解析这里 */
function readStoredZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const td = new TextDecoder()
  let eocd = -1
  const floor = Math.max(0, buf.length - 22 - 65535)
  for (let i = buf.length - 22; i >= floor; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是 zip：找不到 EOCD')
  const count = dv.getUint16(eocd + 10, true)
  let off = dv.getUint32(eocd + 16, true)
  const out = []
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('中央目录损坏')
    const method = dv.getUint16(off + 10, true)
    const size = dv.getUint32(off + 24, true)
    const nameLen = dv.getUint16(off + 28, true)
    const extraLen = dv.getUint16(off + 30, true)
    const commentLen = dv.getUint16(off + 32, true)
    const localOff = dv.getUint32(off + 42, true)
    const name = td.decode(buf.subarray(off + 46, off + 46 + nameLen))
    if (dv.getUint32(localOff, true) !== 0x04034b50) throw new Error('本地头损坏')
    const dataOff = localOff + 30 + dv.getUint16(localOff + 26, true) + dv.getUint16(localOff + 28, true)
    if (method !== 0) throw new Error(`分组包必须是 store 模式：${name}`)
    if (!name.endsWith('/')) out.push([name, buf.subarray(dataOff, dataOff + size)])
    off += 46 + nameLen + extraLen + commentLen
  }
  return out
}

const ENGINE = ASSET_ROOT + '/engine/dist'
// 动态 import 引擎模块（通过 import.meta.url 解析，兼容 ?root 指向 cs15 的情况），无需打包步骤。
async function loadEngine() {
  const url = new URL(ENGINE + '/index.js', import.meta.url).href
  const mod = await import(url)
  return mod.Xash3D
}

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

/* 只取当前游戏需要的游戏端模块 */
const LIB_FILES = {
  'xash.wasm': `${ENGINE}/xash.wasm`,
  'filesystem_stdio.wasm': `${ENGINE}/filesystem_stdio.wasm`,
  'libref_webgl2.wasm': `${ENGINE}/libref_webgl2.wasm`,
  'libref_soft.wasm': `${ENGINE}/libref_soft.wasm`,
}
Object.assign(LIB_FILES, {
  'cl_dlls/menu_emscripten_wasm32.wasm': ASSET_ROOT + '/lib/cstrike/cl_dlls/menu_emscripten_wasm32.wasm',
  'cl_dlls/client_emscripten_wasm32.wasm': ASSET_ROOT + '/lib/cstrike/cl_dlls/client_emscripten_wasm32.wasm',
  'dlls/cs_emscripten_wasm32.wasm': ASSET_ROOT + '/lib/cstrike/dlls/cs_emscripten_wasm32.wasm',
  'dlls/mp_emscripten_wasm32.wasm': ASSET_ROOT + '/lib/cstrike/dlls/cs_emscripten_wasm32.wasm',
  'dlls/yapb_emscripten_wasm32.wasm': ASSET_ROOT + '/lib/cstrike/dlls/yapb_emscripten_wasm32.wasm',
})

const LIBS_MAP = {
  cs: {
    filesystem: `${ENGINE}/filesystem_stdio.wasm`, xash: `${ENGINE}/xash.wasm`,
    menu: ASSET_ROOT + '/lib/cstrike/cl_dlls/menu_emscripten_wasm32.wasm',
    client: ASSET_ROOT + '/lib/cstrike/cl_dlls/client_emscripten_wasm32.wasm',
    server: ASSET_ROOT + '/lib/cstrike/dlls/cs_emscripten_wasm32.wasm',
    render: { gl4es: `${ENGINE}/libref_webgl2.wasm`, gles3compat: `${ENGINE}/libref_webgl2.wasm`, soft: `${ENGINE}/libref_soft.wasm` },
  },
}

async function placeLibs(xash) {
  for (const [name, url] of Object.entries(LIB_FILES)) {
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

async function loadPack(xash, file) {
  const res = await fetch(PACKS_ROOT + '/' + file + '.gz?v=' + ASSET_VERSION)
  if (!res.ok) throw new Error(`取不到分组包 ${file}（HTTP ${res.status}）`)
  let buf = new Uint8Array(await res.arrayBuffer())
  if (file.endsWith('.zip') && typeof DecompressionStream !== 'undefined') {
    const ds = new DecompressionStream('gzip')
    buf = new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer())
  }
  const entries = readStoredZip(buf)
  let bytes = 0
  for (const [name, data] of entries) {
    const full = BASE + name
    const cut = full.lastIndexOf('/')
    if (cut > 0) xash.em.FS.mkdirTree(full.slice(0, cut))
    xash.em.FS.writeFile(full, data)
    bytes += data.length
  }
  return { files: entries.length, bytes }
}

/* ---------------------------------------------------------------------------
 * CS16 兼容补丁：完整 CS1.6 资产下大部分项已存在，这里只补确实缺失的。
 *   - sprites/scope_arc*.tga：cs16-client 进图硬性要的狙击镜贴图，真实资产不一定带。
 *   - resource/*_english.txt：菜单/本地化 token，真实资产已带则跳过。
 * 仅当文件不存在时才写，避免覆盖真实资产。
 * ------------------------------------------------------------------------- */
function makeScopeTga(corner) {
  const W = 64, H = 64, R = 40
  const buf = new Uint8Array(18 + W * H * 4)
  const dv = new DataView(buf.buffer)
  dv.setUint16(12, W, true); dv.setUint16(14, H, true)
  buf[2] = 2; buf[16] = 32; buf[17] = 0x28
  const cx = corner[1] === 'l' ? 0 : W - 1
  const cy = corner[0] === 't' ? 0 : H - 1
  let p = 18
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      buf[p + 3] = Math.hypot(x - cx, y - cy) < R ? 0 : 255
      p += 4
    }
  }
  return buf
}

const COMPAT_TXT = (tokens) => `"lang"\n{\n"Language" "english"\n"Tokens"\n{\n${tokens}}\n}\n`
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
  for (const [f, corner] of [
    ['scope_arc', 'tl'], ['scope_arc_ne', 'bl'], ['scope_arc_nw', 'br'], ['scope_arc_sw', 'tr'],
  ]) {
    FS.writeFile(`${BASE}cstrike/sprites/${f}.tga`, makeScopeTga(corner))
  }
  FS.mkdirTree(BASE + 'cstrike/resource')
  for (const [f, text] of Object.entries(COMPAT_RESOURCE)) {
    const p = `${BASE}cstrike/resource/${f}`
    if (!FS.analyzePath(p).exists) FS.writeFile(p, new TextEncoder().encode(text))
  }
  return loadHudFont(xash)
}

/* 数字键 → 武器槽位绑定。命令行 +bind 会被引擎启动时 exec 的 config.cfg 覆盖，
 * 故写入 autoexec.cfg（在 config 之后执行）。真实 CS1.6 客户端支持 slot 命令，这里直接生效。 */
async function ensureBinds(xash) {
  const FS = xash.em.FS
  const cfg = [
    'echo "AUTOEXEC_LOADED"',
    'bind 1 slot1', 'bind 2 slot2', 'bind 3 slot3',
    'bind 4 slot4', 'bind 5 slot5', 'bind 6 slot6',
    'hud_fastswitch 1',
    // 机器人（yapb wasm）：控制台加/减 bot
    'alias addbot "bot_add"',
    'alias delbot "bot_kill"',
  ].join('\n') + '\n'
  const buf = new TextEncoder().encode(cfg)
  for (const dir of ['', 'cstrike/', 'valve/']) {
    try { FS.writeFile(BASE + dir + 'autoexec.cfg', buf) } catch { /* 目录可能不存在，忽略 */ }
  }
  mark('键位绑定就位 (autoexec.cfg)')
}

/* cs16-client 的 HUD 字体用 TTF 渲染，缺了就空 HUD；站点分发 FiraSans（OFL）并补齐 tomaha.ttf。 */
async function loadHudFont(xash) {
  const FS = xash.em.FS
  try {
    const res = await fetch(ASSET_ROOT + '/gfx/fonts/FiraSans-Regular.ttf')
    if (!res.ok) { log('⚠️ 取不到 HUD 字体（HTTP ' + res.status + '）', 'err'); return }
    const buf = new Uint8Array(await res.arrayBuffer())
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

async function start() {
  const overlay = $('overlay'); if (overlay) overlay.classList.remove('hidden')
  const args = [
    '-windowed', '-console', '-ref', 'webgl2',
    '-game', 'cstrike',
    '+volume', '0', '+hud_scale', '2.5',
    '+exec', 'autoexec.cfg',
    // CS 必须选队伍才会 spawn；队伍选择/购买是 VGUI 菜单，显式开启。
    '+_vgui_menus', '1',
    ...(MAP ? ['+map', MAP] : []),
  ]
  window.__probe.args = args

  const Xash3D = await loadEngine()
  const xash = new Xash3D({
    module: {
      arguments: args,
      print: (s) => { window.__probe.log.push(s); log(s) },
      printErr: (s) => { window.__probe.log.push('[err] ' + s); log('[err] ' + s, 'err') },
      locateFile,
    },
    canvas: $('canvas'),
    libraries: LIBS_MAP.cs,
  })
  window.__probe.xash = xash

  await xash.init()
  mark('引擎初始化完成')
  await placeLibs(xash)
  mark('引擎动态库就位')

  // 完整基础包（cstrike + valve + 全部地图）一次写入
  const wanted = ['base.zip']
  window.__probe.info.packs = wanted
  let files = 0, raw = 0
  for (const pack of wanted) {
    const r = await loadPack(xash, pack)
    files += r.files; raw += r.bytes
    mark(`写入 ${pack}`, `${r.files} 个文件 / ${(r.bytes / 1048576).toFixed(1)} MB 原始`)
  }
  window.__probe.info.assetCount = files
  window.__probe.info.assetBytes = raw

  const extras = await fetch(ASSET_ROOT + '/lib/cstrike/extras.pk3')
  xash.em.FS.writeFile(BASE + 'extras.pk3', new Uint8Array(await extras.arrayBuffer()))
  mark('extras.pk3 就位')

  await compatPatch(xash)
  mark('CS16 兼容补丁')
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
  const box = $('errbox'); if (box) box.textContent = '❌ ' + (e && e.message ? e.message : msg)
  log('❌ ' + (e && e.message ? e.message : msg), 'err')
  console.error(e)
}

if (Q.has('game') || Q.has('map')) {
  start().catch(showError)
} else {
  $('start')?.addEventListener('click', () => start().catch(showError))
}
