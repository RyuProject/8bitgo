/** 通过真实播放器适配器验证 GBA 双端锁步、双核心输入镜像及断开收尾。 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const root = process.cwd()
const pendingPeers = []

// 只替换播放器周边服务；IodineGBA、串口桥、帧时钟、输入路由和 GBA mount 本身都用生产代码。
const stubs = new Map([
  ['../ejsSaveFs', 'export function batterySaveGameName() { return null }'],
  ['../recorder', 'export async function canvasToBlob() { return new Blob() }'],
  ['../romLoader', `export async function loadGameBytes(input) {
    const bytes = String(input) === 'gba-bios' ? globalThis.__gbaTestBios : globalThis.__gbaTestRom
    return { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
  }`],
  ['../gamepadAccess', 'export function readGamepadsSafe() { return [] }'],
  ['../gamepadInput', 'export function gamepadPadState() { return [] }'],
  ['../padKeyboard', 'export function installPadKeyboard() { return () => {} }'],
  ['@/lib/unzip', 'export function isZip() { return false } export async function extractRomFromZip() { throw new Error("unused") }'],
  ['@/services/startupDiagnostics', 'export function diagLog() {}'],
  ['@/services/platformBios', 'export async function resolvePlatformBiosForStartup() { return { url: "gba-bios", mapLoaded: true } }'],
  ['../coreAssetIntegrity', 'export function applyPinnedScriptIntegrity() {}'],
  ['../jsnesNetplay', `export class JsnesNetplay {
    constructor(options) {
      this.options = options
      this.seat = options.seat
      this.bufferFrames = options.bufferFrames ?? 0
      this.remote = new Map()
      this.closed = false
    }
    connect() {
      return new Promise((resolve) => {
        globalThis.__gbaPendingPeers.push({ peer: this, resolve })
        if (globalThis.__gbaPendingPeers.length !== 2) return
        const [{ peer: host, resolve: resolveHost }, { peer: guest, resolve: resolveGuest }] = globalThis.__gbaPendingPeers.splice(0, 2)
        host.remotePeer = guest
        guest.remotePeer = host
        const hostState = host.options.captureOwnState()
        const guestState = guest.options.captureOwnState()
        host.options.applyPeerState(guestState)
        guest.options.applyPeerState(hostState)
        host.options.onReady()
        guest.options.onReady()
        resolveHost()
        resolveGuest()
      })
    }
    sendLocal(frame, bits) {
      if (this.closed || !this.remotePeer) return false
      this.remotePeer.remote.set(frame, bits)
      return true
    }
    remoteBitsFor(frame) { return this.remote.get(frame) }
    pruneRemote(before) {
      for (const frame of this.remote.keys()) if (frame < before) this.remote.delete(frame)
    }
    close() { this.closed = true }
  }`],
])

const bundle = await build({
  entryPoints: [`${root}/src/emulator/adapters/iodinegba.ts`],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [{
    name: 'gba-adapter-test-stubs',
    setup(api) {
      api.onResolve({ filter: /.*/ }, (args) => stubs.has(args.path)
        ? { path: args.path, namespace: 'gba-test' }
        : undefined)
      api.onLoad({ filter: /.*/, namespace: 'gba-test' }, (args) => ({
        contents: stubs.get(args.path),
        loader: 'js',
      }))
    },
  }],
})

let now = 0
let nextId = 1
const rafs = new Map()
const intervals = new Map()
const storage = new Map()
const renderCalls = []
const fakeContext = {
  createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
  putImageData: (...args) => renderCalls.push(args),
}

class FakeElement {
  style = {}
  children = []
  appendChild(child) { this.children.push(child); return child }
  remove() { this.removed = true }
  getContext(kind) { return kind === '2d' ? fakeContext : null }
  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
  setPointerCapture() {}
}

const document = {
  visibilityState: 'visible',
  head: new FakeElement(),
  createElement: () => new FakeElement(),
  addEventListener() {},
  removeEventListener() {},
}
const runtimeContext = {
  console,
  setTimeout,
  clearTimeout,
  setInterval: (fn, ms) => { const id = nextId++; intervals.set(id, { fn, ms }); return id },
  clearInterval: (id) => intervals.delete(id),
  performance: { now: () => now },
  document,
  navigator: { getGamepads: () => [] },
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  },
  requestAnimationFrame: (callback) => { const id = nextId++; rafs.set(id, callback); return id },
  cancelAnimationFrame: (id) => rafs.delete(id),
  addEventListener() {},
  removeEventListener() {},
  URL,
  Blob,
  Uint8Array,
  Uint8ClampedArray,
  Uint16Array,
  Uint32Array,
  Int8Array,
  Int16Array,
  Int32Array,
  Float32Array,
  ArrayBuffer,
  SharedArrayBuffer,
  Atomics,
  Math,
  Date,
  TextEncoder,
  TextDecoder,
}
runtimeContext.window = runtimeContext
runtimeContext.globalThis = runtimeContext

const bios = new Uint8Array(0x4000)
const rom = new Uint8Array(32 * 1024)
// 循环等待本身不访问外设；按键镜像由 IodineGBA 的真实 KEYINPUT 直接核对。
new DataView(rom.buffer).setUint32(0, 0xeafffffe, true)
runtimeContext.__gbaTestBios = bios
runtimeContext.__gbaTestRom = rom

runInNewContext(await readFile(`${root}/public/iodinegba/iodinegba.js`, 'utf8'), runtimeContext)
const NativeIodineGBA = runtimeContext.IodineGBA
const cores = []
runtimeContext.IodineGBA = class TestIodineGBA extends NativeIodineGBA {
  constructor() {
    super()
    this.settings.SKIPBoot = true
    cores.push(this)
  }
}

// 适配器作为浏览器模块运行；其 RAF 由本测试逐帧驱动，setInterval 不会在后台自行推进。
Object.defineProperty(globalThis, 'window', { configurable: true, value: runtimeContext })
Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: runtimeContext.navigator })
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: runtimeContext.localStorage })
Object.defineProperty(globalThis, 'performance', { configurable: true, value: runtimeContext.performance })
Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: runtimeContext.requestAnimationFrame })
Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: runtimeContext.cancelAnimationFrame })
globalThis.__gbaTestRom = rom
globalThis.__gbaTestBios = bios
globalThis.__gbaPendingPeers = pendingPeers

const { mount } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`)
const hostContainer = new FakeElement()
const guestContainer = new FakeElement()
let hostReady
let guestReady
let hostError = ''
let guestError = ''
const hostStarted = new Promise((resolve) => { hostReady = resolve })
const guestStarted = new Promise((resolve) => { guestReady = resolve })
const baseOptions = (onReady, onError) => ({
  game: 'gba-rom',
  gameName: 'Synthetic link game',
  gameSlug: 'synthetic-link-game',
  platform: 'gba',
  biosUrl: 'gba-bios',
  onReady,
  onError: (message) => { onError(message) },
})

const host = mount(hostContainer, baseOptions(hostReady, (message) => { hostError = message }))
const guest = mount(guestContainer, baseOptions(guestReady, (message) => { guestError = message }))

try {
  assert.equal(host.openGbaLinkNetplay({ mode: 'host', bufferFrames: 0 }), false,
    '适配器在首帧就绪前必须拒绝过早建房')
  assert.equal(guest.openGbaLinkNetplay({ mode: 'join', roomId: 'test-room', bufferFrames: 0 }), false,
    '适配器在首帧就绪前必须拒绝过早加入')
  await Promise.all([hostStarted, guestStarted])
  assert.equal(cores.length, 2, '开局先各创建一台真实 GBA 核心')
  assert.equal(host.openGbaLinkNetplay({ mode: 'host', bufferFrames: 0 }), true)
  assert.equal(guest.openGbaLinkNetplay({ mode: 'join', roomId: 'test-room', bufferFrames: 0 }), true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(cores.length, 6, '握手完成后每端再创建两个真实 GBA 核心')

  host.sendButton('a', true)
  guest.sendButton('right', true)
  const step = (timestamp) => {
    now = timestamp
    const callbacks = [...rafs.values()]
    rafs.clear()
    for (const callback of callbacks) callback(timestamp)
  }
  for (let frame = 0; frame < 12; frame++) step(frame * 1000 / 60)

  const hostSeats = cores.slice(2, 4)
  const guestSeats = cores.slice(4, 6)
  assert.equal(hostSeats[0].IOCore.cartridge.ROM.buffer, hostSeats[1].IOCore.cartridge.ROM.buffer,
    '同一玩家的两份联机核心必须共享只读 ROM 字节，避免移动端重复分配大卡带')
  assert.equal(guestSeats[0].IOCore.cartridge.ROM.buffer, guestSeats[1].IOCore.cartridge.ROM.buffer,
    '访客的两份联机核心也必须共享只读 ROM 字节')
  for (const pair of [hostSeats, guestSeats]) {
    const seat0 = pair[0].IOCore.joypad.readKeyStatus16()
    const seat1 = pair[1].IOCore.joypad.readKeyStatus16()
    assert.equal(seat0 & 0x01, 0, '两端座位 0 的真实 GBA KEYINPUT 都应收到房主 A 键')
    assert.equal(seat0 & 0x10, 0x10, '两端座位 0 不应收到访客右键')
    assert.equal(seat1 & 0x01, 0x01, '两端座位 1 不应收到房主 A 键')
    assert.equal(seat1 & 0x10, 0, '两端座位 1 的真实 GBA KEYINPUT 都应收到访客右键')
  }
  assert.equal(hostError, '')
  assert.equal(guestError, '')

  host.closeNetplay()
  guest.closeNetplay()
  assert.equal(hostSeats[1].IOCore, null, '离开联机后销毁本机远端座位副本')
  assert.equal(guestSeats[0].IOCore, null, '离开联机后销毁访客的远端座位副本')
  console.log('GBA 适配器联机回归通过：真实 mount 双机握手、双端四核心锁步、KEYINPUT 镜像及断开资源收尾')
} finally {
  host.destroy()
  guest.destroy()
  rafs.clear()
  intervals.clear()
}
