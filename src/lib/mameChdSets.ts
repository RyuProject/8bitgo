import type { ZipFileEntry } from './unzip'
import { MAME_CHD_CATALOG, mameChdProfileForRomset } from '../../shared/mame-chd-catalog.js'

/**
 * 来自 MAME 源码的“待上传媒体”描述。
 *
 * MAME 驱动只规定 CHD 文件名和内容 SHA-1；压缩后的文件大小、Data SHA-1 和逻辑容量
 * 由实际 CHD v5 头决定。因此这些字段在管理员选中 CHD 后才补齐，不能在目录里瞎填。
 */
export interface MameChdDiskExpectation {
  romset: string
  name: string
  chdSha1: string
}

export interface MameChdCatalogProfile {
  romset: string
  board: string
  disks: readonly MameChdDiskExpectation[]
  /** 仅用于后台提示，方便追到对应的 MAME 驱动源码。 */
  source: string
}

interface ParsedSet {
  row: (typeof MAME_CHD_CATALOG)[number]
  files: ReadonlyMap<string, number>
}

let parsed: readonly ParsedSet[] | null = null

function sets(): readonly ParsedSet[] {
  if (parsed) return parsed
  parsed = MAME_CHD_CATALOG.map((row) => ({
    row,
    files: new Map(row.f.split(' ').map((part) => {
      const at = part.lastIndexOf(':')
      return [part.slice(0, at), Number.parseInt(part.slice(at + 1), 16) >>> 0] as const
    })),
  }))
  return parsed
}

function fileBase(value: string | undefined): string {
  const name = (value ?? '').split(/[\\/]/).pop() ?? ''
  return name.replace(/\.8bg$/i, '').replace(/\.zip$/i, '').trim().toLowerCase()
}

function profileFor(set: ParsedSet): MameChdCatalogProfile {
  return {
    romset: set.row.r,
    board: 'MAME 已识别 CHD 媒体',
    disks: set.row.d.map(([name, chdSha1]) => ({ romset: set.row.r, name, chdSha1 })),
    source: set.row.s,
  }
}

/**
 * 只用 ZIP 中央目录的根目录文件名和 CRC 判别，不解压游戏文件也不依赖用户给 ZIP 起对名字。
 *
 * CHD 游戏的 merged ZIP 可能含有父集的额外成员，所以只要求当前 MAME 清单中的每个成员
 * 都唯一且 CRC 正确；多个候选时只在 ZIP 文件名恰好是其中一个 MAME 短名时才落定，避免猜错。
 */
export function identifyMameChdSet(
  entries: readonly Pick<ZipFileEntry, 'name' | 'crc32'>[],
  fileName?: string,
): MameChdCatalogProfile | null {
  if (!entries.length || entries.some((entry) => entry.name.includes('/'))) return null
  const root = new Map<string, readonly Pick<ZipFileEntry, 'name' | 'crc32'>[]>()
  for (const entry of entries) {
    const name = entry.name.toLowerCase()
    root.set(name, [...(root.get(name) ?? []), entry])
  }
  const hits = sets().filter((set) => {
    for (const [name, crc32] of set.files) {
      const candidates = root.get(name)
      if (!candidates || candidates.length !== 1 || (candidates[0].crc32 >>> 0) !== crc32) return false
    }
    return true
  })
  if (!hits.length) return null
  if (hits.length === 1) return profileFor(hits[0])
  const named = hits.find((set) => set.row.r === fileBase(fileName))
  return named ? profileFor(named) : null
}

/**
 * 编辑已有条目时按 R2 对象名恢复 CHD 面板。它只用于展示待上传项；真正保存时 CHD 仍必须
 * 经过 MAME SHA-1 头校验，播放器也会再次核对 ZIP CRC，不能凭文件名让错误组合启动。
 */
export function mameChdProfileForRomFileName(fileName: string | undefined): MameChdCatalogProfile | null {
  const row = mameChdProfileForRomset(fileBase(fileName))
  if (!row) return null
  return profileFor({ row, files: new Map() })
}
