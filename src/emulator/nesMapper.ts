/**
 * 从 iNES / NES 2.0 文件头里读出 mapper 编号，并回答「jsnes 跑不跑得了」。
 *
 * 为什么需要它：受支持的 `.nes` 可交给 jsnes（纯 JS，不用下 WASM 核心，启动快），可它只实现了
 * 21 个 mapper。碰上没实现的，它在 `loadROM` 里抛一句
 * `Unsupported mapper: 25`，玩家看到的就是一条红字 —— 而同一份 ROM 在 EmulatorJS
 * 的 FCEUmm 核心里毫无问题。真实案例：忍者神龟 3（mapper 25 = Konami VRC4）。
 *
 * 有了这两个函数，适配器就能在**构造引擎之前**认出来，把这一局让给 EmulatorJS，
 * 而不是先失败再让玩家自己想办法。
 */

/**
 * jsnes 实现了的 mapper。
 *
 * 抄自 `node_modules/jsnes/src/mappers/index.js` 的那张注册表 —— 升级 jsnes 之后
 * 请照着那个文件核一遍。多写了会让玩家撞回红字，少写了只是白白多下一个核心，
 * 所以宁可少写。
 */
export const JSNES_MAPPERS: ReadonlySet<number> = new Set([
  0, 1, 2, 3, 4, 5, 7, 9, 11, 34, 38, 66, 71, 79, 94, 118, 119, 140, 180, 240, 241,
])

/** iNES 文件头的魔数：'N' 'E' 'S' 0x1A */
const MAGIC = [0x4e, 0x45, 0x53, 0x1a]

export type JsnesCompatibilityCode =
  | 'supported'
  | 'header-too-short'
  | 'not-ines'
  | 'unsupported-mapper'
  | 'unsupported-submapper'
  | 'unsupported-console'
  | 'unsupported-timing'
  | 'unsupported-trainer'
  | 'unsupported-size-encoding'
  | 'invalid-prg-size'
  | 'truncated-rom'

export interface JsnesCompatibility {
  compatible: boolean
  code: JsnesCompatibilityCode
  message: string
  mapper?: number
  submapper?: number
  expectedBytes?: number
  actualBytes?: number
}

function bytesOf(rom: ArrayBuffer | Uint8Array): Uint8Array {
  return rom instanceof Uint8Array ? rom : new Uint8Array(rom)
}

function isInesHeader(b: Uint8Array): boolean {
  if (b.length < 16) return false
  for (let i = 0; i < MAGIC.length; i++) if (b[i] !== MAGIC[i]) return false
  return true
}

/** 必须逐位复刻 jsnes 2.1.0 的 ROM._loadINES1Header / _loadNES2Header，不能自作聪明纠偏。 */
function mapperFromHeader(b: Uint8Array): { mapper: number; nes2: boolean } {
  const nes2 = (b[7] & 0x0c) === 0x08
  if (nes2) {
    return {
      mapper: ((b[8] & 0x0f) << 8) | (b[7] & 0xf0) | (b[6] >> 4),
      nes2,
    }
  }

  let mapper = (b[6] >> 4) | (b[7] & 0xf0)
  // jsnes 把 iNES 1.0 的 8-15 任一非零都视为脏头，并丢掉 byte 7 的高半字节。
  for (let i = 8; i < 16; i++) {
    if (b[i] !== 0) {
      mapper &= 0x0f
      break
    }
  }
  return { mapper, nes2 }
}

/**
 * 读出 mapper 编号；不是 iNES 文件（或头都不完整）时返回 null。
 *
 * 两种格式混在同一个魔数下面，得分开对待：
 *
 *  · **NES 2.0**（字节 7 的 bit2-3 == 0b10）：mapper 是 12 位，
 *    低 4 位在字节 6 高半字节、中 4 位在字节 7 高半字节、高 4 位在字节 8 低半字节。
 *  · **干净的 iNES 1.0**：mapper 8 位，字节 6 高半字节 + 字节 7 高半字节。
 *  · **脏的 iNES 1.0**：上世纪的一批工具会把自己的名字（最有名的是 `DiskDude!`）
 *    直接写进字节 7-15。那种文件的字节 7 高半字节是 ASCII 的一部分，当 mapper 用
 *    会得到一个荒唐的编号（`DiskDude!` 会让 mapper 变成 64 的倍数）。
 *    判据是看字节 **8-15** 是不是全零：全零才认为字节 7 可信。
 *    宁可只取低 4 位 —— 猜错成大编号会让我们以为 jsnes 跑不了、白下一个核心；
 *    而真正的低编号游戏本来就该走 jsnes。
 *
 * ⚠️ **判据必须和 jsnes 自己那套逐位一致**。尤其不能用文件大小去“纠正”疑似 NES 2.0
 * 的脏头：jsnes 仍会按 NES 2.0 解析。我们若先纠正成 iNES 1.0，便可能把 ROM 交给 jsnes，
 * 随后 jsnes 又读出另一个 mapper 并确定性失败。这里宁可保守转交 EmulatorJS，也不制造
 * “预判支持、实际不支持”的双重解释。
 */
export function readNesMapper(rom: ArrayBuffer | Uint8Array): number | null {
  const b = bytesOf(rom)
  return isInesHeader(b) ? mapperFromHeader(b).mapper : null
}

/**
 * 给运行时选择用的完整静态体检。
 *
 * mapper “存在”不等于板子真的兼容：jsnes 虽然解析 NES 2.0 的 submapper、制式和主机类型，
 * 但它的 mapper / 时钟实现根本不读取这些字段。继续放行会产生最难排查的假成功——画面能出，
 * 速度、IRQ、存档或 bank wiring 却不对。因此只有能被 jsnes 无歧义表达的普通 NES/NTSC ROM
 * 才判 compatible；其余交给 FCEUmm。
 *
 * `totalBytes` 用于只拿到 16 字节 Range 头时校验完整性；本地传整份 ROM 时可省略。
 */
export function analyzeJsnesCompatibility(
  rom: ArrayBuffer | Uint8Array,
  totalBytes?: number,
): JsnesCompatibility {
  const b = bytesOf(rom)
  if (b.length < 16) {
    return { compatible: false, code: 'header-too-short', message: 'iNES 文件头不足 16 字节' }
  }
  if (!isInesHeader(b)) {
    return { compatible: false, code: 'not-ines', message: 'jsnes 只接受 iNES / NES 2.0 格式' }
  }

  const { mapper, nes2 } = mapperFromHeader(b)
  if (!JSNES_MAPPERS.has(mapper)) {
    return { compatible: false, code: 'unsupported-mapper', message: `jsnes 未实现 mapper ${mapper}`, mapper }
  }

  // jsnes 只跳过 trainer 的 512 字节，却没有按 iNES 约定把它装入 $7000-$71FF。
  // 这类 ROM 即便能开机，也可能在进入关卡后才读到错误数据，必须交给完整核心。
  if ((b[6] & 0x04) !== 0) {
    return {
      compatible: false,
      code: 'unsupported-trainer',
      message: 'jsnes 不会把 iNES trainer 映射到卡带内存',
      mapper,
    }
  }

  const consoleType = b[7] & 0x03
  if (consoleType !== 0) {
    return {
      compatible: false,
      code: 'unsupported-console',
      message: `jsnes 不支持该主机类型（console ${consoleType}）`,
      mapper,
    }
  }

  let prgUnits: number
  let chrUnits: number
  if (nes2) {
    const submapper = (b[8] >> 4) & 0x0f
    if (submapper !== 0) {
      return {
        compatible: false,
        code: 'unsupported-submapper',
        message: `jsnes mapper ${mapper} 不区分 submapper ${submapper}`,
        mapper,
        submapper,
      }
    }

    const timingMode = b[12] & 0x03
    if (timingMode !== 0) {
      return {
        compatible: false,
        code: 'unsupported-timing',
        message: `jsnes 不支持该 NES 2.0 制式（timing ${timingMode}）`,
        mapper,
      }
    }

    const prgHigh = b[9] & 0x0f
    const chrHigh = (b[9] >> 4) & 0x0f
    if (prgHigh === 0x0f || chrHigh === 0x0f) {
      return {
        compatible: false,
        code: 'unsupported-size-encoding',
        message: 'jsnes 对 NES 2.0 指数尺寸会按整 bank 补齐，可能错位读取 CHR',
        mapper,
      }
    }
    prgUnits = (prgHigh << 8) | b[4]
    chrUnits = (chrHigh << 8) | b[5]
  } else {
    // jsnes 的 CPU/PPU 固定按 NTSC 跑；iNES byte 9 标 PAL 时强行启动会整体变速。
    if ((b[9] & 0x01) !== 0) {
      return {
        compatible: false,
        code: 'unsupported-timing',
        message: 'jsnes 不支持 iNES PAL 制式',
        mapper,
      }
    }
    prgUnits = b[4]
    chrUnits = b[5]
  }

  if (prgUnits <= 0) {
    return { compatible: false, code: 'invalid-prg-size', message: 'iNES 文件头没有声明 PRG-ROM', mapper }
  }

  const expectedBytes = 16 + prgUnits * 16_384 + chrUnits * 8_192
  const knownBytes = Number.isFinite(totalBytes) && Number(totalBytes) > 0
    ? Math.floor(Number(totalBytes))
    : b.byteLength > 16
      ? b.byteLength
      : undefined
  if (knownBytes !== undefined && knownBytes < expectedBytes) {
    return {
      compatible: false,
      code: 'truncated-rom',
      message: `ROM 不完整：文件头声明至少 ${expectedBytes} 字节，实际 ${knownBytes} 字节`,
      mapper,
      expectedBytes,
      actualBytes: knownBytes,
    }
  }

  return {
    compatible: true,
    code: 'supported',
    message: `iNES ${nes2 ? '2.0' : '1.0'} mapper ${mapper} 可由 jsnes 明确支持`,
    mapper,
    expectedBytes,
    actualBytes: knownBytes,
  }
}

/**
 * jsnes 能不能跑这份 ROM。
 *
 * **认不出格式时返回 false**：jsnes 2.1.0 的 ROM.load 只接受 `NES\\x1a` iNES，
 * 并不支持 UNIF / FDS。以前把未知格式乐观放行，会先下载并创建 jsnes，再确定性失败后
 * 切 EmulatorJS；容器头 `8BG1` 也会被误当成“可以试”。未知格式直接交给兼容面更宽的引擎。
 */
export function jsnesCanRun(rom: ArrayBuffer | Uint8Array, totalBytes?: number): boolean {
  return analyzeJsnesCompatibility(rom, totalBytes).compatible
}
