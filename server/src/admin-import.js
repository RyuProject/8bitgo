import { gameSupportsNetplay } from '../../shared/netplay-players.js'
import { dosGameConfigError } from './dos-game-config.js'

/** 单次导入封顶，避免一个后台请求长时间占着连接并串行开启数千个事务。 */
export const MAX_ADMIN_IMPORT_ITEMS = 2000

const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key)
const record = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value))

function slugProblem(value, label) {
  if (typeof value !== 'string' || !value.trim()) return `${label}缺少 slug`
  const slug = value.trim()
  if (slug.length > 120) return `${label}的 slug 超过 120 个字符`
  // URL 标识被路径、缓存键和对象目录共同使用。导入不允许塞进斜杠、查询串或不可见字符。
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return `${label}的 slug 只能使用小写字母、数字和连字符：${slug}`
  }
  return null
}

function duplicateSlugProblem(list, label) {
  const seen = new Set()
  for (const item of list) {
    const slug = String(item.slug).trim().toLowerCase()
    if (seen.has(slug)) return `${label}中 slug「${slug}」重复；已全部拒绝，避免同一批数据前后互相覆盖`
    seen.add(slug)
  }
  return null
}

/**
 * 批量导入先完整校验、再开始写库。
 *
 * 游戏写入跨多次事务，若第 700 条才发现形状错误，前 699 条已经不可逆地覆盖完成。
 * 所以能在纯数据阶段发现的问题必须一次扫完；返回的列表同时把 slug 两端空白收掉，
 * 避免校验的是一个值、真正写入的却是另一个值。
 */
export function validateAdminImportPayload(body) {
  if (own(body, 'games') && !Array.isArray(body.games)) {
    return { error: 'games 必须是数组', gameList: [], postList: [] }
  }
  if (own(body, 'posts') && !Array.isArray(body.posts)) {
    return { error: 'posts 必须是数组', gameList: [], postList: [] }
  }

  const rawGames = Array.isArray(body?.games) ? body.games : []
  const rawPosts = Array.isArray(body?.posts) ? body.posts : []
  if (!rawGames.length && !rawPosts.length) {
    return { error: '请求里没有 games 或 posts 数组', gameList: [], postList: [] }
  }
  if (rawGames.length + rawPosts.length > MAX_ADMIN_IMPORT_ITEMS) {
    return {
      error: `单次最多导入 ${MAX_ADMIN_IMPORT_ITEMS} 条，请拆成多批`,
      gameList: [],
      postList: [],
    }
  }

  const gameList = []
  for (let index = 0; index < rawGames.length; index++) {
    const game = rawGames[index]
    const label = `第 ${index + 1} 款游戏`
    if (!record(game)) return { error: `${label}不是对象`, gameList: [], postList: [] }
    const slugError = slugProblem(game.slug, label)
    if (slugError) return { error: slugError, gameList: [], postList: [] }
    if (typeof game.title !== 'string' || !game.title.trim()) {
      return { error: `${label}缺少英文标题`, gameList: [], postList: [] }
    }
    if (typeof game.platform !== 'string' || !game.platform.trim()) {
      return { error: `${label}缺少平台`, gameList: [], postList: [] }
    }
    if ((game.multiplayer === true || game.multiplayer === 1 || game.multiplayer === '1') &&
        !gameSupportsNetplay(game.multiplayer, game.players)) {
      return { error: `${label}启用了联机，但最大玩家数小于 2`, gameList: [], postList: [] }
    }
    const dosError = dosGameConfigError(game)
    if (dosError) return { error: `${label}：${dosError}`, gameList: [], postList: [] }
    gameList.push({ ...game, slug: game.slug.trim() })
  }

  const postList = []
  for (let index = 0; index < rawPosts.length; index++) {
    const post = rawPosts[index]
    const label = `第 ${index + 1} 篇文章`
    if (!record(post)) return { error: `${label}不是对象`, gameList: [], postList: [] }
    const slugError = slugProblem(post.slug, label)
    if (slugError) return { error: slugError, gameList: [], postList: [] }
    if (typeof post.title !== 'string' || !post.title.trim()) {
      return { error: `${label}缺少标题`, gameList: [], postList: [] }
    }
    postList.push({ ...post, slug: post.slug.trim() })
  }

  const duplicateGame = duplicateSlugProblem(gameList, '游戏数组')
  if (duplicateGame) return { error: duplicateGame, gameList: [], postList: [] }
  const duplicatePost = duplicateSlugProblem(postList, '文章数组')
  if (duplicatePost) return { error: duplicatePost, gameList: [], postList: [] }

  return { error: null, gameList, postList }
}
