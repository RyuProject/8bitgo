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
 * 封面、视频、MAME 媒体盘和 DOS 系统/流式盘则不属于这个按钮的操作范围，命中时必须拦住。
 */
export function planRomObjectDeletion(games: Game[], objectKeys: string[]): RomDeletePlan {
  const targets = new Set(objectKeys)
  const romGames = games.filter((game) => romKeysOf(game).some((key) => targets.has(key)))
  const otherReferences: NonRomObjectReference[] = []

  for (const game of games) {
    const checks: Array<[string, string | undefined]> = [
      ['封面', game.cover],
      ['视频', game.video],
      ['DOS 系统镜像', game.dosSystem],
      ['DOS 流式盘', game.dosSockdrive],
      ...Object.values(game.dosSockdrives ?? {}).map((key) => ['DOS 流式盘', key] as [string, string | undefined]),
      ...parseDosExtras(game.dosExtras).map(({ key }) => ['DOS 附加文件', key] as [string, string | undefined]),
      ...((game.arcadeMameDisks ?? []).map((disk) => ['MAME 媒体盘', disk.key] as [string, string | undefined])),
    ]

    const seenFields = new Set<string>()
    for (const [field, key] of checks) {
      if (!key || !objectReferenceMatches(field, key, targets) || seenFields.has(field)) continue
      seenFields.add(field)
      otherReferences.push({ slug: game.slug, title: game.titleZh || game.title || game.slug, field })
    }
  }

  return { romGames, otherReferences }
}

/**
 * 生成从一款游戏的多个 ROM / 备用地址字段中移除整组 key 的最小补丁。
 *
 * 逐 key 复用同一补丁器，避免多语言槽共享同一对象时只清掉第一处引用。
 */
export function unbindRomObjectKeys(game: Game, objectKeys: string[]): Partial<Game> {
  let current: Pick<Game, 'rom' | 'roms' | 'romBackups'> = {
    rom: game.rom,
    roms: game.roms,
    romBackups: game.romBackups,
  }
  const patch: Partial<Game> = {}

  for (const key of new Set(objectKeys)) {
    const next = unbindKeyPatch(current, key)
    Object.assign(current, next)
    Object.assign(patch, next)
  }

  return patch
}
