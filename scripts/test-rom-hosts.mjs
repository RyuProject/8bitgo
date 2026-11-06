// BIOS / 系统盘 / Sockdrive 跟随主域与 EdgeOne 镜像线路（src/services/romHosts.ts）的回归。不联网。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const PRIMARY = 'https://assets.example.com'
const MIRROR = 'https://cn-assets.example.com'
globalThis.__viteEnv = { VITE_ROM_BASE_URL: PRIMARY, VITE_ROM_MIRROR_URL: MIRROR }

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}
globalThis.window = globalThis

const hosts = await import('../src/services/romHosts.ts')
const { romCacheKey } = await import('../src/emulator/romCache.ts')
const { clearRomHostChoice } = await import('../src/services/romRoute.ts')
const setHost = (host, at = Date.now()) => {
  clearRomHostChoice()
  store.set('8bitgo.rom-host.v1', JSON.stringify({ pair: `${PRIMARY}|${MIRROR}`, host, at }))
}

let passed = 0
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`) }

// ── 地址换算 ──
assert.equal(hosts.canonicalRomUrl(`${MIRROR}/roms/bios/neogeo.zip`), `${PRIMARY}/roms/bios/neogeo.zip`)
assert.equal(hosts.canonicalRomUrl(`${PRIMARY}/roms/x.zip`), `${PRIMARY}/roms/x.zip`)
assert.equal(hosts.canonicalRomUrl('https://other.example.com/x'), 'https://other.example.com/x')
assert.equal(hosts.mirrorRomUrl(`${PRIMARY}/systems/dos/a.jsdos`), `${MIRROR}/systems/dos/a.jsdos`)
assert.equal(hosts.mirrorRomUrl('/system-images/a.jsdos'), '', '同源路径不换')
ok('主域 / 镜像地址互换')

// ── 没测过线路：用 fallback；测过：用结论 ──
const bios = `${PRIMARY}/roms/bios/neogeo.zip`
assert.equal(hosts.routeRomAssetUrl(bios), bios)
assert.equal(hosts.routeRomAssetUrl(bios, 'mirror'), `${MIRROR}/roms/bios/neogeo.zip`, '大陆访客没测完时默认镜像')
setHost('mirror')
assert.equal(hosts.routeRomAssetUrl(bios), `${MIRROR}/roms/bios/neogeo.zip`, '测出镜像更快就走镜像')
assert.equal(hosts.routeRomAssetUrl('https://other.example.com/bios.zip'), 'https://other.example.com/bios.zip', '外链不动')
setHost('mirror', Date.now() - 31 * 60 * 1000)
assert.equal(hosts.routeRomAssetUrl(bios), bios, '过期结论不用')
ok('BIOS / 系统盘按已测线路改写，过期退回 fallback')

// ── 缓存键按主域写法 ──
assert.equal(romCacheKey(`${MIRROR}/systems/dos/a.jsdos?romv=abc`), `${PRIMARY}/systems/dos/a.jsdos?romv=abc`)
assert.equal(romCacheKey(`${PRIMARY}/systems/dos/a.jsdos?romv=abc`), `${PRIMARY}/systems/dos/a.jsdos?romv=abc`)
assert.equal(romCacheKey(`${MIRROR}/roms/a.zip`), '', '没有版本仍不缓存')
ok('IndexedDB 缓存键换线路不变')

// ── Sockdrive 每块盘钉一条线路 ──
const disk = `${PRIMARY}/sockdrives/game-v1`
setHost('mirror')
assert.equal(hosts.pinnedSockdriveUrl(disk), `${MIRROR}/sockdrives/game-v1`, '第一次按当时线路')
setHost('primary')
assert.equal(hosts.pinnedSockdriveUrl(disk), `${MIRROR}/sockdrives/game-v1`, '之后线路变了也不换，OPFS 只存一份')
hosts.clearSockdrivePin(`${MIRROR}/sockdrives/game-v1`)
assert.equal(hosts.pinnedSockdriveUrl(disk), disk, '挂载失败解除绑定后按新线路重选')
ok('Sockdrive 线路按盘钉住，失败可解除')

// ── 存档包里的盘 URL 换成当前地址 ──
const enc = new TextEncoder()
const record = (url, data) => {
  const u = enc.encode(url)
  const out = new Uint8Array(8 + u.length + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, u.length, true)
  out.set(u, 4)
  view.setUint32(4 + u.length, data.length, true)
  out.set(data, 8 + u.length)
  return out
}
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
const data = new Uint8Array([1, 2, 3, 4, 5])
const savedOnPrimary = concat(record(disk, data), record('https://elsewhere.example.com/other', new Uint8Array([9])))
const mirrorDisk = `${MIRROR}/sockdrives/game-v1`
const retargeted = hosts.retargetSockdriveChanges(savedOnPrimary, mirrorDisk)
const parsed = []
{
  const view = new DataView(retargeted.buffer, retargeted.byteOffset, retargeted.byteLength)
  let i = 0
  while (i < retargeted.length) {
    const ul = view.getUint32(i, true)
    const url = new TextDecoder().decode(retargeted.subarray(i + 4, i + 4 + ul))
    const dl = view.getUint32(i + 4 + ul, true)
    parsed.push([url, [...retargeted.subarray(i + 8 + ul, i + 8 + ul + dl)]])
    i += 8 + ul + dl
  }
}
assert.deepEqual(parsed, [[mirrorDisk, [1, 2, 3, 4, 5]], ['https://elsewhere.example.com/other', [9]]], '只改同一块盘，其它记录与扇区数据原样')
assert.equal(hosts.retargetSockdriveChanges(savedOnPrimary, disk), savedOnPrimary, '地址相同不复制')
const zip = new Uint8Array([0x50, 0x4b, 3, 4, 0])
assert.equal(hosts.retargetSockdriveChanges(zip, mirrorDisk), zip, 'ZIP 存档原样交回')
const garbage = new Uint8Array([255, 255, 255, 255, 1])
assert.equal(hosts.retargetSockdriveChanges(garbage, mirrorDisk), garbage, '格式不对原样交回')
ok('Sockdrive 存档跨线路可读')

// ── 接线 ──
const jsdos = readFileSync(new URL('../src/emulator/adapters/jsdos.ts', import.meta.url), 'utf8')
assert.match(jsdos, /sockdriveVersionedSaveKey\(baseSaveKey, canonicalRomUrl\(sockdriveUrl\)\)/, '存档键按主域写法')
assert.match(jsdos, /retargetSockdriveChanges\(new Uint8Array\(saved\.data\), mounted\)/, '读档时改写盘 URL')
const player = readFileSync(new URL('../src/emulator/EmulatorPlayer.tsx', import.meta.url), 'utf8')
assert.match(player, /routeRomAssetUrl\(rawDosSystemUrl, hostFallback\)/)
assert.match(player, /pinnedSockdriveUrl\(rawDosSockdriveUrl, hostFallback\)/)
assert.match(player, /clearSockdrivePin\(dosSockdriveUrlRef\.current\)/)
const bios2 = readFileSync(new URL('../src/services/platformBios.ts', import.meta.url), 'utf8')
assert.doesNotMatch(bios2, /return (key|raw) \? romUrlForKey\(/, 'BIOS 地址都要过线路选择')
ok('播放器 / BIOS / js-dos 接线')

console.log(`\n${passed} 项通过`)
