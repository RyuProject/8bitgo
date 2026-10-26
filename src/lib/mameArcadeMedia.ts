import type { ArcadeMameDisk } from '@/types'
import type { ZipFileEntry } from './unzip'
import {
  knownMameArcadeMediaForRomset,
  mameArcadeDiskObjectKey,
} from '../../shared/mame-arcade-media.js'

/** 浏览器不需要解 CHD；只读固定 124 字节头即可在上传/开局前识别错误媒体。 */
export const MAME_CHD_V5_HEADER_BYTES = 124

export interface MameChdHeader {
  version: number
  headerBytes: number
  compressors: readonly string[]
  logicalBytes: number
  hunkBytes: number
  unitBytes: number
  /** chdman info 里的 Data SHA1。 */
  dataSha1: string
  /** chdman info 里的 SHA1。 */
  chdSha1: string
}

export interface MameArcadeDiskProfile {
  romset: string
  board: string
  disks: readonly Omit<ArcadeMameDisk, 'key'>[]
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

function u64(view: DataView, offset: number): number {
  const value = (BigInt(view.getUint32(offset, false)) << 32n) | BigInt(view.getUint32(offset + 4, false))
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CHD 逻辑容量超过浏览器可安全处理的范围')
  return Number(value)
}

function fourCc(view: DataView, offset: number): string {
  const value = view.getUint32(offset, false)
  if (value === 0) return ''
  return String.fromCharCode((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
}

/**
 * 解析 CHD v5 固定头。这里故意不声称完成了完整扇区校验：完整验证要由 chdman/MAME 做，
 * 浏览器这一层的职责是尽早挡掉“把 BIOS 或别的 CHD 传上来”的配置错误。
 */
export function readMameChdHeader(input: ArrayBuffer | Uint8Array): MameChdHeader {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.byteLength < MAME_CHD_V5_HEADER_BYTES) throw new Error('CHD 文件太小，缺少 v5 文件头')
  if (new TextDecoder().decode(bytes.subarray(0, 8)) !== 'MComprHD') throw new Error('不是 MAME CHD 文件（缺少 MComprHD 标识）')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const headerBytes = view.getUint32(8, false)
  const version = view.getUint32(12, false)
  if (version !== 5 || headerBytes !== MAME_CHD_V5_HEADER_BYTES) {
    throw new Error(`只支持可验证的 CHD v5（当前是 v${version}，头长 ${headerBytes}）`)
  }
  const compressors = [16, 20, 24, 28].map((offset) => fourCc(view, offset)).filter(Boolean)
  return {
    version,
    headerBytes,
    compressors,
    logicalBytes: u64(view, 32),
    hunkBytes: view.getUint32(56, false),
    unitBytes: view.getUint32(60, false),
    dataSha1: hex(bytes.subarray(64, 84)),
    chdSha1: hex(bytes.subarray(84, 104)),
  }
}

/** 当前已用真实文件 + chdman verify 核验过的 Namco System 10《太鼓之达人2》。 */
export const TAIKO2_MAME_MEDIA = knownMameArcadeMediaForRomset('taiko2') as MameArcadeDiskProfile

const TAIKO2_ROM_FILES: Readonly<Record<string, { crc32: number; bytes: number }>> = {
  'tk21verc_0.8e': { crc32: 0xf3842791, bytes: 17301504 },
  'tk21verc_1.8d': { crc32: 0xe294f460, bytes: 17301504 },
  'tk21verc_2.7e': { crc32: 0xf1dbe387, bytes: 17301504 },
}

/** 只在 ZIP 恰好是 taiko2 的三颗 NAND、每颗 CRC/容量都相符时才启用 MAME CHD 工作流。 */
export function identifyKnownMameArcadeMedia(entries: readonly Pick<ZipFileEntry, 'name' | 'crc32' | 'uncompressedSize'>[]): MameArcadeDiskProfile | null {
  if (entries.length !== Object.keys(TAIKO2_ROM_FILES).length) return null
  const seen = new Set<string>()
  for (const entry of entries) {
    if (entry.name.includes('/')) return null
    const name = entry.name.toLowerCase()
    const expected = TAIKO2_ROM_FILES[name]
    if (!expected || seen.has(name) || (entry.crc32 >>> 0) !== expected.crc32 || entry.uncompressedSize !== expected.bytes) return null
    seen.add(name)
  }
  return seen.size === Object.keys(TAIKO2_ROM_FILES).length ? TAIKO2_MAME_MEDIA : null
}

export function mameDiskHeaderProblem(file: Pick<Blob, 'size' | 'slice'>, expected: Omit<ArcadeMameDisk, 'key'>): Promise<string | null> {
  if (file.size !== expected.storedBytes) return Promise.resolve(`CHD 文件大小不符：应为 ${expected.storedBytes.toLocaleString()} 字节，实际为 ${file.size.toLocaleString()} 字节`)
  return file.slice(0, MAME_CHD_V5_HEADER_BYTES).arrayBuffer().then((bytes) => {
    const header = readMameChdHeader(bytes)
    if (header.chdSha1 !== expected.chdSha1 || header.dataSha1 !== expected.dataSha1 || header.logicalBytes !== expected.logicalBytes) {
      return 'CHD 头中的 SHA-1 或逻辑容量与此游戏需要的媒体不一致'
    }
    return null
  }).catch((error: unknown) => error instanceof Error ? error.message : '无法读取 CHD 文件头')
}

export function mameDiskObjectKey(disk: Omit<ArcadeMameDisk, 'key'>): string {
  // SHA-1 是内容身份；同一张盘给多个游戏引用时自然复用，版本不同时绝不会原地覆盖。
  return mameArcadeDiskObjectKey(disk)
}
