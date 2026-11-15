/**
 * 联机人数自动推断 + 生效值重算。
 *
 * ## 为什么
 * 以前联机完全看管理员有没有在后台勾「支持联机」、填人数：线上 107 款街机只有 63 款能联机，
 * 剩下的双打 / 四打游戏只是没人去填。而 FBNeo 驱动表里每个 romset 都写着最大玩家数
 * （scripts/build-arcade-players.mjs 抽成 shared/arcade-players.json），按 ROM 文件短名查就有。
 *
 * ## 存储模型
 * games.netplay_mode（auto / on / off，见 shared/netplay-players.js）记**意图**，
 * games.players_inferred 记推断结果（只为后台展示与排查），
 * games.players / games.multiplayer 仍是**生效值**：每次写入游戏后由 syncNetplayDerived 重算。
 * 这样公开 API、游戏库筛选、开房鉴权（netplay-game-policy.js）一行都不用改，也不会有读者漏看 mode。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeGamePlayers, normalizeNetplayMode } from '../../shared/netplay-players.js'
import { romsetNameFromKey } from './arcade-bios-index.js'

/**
 * @param {string} file shared/arcade-players.json
 * @returns {{ players: Map<string, number>, defaultPlayers: number }}
 */
export function loadArcadePlayers(file) {
  const data = JSON.parse(readFileSync(file, 'utf8'))
  const defaultPlayers = Number(data.defaultPlayers) || 2
  const players = new Map()
  for (const name of String(data.known ?? '').split(/\s+/)) if (name) players.set(name, defaultPlayers)
  for (const [count, names] of Object.entries(data.players ?? {})) {
    const n = Number(count)
    if (!Number.isInteger(n) || n < 1) continue
    for (const name of names) players.set(String(name).toLowerCase(), n)
  }
  if (players.size < 1000) throw new Error(`${file} 只有 ${players.size} 个 romset，文件可能被截断`)
  return { players, defaultPlayers }
}

/** undefined = 还没加载；null = 加载失败（这时一律不推断，退回「街机默认 2 人」） */
let defaultLookup
export function defaultArcadePlayers() {
  if (defaultLookup !== undefined) return defaultLookup
  defaultLookup = null
  const file = process.env.ARCADE_PLAYERS_INDEX
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'shared', 'arcade-players.json')
  try {
    defaultLookup = loadArcadePlayers(file)
  } catch (error) {
    console.warn('[netplay-auto] 读取街机人数表失败：', error?.message ?? error)
  }
  return defaultLookup
}

/** RomData 汉化 / 修改版的包名不在驱动表里，但 dat 写着借哪个驱动跑（`DrvName  wof`） */
export function romDataDriverName(romData) {
  return /^\s*DrvName\s+"?([A-Za-z0-9_]+)"?/m.exec(String(romData ?? ''))?.[1]?.toLowerCase() ?? ''
}

/**
 * 按 ROM 推断最大玩家数。认不出返回 null。
 *
 * 一款游戏可能绑了好几个语言槽：取认得出的里面**最少**的那个 —— 宁可少开一个手柄位，
 * 也不让第三个人进一个按键没反应的房间。
 */
export function inferNetplayPlayers({ platform, romKeys = [], romData = '' }, lookup = defaultArcadePlayers()) {
  if (platform !== 'arcade' || !lookup) return null
  const names = new Set(romKeys.map(romsetNameFromKey).filter(Boolean))
  const drv = romDataDriverName(romData)
  // RomData 游戏的包名是自定义的（wofcn），只有 DrvName 认得
  if (drv) names.add(drv)
  const counts = [...names].map((n) => lookup.players.get(n)).filter((n) => Number.isInteger(n))
  return counts.length ? Math.min(...counts) : null
}

/**
 * 街机没有手动开关：能不能联机、几个人，一律按 ROM 自动识别（2026-11-14 运营决定）。
 * 库里历史遗留的 on / off 不再生效，下一次写入或全库重算时也会被改回 auto。
 */
export function effectiveNetplayMode(platform, mode) {
  return platform === 'arcade' ? 'auto' : normalizeNetplayMode(mode)
}

/**
 * 意图 + 推断 → 生效的 { players, multiplayer }。
 * @param {{ mode?: string, platform?: string, players?: unknown, multiplayer?: unknown, inferred?: number | null }} input
 */
export function resolveNetplay({ mode, platform, players, multiplayer, inferred }) {
  const stored = normalizeGamePlayers(players)
  switch (effectiveNetplayMode(platform, mode)) {
    case 'off':
      return { players: stored, multiplayer: 0 }
    case 'on':
      return { players: Math.max(2, stored), multiplayer: 1 }
    default:
      if (Number.isInteger(inferred)) {
        const n = normalizeGamePlayers(inferred)
        return { players: n, multiplayer: n >= 2 ? 1 : 0 }
      }
      // 驱动表里没有的街机（MAME 专属 romset、错名包）：街机台子几乎都是双打起步。
      if (platform === 'arcade') return { players: Math.max(2, stored), multiplayer: 1 }
      // 其它平台还没有可靠的数据源，沿用库里已有的值，不替运营做决定。
      return { players: stored, multiplayer: multiplayer === 1 || multiplayer === true || multiplayer === '1' ? 1 : 0 }
  }
}

let missingColumnsWarned = false

/**
 * 在写游戏的同一个事务里重算生效值。迁移还没跑（缺列）时只告警一次、什么都不做 ——
 * 不能因为这一步让后台保存整个失败。
 * @param {(sql: string, params?: unknown[]) => Promise<any[]>} run
 * @param {number} gameId
 * @param {{ mode?: string, dryRun?: boolean }} [opts] mode 给了就先落库；dryRun 只算不写
 * @returns {Promise<null | { from: { players: number, multiplayer: number }, to: { players: number, multiplayer: number }, inferred: number | null }>}
 *   null = 无需改动（或缺列）
 */
export async function syncNetplayDerived(run, gameId, { mode, dryRun = false } = {}, lookup = defaultArcadePlayers()) {
  let game
  try {
    ;[game] = await run(
      'SELECT platform, netplay_mode, players, multiplayer, players_inferred, arcade_romdata FROM games WHERE id = ?',
      [gameId],
    )
  } catch (error) {
    if (error?.code !== 'ER_BAD_FIELD_ERROR') throw error
    if (!missingColumnsWarned) {
      missingColumnsWarned = true
      console.warn('[netplay-auto] games 缺 netplay_mode / players_inferred 列，联机人数不会自动推断：cd server && npm run migrate')
    }
    return null
  }
  if (!game) return null
  // 街机忽略请求里的模式，并把库里遗留的 on / off 收回 auto
  const wantMode = game.platform === 'arcade' ? 'auto' : mode ? normalizeNetplayMode(mode) : null
  if (wantMode && wantMode !== normalizeNetplayMode(game.netplay_mode)) {
    if (!dryRun) await run('UPDATE games SET netplay_mode = ? WHERE id = ?', [wantMode, gameId])
    game.netplay_mode = wantMode
  }
  const keys = (await run('SELECT object_key FROM game_roms WHERE game_id = ?', [gameId])).map((r) => r.object_key)
  const inferred = inferNetplayPlayers({ platform: game.platform, romKeys: keys, romData: game.arcade_romdata }, lookup)
  const next = resolveNetplay({ ...game, mode: game.netplay_mode, inferred })
  const storedInferred = game.players_inferred == null ? null : Number(game.players_inferred)
  if (
    next.players === Number(game.players)
    && next.multiplayer === Number(game.multiplayer)
    && (inferred ?? null) === storedInferred
  ) return null
  if (!dryRun) {
    await run(
      'UPDATE games SET players = ?, multiplayer = ?, players_inferred = ? WHERE id = ?',
      [next.players, next.multiplayer, inferred ?? null, gameId],
    )
  }
  return { from: { players: Number(game.players), multiplayer: Number(game.multiplayer) }, to: next, inferred: inferred ?? null }
}

/**
 * 全库重算（迁移与 `npm run netplay-players` 用）。FBNeo 人数表更新后重跑一次即可。
 * @returns {Promise<Array<{ slug: string, from: object, to: object, inferred: number | null }>>}
 */
export async function recomputeAllNetplay(run, { dryRun = false } = {}) {
  const rows = await run('SELECT id, slug FROM games ORDER BY id')
  const changed = []
  for (const { id, slug } of rows) {
    const diff = await syncNetplayDerived(run, id, { dryRun })
    if (diff) changed.push({ slug, ...diff })
  }
  return changed
}
