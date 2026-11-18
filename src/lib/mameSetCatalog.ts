import type { ZipFileEntry } from './unzip'
import { arcadeArchiveUnsafePathProblem } from './namcoSystem11'
import { rewriteZipEntries, type ZipRewriteItem } from './zipRewrite'
import type { MameSetCatalogDeviceRow, MameSetCatalogRow } from './mameSetCatalogData'

/**
 * 「只能交给 mame-current 跑」的街机 set 识别与单集重组（数据：scripts/gen-mame-set-catalog.mjs）。
 *
 * 第一批是 Sega Model 2（Dead or Alive / doaae 等 90 个 set）。和 Namco System 11/12 的识别
 * （namcoMameSets.ts）是同一个思路，但多解决了两件网上的 Model 2 包几乎必然遇到的事：
 *
 *   1. **merged 包**：doa.zip 里同时装着 doa / doab / doaa / doaab / doaae；克隆集里和父集
 *      同 CRC 的 ROM 只存一份、用父集的文件名（doaae 的 mpr-19318.10 在包里叫 mpr-19318.11）。
 *      所以按「CRC + 长度」匹配，不看文件名；匹配成功后把目标 set 用 MAME 的原名重组成一个
 *      自洽的单集 ZIP（只改 ZIP 头，压缩数据原样引用，不重压）。
 *   2. **板载设备 ROM**：Model 2A 的 Sega Billboard 要 segabill.zip（epr-18022.ic2）。MAME 找设备
 *      ROM 的顺序是 [设备短名, 游戏 set, 父集]，所以包里自带的设备 ROM 一并放进单集；
 *      包里没有的，交给后台「BIOS 包（系统名）」那一档（只能放一个，见 biosPlan.ts）。
 *
 * 数据表约 80KB，只在需要时动态加载（loadMameSetCatalog），不进播放器主包。
 */

export interface MameCatalogRom {
  name: string
  crc32: number
  /** 0 = 源码里的长度不是字面量，匹配时只看 CRC */
  size: number
}

export interface MameCatalogDevice {
  id: string
  /** MAME 设备短名 = 单独存放时的 ZIP 名 */
  shortname: string
  title: string
  roms: readonly MameCatalogRom[]
}

export type MameCatalogStatus = MameSetCatalogRow['s']

export interface MameCatalogSet {
  romset: string
  parent: string
  title: string
  year: number
  board: string
  status: MameCatalogStatus
  buttons?: 2 | 4 | 6
  roms: readonly MameCatalogRom[]
  devices: readonly MameCatalogDevice[]
  disks: readonly string[]
}

export interface MameCatalog {
  revision: string
  sets: readonly MameCatalogSet[]
}

export interface MameCatalogMatch extends MameCatalogSet {
  /** 输出单集里的每个成员（MAME 原名）由原包的哪个 entry 提供；含已打包进来的设备 ROM */
  items: readonly ZipRewriteItem[]
  /** 原包里自带、已一并放进单集的设备 */
  bundledDevices: readonly MameCatalogDevice[]
  /** 原包里没有、要靠 BIOS 包提供的设备 */
  missingDevices: readonly MameCatalogDevice[]
  /** 原包已经是「根目录、原名、恰好这些成员」的单集，不必重组 */
  exact: boolean
  /** 重组后丢掉的原包成员数（merged 包里的其它 set、说明文件等） */
  droppedEntries: number
}

export interface MameCatalogIdentification {
  /** 原包里能凑齐的全部 set（merged 包会有好几个） */
  candidates: readonly MameCatalogMatch[]
  /** 只有一个候选、或文件名正好是某个候选短名时才落定；否则留给管理员挑 */
  chosen: MameCatalogMatch | null
}

function parseRoms(encoded: string): MameCatalogRom[] {
  if (!encoded) return []
  return encoded.split(' ').map((part) => {
    const [name, crc, size] = part.split(':')
    return { name, crc32: Number.parseInt(crc, 16) >>> 0, size: Number.parseInt(size ?? '0', 16) || 0 }
  })
}

export function buildMameCatalog(
  rows: readonly MameSetCatalogRow[],
  deviceRows: readonly MameSetCatalogDeviceRow[],
  revision: string,
): MameCatalog {
  const devices = new Map(deviceRows.map((row) => [row.i, {
    id: row.i,
    shortname: row.n,
    title: row.t,
    roms: parseRoms(row.f),
  } satisfies MameCatalogDevice]))
  const sets = rows.map((row) => ({
    romset: row.r,
    parent: row.p,
    title: row.t,
    year: row.y,
    board: row.b,
    status: row.s,
    ...(row.k ? { buttons: row.k } : {}),
    roms: parseRoms(row.f),
    devices: row.v.map((id) => {
      const device = devices.get(id)
      if (!device) throw new Error(`MAME set 目录损坏：${row.r} 引用了不存在的设备 ${id}`)
      return device
    }),
    disks: row.d,
  } satisfies MameCatalogSet))
  return { revision, sets }
}

let catalogPromise: Promise<MameCatalog> | null = null
/** 按需加载数据表；失败后允许下次重试（不把一次网络抖动钉成永久失败） */
export function loadMameSetCatalog(): Promise<MameCatalog> {
  catalogPromise ??= import('./mameSetCatalogData').then((data) => (
    buildMameCatalog(data.MAME_SET_CATALOG, data.MAME_SET_CATALOG_DEVICES, data.MAME_SET_CATALOG_REVISION)
  )).catch((error) => {
    catalogPromise = null
    throw error
  })
  return catalogPromise
}

const baseOf = (path: string) => (path.split('/').pop() ?? '').toLowerCase()

function fileBase(value: string | undefined): string {
  const name = (value ?? '').split(/[\\/]/).pop() ?? ''
  return name.replace(/\.8bg$/i, '').replace(/\.zip$/i, '').trim().toLowerCase()
}

/**
 * 给 ROM 在原包里找一个提供者：CRC + 长度相符；同名的优先，其次根目录的，最后任意一个。
 * MAME 自己也是这么找的（名字 + CRC 优先，退回只按 CRC），所以不会选出 MAME 不认的那份。
 */
function providerFor(rom: MameCatalogRom, byCrc: ReadonlyMap<number, readonly ZipFileEntry[]>): ZipFileEntry | null {
  const candidates = (byCrc.get(rom.crc32) ?? []).filter((entry) => !rom.size || entry.uncompressedSize === rom.size)
  if (!candidates.length) return null
  return candidates.find((entry) => entry.name.toLowerCase() === rom.name)
    ?? candidates.find((entry) => baseOf(entry.name) === rom.name)
    ?? candidates.find((entry) => !entry.name.includes('/'))
    ?? candidates[0]
}

function matchSet(set: MameCatalogSet, entries: readonly ZipFileEntry[], byCrc: ReadonlyMap<number, readonly ZipFileEntry[]>): MameCatalogMatch | null {
  const items: ZipRewriteItem[] = []
  for (const rom of set.roms) {
    const entry = providerFor(rom, byCrc)
    if (!entry) return null
    items.push({ entry, name: rom.name })
  }
  const bundledDevices: MameCatalogDevice[] = []
  const missingDevices: MameCatalogDevice[] = []
  const taken = new Set(items.map((item) => item.name))
  for (const device of set.devices) {
    const deviceItems: ZipRewriteItem[] = []
    for (const rom of device.roms) {
      const entry = providerFor(rom, byCrc)
      if (!entry) break
      deviceItems.push({ entry, name: rom.name })
    }
    if (deviceItems.length !== device.roms.length) {
      missingDevices.push(device)
      continue
    }
    bundledDevices.push(device)
    for (const item of deviceItems) {
      if (taken.has(item.name)) continue
      taken.add(item.name)
      items.push(item)
    }
  }
  const used = new Set(items.map((item) => item.entry))
  const exact = entries.length === items.length &&
    used.size === items.length &&
    items.every((item) => item.entry.name.toLowerCase() === item.name)
  return {
    ...set,
    items,
    bundledDevices,
    missingDevices,
    exact,
    droppedEntries: entries.filter((entry) => !used.has(entry)).length,
  }
}

/**
 * 只读 ZIP 中央目录（名字 / CRC / 长度），不解压。
 *
 * 不安全路径直接放弃识别（不给路径穿越包任何豁免）。多个候选时只在 ZIP 文件名正好是
 * 其中一个短名时落定 —— merged 包里装着父集和全部克隆，替管理员猜版本会把 Model 2B 当 2A 上架。
 */
export function identifyMameCatalogSets(
  catalog: MameCatalog,
  entries: readonly ZipFileEntry[],
  fileName?: string,
): MameCatalogIdentification {
  if (!entries.length || arcadeArchiveUnsafePathProblem(entries)) return { candidates: [], chosen: null }
  const byCrc = new Map<number, ZipFileEntry[]>()
  for (const entry of entries) {
    const crc = entry.crc32 >>> 0
    const list = byCrc.get(crc)
    if (list) list.push(entry)
    else byCrc.set(crc, [entry])
  }
  const candidates: MameCatalogMatch[] = []
  for (const set of catalog.sets) {
    // 快速排除：任何一颗 CRC 不在包里就不必逐项找提供者
    if (!set.roms.every((rom) => byCrc.has(rom.crc32))) continue
    const match = matchSet(set, entries, byCrc)
    if (match) candidates.push(match)
  }
  if (candidates.length === 1) return { candidates, chosen: candidates[0] }
  const base = fileBase(fileName)
  return { candidates, chosen: candidates.find((candidate) => candidate.romset === base) ?? null }
}

/**
 * 播放器侧的确定性挑选（本地 / 历史 merged 包，没人可问）：文件名 → 唯一父集 → 目录顺序第一个。
 * 后台上传不用它 —— 那边分不清就让管理员选。
 */
export function pickMameCatalogSetForPlayback(identification: MameCatalogIdentification): MameCatalogMatch | null {
  if (identification.chosen) return identification.chosen
  const parents = identification.candidates.filter((candidate) => !candidate.parent)
  return parents.length === 1 ? parents[0] : identification.candidates[0] ?? null
}

/** 后台上传用：把选中的 set 重组成 `<romset>.zip` 的单集（已经是单集就原样返回） */
export async function buildMameCatalogSetZip(blob: Blob, match: MameCatalogMatch): Promise<Blob> {
  if (match.exact) return blob
  return rewriteZipEntries(blob, match.items, '重组')
}

/**
 * 运行时的廉价预筛：Sega 系列 ROM 名几乎都是 epr- / mpr- / opr- 开头。
 * 不是这种包就不必为它下载 80KB 的数据表（绝大多数街机游戏走 FBNeo，不该多一次请求）。
 */
export function mayContainMameCatalogSet(entries: readonly Pick<ZipFileEntry, 'name'>[]): boolean {
  return entries.some((entry) => /^(?:epr|mpr|opr)-\d/i.test(baseOf(entry.name)))
}

/** 需要单独提供的 BIOS 系统名：只能有一个（后台只有一个「BIOS 包」字段） */
export function mameCatalogBiosName(match: Pick<MameCatalogMatch, 'missingDevices'>): string {
  return match.missingDevices.length === 1 ? match.missingDevices[0].shortname : ''
}

/** 后台提示：MAME 自己标的状态 + 设备 ROM 缺口（只描述事实，不夸大） */
export function mameCatalogStatusNote(match: Pick<MameCatalogMatch, 'status' | 'missingDevices' | 'disks'>): string {
  const notes: string[] = []
  if (match.status === 'not-working') notes.push('MAME 标为「无法运行」（MACHINE_NOT_WORKING），上架前务必实测')
  if (match.status === 'imperfect') notes.push('MAME 标为画面/声音/保护不完美')
  if (match.status === 'needs-link') notes.push('需要联网机台互联（MAME 未模拟），单机可能无法进入游戏')
  if (match.disks.length) notes.push(`还需要 CHD 媒体盘：${match.disks.join(', ')}`)
  if (match.missingDevices.length > 1) {
    notes.push(
      `缺 ${match.missingDevices.length} 组设备 ROM（${match.missingDevices.map((device) => `${device.shortname}.zip`).join('、')}），` +
      '但「BIOS 包」一栏只能挂一个；请把这些 ROM 一起放进游戏 ZIP 后重新上传',
    )
  }
  return notes.join('；')
}

export function describeMameCatalogDevice(device: MameCatalogDevice): string {
  return `${device.shortname}.zip（${device.title}：${device.roms.map((rom) => `${rom.name}，CRC ${rom.crc32.toString(16).padStart(8, '0')}`).join('、')}）`
}

/**
 * BIOS 包上传防呆：后台「街机 BIOS 包」里绑 bios:<设备短名> 时，核对 ZIP 根目录里确有这个设备
 * 要的每一颗 ROM（名字 + CRC）。传错一个版本，所有 Model 2A 游戏开局都是缺文件。
 * 不是目录里的设备返回 null（交给通用检查）。
 */
export function mameCatalogDeviceBiosProblem(
  catalog: MameCatalog,
  shortname: string,
  entries: readonly Pick<ZipFileEntry, 'name' | 'crc32'>[],
): string | null {
  const variants = new Map<string, MameCatalogDevice>()
  for (const set of catalog.sets) {
    for (const device of set.devices) if (device.shortname === shortname) variants.set(device.id, device)
  }
  if (!variants.size) return null
  if (entries.some((entry) => entry.name.includes('/'))) return `${shortname}.zip 的 ROM 必须放在 ZIP 根目录，不能套文件夹。`
  const root = new Map(entries.map((entry) => [entry.name.toLowerCase(), entry.crc32 >>> 0]))
  const satisfied = [...variants.values()].some((device) => device.roms.every((rom) => root.get(rom.name) === rom.crc32))
  if (satisfied) return null
  const expected = [...variants.values()].map((device) => device.roms.map((rom) => `${rom.name}（CRC ${rom.crc32.toString(16).padStart(8, '0')}）`).join(' + '))
  return `这不是 MAME 认得的 ${shortname}.zip：根目录必须有 ${expected.join(' 或 ')}；文件未上传。`
}
