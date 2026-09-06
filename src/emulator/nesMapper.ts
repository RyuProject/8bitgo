/**
 * 从 iNES / NES 2.0 文件头里读出 mapper 编号，并回答「jsnes 跑不跑得了」。
 *
 * 为什么需要它：`.nes` 默认交给 jsnes（纯 JS，不用下 WASM 核心，启动快），可它只实现了
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

/**
 * 读出 mapper 编号；不是 iNES 文件（或头都不完整）时返回 null。
 *
 * 三种格式混在同一个魔数下面，得分开对待：
 *
 *  · **NES 2.0**（字节 7 的 bit2-3 == 0b10）：mapper 是 12 位，
 *    低 4 位在字节 6 高半字节、中 4 位在字节 7 高半字节、高 4 位在字节 8 低半字节。
 *  · **干净的 iNES 1.0**：mapper 8 位，字节 6 高半字节 + 字节 7 高半字节。
 *  · **脏的 iNES 1.0**：上世纪的一批工具会把自己的名字（最有名的是 `DiskDude!`）
 *    直接写进字节 7-15。那种文件的字节 7 高半字节是 ASCII 的一部分，当 mapper 用
 *    会得到一个荒唐的编号（`DiskDude!` 会让 mapper 变成 64 的倍数）。
 *    通行的判据是看字节 12-15 是不是全零：全零才认为字节 7 可信。
 *    宁可只取低 4 位 —— 猜错成大编号会让我们以为 jsnes 跑不了、白下一个核心；
 *    而真正的低编号游戏本来就该走 jsnes。
 */
export function readNesMapper(rom: ArrayBuffer | Uint8Array): number | null {
  const b = rom instanceof Uint8Array ? rom : new Uint8Array(rom)
  if (b.length < 16) return null
  for (let i = 0; i < MAGIC.length; i++) if (b[i] !== MAGIC[i]) return null

  const low = b[6] >> 4
  const flags7 = b[7]

  if ((flags7 & 0x0c) === 0x08) return ((b[8] & 0x0f) << 8) | (flags7 & 0xf0) | low

  const trailerClean = b[12] === 0 && b[13] === 0 && b[14] === 0 && b[15] === 0
  return trailerClean ? (flags7 & 0xf0) | low : low
}

/**
 * jsnes 能不能跑这份 ROM。
 *
 * **认不出格式时返回 true**（让 jsnes 自己去试）：这个函数的职责是「提前拦下必然失败的」，
 * 不是替 jsnes 做校验。UNIF、FDS 这些非 iNES 的东西读不出 mapper，
 * 在这里判死会把本来能跑的挡在门外。
 */
export function jsnesCanRun(rom: ArrayBuffer | Uint8Array): boolean {
  const mapper = readNesMapper(rom)
  return mapper === null || JSNES_MAPPERS.has(mapper)
}
