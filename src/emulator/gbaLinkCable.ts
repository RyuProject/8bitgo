/**
 * 把两台 IodineGBA 核心的串口接成一条本地 GBA 电缆。
 *
 * 网络联机时两端各运行同一对锁步核心，因此线上的数据不需要经过网络；在两台核心
 * 都推进完本帧后原子交换寄存器，避免网络延迟进入游戏串口时序。IodineGBA 上游的
 * addClocks 对普通模式的内/外时钟位判定与 GBA 寄存器定义相反，若让子机继续推进，
 * 会把“等待外部时钟”误当成本机时钟并反复执行单机假回包；桥接期间因此接管时钟。
 */

export interface GbaLinkSerial {
  SIOCNT_MODE: number
  SIOTransferStarted: boolean
  SIOMULT_PLAYER_NUMBER: number
  SIOBaudRate: number
  SIOShiftClockExternal: number
  SIOShiftClockDivider: number
  SIOCNT0_DATA: number
  SIOCNT_IRQ: number
  SIOCOMMERROR: boolean
  SIOCNT_UART_SEND_ENABLE: boolean
  SIOCNT_UART_RECV_ENABLE: boolean
  SIODATA8: number
  SIODATA_A: number
  SIODATA_B: number
  SIODATA_C: number
  SIODATA_D: number
  RCNTDataBits: number
  RCNTDataBitFlow: number
  serialBitsShifted: number
  shiftClocks: number
  RCNTMode: number
  writeSIOCNT0: (data: number) => void
  writeSIOCNT1: (data: number) => void
  readSIOCNT0: () => number
  writeRCNT1: (data: number) => void
  readRCNT0: () => number
  writeRCNT0: (data: number) => void
  readJOYCNT: () => number
  writeJOYCNT: (data: number) => void
  readJOYBUS_RECV0: () => number
  readJOYBUS_RECV1: () => number
  readJOYBUS_RECV2: () => number
  readJOYBUS_RECV3: () => number
  writeJOYBUS_RECV0: (data: number) => void
  writeJOYBUS_RECV1: (data: number) => void
  writeJOYBUS_RECV2: (data: number) => void
  writeJOYBUS_RECV3: (data: number) => void
  readJOYBUS_SEND0: () => number
  readJOYBUS_SEND1: () => number
  readJOYBUS_SEND2: () => number
  readJOYBUS_SEND3: () => number
  writeJOYBUS_SEND0: (data: number) => void
  writeJOYBUS_SEND1: (data: number) => void
  writeJOYBUS_SEND2: (data: number) => void
  writeJOYBUS_SEND3: (data: number) => void
  readJOYBUS_STAT: () => number
  writeJOYBUS_STAT: (data: number) => void
  addClocks: (clocks: number) => void
  clockSerial: () => void
  clockMultiplayer: () => void
  clockUART: () => void
  IOCore?: { irq?: { requestIRQ?: (mask: number) => void } }
}

export interface GbaLinkEndpoint {
  serial: GbaLinkSerial
}

export interface GbaLinkCable {
  /** 在两台机器都推进完本帧后结算主机发起的传输。 */
  settleFrame(): 'idle' | 'waiting' | 'transferred' | 'failed'
  /** 失败时用于向玩家说明停止联机的具体原因。 */
  readonly failureReason: string | null
  /** 断开时恢复核心原方法，避免重启或换局后串口继续引用旧电缆。 */
  destroy(): void
}

const NORMAL_8BIT_MODE = 0
const NORMAL_32BIT_MODE = 1
const MULTIPLAYER_MODE = 2
const UART_MODE = 3
/** 串口时序实现变更时递增，避免不同版本的浏览器运行时继续锁步。 */
export const GBA_LINK_PROTOCOL_VERSION = 'gba-link-cable-v2'
const SERIAL_IRQ_MASK = 0x80
const WORD_MASK = 0xffff
const BYTE_MASK = 0xff
/** 普通串口对端一直未就绪时给游戏一个有限等待窗口，避免联机永久卡住。 */
const MAX_PENDING_FRAMES = 360

type OriginalMethods = {
  writeSIOCNT0: GbaLinkSerial['writeSIOCNT0']
  writeSIOCNT1: GbaLinkSerial['writeSIOCNT1']
  readSIOCNT0: GbaLinkSerial['readSIOCNT0']
  writeRCNT1: GbaLinkSerial['writeRCNT1']
  readRCNT0: GbaLinkSerial['readRCNT0']
  writeRCNT0: GbaLinkSerial['writeRCNT0']
  readJOYCNT: GbaLinkSerial['readJOYCNT']
  writeJOYCNT: GbaLinkSerial['writeJOYCNT']
  readJOYBUS_RECV0: GbaLinkSerial['readJOYBUS_RECV0']
  readJOYBUS_RECV1: GbaLinkSerial['readJOYBUS_RECV1']
  readJOYBUS_RECV2: GbaLinkSerial['readJOYBUS_RECV2']
  readJOYBUS_RECV3: GbaLinkSerial['readJOYBUS_RECV3']
  writeJOYBUS_RECV0: GbaLinkSerial['writeJOYBUS_RECV0']
  writeJOYBUS_RECV1: GbaLinkSerial['writeJOYBUS_RECV1']
  writeJOYBUS_RECV2: GbaLinkSerial['writeJOYBUS_RECV2']
  writeJOYBUS_RECV3: GbaLinkSerial['writeJOYBUS_RECV3']
  readJOYBUS_SEND0: GbaLinkSerial['readJOYBUS_SEND0']
  readJOYBUS_SEND1: GbaLinkSerial['readJOYBUS_SEND1']
  readJOYBUS_SEND2: GbaLinkSerial['readJOYBUS_SEND2']
  readJOYBUS_SEND3: GbaLinkSerial['readJOYBUS_SEND3']
  writeJOYBUS_SEND0: GbaLinkSerial['writeJOYBUS_SEND0']
  writeJOYBUS_SEND1: GbaLinkSerial['writeJOYBUS_SEND1']
  writeJOYBUS_SEND2: GbaLinkSerial['writeJOYBUS_SEND2']
  writeJOYBUS_SEND3: GbaLinkSerial['writeJOYBUS_SEND3']
  readJOYBUS_STAT: GbaLinkSerial['readJOYBUS_STAT']
  writeJOYBUS_STAT: GbaLinkSerial['writeJOYBUS_STAT']
  addClocks: GbaLinkSerial['addClocks']
  clockSerial: GbaLinkSerial['clockSerial']
  clockMultiplayer: GbaLinkSerial['clockMultiplayer']
  clockUART: GbaLinkSerial['clockUART']
}

/** 创建真实双机本地电缆；普通 8/32 位与 Multi-Pak 可用，未实现的串口协议在实际访问时明确失败。 */
export function attachGbaCable(
  player0: GbaLinkEndpoint,
  player1: GbaLinkEndpoint,
): GbaLinkCable {
  const serials = [player0.serial, player1.serial] as const
  if (serials[0] === serials[1]) throw new Error('GBA Link Cable requires two independent serial ports')

  const originals = serials.map((serial) => ({
    writeSIOCNT0: serial.writeSIOCNT0,
    writeSIOCNT1: serial.writeSIOCNT1,
    readSIOCNT0: serial.readSIOCNT0,
    writeRCNT1: serial.writeRCNT1,
    readRCNT0: serial.readRCNT0,
    writeRCNT0: serial.writeRCNT0,
    readJOYCNT: serial.readJOYCNT,
    writeJOYCNT: serial.writeJOYCNT,
    readJOYBUS_RECV0: serial.readJOYBUS_RECV0,
    readJOYBUS_RECV1: serial.readJOYBUS_RECV1,
    readJOYBUS_RECV2: serial.readJOYBUS_RECV2,
    readJOYBUS_RECV3: serial.readJOYBUS_RECV3,
    writeJOYBUS_RECV0: serial.writeJOYBUS_RECV0,
    writeJOYBUS_RECV1: serial.writeJOYBUS_RECV1,
    writeJOYBUS_RECV2: serial.writeJOYBUS_RECV2,
    writeJOYBUS_RECV3: serial.writeJOYBUS_RECV3,
    readJOYBUS_SEND0: serial.readJOYBUS_SEND0,
    readJOYBUS_SEND1: serial.readJOYBUS_SEND1,
    readJOYBUS_SEND2: serial.readJOYBUS_SEND2,
    readJOYBUS_SEND3: serial.readJOYBUS_SEND3,
    writeJOYBUS_SEND0: serial.writeJOYBUS_SEND0,
    writeJOYBUS_SEND1: serial.writeJOYBUS_SEND1,
    writeJOYBUS_SEND2: serial.writeJOYBUS_SEND2,
    writeJOYBUS_SEND3: serial.writeJOYBUS_SEND3,
    readJOYBUS_STAT: serial.readJOYBUS_STAT,
    writeJOYBUS_STAT: serial.writeJOYBUS_STAT,
    addClocks: serial.addClocks,
    clockSerial: serial.clockSerial,
    clockMultiplayer: serial.clockMultiplayer,
    clockUART: serial.clockUART,
  })) as [OriginalMethods, OriginalMethods]

  let destroyed = false
  let failed = false
  let failureReason: string | null = null
  let unsupportedProtocol: 'UART' | 'GPIO' | 'JoyBus' | 'RFU' | null = null
  let multiTransferActive = false
  let unsupportedSerialActivity = false
  // 只累计 GPIO 时钟输出线的真实边沿；读取寄存器或设置静态电平常用于启动探测。
  let gpioClockEdges = 0
  let pendingNormalFrames = 0
  let multiSendWords: [number, number] = [serials[0].SIODATA8 & WORD_MASK, serials[1].SIODATA8 & WORD_MASK]
  const normalOutbox: [number | null, number | null] = [null, null]

  const readNormalPayload = (serial: GbaLinkSerial, mode = serial.SIOCNT_MODE) => {
    if (mode === NORMAL_8BIT_MODE) return serial.SIODATA8 & BYTE_MASK
    // SIODATA32 是 0x120/0x122 的两个 16 位字；C/D 是 Multi-Pak 的额外接收槽。
    return ((serial.SIODATA_A & WORD_MASK) | ((serial.SIODATA_B & WORD_MASK) << 16)) >>> 0
  }

  for (let index = 0; index < serials.length; index++) {
    const serial = serials[index]
    // 容错接管已启动的核心状态；正常联机开局会在安装桥后才发起传输。
    if (serial.SIOTransferStarted && serial.SIOCNT_MODE <= NORMAL_32BIT_MODE) {
      normalOutbox[index] = readNormalPayload(serial)
    }
  }

  const armMultiTransfer = () => {
    if (multiTransferActive) return
    multiTransferActive = true
    // Start 锁存发送寄存器；之后游戏写入的新数据属于下一次传输。
    multiSendWords = [serials[0].SIODATA8 & WORD_MASK, serials[1].SIODATA8 & WORD_MASK]
    // Multi-Pak 只有 0 号主机写 Start；1 号的 Busy 由连接拓扑产生。
    serials[1].SIOTransferStarted = true
    serials[1].serialBitsShifted = 0
    serials[1].shiftClocks = 0
  }

  const resetCounters = (serial: GbaLinkSerial) => {
    serial.serialBitsShifted = 0
    serial.shiftClocks = 0
  }

  const completeTransfer = (writeData: (serial: GbaLinkSerial, peer: GbaLinkSerial) => void) => {
    const [first, second] = serials
    // 先快照，再写回；不能让第一个端口的写入污染另一个端口的接收数据。
    writeData(first, second)
    writeData(second, first)
    for (const serial of serials) {
      serial.SIOTransferStarted = false
      serial.SIOCOMMERROR = false
      resetCounters(serial)
      if (serial.SIOCNT_IRQ) serial.IOCore?.irq?.requestIRQ?.(SERIAL_IRQ_MASK)
    }
    multiTransferActive = false
    pendingNormalFrames = 0
    normalOutbox[0] = null
    normalOutbox[1] = null
  }

  const failTransfer = (reason = 'GBA 串口传输失败') => {
    failed = true
    failureReason = reason
    multiTransferActive = false
    pendingNormalFrames = 0
    unsupportedSerialActivity = false
    normalOutbox[0] = null
    normalOutbox[1] = null
    for (const serial of serials) {
      serial.SIOTransferStarted = false
      serial.SIOCOMMERROR = true
      resetCounters(serial)
      if (serial.SIOCNT_IRQ) serial.IOCore?.irq?.requestIRQ?.(SERIAL_IRQ_MASK)
    }
  }

  const markUnsupportedProtocol = (protocol: 'UART' | 'GPIO' | 'JoyBus' | 'RFU') => {
    unsupportedProtocol ??= protocol
    unsupportedSerialActivity = true
  }

  const wrapJoyBusAccess = <T extends (...args: never[]) => unknown>(method: T): T => {
    return function (this: GbaLinkSerial, ...args: never[]) {
      if (this.RCNTMode === 3) markUnsupportedProtocol('JoyBus')
      return method.apply(this, args)
    } as T
  }

  /** 普通 32 位模式只交换 SIODATA32 的 A/B 两个半字，不覆盖 Multi-Pak 的 C/D 槽。 */
  const writeNormal32 = (serial: GbaLinkSerial, value: number) => {
    serial.SIODATA_A = value & WORD_MASK
    serial.SIODATA_B = (value >>> 16) & WORD_MASK
  }

  const normalSoLevel = (serial: GbaLinkSerial, index: number) => {
    if (serial.SIOTransferStarted) {
      const payload = normalOutbox[index] ?? readNormalPayload(serial)
      if (serial.SIOCNT_MODE === NORMAL_8BIT_MODE) return (payload >>> 7) & 1
      if (serial.SIOCNT_MODE === NORMAL_32BIT_MODE) return (payload >>> 31) & 1
    }
    // 闲置 SO 由 SIOCNT bit 3 控制；Iodine 保存该输出位在 SIOCNT0_DATA 中。
    return (serial.SIOCNT0_DATA >>> 3) & 1
  }

  for (let index = 0; index < serials.length; index++) {
    const serial = serials[index]
    const original = originals[index]
    const playerNumber = index

    serial.writeSIOCNT0 = function (input: number) {
      let data = input | 0
      const currentMode = serial.SIOCNT_MODE | 0
      const wasStarted = serial.SIOTransferStarted
      if (currentMode === MULTIPLAYER_MODE) {
        // 固定座位必须在交给核心前写入，否则核心可能先按错误 ID 清空或启动寄存器。
        data = (data & ~0x30) | (playerNumber << 4)
        // 从机的 Start 是只读 Busy；让真实核心也看见这个硬件规则。
        if (playerNumber !== 0) data &= ~0x80
      }
      original.writeSIOCNT0.call(serial, data)
      if (currentMode <= NORMAL_32BIT_MODE) {
        if (serial.SIOTransferStarted && !wasStarted) normalOutbox[playerNumber] = readNormalPayload(serial, currentMode)
        else if (!serial.SIOTransferStarted) normalOutbox[playerNumber] = null
      }
      if (currentMode === MULTIPLAYER_MODE) {
        serial.SIOMULT_PLAYER_NUMBER = playerNumber
        if (playerNumber === 0 && serial.SIOTransferStarted) armMultiTransfer()
        else if (playerNumber === 0 && !serial.SIOTransferStarted) {
          multiTransferActive = false
          serials[1].SIOTransferStarted = false
        } else if (playerNumber === 1) {
          serial.SIOTransferStarted = multiTransferActive
        }
      }
    }

    serial.readSIOCNT0 = function () {
      const value = original.readSIOCNT0.call(serial)
      if (serial.RCNTMode >= 2) return value
      if (serial.SIOCNT_MODE === MULTIPLAYER_MODE) {
        const connected = serials.every((port) => port.RCNTMode < 2 && port.SIOCNT_MODE === MULTIPLAYER_MODE)
        // Multi 模式的 SI-Terminal 用于识别主从，SD-Terminal 表示所有连接单位已就绪。
        return (value & ~0x3c) | (playerNumber << 4) | (playerNumber === 0 ? 0 : 0x04) | (connected ? 0x08 : 0)
      }
      if (serial.SIOCNT_MODE === NORMAL_8BIT_MODE || serial.SIOCNT_MODE === NORMAL_32BIT_MODE) {
        const peerIndex = playerNumber === 0 ? 1 : 0
        const peer = serials[peerIndex]
        return (value & ~0x04) | (normalSoLevel(peer, peerIndex) ? 0x04 : 0)
      }
      return value
    }

    // 普通游戏会读取 RCNT 探测外设；读取静态 GPIO 电平不是数据传输，不能据此中止联机。
    serial.readRCNT0 = function () {
      return original.readRCNT0.call(serial)
    }

    serial.writeRCNT0 = function (data: number) {
      if (serial.RCNTMode === 2) {
        // RFU 登录用 GPIO 的 PD 复位脉冲（bit 5 拉高且旧 bit 1 为低）；它必须识别为
        // 无线协议，不能把握手寄存器伪装成普通 GPIO 电缆数据。
        const previousBits = serial.RCNTDataBits & 0x0f
        const previousDirections = serial.RCNTDataBitFlow & 0x0f
        const rfuResetPulse = (data & 0x20) !== 0 && (previousBits & 0x02) === 0
        if (rfuResetPulse) markUnsupportedProtocol('RFU')
        original.writeRCNT0.call(serial, data)

        // GPIO 联机协议至少要让输出的 SC 线完成一个高低周期。游戏启动时常写一次
        // GPIO 配置、读回静态状态或拉高一根线探测附件；这些都不是串行数据，不能误杀。
        const clockOutput = (previousDirections & 0x04) !== 0 && (serial.RCNTDataBitFlow & 0x04) !== 0
        const clockEdge = ((previousBits ^ serial.RCNTDataBits) & 0x04) !== 0
        if (!rfuResetPulse && clockOutput && clockEdge) {
          gpioClockEdges++
          if (gpioClockEdges >= 2) markUnsupportedProtocol('GPIO')
        }
        return
      }
      original.writeRCNT0.call(serial, data)
    }

    serial.writeSIOCNT1 = function (data: number) {
      const previousMode = serial.SIOCNT_MODE
      original.writeSIOCNT1.call(serial, data)
      if (serial.SIOCNT_MODE === MULTIPLAYER_MODE) {
        // 16 位 SIOCNT 写入先到低字节；切到 Multi 时低字节处理仍看见旧模式，必须在此补定座位。
        serial.SIOMULT_PLAYER_NUMBER = playerNumber
      }
      if (!serial.SIOTransferStarted && serial.SIOCNT_MODE !== previousMode) normalOutbox[playerNumber] = null
      // Iodine 的 UART 是独立 FIFO 协议；发现启用收发时停止联机，不伪造串口回包。
      if (
        serial.SIOCNT_MODE === UART_MODE &&
        (serial.SIOCNT_UART_SEND_ENABLE || serial.SIOCNT_UART_RECV_ENABLE)
      ) markUnsupportedProtocol('UART')
    }

    serial.writeRCNT1 = function (data: number) {
      const previousMode = serial.RCNTMode
      original.writeRCNT1.call(serial, data)
      if (serial.RCNTMode !== previousMode) gpioClockEdges = 0
    }

    // JoyBus 的寄存器协议与 GBA 电缆位移时序无关；保留上游寄存器行为，但阻止伪造回包。
    serial.readJOYCNT = wrapJoyBusAccess(original.readJOYCNT)
    serial.writeJOYCNT = wrapJoyBusAccess(original.writeJOYCNT)
    serial.readJOYBUS_RECV0 = wrapJoyBusAccess(original.readJOYBUS_RECV0)
    serial.readJOYBUS_RECV1 = wrapJoyBusAccess(original.readJOYBUS_RECV1)
    serial.readJOYBUS_RECV2 = wrapJoyBusAccess(original.readJOYBUS_RECV2)
    serial.readJOYBUS_RECV3 = wrapJoyBusAccess(original.readJOYBUS_RECV3)
    serial.writeJOYBUS_RECV0 = wrapJoyBusAccess(original.writeJOYBUS_RECV0)
    serial.writeJOYBUS_RECV1 = wrapJoyBusAccess(original.writeJOYBUS_RECV1)
    serial.writeJOYBUS_RECV2 = wrapJoyBusAccess(original.writeJOYBUS_RECV2)
    serial.writeJOYBUS_RECV3 = wrapJoyBusAccess(original.writeJOYBUS_RECV3)
    serial.readJOYBUS_SEND0 = wrapJoyBusAccess(original.readJOYBUS_SEND0)
    serial.readJOYBUS_SEND1 = wrapJoyBusAccess(original.readJOYBUS_SEND1)
    serial.readJOYBUS_SEND2 = wrapJoyBusAccess(original.readJOYBUS_SEND2)
    serial.readJOYBUS_SEND3 = wrapJoyBusAccess(original.readJOYBUS_SEND3)
    serial.writeJOYBUS_SEND0 = wrapJoyBusAccess(original.writeJOYBUS_SEND0)
    serial.writeJOYBUS_SEND1 = wrapJoyBusAccess(original.writeJOYBUS_SEND1)
    serial.writeJOYBUS_SEND2 = wrapJoyBusAccess(original.writeJOYBUS_SEND2)
    serial.writeJOYBUS_SEND3 = wrapJoyBusAccess(original.writeJOYBUS_SEND3)
    serial.readJOYBUS_STAT = wrapJoyBusAccess(original.readJOYBUS_STAT)
    serial.writeJOYBUS_STAT = wrapJoyBusAccess(original.writeJOYBUS_STAT)

    // 本桥在帧边界交换寄存器，不让上游按其相反的时钟位判定执行数十万次空移位。
    serial.addClocks = function (clocks: number) {
      if (destroyed) return original.addClocks.call(serial, clocks)
      serial.shiftClocks = 0
    }

    // 核心原实现把“未连接”当成全 1 输入；阻止假完成，由 settleFrame 统一处理。
    serial.clockSerial = function () {
      if (destroyed) original.clockSerial.call(serial)
    }
    serial.clockMultiplayer = function () {
      if (destroyed) original.clockMultiplayer.call(serial)
    }
    serial.clockUART = function () {
      if (destroyed) original.clockUART.call(serial)
      else markUnsupportedProtocol('UART')
    }
  }

  return {
    get failureReason() {
      return failureReason
    },
    settleFrame() {
      if (destroyed) return 'idle'
      if (failed) return 'failed'
      if (unsupportedSerialActivity) {
        const protocol = unsupportedProtocol ?? 'RFU'
        failTransfer(`当前游戏实际使用了暂未支持的 GBA ${protocol} 串口协议`)
        return 'failed'
      }

      const [first, second] = serials
      if (
        serials.some((serial) => serial.RCNTMode >= 2) &&
        (multiTransferActive || serials.some((serial) => serial.SIOTransferStarted))
      ) {
        failTransfer('GBA 串口传输过程中切换到了 GPIO/JoyBus 模式')
        return 'failed'
      }
      if (first.SIOCNT_MODE === MULTIPLAYER_MODE && second.SIOCNT_MODE === MULTIPLAYER_MODE) {
        if (!multiTransferActive) {
          // 1 号口不会自主发起 Multi 传输；等 0 号口写 Start。
          if (!first.SIOTransferStarted) {
            pendingNormalFrames = 0
            return 'idle'
          }
          armMultiTransfer()
        }
        if (
          first.SIOCNT_MODE !== MULTIPLAYER_MODE ||
          second.SIOCNT_MODE !== MULTIPLAYER_MODE ||
          !first.SIOTransferStarted ||
          !second.SIOTransferStarted ||
          first.SIOBaudRate !== second.SIOBaudRate ||
          first.SIOMULT_PLAYER_NUMBER !== 0 ||
          second.SIOMULT_PLAYER_NUMBER !== 1
        ) {
          failTransfer('两台核心的 Multi-Pak 串口模式、玩家座位或波特率不一致')
          return 'failed'
        }
        const words = multiSendWords
        completeTransfer((serial) => {
          serial.SIODATA_A = words[0]
          serial.SIODATA_B = words[1]
          serial.SIODATA_C = WORD_MASK
          serial.SIODATA_D = WORD_MASK
        })
        return 'transferred'
      }

      if (first.SIOCNT_MODE === MULTIPLAYER_MODE || second.SIOCNT_MODE === MULTIPLAYER_MODE) {
        if (!first.SIOTransferStarted && !second.SIOTransferStarted) {
          pendingNormalFrames = 0
          return 'idle'
        }
        pendingNormalFrames++
        if (pendingNormalFrames >= MAX_PENDING_FRAMES) {
          failTransfer('两台核心进入了不同的 GBA 串口模式')
          return 'failed'
        }
        return 'waiting'
      }

      const active = serials.some((serial) => serial.SIOTransferStarted)
      if (!active) {
        pendingNormalFrames = 0
        return 'idle'
      }
      pendingNormalFrames++
      if (first.SIOTransferStarted && second.SIOTransferStarted) {
        if (
          first.SIOCNT_MODE !== second.SIOCNT_MODE ||
          first.SIOCNT_MODE > NORMAL_32BIT_MODE ||
          first.SIOShiftClockDivider !== second.SIOShiftClockDivider
        ) {
          failTransfer('两台核心的普通串口模式或传输速率不一致')
          return 'failed'
        }
        // bit 0 = 1 是内部时钟主机，0 是外部时钟从机；同时主机或同时从机都不能传输。
        if (first.SIOShiftClockExternal !== second.SIOShiftClockExternal) {
          const payloads: [number, number] = [
            normalOutbox[0] ?? readNormalPayload(first),
            normalOutbox[1] ?? readNormalPayload(second),
          ]
          if (first.SIOCNT_MODE === NORMAL_8BIT_MODE) {
            completeTransfer((serial, peer) => {
              serial.SIODATA8 = (serial.SIODATA8 & 0xff00) | (peer === first ? payloads[0] : payloads[1])
            })
            return 'transferred'
          }
          completeTransfer((serial, peer) => writeNormal32(serial, peer === first ? payloads[0] : payloads[1]))
          return 'transferred'
        }
      }
      if (pendingNormalFrames >= MAX_PENDING_FRAMES) {
        failTransfer('等待 GBA 串口对端超时；请确认双方使用相同游戏并已进入联机模式')
        return 'failed'
      }
      return 'waiting'
    },
    destroy() {
      if (destroyed) return
      if (
        multiTransferActive ||
        unsupportedSerialActivity ||
        serials.some((serial) => serial.SIOTransferStarted)
      ) failTransfer()
      destroyed = true
      for (let index = 0; index < serials.length; index++) {
        const serial = serials[index]
        const original = originals[index]
        serial.writeSIOCNT0 = original.writeSIOCNT0
        serial.writeSIOCNT1 = original.writeSIOCNT1
        serial.readSIOCNT0 = original.readSIOCNT0
        serial.writeRCNT1 = original.writeRCNT1
        serial.readRCNT0 = original.readRCNT0
        serial.writeRCNT0 = original.writeRCNT0
        serial.readJOYCNT = original.readJOYCNT
        serial.writeJOYCNT = original.writeJOYCNT
        serial.readJOYBUS_RECV0 = original.readJOYBUS_RECV0
        serial.readJOYBUS_RECV1 = original.readJOYBUS_RECV1
        serial.readJOYBUS_RECV2 = original.readJOYBUS_RECV2
        serial.readJOYBUS_RECV3 = original.readJOYBUS_RECV3
        serial.writeJOYBUS_RECV0 = original.writeJOYBUS_RECV0
        serial.writeJOYBUS_RECV1 = original.writeJOYBUS_RECV1
        serial.writeJOYBUS_RECV2 = original.writeJOYBUS_RECV2
        serial.writeJOYBUS_RECV3 = original.writeJOYBUS_RECV3
        serial.readJOYBUS_SEND0 = original.readJOYBUS_SEND0
        serial.readJOYBUS_SEND1 = original.readJOYBUS_SEND1
        serial.readJOYBUS_SEND2 = original.readJOYBUS_SEND2
        serial.readJOYBUS_SEND3 = original.readJOYBUS_SEND3
        serial.writeJOYBUS_SEND0 = original.writeJOYBUS_SEND0
        serial.writeJOYBUS_SEND1 = original.writeJOYBUS_SEND1
        serial.writeJOYBUS_SEND2 = original.writeJOYBUS_SEND2
        serial.writeJOYBUS_SEND3 = original.writeJOYBUS_SEND3
        serial.readJOYBUS_STAT = original.readJOYBUS_STAT
        serial.writeJOYBUS_STAT = original.writeJOYBUS_STAT
        serial.addClocks = original.addClocks
        serial.clockSerial = original.clockSerial
        serial.clockMultiplayer = original.clockMultiplayer
        serial.clockUART = original.clockUART
      }
    },
  }
}

/** 保留旧导出名，避免仓库中已有的工具或测试脚本在升级时失效。 */
export const attachGbaMultiPakCable = attachGbaCable
