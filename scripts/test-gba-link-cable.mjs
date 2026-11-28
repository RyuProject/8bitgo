/** 使用仓库锁定的 IodineGBA 串口实现，覆盖 Multi-Pak 与普通 8/32 位双机传输。 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { transform } from 'esbuild'

const coreSource = await readFile(new URL('../vendor/iodinegba/IodineGBA/core/Serial.js', import.meta.url), 'utf8')
const coreContext = {}
runInNewContext(`${coreSource}\nglobalThis.GbaSerial = GameBoyAdvanceSerial`, coreContext)
const Serial = coreContext.GbaSerial

const bridgeSource = await readFile(new URL('../src/emulator/gbaLinkCable.ts', import.meta.url), 'utf8')
const { code } = await transform(bridgeSource, { loader: 'ts', format: 'esm', target: 'es2022' })
const bridge = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
const { attachGbaCable } = bridge

function endpoint(mode, irq = false) {
  const calls = { irq: [] }
  const serial = new Serial({ irq: { requestIRQ(mask) { calls.irq.push(mask) } } })
  serial.initialize()
  serial.writeSIOCNT1((mode << 4) | (irq ? 0x40 : 0))
  return { serial, calls }
}

function testMultiPak() {
  const p0 = endpoint(2, true)
  const p1 = endpoint(2, true)
  const originalRead0 = p0.serial.readSIOCNT0
  const cable = attachGbaCable(p0, p1)

  // 固定座位、主从状态与连接就绪位要符合 Multi-Pak 硬件定义。
  p0.serial.writeSIOCNT0(0x20)
  p1.serial.writeSIOCNT0(0x00)
  assert.equal(p0.serial.SIOMULT_PLAYER_NUMBER, 0)
  assert.equal(p1.serial.SIOMULT_PLAYER_NUMBER, 1)
  assert.equal((p0.serial.readSIOCNT0() >> 4) & 3, 0)
  assert.equal((p1.serial.readSIOCNT0() >> 4) & 3, 1)
  assert.equal((p0.serial.readSIOCNT0() >> 2) & 1, 0, '父机 SI-Terminal 必须为 0')
  assert.equal((p1.serial.readSIOCNT0() >> 2) & 1, 1, '子机 SI-Terminal 必须为 1')
  assert.equal((p0.serial.readSIOCNT0() >> 3) & 1, 1, '双方处于 Multi 模式时 SD-Terminal 必须就绪')
  p0.serial.writeSIODATA8_0(0x34)
  p0.serial.writeSIODATA8_1(0x12)
  p1.serial.writeSIODATA8_0(0xcd)
  p1.serial.writeSIODATA8_1(0xab)

  // Multi-Pak 的子机不能自行写 Start，主机启动后子机 Busy 由电缆置位。
  p1.serial.writeSIOCNT0(0x80)
  assert.equal(p1.serial.SIOTransferStarted, false)
  p0.serial.writeSIOCNT0(0x80)
  assert.equal(p1.serial.SIOTransferStarted, true)
  assert.equal((p1.serial.readSIOCNT0() >> 7) & 1, 1)
  p1.serial.writeSIOCNT0(0x00)
  assert.equal(p1.serial.SIOTransferStarted, true, '子机寄存器写入不能清掉电缆 Busy')
  p0.serial.writeSIODATA8_0(0x99)
  p1.serial.writeSIODATA8_0(0x66)
  p0.serial.addClocks(1_000_000)
  assert.equal(p0.serial.SIOTransferStarted, true, '上游单机时钟不能提前伪完成 Multi 传输')
  assert.equal(cable.settleFrame(), 'transferred')
  for (const port of [p0.serial, p1.serial]) {
    assert.equal(port.readSIODATA_A0(), 0x34)
    assert.equal(port.readSIODATA_A1(), 0x12)
    assert.equal(port.readSIODATA_B0(), 0xcd)
    assert.equal(port.readSIODATA_B1(), 0xab)
    assert.equal(port.SIODATA_C, 0xffff)
    assert.equal(port.SIODATA_D, 0xffff)
    assert.equal(port.SIOTransferStarted, false)
    assert.equal(port.SIOCOMMERROR, false)
  }
  assert.deepEqual(p0.calls.irq, [0x80])
  assert.deepEqual(p1.calls.irq, [0x80])

  // 波特率不匹配时两端都失败并请求 IRQ，不能静默交换错位数据。
  p1.serial.writeSIOCNT0(0x02)
  p0.serial.writeSIOCNT0(0x80)
  assert.equal(cable.settleFrame(), 'failed')
  assert.equal(p0.serial.SIOCOMMERROR, true)
  assert.equal(p1.serial.SIOCOMMERROR, true)
  assert.equal(p0.serial.SIOTransferStarted, false)
  assert.deepEqual(p0.calls.irq, [0x80, 0x80])
  assert.deepEqual(p1.calls.irq, [0x80, 0x80])
  cable.destroy()
  assert.equal(p0.serial.readSIOCNT0, originalRead0)
}

function testNormal8Bit() {
  const p0 = endpoint(0, true)
  const p1 = endpoint(0, true)
  const cable = attachGbaCable(p0, p1)
  p0.serial.writeSIODATA8_0(0xa5)
  p1.serial.writeSIODATA8_0(0x3c)
  p0.serial.writeSIOCNT0(0x81) // 内部时钟主机
  p0.serial.writeSIODATA8_0(0x99) // Start 已锁存，后续改寄存器只能影响下一次传输
  p1.serial.writeSIOCNT0(0x80) // 外部时钟从机
  assert.equal((p0.serial.readSIOCNT0() >> 2) & 1, 0, 'SI 应反映对端发送线的首位')
  assert.equal((p1.serial.readSIOCNT0() >> 2) & 1, 1)

  // Iodine 原 addClocks 会在 0（硬件外部时钟）时重复空移位；桥接后不允许它消耗 CPU。
  let idleClockCalls = 0
  const clockSerial = p1.serial.clockSerial
  p1.serial.clockSerial = () => { idleClockCalls++; clockSerial() }
  p0.serial.addClocks(20_000_000)
  p1.serial.addClocks(20_000_000)
  assert.equal(idleClockCalls, 0, '桥接后不能逐位空转普通串口时钟')
  assert.equal(p0.serial.serialBitsShifted, 0)
  assert.equal(p1.serial.serialBitsShifted, 0)
  assert.equal(cable.settleFrame(), 'transferred')
  assert.equal(p0.serial.readSIODATA8_0(), 0x3c)
  assert.equal(p1.serial.readSIODATA8_0(), 0xa5)
  assert.equal(p0.serial.SIOTransferStarted, false)
  assert.equal(p1.serial.SIOTransferStarted, false)
  assert.deepEqual(p0.calls.irq, [0x80])
  assert.deepEqual(p1.calls.irq, [0x80])
  cable.destroy()
}

function testNormal32Bit() {
  const p0 = endpoint(1)
  const p1 = endpoint(1)
  const cable = attachGbaCable(p0, p1)
  const first = 0x78563412
  const second = 0xf0debc9a
  p0.serial.SIODATA_A = first & 0xffff
  p0.serial.SIODATA_B = first >>> 16
  p0.serial.SIODATA_C = 0x1357
  p0.serial.SIODATA_D = 0x2468
  p1.serial.SIODATA_A = second & 0xffff
  p1.serial.SIODATA_B = second >>> 16
  p1.serial.SIODATA_C = 0x369c
  p1.serial.SIODATA_D = 0x48ad
  p0.serial.writeSIOCNT0(0x81)
  p0.serial.SIODATA_A = 0xabcd // Start 已锁存 32 位发送值
  p0.serial.SIODATA_B = 0xef01
  p1.serial.writeSIOCNT0(0x80)
  assert.equal(cable.settleFrame(), 'transferred')
  assert.deepEqual(
    [p0.serial.SIODATA_A, p0.serial.SIODATA_B],
    [second & 0xffff, second >>> 16],
  )
  assert.deepEqual(
    [p1.serial.SIODATA_A, p1.serial.SIODATA_B],
    [first & 0xffff, first >>> 16],
  )
  assert.deepEqual([p0.serial.SIODATA_C, p0.serial.SIODATA_D], [0x1357, 0x2468], '普通 32 位传输不能污染 Multi-Pak 槽')
  assert.deepEqual([p1.serial.SIODATA_C, p1.serial.SIODATA_D], [0x369c, 0x48ad], '普通 32 位传输不能污染 Multi-Pak 槽')
  cable.destroy()
}

function testUnsupportedAndTimeouts() {
  const uart = endpoint(3)
  const uartPeer = endpoint(3)
  const uartCable = attachGbaCable(uart, uartPeer)
  uart.serial.writeSIOCNT1(0x34) // UART 收发使能
  assert.equal(uartCable.settleFrame(), 'failed')
  assert.match(uartCable.failureReason, /UART/)
  uartCable.destroy()

  const gpio = endpoint(0)
  const gpioPeer = endpoint(0)
  const gpioCable = attachGbaCable(gpio, gpioPeer)
  gpio.serial.writeRCNT1(0x80) // RCNT mode 2 = GPIO
  assert.equal(gpioCable.settleFrame(), 'idle', '仅在启动时切换 GPIO 模式不应误判为使用 GPIO 协议')
  gpio.serial.writeRCNT0(0x04) // 真正访问 GPIO 引脚
  assert.equal(gpioCable.settleFrame(), 'failed')
  assert.match(gpioCable.failureReason, /GPIO/)
  gpioCable.destroy()

  const joyBus = endpoint(0)
  const joyBusPeer = endpoint(0)
  const joyBusCable = attachGbaCable(joyBus, joyBusPeer)
  joyBus.serial.writeRCNT1(0xc0) // 仅选中 JoyBus 模式时尚未发生协议数据交换
  assert.equal(joyBusCable.settleFrame(), 'idle')
  joyBus.serial.writeJOYCNT(0x01)
  assert.equal(joyBusCable.settleFrame(), 'failed')
  assert.match(joyBusCable.failureReason, /JoyBus/)
  joyBusCable.destroy()

  const rfu = endpoint(0)
  const rfuPeer = endpoint(0)
  const rfuCable = attachGbaCable(rfu, rfuPeer)
  rfu.serial.writeRCNT1(0x80) // RFU 复位时先选择 GPIO
  rfu.serial.writeRCNT0(0xa0) // RFU 的 PD 复位脉冲
  assert.equal(rfuCable.settleFrame(), 'failed')
  assert.match(rfuCable.failureReason, /RFU/)
  rfuCable.destroy()

  const switchedDuringTransfer = endpoint(0)
  const transferPeer = endpoint(0)
  const switchedCable = attachGbaCable(switchedDuringTransfer, transferPeer)
  switchedDuringTransfer.serial.writeSIOCNT0(0x81)
  transferPeer.serial.writeSIOCNT0(0x80)
  switchedDuringTransfer.serial.writeRCNT1(0x80)
  assert.equal(switchedCable.settleFrame(), 'failed', '电缆传输中切换到 GPIO 不能完成伪造的数据交换')
  assert.match(switchedCable.failureReason, /传输过程中切换/)
  switchedCable.destroy()

  const mixed = endpoint(2)
  const mixedPeer = endpoint(0)
  const mixedCable = attachGbaCable(mixed, mixedPeer)
  mixedPeer.serial.writeSIOCNT0(0x81)
  assert.equal(mixedCable.settleFrame(), 'waiting', '串口模式暂时不一致时仍需监视，不可把一端 Busy 忽略掉')
  for (let frame = 1; frame < 359; frame++) assert.equal(mixedCable.settleFrame(), 'waiting')
  assert.equal(mixedCable.settleFrame(), 'failed')
  assert.match(mixedCable.failureReason, /不同.*串口模式/)
  mixedCable.destroy()

  const waiting = endpoint(0)
  const waitingPeer = endpoint(0)
  const waitingCable = attachGbaCable(waiting, waitingPeer)
  waiting.serial.writeSIOCNT0(0x81) // 只有主机开始，子机一直没有准备外部时钟
  assert.equal(waitingCable.settleFrame(), 'waiting')
  for (let frame = 1; frame < 359; frame++) assert.equal(waitingCable.settleFrame(), 'waiting')
  assert.equal(waitingCable.settleFrame(), 'failed', '缺少对端的串口传输必须在有限时间内终止')
  assert.match(waitingCable.failureReason, /超时/)
  waitingCable.destroy()
}

function testDestroyRestoresCore() {
  const p0 = endpoint(0)
  const p1 = endpoint(0)
  const patchedMethods = [
    'writeSIOCNT0', 'writeSIOCNT1', 'readSIOCNT0', 'writeRCNT1', 'readRCNT0', 'writeRCNT0',
    'readJOYCNT', 'writeJOYCNT',
    'readJOYBUS_RECV0', 'readJOYBUS_RECV1', 'readJOYBUS_RECV2', 'readJOYBUS_RECV3',
    'writeJOYBUS_RECV0', 'writeJOYBUS_RECV1', 'writeJOYBUS_RECV2', 'writeJOYBUS_RECV3',
    'readJOYBUS_SEND0', 'readJOYBUS_SEND1', 'readJOYBUS_SEND2', 'readJOYBUS_SEND3',
    'writeJOYBUS_SEND0', 'writeJOYBUS_SEND1', 'writeJOYBUS_SEND2', 'writeJOYBUS_SEND3',
    'readJOYBUS_STAT', 'writeJOYBUS_STAT', 'addClocks', 'clockSerial', 'clockMultiplayer', 'clockUART',
  ]
  const originals = patchedMethods.map((method) => p0.serial[method])
  const cable = attachGbaCable(p0, p1)
  cable.destroy()
  assert.equal(cable.settleFrame(), 'idle')
  assert.deepEqual(patchedMethods.map((method) => p0.serial[method]), originals, '销毁必须还原每个串口拦截器')
  p0.serial.writeSIOCNT1(0x40)
  p0.serial.writeSIOCNT0(0x80)
  p0.serial.addClocks(p0.serial.SIOShiftClockDivider * 8)
  assert.equal(p0.serial.SIOTransferStarted, false, '销毁后核心恢复到原有单机无从机行为')
}

async function testFullIodineRuntime() {
  // 用生产 bundle 和自有空 ROM/BIOS跑真实 CPU 与内存映射 IO，避免只在 Serial.js 单元层验收。
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
  const runtimeSource = await readFile(new URL('../public/iodinegba/iodinegba.js', import.meta.url), 'utf8')
  runInNewContext(runtimeSource, runtimeContext)
  assert.equal(typeof runtimeContext.IodineGBA, 'function', '生产 bundle 必须导出可构造的 IodineGBA')

  function createCore(romBytes = new Uint8Array(32 * 1024)) {
    const core = new runtimeContext.IodineGBA()
    core.settings.SKIPBoot = true
    core.settings.offthreadGfxEnabled = false
    core.settings.dynamicSpeed = false
    core.attachPlayStatusHandler(() => {})
    core.attachGraphicsFrameHandler({ copyBuffer() {} })
    core.attachSaveImportHandler((_name, _found, missing) => missing())
    core.attachSaveExportHandler(() => {})
    core.attachROM(romBytes)
    core.attachBIOS(new Uint8Array(0x4000))
    core.setIntervalRate(1000 / 60)
    core.play()
    assert.equal(core.emulatorStatus, 5, 'IodineGBA 生产核心必须能以测试 BIOS/ROM 初始化')
    return core
  }

  const first = createCore()
  const second = createCore()
  const cores = [first, second]
  const cable = attachGbaCable({ serial: first.IOCore.serial }, { serial: second.IOCore.serial })
  const write16 = (core, address, value) => core.IOCore.memory.writeIODispatch16(address, value)
  const read16 = (core, address) => core.IOCore.memory.readIODispatch16(address)
  const write32 = (core, address, value) => core.IOCore.memory.writeIODispatch32(address, value)
  const read32 = (core, address) => core.IOCore.memory.readIODispatch32(address) >>> 0
  let timestamp = 0
  const advance = () => {
    timestamp += 1000 / 60
    for (const core of cores) {
      core.audioUnderrunAdjustment = function () {
        this.CPUCyclesTotal = this.CPUCyclesPerIteration
      }
      core.timerCallback(timestamp)
    }
    assert.deepEqual(cores.map((core) => core.emulatorStatus), [5, 5], '串口联机不能使核心崩溃或暂停')
    return cable.settleFrame()
  }

  try {
    // 普通 8 位：由真实 Memory 写入函数设置 0x0400012A / SIOCNT，再逐帧运行两份 CPU。
    write16(first, 0x4000128, 0x4000)
    write16(second, 0x4000128, 0x4000)
    write16(first, 0x400012a, 0x00a5)
    write16(second, 0x400012a, 0x003c)
    write16(first, 0x4000128, 0x4081)
    write16(second, 0x4000128, 0x4080)
    assert.equal(advance(), 'transferred')
    assert.equal(read16(first, 0x400012a) & 0xff, 0x3c)
    assert.equal(read16(second, 0x400012a) & 0xff, 0xa5)

    // 普通 32 位：按真实 SIODATA32 低/高寄存器写入、交换并读回整字。
    write16(first, 0x4000128, 0x5000)
    write16(second, 0x4000128, 0x5000)
    const firstWord = 0x78563412
    const secondWord = 0xf0debc9a
    write32(first, 0x4000120, firstWord)
    write32(second, 0x4000120, secondWord)
    write16(first, 0x4000128, 0x5081)
    write16(second, 0x4000128, 0x5080)
    assert.equal(advance(), 'transferred')
    assert.equal(read32(first, 0x4000120), secondWord)
    assert.equal(read32(second, 0x4000120), firstWord)

    // Multi-Pak：生产核心的真实 IO 读写必须保留两个玩家槽并暴露正确座位状态。
    write16(first, 0x4000128, 0x2000)
    write16(second, 0x4000128, 0x2000)
    write16(first, 0x400012a, 0x1234)
    write16(second, 0x400012a, 0xabcd)
    write16(first, 0x4000128, 0x2080)
    assert.equal(advance(), 'transferred', cable.failureReason ?? '真实核心 Multi-Pak 传输没有完成')
    assert.deepEqual(
      [read16(first, 0x4000120), read16(first, 0x4000122), read16(first, 0x4000124), read16(first, 0x4000126)],
      [0x1234, 0xabcd, 0xffff, 0xffff],
    )
    assert.deepEqual(
      [read16(second, 0x4000120), read16(second, 0x4000122), read16(second, 0x4000124), read16(second, 0x4000126)],
      [0x1234, 0xabcd, 0xffff, 0xffff],
    )
    assert.equal((read16(first, 0x4000128) >> 4) & 3, 0)
    assert.equal((read16(second, 0x4000128) >> 4) & 3, 1)
  } finally {
    cable.destroy()
    for (const core of cores) core.pause()
  }

  // 两份自制 ARM 测试程序各自通过 CPU 指令写 SIO、等待 Busy 清除并把收到的数据写入 IWRAM。
  const createCpuSerialRom = (sendByte, startValue) => {
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
  const cpuCores = [
    createCore(createCpuSerialRom(0xa5, 0x4081)),
    createCore(createCpuSerialRom(0x3c, 0x4080)),
  ]
  const cpuCable = attachGbaCable(
    { serial: cpuCores[0].IOCore.serial },
    { serial: cpuCores[1].IOCore.serial },
  )
  try {
    for (let frame = 1; frame <= 2; frame++) {
      for (const core of cpuCores) {
        core.audioUnderrunAdjustment = function () {
          this.CPUCyclesTotal = this.CPUCyclesPerIteration
        }
        core.timerCallback((frame * 1000) / 60)
      }
      if (frame === 1) assert.equal(cpuCable.settleFrame(), 'transferred')
      else cpuCable.settleFrame()
    }
    assert.equal(cpuCores[0].IOCore.memory.internalRAM16[0], 0x3c, '真实 ARM 指令应读回对端的 8 位数据')
    assert.equal(cpuCores[1].IOCore.memory.internalRAM16[0], 0xa5, '对端 ARM 指令应读回本机的 8 位数据')
  } finally {
    cpuCable.destroy()
    for (const core of cpuCores) core.pause()
  }
}

testMultiPak()
testNormal8Bit()
testNormal32Bit()
testUnsupportedAndTimeouts()
testDestroyRestoresCore()
await testFullIodineRuntime()
assert.equal(bridge.attachGbaMultiPakCable, attachGbaCable, '兼容导出必须保持相同实现')
console.log('GBA 串口桥通过真实 IodineGBA 回归：生产核心内存映射 IO、CPU 自制 ROM 双向收发、Multi-Pak、普通 8/32 位、IRQ、超时、失败关闭与销毁恢复')
