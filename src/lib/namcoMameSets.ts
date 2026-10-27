import { NAMCO_MAME_SETS, type NamcoMameSetRow } from './namcoMameSetsData'
import { arcadeArchiveUnsafePathProblem, type ArcadeArchiveEntry } from './namcoSystem11'

/**
 * Namco System 11 / System 12 的精确识别（数据来自 MAME 源码，见 scripts/gen-namco-mame-sets.mjs）。
 *
 * 为什么不能沿用 FBNeo 索引：FBNeo 根本没有这两块板子，`identifyArcadeRomset()` 对它们恒为 null；
 * 以前只认 Tekken 一个父集，《铁拳 2》《灵魂之刃》《铁拳 3》《灵魂能力》《铁拳 TT》等全部
 * 落回 FBNeo 默认核心，开局就是 `Romset is unknown`。而 mame-current 的文件名纠正
 * （canonicalMameRomset）会把 `Tekken 3 (Japan).zip` 收成 System 11 的 `tekken`、
 * `Soul Calibur.zip` 收成 `soul` —— 名字一错，MAME 就静默回菜单。
 *
 * 规则（与 Tekken 那条窄例外同一套、只是推广到全部 95 个 set）：
 *   - 只看 ZIP **根目录**成员；某个 set 的每颗 ROM 都以原名、唯一一份、CRC 完全相符出现才算命中；
 *   - 根目录多出的文件（merged 包里的克隆 ROM）不影响命中 —— MAME 只按清单取；
 *   - 多个 set 同时命中（merged 包）时：先认上传文件名，再认唯一的父集，仍分不出就不猜；
 *   - 任何不安全路径直接放弃识别。
 */
export type NamcoBoard = 'Namco System 11' | 'Namco System 12'

export interface NamcoMameMatch {
  romset: string
  parent: string
  board: NamcoBoard
  /** System 11 每块板都要 C76 声音 MCU 的内部 ROM（MAME 设备 namcoc76）；System 12 不需要 BIOS 集 */
  bios?: 'namcoc76'
  machine: string
  title: string
  year: number
  status: NamcoMameSetRow['s']
  /** 还需要的 CHD（目前只有 System 12 的 ujlnow / questff / truckk） */
  disks: readonly string[]
  /** 已知的格斗游戏是四键（LP RP LK RK）；其它游戏不猜，留给后台 */
  buttons?: 4
  matchedFiles: number
  totalFiles: number
  nestedExtras: number
}

const FOUR_BUTTON_FIGHTERS = /^(?:tekken|souledge|soulclbr|tektagt)/

interface ParsedSet {
  row: NamcoMameSetRow
  files: ReadonlyMap<string, number>
}

let parsed: ParsedSet[] | null = null
function sets(): ParsedSet[] {
  if (parsed) return parsed
  parsed = NAMCO_MAME_SETS.map((row) => ({
    row,
    files: new Map(row.f.split(' ').map((pair) => {
      const at = pair.lastIndexOf(':')
      return [pair.slice(0, at), Number.parseInt(pair.slice(at + 1), 16) >>> 0] as const
    })),
  }))
  return parsed
}

function toMatch(set: ParsedSet, nestedExtras: number): NamcoMameMatch {
  const { row } = set
  return {
    romset: row.r,
    parent: row.p,
    board: row.b === 11 ? 'Namco System 11' : 'Namco System 12',
    ...(row.b === 11 ? { bios: 'namcoc76' as const } : {}),
    machine: row.m,
    title: row.t,
    year: row.y,
    status: row.s,
    disks: row.d,
    ...(FOUR_BUTTON_FIGHTERS.test(row.r) ? { buttons: 4 as const } : {}),
    matchedFiles: set.files.size,
    totalFiles: set.files.size,
    nestedExtras,
  }
}

/** 文件名（可带路径 / .zip / .8bg）→ 可能的 MAME 短名，只用来在 merged 包里挑 set，不用来猜。 */
function baseNameOf(fileName: string | undefined): string {
  if (!fileName) return ''
  const last = fileName.split(/[\\/]/).pop() ?? ''
  return last.replace(/\.8bg$/i, '').replace(/\.zip$/i, '').trim().toLowerCase()
}

export function identifyNamcoMameSet(
  entries: readonly ArcadeArchiveEntry[],
  fileName?: string,
): NamcoMameMatch | null {
  if (!entries.length || arcadeArchiveUnsafePathProblem(entries)) return null

  const root = new Map<string, ArcadeArchiveEntry[]>()
  let nestedExtras = 0
  for (const entry of entries) {
    if (entry.name.includes('/')) {
      nestedExtras++
      continue
    }
    const name = entry.name.toLowerCase()
    const list = root.get(name)
    if (list) list.push(entry)
    else root.set(name, [entry])
  }
  if (!root.size) return null

  const hits = sets().filter((set) => {
    for (const [name, crc] of set.files) {
      const found = root.get(name)
      if (!found || found.length !== 1 || (found[0].crc32 >>> 0) !== crc) return false
    }
    return true
  })
  if (!hits.length) return null
  if (hits.length === 1) return toMatch(hits[0], nestedExtras)

  // merged 包：父集和克隆同时满分。先听文件名，再取唯一父集；都分不出就不替管理员拍板。
  const base = baseNameOf(fileName)
  const byName = hits.find((set) => set.row.r === base)
  if (byName) return toMatch(byName, nestedExtras)
  const parents = hits.filter((set) => !set.row.p)
  if (parents.length === 1) return toMatch(parents[0], nestedExtras)
  return null
}

/** 按短名查表（播放器用：拿到的名字已经是 romset 时补齐板卡信息）。 */
export function namcoMameSetByName(romset: string): NamcoMameMatch | null {
  const id = baseNameOf(romset)
  const set = sets().find((candidate) => candidate.row.r === id)
  return set ? toMatch(set, 0) : null
}

/** 后台提示用的状态文字（只描述 MAME 自己标的情况，不夸大） */
export function namcoMameStatusNote(match: Pick<NamcoMameMatch, 'status' | 'disks' | 'machine' | 'board'>): string {
  const notes: string[] = []
  if (match.status === 'not-working') notes.push('MAME 标为「无法运行」（MACHINE_NOT_WORKING），上架前务必实测')
  if (match.status === 'imperfect') notes.push('MAME 标为画面/声音/操作不完美')
  if (match.status === 'needs-link') notes.push('需要联网机台互联（MAME 未模拟 LAN），单机可能无法进入游戏')
  if (match.disks.length) notes.push(`还需要 CHD 媒体盘：${match.disks.join(', ')}（本站尚未核验，暂不可用）`)
  if (match.board === 'Namco System 12' && !/^coh7\d\db?$/.test(match.machine)) {
    notes.push(`使用特殊机台配置 ${match.machine}（外设/控制器与普通 System 12 不同）`)
  }
  return notes.join('；')
}
