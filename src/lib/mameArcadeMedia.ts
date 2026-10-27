import type { ArcadeMameDisk } from '@/types'
import type { ZipFileEntry } from './unzip'
import {
  knownMameArcadeMediaForRomset,
  mameArcadeDiskObjectKey,
} from '../../shared/mame-arcade-media.js'
import { identifyMameChdSet, type MameChdDiskExpectation } from './mameChdSets'

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

export interface MameArcadeDiskExpectation extends MameChdDiskExpectation {
  /**
   * 已实盘核验的条目会固定 Data SHA-1 与逻辑容量；通用 MAME 目录在选文件时从头部补齐。
   * `storedBytes` 只用于已保存历史记录，不能作为目录条件：无损重压同一 CHD 时它会变化。
   */
  dataSha1?: string
  storedBytes?: number
  logicalBytes?: number
}

export interface MameArcadeDiskProfile {
  romset: string
  board: string
  disks: readonly MameArcadeDiskExpectation[]
  source?: string
}

/**
 * 后台绑定的媒体盘是否满足驱动要求。
 *
 * MAME 认的是 CHD SHA-1；Data SHA-1 和逻辑容量只在目录里写了的时候才比（通用目录只有 CHD SHA-1）。
 * ⚠️ `storedBytes` **不参与**：无损重压同一张盘时它会变（见 MameArcadeDiskExpectation 的注释）。
 * 2026-10-27 线上《狂热节拍》：目录早已去掉 storedBytes，播放器这里却还在逐字段 `===`，
 * `134647845 === undefined` 恒为假 —— 盘明明绑好了，每次开局都报「缺少必需的媒体盘」。
 */
export function mameDiskSatisfies(
  disk: Pick<MameArcadeDiskExpectation, 'romset' | 'name' | 'chdSha1' | 'dataSha1' | 'logicalBytes'>,
  expected: MameArcadeDiskExpectation,
): boolean {
  return disk.romset === expected.romset &&
    disk.name === expected.name &&
    disk.chdSha1 === expected.chdSha1 &&
    (expected.dataSha1 === undefined || disk.dataSha1 === expected.dataSha1) &&
    (expected.logicalBytes === undefined || disk.logicalBytes === expected.logicalBytes)
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
/** Konami GQ753《狂热节拍 / beatmania》首作，使用一张独立 IDE CHD。 */
export const BM1STMIX_MAME_MEDIA = knownMameArcadeMediaForRomset('bm1stmix') as MameArcadeDiskProfile

const TAIKO2_ROM_FILES: Readonly<Record<string, { crc32: number; bytes: number }>> = {
  'tk21verc_0.8e': { crc32: 0xf3842791, bytes: 17301504 },
  'tk21verc_1.8d': { crc32: 0xe294f460, bytes: 17301504 },
  'tk21verc_2.7e': { crc32: 0xf1dbe387, bytes: 17301504 },
}

/**
 * MAME 官方 bm1stmix 驱动的十颗 27C040。所有文件都是 512 KiB；仍逐个比 CRC，
 * 不能只看 ZIP 名称，因为克隆版/混合包会同样叫 bm1stmix.zip 却无法配这张硬盘。
 */
const BM1STMIX_ROM_FILES: Readonly<Record<string, { crc32: number; bytes: number }>> = {
  '753jab01.6a': { crc32: 0x25bf8629, bytes: 524288 },
  '753jab02.8a': { crc32: 0x6ab951de, bytes: 524288 },
  '753jaa03.19a': { crc32: 0xf2b2bce8, bytes: 524288 },
  '753jaa04.20a': { crc32: 0x85a18f9d, bytes: 524288 },
  '753jaa05.22a': { crc32: 0x749b1e87, bytes: 524288 },
  '753jaa06.24a': { crc32: 0x6d86b0fd, bytes: 524288 },
  '753jaa07.22d': { crc32: 0xf03ab5d8, bytes: 524288 },
  '753jaa08.23d': { crc32: 0x6559f0c8, bytes: 524288 },
  '753jaa09.25d': { crc32: 0xb50c3dbb, bytes: 524288 },
  '753jaa10.27d': { crc32: 0x391f4bfd, bytes: 524288 },
}

const KNOWN_MAME_MEDIA_ROMSETS: readonly {
  readonly profile: MameArcadeDiskProfile
  readonly files: Readonly<Record<string, { crc32: number; bytes: number }>>
}[] = [
  { profile: TAIKO2_MAME_MEDIA, files: TAIKO2_ROM_FILES },
  { profile: BM1STMIX_MAME_MEDIA, files: BM1STMIX_ROM_FILES },
]

/** 只在 ZIP 恰好是 taiko2 的三颗 NAND、每颗 CRC/容量都相符时才启用 MAME CHD 工作流。 */
function exactMameMediaRomset(
  entries: readonly Pick<ZipFileEntry, 'name' | 'crc32' | 'uncompressedSize'>[],
  files: Readonly<Record<string, { crc32: number; bytes: number }>>,
): boolean {
  if (entries.length !== Object.keys(files).length) return false
  const seen = new Set<string>()
  for (const entry of entries) {
    if (entry.name.includes('/')) return false
    const name = entry.name.toLowerCase()
    const expected = files[name]
    if (!expected || seen.has(name) || (entry.crc32 >>> 0) !== expected.crc32 || entry.uncompressedSize !== expected.bytes) return false
    seen.add(name)
  }
  return seen.size === Object.keys(files).length
}

/**
 * 只在 ZIP 与已核验的 MAME 驱动逐项相等时显示 CHD 上传位。
 *
 * 这里不能靠文件名猜：merged/clone 或“补丁后仍沿用原文件名”的 ZIP 一旦被错配，
 * 上传成功也会在 MAME 启动时变成难诊断的 missing files。
 */
export function identifyKnownMameArcadeMedia(
  entries: readonly Pick<ZipFileEntry, 'name' | 'crc32' | 'uncompressedSize'>[],
  fileName?: string,
): MameArcadeDiskProfile | null {
  const strict = KNOWN_MAME_MEDIA_ROMSETS.find(({ files }) => exactMameMediaRomset(entries, files))?.profile
  if (strict) return strict
  const catalog = identifyMameChdSet(entries, fileName)
  /*
    已实盘核验的条目有更严的“没有多余成员”规则。若它命中目录却没命中严格清单，
    说明 ZIP 不是那份我们验证过的原始包；不能为了 merged 宽松匹配而退化安全界限。
  */
  if (catalog && KNOWN_MAME_MEDIA_ROMSETS.some(({ profile }) => profile.romset === catalog.romset)) return null
  return catalog
}

async function validatedMameDisk(file: Pick<Blob, 'size' | 'slice'>, expected: MameArcadeDiskExpectation): Promise<Omit<ArcadeMameDisk, 'key'>> {
  if (!Number.isSafeInteger(file.size) || file.size < MAME_CHD_V5_HEADER_BYTES || file.size > 1024 * 1024 * 1024) {
    throw new Error('CHD 文件容量不合法（本站当前上限为 1 GiB）')
  }
  const header = readMameChdHeader(await file.slice(0, MAME_CHD_V5_HEADER_BYTES).arrayBuffer())
  if (header.chdSha1 !== expected.chdSha1) {
    throw new Error('CHD SHA-1 与 MAME 驱动要求的媒体不一致')
  }
  if ((expected.dataSha1 !== undefined && header.dataSha1 !== expected.dataSha1) ||
      (expected.logicalBytes !== undefined && header.logicalBytes !== expected.logicalBytes)) {
    throw new Error('CHD 头中的 Data SHA-1 或逻辑容量与已核验媒体不一致')
  }
  return {
    romset: expected.romset,
    name: expected.name,
    chdSha1: header.chdSha1,
    dataSha1: header.dataSha1,
    storedBytes: file.size,
    logicalBytes: header.logicalBytes,
  }
}

/** 上传前的只读校验；失败原因给 UI，成功时由 mameDiskFromFile 复用同一规则生成持久化描述。 */
export function mameDiskHeaderProblem(file: Pick<Blob, 'size' | 'slice'>, expected: MameArcadeDiskExpectation): Promise<string | null> {
  return validatedMameDisk(file, expected).then(() => null).catch((error: unknown) => error instanceof Error ? error.message : '无法读取 CHD 文件头')
}

/**
 * 将 MAME 源码里的“预期盘”与实际 v5 CHD 头合成可保存的完整记录。
 * Data SHA-1 / 压缩大小不能从 MAME 源码推断，必须来源于管理员选中的那一份文件。
 */
export function mameDiskFromFile(file: Pick<Blob, 'size' | 'slice'>, expected: MameArcadeDiskExpectation): Promise<Omit<ArcadeMameDisk, 'key'>> {
  return validatedMameDisk(file, expected)
}

export function mameDiskObjectKey(disk: Pick<ArcadeMameDisk, 'chdSha1' | 'name'>): string {
  // SHA-1 是内容身份；同一张盘给多个游戏引用时自然复用，版本不同时绝不会原地覆盖。
  return mameArcadeDiskObjectKey(disk)
}
