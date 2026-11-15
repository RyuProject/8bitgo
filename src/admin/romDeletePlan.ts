import type { Game } from '@/types'
import { romKeysOf, unbindKeyPatch } from '@/services/roms'
import { parseDosExtras } from '@/lib/dosExtras'

export interface NonRomObjectReference {
  slug: string
  title: string
  field: string
}

export interface RomDeletePlan {
  /** 需要先从数据库的 ROM / 备用 ROM 字段摘除引用的游戏。 */
  romGames: Game[]
  /** 这些字段不是本按钮的 ROM 绑定；命中时必须阻止删除，避免连带弄坏媒体或系统盘。 */
  otherReferences: NonRomObjectReference[]
}

/** 平台 BIOS 表：`{ arcade: 'roms/bios/neogeo.zip', 'bios:pgm': 'roms/bios/pgm.zip' }`。 */
export type PlatformBiosRefs = Readonly<Record<string, string | undefined>>

/**
 * 一个对象被谁引用。
 *
 *   rom      游戏的主 ROM / 语言 ROM / 备用地址（含多文件包整目录）—— 删除按钮可以顺手解绑
 *   derived  游戏绑 `a.zip`，播放器会先探 `a.zip.8bg`（roms.ts 的 playbackRomCandidates）—— 删了会改变玩家实际加载的文件
 *   reverse  游戏绑 `a.zip.8bg`，旁边还留着 `a.zip`；播放器不会加载它，只在批量清理里保守地留着
 *   other    封面 / 视频 / DOS 系统盘 / 附加文件 / 流式盘 / MAME 盘 / 平台 BIOS / 系统保留前缀 —— 一律拦截
 */
export type ObjectReferenceKind = 'rom' | 'derived' | 'reverse' | 'other'

export interface ObjectReference {
  kind: ObjectReferenceKind
  /** 游戏 slug；平台 BIOS / 系统保留项没有 */
  slug?: string
  /** 给人看的来源：游戏名或「平台 BIOS」 */
  title: string
  field: string
}

export interface ObjectReferenceIndex {
  exact: Map<string, ObjectReference[]>
  /** 以 `/` 结尾的目录前缀：Sockdrive 目录、多文件包目录、系统保留前缀 */
  prefixes: Map<string, ObjectReference[]>
}

/** 这些对象任何清理都不能碰：线路探针、转换任务的暂存源、分片上传标记。 */
const RESERVED_PREFIXES: Array<[string, string]> = [
  ['roms/_route-probe/', 'ROM 线路测速探针'],
  ['psp-staging/', 'PSP 转换暂存'],
  ['sockdrive-staging/', 'Sockdrive 转换暂存'],
  ['_uploads/', '分片上传标记'],
]

const OWN_OBJECT_HOSTS = /^https?:\/\/(?:assets|cn-assets|roms)\.8bitgo\.com\//i

/**
 * 把库里存的值规范成 R2 对象 key；外站地址返回 null。
 *
 * 站内绝对路径（`/systems/dos/x.jsdos`）也当作同名 key 处理：有的系统盘既从站点磁盘发，
 * 又在 R2 留着镜像。宁可多保护一个对象，也不能少认一个引用。
 */
export function objectKeyOf(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null
  let key = value.trim()
  if (!key) return null
  if (OWN_OBJECT_HOSTS.test(key)) {
    const path = key.replace(OWN_OBJECT_HOSTS, '').split(/[?#]/)[0]
    try {
      key = decodeURIComponent(path)
    } catch {
      key = path
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(key)) {
    return null
  }
  key = key.replace(/^\/+/, '')
  return key || null
}

/** 单文件 ROM 是 `<前缀>/<平台>/<文件>`；多出一层说明它属于多文件包目录。 */
function bundleDirectory(key: string): string | null {
  const parts = key.split('/').filter(Boolean)
  if (parts.length < 4 || parts[0] !== 'roms') return null
  return `${parts.slice(0, -1).join('/')}/`
}

function push(map: Map<string, ObjectReference[]>, key: string, reference: ObjectReference) {
  const list = map.get(key)
  if (list) list.push(reference)
  else map.set(key, [reference])
}

/**
 * 全库引用索引：删 R2 对象前唯一可信的判据。
 *
 * 只看 game_roms 不够 —— 2026-11-15 清理时发现 ROM 存储页把平台 BIOS、MAME 媒体盘都当成
 * 「未绑定」列出来，点删除就会让整个平台的街机或 PS1 起不来。
 */
export function buildObjectReferenceIndex(games: readonly Game[], platformBios: PlatformBiosRefs = {}): ObjectReferenceIndex {
  const exact = new Map<string, ObjectReference[]>()
  const prefixes = new Map<string, ObjectReference[]>()

  for (const game of games) {
    const title = game.titleZh || game.title || game.slug
    const of = (kind: ObjectReferenceKind, field: string): ObjectReference => ({ kind, slug: game.slug, title, field })

    for (const raw of romKeysOf(game)) {
      const key = objectKeyOf(raw)
      if (!key) continue
      push(exact, key, of('rom', 'ROM'))
      if (key.endsWith('.8bg')) push(exact, key.slice(0, -4), of('reverse', 'ROM（8BG 原件）'))
      else push(exact, `${key}.8bg`, of('derived', 'ROM（8BG 派生）'))
      const dir = bundleDirectory(key)
      if (dir) push(prefixes, dir, of('rom', 'ROM 多文件包'))
    }

    const others: Array<[string, string | undefined]> = [
      ['封面', game.cover],
      ['视频', game.video],
      ['DOS 系统镜像', game.dosSystem],
      ...parseDosExtras(game.dosExtras).map(({ key }) => ['DOS 附加文件', key] as [string, string | undefined]),
      ...(game.arcadeMameDisks ?? []).map((disk) => ['MAME 媒体盘', disk.key] as [string, string | undefined]),
    ]
    for (const [field, raw] of others) {
      const key = objectKeyOf(raw)
      if (!key) continue
      push(exact, key, of('other', field))
      if (field === 'DOS 附加文件') push(exact, key.endsWith('.8bg') ? key.slice(0, -4) : `${key}.8bg`, of('other', field))
    }

    for (const raw of [game.dosSockdrive, ...Object.values(game.dosSockdrives ?? {})]) {
      const key = objectKeyOf(raw)
      if (key) push(prefixes, `${key.replace(/\/+$/, '')}/`, of('other', 'DOS 流式盘'))
    }
  }

  for (const [slot, raw] of Object.entries(platformBios)) {
    const key = objectKeyOf(raw)
    if (key) push(exact, key, { kind: 'other', title: '平台 BIOS', field: slot })
  }
  for (const [prefix, field] of RESERVED_PREFIXES) push(prefixes, prefix, { kind: 'other', title: '系统保留', field })

  return { exact, prefixes }
}

/** 这个对象的全部引用（精确 key + 所有命中的目录前缀）。 */
export function referencesForObject(index: ObjectReferenceIndex, key: string): ObjectReference[] {
  const found = [...(index.exact.get(key) ?? [])]
  for (const [prefix, references] of index.prefixes) if (key.startsWith(prefix)) found.push(...references)
  return found
}

/** Sockdrive 字段保存的是目录，不是具体分块文件；命中目录下任一待删对象也必须拦截。 */
export function objectReferenceMatches(field: string, value: string, objectKeys: ReadonlySet<string>): boolean {
  if (objectKeys.has(value)) return true
  if (field !== 'DOS 流式盘') return false
  const directory = value.trim().replace(/\/+$/, '')
  return Boolean(directory) && [...objectKeys].some((key) => key.startsWith(`${directory}/`))
}

/**
 * 删除 ROM 对象前先检查全库引用。
 *
 * 同一 R2 key 可能被多个游戏、语言槽或备用地址复用。ROM 引用可以随删除一并解除；
 * 封面、视频、MAME 媒体盘、DOS 系统/流式盘、平台 BIOS 和「播放器会优先加载的 8BG 派生包」
 * 不属于这个按钮的操作范围，命中时必须拦住。8BG 原件（reverse）不拦：播放器不会加载它。
 */
export function planRomObjectDeletion(games: Game[], objectKeys: string[], platformBios: PlatformBiosRefs = {}): RomDeletePlan {
  const targets = new Set(objectKeys)
  const romGames = games.filter((game) => romKeysOf(game).some((raw) => {
    const key = objectKeyOf(raw)
    return key ? targets.has(key) : targets.has(raw)
  }))
  const index = buildObjectReferenceIndex(games, platformBios)
  const otherReferences: NonRomObjectReference[] = []
  const seen = new Set<string>()

  for (const key of targets) {
    for (const reference of referencesForObject(index, key)) {
      if (reference.kind === 'rom' || reference.kind === 'reverse') continue
      const id = `${reference.slug ?? reference.title}\n${reference.field}`
      if (seen.has(id)) continue
      seen.add(id)
      otherReferences.push({ slug: reference.slug ?? '', title: reference.title, field: reference.field })
    }
  }

  return { romGames, otherReferences }
}

export interface CleanupObject {
  key: string
  size: number
  uploaded?: string
}

export interface CleanupGroup {
  /** 单文件就是 key；Sockdrive / 多文件包是以 `/` 结尾的目录 */
  id: string
  keys: string[]
  size: number
  /** 组内最晚的上传时间 */
  uploaded?: string
}

export interface CleanupScan {
  /** 没有任何引用、且不是刚上传的：可以删 */
  orphans: CleanupGroup[]
  /** 没有引用但在保护期内上传（后台可能还没点保存）：只列出、不勾选 */
  recent: CleanupGroup[]
  referencedCount: number
}

/** 清理按「组」走：一个 Sockdrive 版本目录、一个多文件包目录不能删一半留一半。 */
function cleanupGroupId(key: string): string {
  const parts = key.split('/')
  if (parts[0] === 'sockdrives' && parts.length >= 3) return `${parts.slice(0, 2).join('/')}/`
  return bundleDirectory(key) ?? key
}

/**
 * 找出没有任何引用的对象并按组归并。
 *
 * - 8BG 原件（reverse）按「仍被引用」处理：播放器不加载它，但它常是迁移时留的回滚件，留给人工判断；
 * - 以 `/` 结尾的 0 字节目录占位对象跳过：Worker 不接受这种 key，混进批量删除会让整批 400；
 * - 组内只要有一个对象被引用，整组都不算孤儿（多文件包兄弟文件、流式盘目录必须同进退）。
 */
export function scanUnreferencedObjects(
  objects: readonly CleanupObject[],
  index: ObjectReferenceIndex,
  options: { now?: number; recentMs?: number } = {},
): CleanupScan {
  const now = options.now ?? Date.now()
  const recentMs = options.recentMs ?? 72 * 3600 * 1000
  const groups = new Map<string, CleanupGroup & { referenced: boolean }>()
  let referencedCount = 0

  for (const object of objects) {
    if (!object.key || object.key.endsWith('/')) continue
    const id = cleanupGroupId(object.key)
    const group = groups.get(id) ?? { id, keys: [], size: 0, uploaded: undefined, referenced: false }
    group.keys.push(object.key)
    group.size += object.size
    if (object.uploaded && (!group.uploaded || object.uploaded > group.uploaded)) group.uploaded = object.uploaded
    if (referencesForObject(index, object.key).length) {
      group.referenced = true
      referencedCount++
    }
    groups.set(id, group)
  }

  const orphans: CleanupGroup[] = []
  const recent: CleanupGroup[] = []
  for (const { referenced, ...group } of groups.values()) {
    if (referenced) continue
    const uploadedAt = group.uploaded ? Date.parse(group.uploaded) : NaN
    if (!Number.isFinite(uploadedAt) || now - uploadedAt < recentMs) recent.push(group)
    else orphans.push(group)
  }
  orphans.sort((a, b) => b.size - a.size)
  recent.sort((a, b) => b.size - a.size)
  return { orphans, recent, referencedCount }
}

/**
 * 生成从一款游戏的多个 ROM / 备用地址字段中移除整组 key 的最小补丁。
 *
 * 逐 key 复用同一补丁器，避免多语言槽共享同一对象时只清掉第一处引用。
 */
export function unbindRomObjectKeys(game: Game, objectKeys: string[]): Partial<Game> {
  let current: Pick<Game, 'rom' | 'roms' | 'romBackups' | 'romAssets'> = {
    rom: game.rom,
    roms: game.roms,
    romBackups: game.romBackups,
    romAssets: game.romAssets,
  }
  const patch: Partial<Game> = {}

  const targets = new Set(objectKeys)
  for (const raw of romKeysOf(current)) {
    const normalized = objectKeyOf(raw)
    if (!(normalized ? targets.has(normalized) : targets.has(raw))) continue
    const next = unbindKeyPatch(current, raw)
    Object.assign(current, next)
    Object.assign(patch, next)
  }

  return patch
}
