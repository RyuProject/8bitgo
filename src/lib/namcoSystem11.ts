/**
 * 只为已核实过的 Namco System 11 Tekken 父集提供窄范围识别。
 *
 * FBNeo romset 索引不含 System 11；不能因为它没认出来就猜一个相似驱动。这里按 MAME
 * `ROM_START(tekken)` 的根目录成员名 + CRC 逐项核验。用户包中其它地区版/克隆版放在子目录，
 * MAME 对当前 `tekken` set 不会读它们；只有父集的 12 项完整匹配时才允许这个例外。
 */
export interface ArcadeArchiveEntry {
  name: string
  crc32: number
  uncompressedSize?: number
}

export interface NamcoSystem11Match {
  romset: 'tekken'
  board: 'Namco System 11'
  bios: 'namcoc76'
  matchedFiles: number
  nestedExtras: number
}

const TEKKEN_PARENT_FILES: Readonly<Record<string, number>> = {
  'te1rom0l.ic5': 0x03786e09,
  'te1rom0u.ic6': 0x75d91051,
  'te1rom1l.ic3': 0x81416f8e,
  'te1rom1u.ic8': 0xfa7ba433,
  'te1rom2l.ic4': 0x41d77846,
  'te1rom2u.ic7': 0xa678987e,
  'te1sprog.6d': 0x849587e9,
  'te1verb.2f': 0x3dc01aad,
  'te1verb.2k': 0xb9860b29,
  'te1wave.8k': 0xfce6c57a,
  'te2verc.2j': 0x3224c298,
  'te2verc.2l': 0xa24c8c57,
}

/** 拒绝会造成路径歧义或跨目录写入的成员名；绝不对上传包做隐式解压/拍平。 */
export function arcadeArchiveUnsafePathProblem(entries: readonly { name: string }[]): string | null {
  const unsafe = entries.find(({ name }) => {
    if (!name || name.includes('\0') || name.startsWith('/') || /^[a-z]:\//i.test(name)) return true
    return name.split('/').some((part) => part === '.' || part === '..' || part === '')
  })
  return unsafe ? `ZIP 内含不安全路径“${unsafe.name}”；请重新打包后再上传。` : null
}

/** 只在 Tekken 父集 12 个文件逐项 CRC 全匹配时返回；任何缺项、重名或错 CRC 都不猜。 */
export function identifyNamcoSystem11Tekken(entries: readonly ArcadeArchiveEntry[]): NamcoSystem11Match | null {
  if (arcadeArchiveUnsafePathProblem(entries)) return null

  const rootFiles = new Map<string, ArcadeArchiveEntry[]>()
  for (const entry of entries) {
    if (entry.name.includes('/')) continue
    const name = entry.name.toLowerCase()
    const list = rootFiles.get(name)
    if (list) list.push(entry)
    else rootFiles.set(name, [entry])
  }

  for (const [name, expectedCrc] of Object.entries(TEKKEN_PARENT_FILES)) {
    const matches = rootFiles.get(name)
    if (!matches || matches.length !== 1 || (matches[0].crc32 >>> 0) !== expectedCrc) return null
  }

  return {
    romset: 'tekken',
    board: 'Namco System 11',
    bios: 'namcoc76',
    matchedFiles: Object.keys(TEKKEN_PARENT_FILES).length,
    nestedExtras: entries.filter((entry) => entry.name.includes('/')).length,
  }
}

/** C76 BIOS 上传防呆：必须是核心可识别的 namcoc76.zip，且包含原名 c76.bin 的正确 ROM。 */
export function namcoC76BiosProblem(entries: readonly ArcadeArchiveEntry[]): string | null {
  const unsafe = arcadeArchiveUnsafePathProblem(entries)
  if (unsafe) return unsafe
  if (entries.some((entry) => entry.name.includes('/'))) return 'namcoc76.zip 的 c76.bin 必须放在 ZIP 根目录，不能套文件夹。'
  const c76 = entries.filter((entry) => entry.name.toLowerCase() === 'c76.bin')
  if (c76.length !== 1) return '这不是可识别的 Namco C76 BIOS 包：ZIP 根目录必须恰有一个 c76.bin。'
  if (c76[0].uncompressedSize !== 16384 || (c76[0].crc32 >>> 0) !== 0x399faac7) {
    return 'c76.bin 的大小或 CRC 与 Namco C76 BIOS 不符；文件未上传。'
  }
  if (entries.length !== 1) return 'namcoc76.zip 应只包含 c76.bin；请移除其它文件后再上传。'
  return null
}
