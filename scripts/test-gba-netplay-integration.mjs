/**
 * 用真实 IodineGBA 核心把双向输入、可靠数据通道和本地 GBA 电缆串成一次锁步对局。
 * WebRTC 传输用有序异步通道替身；真实公网 ICE 另行手动冒烟，避免 CI 依赖公网服务。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { build, transform } from 'esbuild'

const root = process.cwd()
const netplayBuild = await build({
  entryPoints: [`${root}/src/emulator/jsnesNetplay.ts`],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [{
    name: 'gba-link-netplay-service-stub',
    setup(api) {
      api.onResolve({ filter: /^@\/services\/netplay$/ }, () => ({ path: 'netplay', namespace: 'test' }))
      api.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
        contents: "export const NETPLAY_URL='/netplay'; export const fetchIceConfig=async()=>({iceServers:[],hasTurn:false,expiry:0})",
        loader: 'js',
      }))
    },
  }],
})

globalThis.window = globalThis
globalThis.location = { protocol: 'http:', href: 'http://unit.test/games/gba-link-test' }
const { JsnesNetplay } = await import(`data:text/javascript;base64,${Buffer.from(netplayBuild.outputFiles[0].contents).toString('base64')}`)

class FakeDataChannel {
  readyState = 'connecting'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  peer = null
  onopen = null
  onclose = null
  onerror = null
  onmessage = null

  send(data) {
    assert.equal(this.readyState, 'open')
    queueMicrotask(() => this.peer?.onmessage?.({ data }))
  }

  open() {
    this.readyState = 'open'
    this.onopen?.()
  }

  close() {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.onclose?.()
  }
}

const runtimeContext = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  performance,
  Uint8Array,
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
runInNewContext(await readFile(`${root}/public/iodinegba/iodinegba.js`, 'utf8'), runtimeContext)

const { code } = await transform(
  await readFile(`${root}/src/emulator/gbaLinkCable.ts`, 'utf8'),
  { loader: 'ts', format: 'esm', target: 'es2022' },
)
const { attachGbaCable } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

function createCpuSerialRom(sendByte, startValue) {
  // 自制 ARM 程序经真实 CPU 写 8 位串口、等待对端并把收到的数据写进 IWRAM。
  const instructions = [
    0xe59f0038, 0xe3a01000 | (sendByte & 0xff), 0xe1c010b0, 0xe59f0030,
    0xe3a01901, 0xe1c010b0, 0xe59f1028, 0xe1c010b0, 0xe1d020b0,
    0xe3120080, 0x1afffffc, 0xe59f000c, 0xe1d030b0, 0xe3a00403,
    0xe1c030b0, 0xeafffffe, 0x0400012a, 0x04000128, startValue >>> 0,
  ]
  const rom = new Uint8Array(32 * 1024)
  const view = new DataView(rom.buffer)
  instructions.forEach((instruction, index) => view.setUint32(index * 4, instruction >>> 0, true))
  return rom
}

const renderedFrames = [0, 0, 0, 0]

function createCore(rom, render, index) {
  const core = new runtimeContext.IodineGBA()
  core.settings.SKIPBoot = true
  core.settings.offthreadGfxEnabled = false
  core.settings.dynamicSpeed = false
  core.attachPlayStatusHandler(() => {})
  core.attachGraphicsFrameHandler({ copyBuffer() { if (render) renderedFrames[index]++ } })
  core.attachSaveImportHandler((_name, _found, missing) => missing())
  core.attachSaveExportHandler(() => {})
  core.attachROM(rom)
  core.attachBIOS(new Uint8Array(0x4000))
  core.setIntervalRate(1000 / 60)
  core.play()
  assert.equal(core.emulatorStatus, 5)
  core.audioUnderrunAdjustment = function () {
    this.CPUCyclesTotal = this.CPUCyclesPerIteration
  }
  return core
}

const hostSeatRoms = [createCpuSerialRom(0xa5, 0x4081), createCpuSerialRom(0x3c, 0x4080)]
const guestSeatRoms = hostSeatRoms.map((rom) => rom.slice())
const hostCores = hostSeatRoms.map((rom, seat) => createCore(rom, seat === 0, seat))
const guestCores = guestSeatRoms.map((rom, seat) => createCore(rom, seat === 1, seat + 2))
const hostCable = attachGbaCable(
  { serial: hostCores[0].IOCore.serial },
  { serial: hostCores[1].IOCore.serial },
)
const guestCable = attachGbaCable(
  { serial: guestCores[0].IOCore.serial },
  { serial: guestCores[1].IOCore.serial },
)

let hostReady = false
let guestReady = false
let hostPeerSave = null
let guestPeerSave = null
const host = new JsnesNetplay({
  seat: 0,
  gameId: 'synthetic-gba-link-rom',
  captureInitialState: () => null,
  applyInitialState: () => {},
  captureOwnState: () => ({ seat: 0, save: 'seat-0' }),
  applyPeerState: (state) => { hostPeerSave = state },
  onReady: () => { hostReady = true },
})
const guest = new JsnesNetplay({
  seat: 1,
  gameId: 'synthetic-gba-link-rom',
  captureInitialState: () => null,
  applyInitialState: () => {},
  captureOwnState: () => ({ seat: 1, save: 'seat-1' }),
  applyPeerState: (state) => { guestPeerSave = state },
  onReady: () => { guestReady = true },
})
const hostDc = new FakeDataChannel()
const guestDc = new FakeDataChannel()
hostDc.peer = guestDc
guestDc.peer = hostDc
host.bindDc(hostDc)
guest.bindDc(guestDc)
hostDc.open()
guestDc.open()

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
for (let index = 0; index < 12 && (!hostReady || !guestReady); index++) await tick()
assert.equal(hostReady, true, '房主收到对端存档确认后才启动锁步')
assert.equal(guestReady, true, '访客收到房主开始信号后才启动锁步')
assert.deepEqual(hostPeerSave, { seat: 1, save: 'seat-1' })
assert.deepEqual(guestPeerSave, { seat: 0, save: 'seat-0' })

const actions = ['a', 'b', 'select', 'start', 'up', 'down', 'left', 'right', 'l', 'r']
const keyIndexes = [0, 1, 2, 3, 6, 7, 5, 4, 9, 8]
const priorBits = { host: [0, 0], guest: [0, 0] }
const localRings = { host: [], guest: [] }
const delay = host.bufferFrames
const hostInputs = [0, 1, 65, 0, 512, 130, 0, 9, 0, 1, 0, 0]
const guestInputs = [0, 2, 132, 0, 256, 33, 0, 8, 0, 2, 0, 0]

function applyBits(side, seat, bits) {
  const previous = priorBits[side][seat]
  if (previous === bits) return
  const core = side === 'host' ? hostCores[seat] : guestCores[seat]
  for (let index = 0; index < actions.length; index++) {
    const was = (previous & (1 << index)) !== 0
    const down = (bits & (1 << index)) !== 0
    if (was === down) continue
    if (down) core.keyDown(keyIndexes[index])
    else core.keyUp(keyIndexes[index])
  }
  priorBits[side][seat] = bits
}

try {
  for (let frame = 0; frame < hostInputs.length; frame++) {
    assert.equal(host.sendLocal(frame, hostInputs[frame]), true)
    assert.equal(guest.sendLocal(frame, guestInputs[frame]), true)
    await tick()

    const sourceFrame = frame - delay
    localRings.host.push(hostInputs[frame])
    localRings.guest.push(guestInputs[frame])
    while (localRings.host.length > delay + 1) localRings.host.shift()
    while (localRings.guest.length > delay + 1) localRings.guest.shift()
    const hostRemote = sourceFrame < 0 ? 0 : host.remoteBitsFor(sourceFrame)
    const guestRemote = sourceFrame < 0 ? 0 : guest.remoteBitsFor(sourceFrame)
    assert.notEqual(hostRemote, undefined, `房主缺少第 ${sourceFrame} 帧访客输入`)
    assert.notEqual(guestRemote, undefined, `访客缺少第 ${sourceFrame} 帧房主输入`)

    if (sourceFrame < 0) {
      applyBits('host', 0, 0)
      applyBits('host', 1, 0)
      applyBits('guest', 0, 0)
      applyBits('guest', 1, 0)
    } else {
      applyBits('host', 0, localRings.host[0] ?? 0)
      applyBits('host', 1, hostRemote)
      applyBits('guest', 0, guestRemote)
      applyBits('guest', 1, localRings.guest[0] ?? 0)
      host.pruneRemote(sourceFrame - 1)
      guest.pruneRemote(sourceFrame - 1)
    }

    const timestamp = Math.floor((frame + 1) * 1000 / 60) >>> 0
    for (const core of [...hostCores, ...guestCores]) core.timerCallback(timestamp)
    assert.equal(hostCable.settleFrame(), guestCable.settleFrame(), '两端对同一座位的串口传输必须一致')

    for (let seat = 0; seat < 2; seat++) {
      assert.equal(
        hostCores[seat].IOCore.joypad.readKeyStatus16(),
        guestCores[seat].IOCore.joypad.readKeyStatus16(),
        `锁步后座位 ${seat} 的真实 GBA KEYINPUT 必须逐帧一致`,
      )
      assert.deepEqual(
        Array.from(hostCores[seat].IOCore.cpu.registers),
        Array.from(guestCores[seat].IOCore.cpu.registers),
        `锁步后座位 ${seat} 的真实 CPU 寄存器必须逐帧一致`,
      )
    }
  }

  assert.equal(hostCores[0].IOCore.memory.internalRAM16[0], 0x3c, '房主座位 0 的真实游戏 CPU 应收到座位 1 数据')
  assert.equal(hostCores[1].IOCore.memory.internalRAM16[0], 0xa5, '房主座位 1 的真实游戏 CPU 应收到座位 0 数据')
  assert.equal(guestCores[0].IOCore.memory.internalRAM16[0], 0x3c, '访客座位 0 必须复现同一串口结果')
  assert.equal(guestCores[1].IOCore.memory.internalRAM16[0], 0xa5, '访客座位 1 必须复现同一串口结果')
  assert.ok(renderedFrames[0] > 0, '房主只把本机座位的真实 GBA 帧交给画面层')
  assert.equal(renderedFrames[1], 0, '房主的远端副本不能额外复制帧画面')
  assert.equal(renderedFrames[2], 0, '访客的远端副本不能额外复制帧画面')
  assert.ok(renderedFrames[3] > 0, '访客只把本机座位的真实 GBA 帧交给画面层')
  console.log('GBA 联机集成回归通过：双向存档握手、延迟输入锁步、真实 KEYINPUT/CPU/串口逐帧一致，且仅渲染本机座位')
} finally {
  host.close()
  guest.close()
  hostCable.destroy()
  guestCable.destroy()
  for (const core of [...hostCores, ...guestCores]) core.pause()
}
