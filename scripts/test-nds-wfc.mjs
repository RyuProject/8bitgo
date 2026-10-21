import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { installNdsWfcRuntime, isWorldAtWarNdsRomHeader, loadNdsWfcSettings, ndsWfcMacAddress, ndsWfcSocketUrl, saveNdsWfcSettings } from '../src/emulator/ndsWfc.ts'
import { NDS_WFC_SETTINGS_PATH, NDS_WFC_SETTINGS_SIZE } from '../src/emulator/ndsStartup.ts'

const storedMac = new Map()
const macWindow = {
  localStorage: {
    getItem: (key) => storedMac.get(key) ?? null,
    setItem: (key, value) => storedMac.set(key, value),
  },
  crypto: { getRandomValues: (bytes) => { bytes.set([0x12, 0x34, 0x56]); return bytes } },
}
// 任天堂 OUI；旧版 v1 的 00:08:BF 不再沿用
storedMac.set('8bitgo:nds-wfc-mac-v1', '00:08:bf:aa:bb:cc')
assert.equal(ndsWfcMacAddress(macWindow), '00:09:bf:12:34:56')
assert.equal(storedMac.get('8bitgo:nds-wfc-mac-v2'), '00:09:bf:12:34:56')
assert.equal(ndsWfcMacAddress(macWindow), '00:09:bf:12:34:56')

// WFC 设置（WFC 用户 ID 等）按网卡地址存取；长度不对、全 0 的都不能当成有效存档
assert.equal(NDS_WFC_SETTINGS_PATH, '/home/web_user/retroarch/userdata/system/melonDS DS/wfcsettings.bin')
assert.equal(NDS_WFC_SETTINGS_SIZE, 2304)
const wfcStore = new Map()
const storage = { getItem: (key) => wfcStore.get(key) ?? null, setItem: (key, value) => wfcStore.set(key, value) }
const settings = new Uint8Array(NDS_WFC_SETTINGS_SIZE).map((_, i) => (i * 7) & 0xff)
assert.equal(loadNdsWfcSettings('00:09:BF:12:34:56', NDS_WFC_SETTINGS_SIZE, storage), null)
assert.equal(saveNdsWfcSettings('00:09:BF:12:34:56', settings, NDS_WFC_SETTINGS_SIZE, storage), true)
assert.deepEqual(loadNdsWfcSettings('00:09:bf:12:34:56', NDS_WFC_SETTINGS_SIZE, storage), settings)
assert.equal(loadNdsWfcSettings('00:09:bf:ff:ff:ff', NDS_WFC_SETTINGS_SIZE, storage), null, '另一台虚拟 DS 不能拿到这台的 WFC ID')
assert.equal(saveNdsWfcSettings('00:09:bf:12:34:56', new Uint8Array(NDS_WFC_SETTINGS_SIZE), NDS_WFC_SETTINGS_SIZE, storage), false)
assert.equal(saveNdsWfcSettings('00:09:bf:12:34:56', new Uint8Array(10), NDS_WFC_SETTINGS_SIZE, storage), false)
assert.deepEqual(loadNdsWfcSettings('00:09:bf:12:34:56', NDS_WFC_SETTINGS_SIZE, storage), settings)

const session = { token: 'A'.repeat(32), path: '/api/nds-wfc/socket/', instanceId: 'b'.repeat(16) }
const header = new Uint8Array(16)
header.set(Buffer.from('CALLOFDUTY5'), 0)
header.set(Buffer.from('CALE'), 12)
assert.equal(isWorldAtWarNdsRomHeader(header), true)
header.set(Buffer.from('CALP'), 12)
assert.equal(isWorldAtWarNdsRomHeader(header), true)
header[12] = 0
assert.equal(isWorldAtWarNdsRomHeader(header), false)
header.set(Buffer.from('CALE'), 12)
header[0] = 0
assert.equal(isWorldAtWarNdsRomHeader(header), false)
assert.equal(
  ndsWfcSocketUrl('https://8bitgo.com', session, '178.62.43.212', 53, 2, 'socket[12]'),
  `wss://8bitgo.com/api/nds-wfc/socket/${session.token}/udp/178.62.43.212/53/12/${session.instanceId}`,
)
assert.equal(
  ndsWfcSocketUrl('http://127.0.0.1:5173', session, '95.217.77.151', 29900, 1),
  `ws://127.0.0.1:5173/api/nds-wfc/socket/${session.token}/tcp/95.217.77.151/29900`,
)
assert.throws(() => ndsWfcSocketUrl('https://8bitgo.com', session, 'localhost', 80, 1))
assert.throws(() => ndsWfcSocketUrl('https://8bitgo.com', session, '178.62.43.212', 53, 99))
assert.throws(() => ndsWfcSocketUrl('https://8bitgo.com', session, '178.62.43.212', 53, 2))
assert.throws(() => ndsWfcSocketUrl('https://8bitgo.com', session, '178.62.43.212', 53, 2, 'socket[../1]'))

const win = { EJS_Runtime: (config) => config }
assert.equal(installNdsWfcRuntime(win, session, 'https://8bitgo.com'), true)
assert.equal(installNdsWfcRuntime(win, session, 'https://8bitgo.com'), true)
const moduleConfig = win.EJS_Runtime({ noInitialRun: true })
assert.equal(moduleConfig.noInitialRun, true)
assert.equal(moduleConfig.websocket.url('178.62.43.212', 53, 2, 'socket[12]'),
  `wss://8bitgo.com/api/nds-wfc/socket/${session.token}/udp/178.62.43.212/53/12/${session.instanceId}`)
assert.equal(moduleConfig.websocket.subprotocol, 'binary')
const renewed = { ...session, token: 'B'.repeat(32) }
assert.equal(installNdsWfcRuntime(win, renewed, 'https://8bitgo.com'), true)
assert.equal(moduleConfig.websocket.url('178.62.43.212', 53, 2, 'socket[12]'),
  `wss://8bitgo.com/api/nds-wfc/socket/${session.token}/udp/178.62.43.212/53/12/${session.instanceId}`)
assert.equal(win.EJS_Runtime({}).websocket.url('95.217.77.151', 29900, 1),
  `wss://8bitgo.com/api/nds-wfc/socket/${renewed.token}/tcp/95.217.77.151/29900`)
// 以前出现过“源码打了补丁、线上静态核心仍是旧产物”；这次直接验实际发给浏览器的归档。
const archive = fileURLToPath(new URL('../public/emulatorjs/cores/melondsds-wasm.data', import.meta.url))
const shippedJs = execFileSync('7z', ['x', '-so', archive, 'melondsds_libretro.js'], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
assert.ok(shippedJs.includes('SOCKFS.websocketArgs["url"](addr,port,sock.type,sock.stream.node.name)'), '发布核心缺少逐 socket WFC 路由补丁')
const shippedWasm = execFileSync('7z', ['x', '-so', archive, 'melondsds_libretro.wasm'], { maxBuffer: 16 * 1024 * 1024 })
assert.ok(shippedWasm.includes(Buffer.from('/8bitgo-wfc-mac.txt')), '发布核心没有登记逐浏览器 MAC 选项，RetroArch 会静默回退共享默认地址')
console.log('NDS WFC：核心工厂注入及 TCP/UDP 目标路由检查通过')
