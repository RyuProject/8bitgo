/**
 * games 的数据访问层（schema v2）。
 *
 * 全部筛选、排序、分页都在 SQL 里做。v1 是把整个游戏库发给浏览器再用 JS 过滤，
 * 91 款时看不出问题，上千款时首屏要下载整个目录 —— 这一层就是为了终结那种做法。
 *
 * 关联数据（类型 / 标签 / ROM）一律批量装配：一页 24 条只多打 3 条
 * WHERE game_id IN (...)，不会变成每款查三次。
 */
import { query, queryOne, withTransaction } from './db.js'
import { gameRowToApi, gameApiToRow, romsOf, GENERIC_ROM_LANG } from './mappers.js'
import { buildGameTokens, queryTerms, tokenMatchSql, normalize, tokenize } from './search.js'

/** 列表页每页最多给多少条，挡住 ?pageSize=100000 这种请求 */
const MAX_PAGE_SIZE = 100

/* ---------------- 读 ---------------- */

/**
 * 给一批 games 行装配关联数据。
 * @param {object[]} rows games 表的原始行
 * @returns {Promise<object[]>} 前端的 Game 对象数组，顺序与 rows 一致
 */
export async function attachRelations(rows) {
  if (!rows.length) return []
  const ids = rows.map((r) => r.id)
  const holes = ids.map(() => '?').join(',')
  const [genreRows, tagRows, romRows] = await Promise.all([
    query(`SELECT game_id, genre_id FROM game_genres WHERE game_id IN (${holes})`, ids),
    query(`SELECT game_id, tag FROM game_tags WHERE game_id IN (${holes})`, ids),
    query(`SELECT game_id, lang, object_key FROM game_roms WHERE game_id IN (${holes})`, ids),
  ])
  // BIGINT 在 mysql2 里可能回成数字也可能回成字符串（取决于是否超出安全整数范围），
  // 两边都统一成字符串当 key，免得 Map 对不上导致关联数据凭空丢失
  const key = (v) => String(v)
  const genres = new Map()
  const tags = new Map()
  const roms = new Map()
  for (const r of genreRows) {
    const k = key(r.game_id)
    if (!genres.has(k)) genres.set(k, [])
    genres.get(k).push(r.genre_id)
  }
  for (const r of tagRows) {
    const k = key(r.game_id)
    if (!tags.has(k)) tags.set(k, [])
    tags.get(k).push(r.tag)
  }
  for (const r of romRows) {
    const k = key(r.game_id)
    if (!roms.has(k)) roms.set(k, {})
    roms.get(k)[r.lang] = r.object_key
  }
  return rows.map((r) => {
    const k = key(r.id)
    return gameRowToApi(r, { genres: genres.get(k) ?? [], tags: tags.get(k) ?? [], roms: roms.get(k) ?? {} })
  })
}

/** 把 ?sort= 翻成 ORDER BY。带 g. 前缀是因为按类型筛选时要 join。 */
function orderBy(sort) {
  switch (sort) {
    case 'newest':
      // 上线日期可能为空（后台没填），用入库时间兜底，再用 id 保证顺序稳定
      return 'COALESCE(g.added_at, DATE(g.created_at)) DESC, g.id DESC'
    case 'name':
      return 'g.title ASC, g.id ASC'
    case 'home':
      // 首页精选位：后台给的序号说了算。没给序号的排在最后，
      // 同号之间再按游玩次数，保证顺序不会每次查询都漂
      return 'g.home_rank IS NULL, g.home_rank ASC, g.plays DESC, g.id DESC'
    case 'popular':
    default:
      // 新站大量游戏 plays 都是 0，只按 plays 排会导致顺序随数据库返回顺序漂移，
      // 所以补上「上线日期 → id」兜底，保证翻页结果稳定
      return 'g.plays DESC, COALESCE(g.added_at, DATE(g.created_at)) DESC, g.id DESC'
  }
}

/**
 * 列表查询。
 * @param {object} q { platform, genre, developer, multiplayer, coin, q, sort, page, pageSize, includeHidden }
 * @returns {Promise<{items, total, page, pageSize, totalPages}>}
 */
export async function listGames(q = {}) {
  const where = []
  const params = []

  // includeHidden 只有管理员视角才会传；默认一律只给上架的
  if (!q.includeHidden) where.push('g.hidden = 0')
  // 管理员视角下还能进一步只看上架 / 只看下架。放在 SQL 里做，
  // 否则「只看已下架」会退化成在当前页的 24 条里挑，翻页结果毫无意义。
  else if (q.status === 'visible') where.push('g.hidden = 0')
  else if (q.status === 'hidden') where.push('g.hidden = 1')
  if (q.platform) {
    where.push('g.platform = ?')
    params.push(String(q.platform))
  }
  if (q.developer) {
    // 一款游戏可以录多家开发商；边界匹配避免「SNK」误命中「SNK Playmore」。
    where.push("FIND_IN_SET(?, REPLACE(REPLACE(g.developer, '，', ','), ', ', ',')) > 0")
    params.push(String(q.developer))
  }
  if (q.multiplayer) where.push('g.multiplayer = 1')
  if (q.coin) where.push('g.coin_reward > 0')
  // 首页精选位。true = 只看被钦点的，false = 只看没被钦点的（后台筛选用）
  if (q.home === true) where.push('g.home_rank IS NOT NULL')
  else if (q.home === false) where.push('g.home_rank IS NULL')


  // 按类型筛选走关联表。用 JOIN 而不是 EXISTS：genre_id 上有索引，
  // 先在小表上定位再回主键，比全表扫 games 快得多
  const genreJoin = q.genre ? 'JOIN game_genres gg ON gg.game_id = g.id AND gg.genre_id = ?' : ''
  const genreParams = q.genre ? [String(q.genre)] : []

  /**
   * 关键词走倒排索引，不再用 LIKE '%…%'。
   * 上万款游戏时 LIKE 是全表扫，而联想下拉每敲一个字就查一次，扛不住。
   */
  let searchJoin = ''
  let searchParams = []
  let relevanceSql = ''
  let relevanceParams = []
  if (q.q && String(q.q).trim()) {
    const parsed = queryTerms(q.q, { prefixLast: q.prefixLast !== false })
    if (parsed.empty) {
      // 输入里一个可搜索字符都没有（比如全是标点）：直接给空，别退化成「搜全部」
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(q.pageSize) || 24))
      return { items: [], total: 0, page: 1, pageSize, totalPages: 1 }
    }
    const m = tokenMatchSql(parsed)
    searchJoin = `JOIN (${m.sql}) s ON s.game_id = g.id`
    searchParams = m.params
    const norm = normalize(q.q).trim()
    // 索引给的是「命中了什么」，这里再叠一层「命中得有多正」：
    // 标题整个就是这个词 > 标题以它开头 > 只是含在某处。
    // 不这么做的话，一个标签里带「马里奥」的冷门游戏会和《超级马里奥》并列。
    relevanceSql =
      '(s.score + CASE WHEN g.title = ? OR g.title_zh = ? THEN 1000 ELSE 0 END' +
      ' + CASE WHEN g.title LIKE ? OR g.title_zh LIKE ? THEN 300 ELSE 0 END) DESC, '
    relevanceParams = [norm, norm, `${norm}%`, `${norm}%`]
  }

  const join = `${genreJoin} ${searchJoin}`.trim()
  const joinParams = [...genreParams, ...searchParams]
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const allParams = [...joinParams, ...params]

  const totalRow = await queryOne(`SELECT COUNT(*) AS n FROM games g ${join} ${whereSql}`, allParams)
  const total = Number(totalRow?.n ?? 0)

  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(q.pageSize) || 24))
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(Math.max(1, Number(q.page) || 1), totalPages)
  const offset = (page - 1) * pageSize

  // 有关键词时默认按相关性排；用户显式选了排序方式就听他的
  const explicitSort = q.sort && q.sort !== 'popular'
  const order = relevanceSql && !explicitSort ? relevanceSql + orderBy(q.sort) : orderBy(q.sort)
  const orderParams = relevanceSql && !explicitSort ? relevanceParams : []

  // LIMIT / OFFSET 直接拼进 SQL：上面已经强制转成数字并夹在合理范围内，注不进东西
  const rows = await query(
    `SELECT g.* FROM games g ${join} ${whereSql} ORDER BY ${order} LIMIT ${pageSize} OFFSET ${offset}`,
    [...allParams, ...orderParams],
  )
  return { items: await attachRelations(rows), total, page, pageSize, totalPages }
}

/* ---------------- 联想 & 搜不到时的补救 ---------------- */

/**
 * 搜索框联想。刻意做得很轻：只回列表要显示的那几列，不装配类型/标签/ROM。
 * 每敲一个字就会调一次，多查一次关联表就是多一轮往返。
 */
export async function suggestGames(q, { limit = 8 } = {}) {
  const parsed = queryTerms(q)
  if (parsed.empty) return []
  const n = Math.min(20, Math.max(1, Number(limit) || 8))
  const m = tokenMatchSql(parsed)
  const norm = normalize(q).trim()
  const rows = await query(
    `SELECT g.id, g.slug, g.title, g.title_zh, g.platform, g.year, g.icon, g.cover, g.plays
       FROM games g
       JOIN (${m.sql}) s ON s.game_id = g.id
      WHERE g.hidden = 0
      ORDER BY (s.score
                + CASE WHEN g.title = ? OR g.title_zh = ? THEN 1000 ELSE 0 END
                + CASE WHEN g.title LIKE ? OR g.title_zh LIKE ? THEN 300 ELSE 0 END) DESC,
               g.plays DESC, g.id DESC
      LIMIT ${n}`,
    [...m.params, norm, norm, `${norm}%`, `${norm}%`],
  )
  return rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    titleZh: r.title_zh ?? null,
    platform: r.platform,
    year: Number(r.year) || null,
    icon: r.icon,
    cover: r.cover ?? null,
  }))
}

/** 编辑距离（带上限提前退出：超过 max 就不用算完了） */
function editDistance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      if (cur[j] < best) best = cur[j]
    }
    if (best > max) return max + 1
    prev = cur
  }
  return prev[b.length]
}

/**
 * 一个词都没搜到时的补救，两步：
 *   1. 把「所有词都要命中」放宽成「命中任意一个词」—— 多打了一个词、词序不对都能救回来
 *   2. 还是没有，就在索引里找拼写相近的 token（编辑距离 ≤ 2）当「你是不是想找…」
 *
 * 候选 token 按首字母 + 长度圈定，不是全表扫：搜不到本来就是低频路径，
 * 但也不能因为低频就允许它拖慢数据库。
 */
export async function searchFallback(q, { limit = 12 } = {}) {
  const parsed = queryTerms(q, { prefixLast: false })
  if (parsed.empty) return { suggestion: null, related: [] }
  const n = Math.min(24, Math.max(1, Number(limit) || 12))

  // 第一步：任意一个 token 命中即可，按命中个数 × 权重排。
  // 这里用 tokenize 而不是 queryTerms，是为了把汉字拆到**单字**：
  // 搜「街霸」时二字组「街霸」在库里根本不存在，但拆成 街 / 霸 之后
  // 《街头霸王》两个都中，就能被捞回来 —— 缩写、简称基本都是这么救回来的。
  const loose = [...tokenize(q)].slice(0, 24)
  if (!loose.length) return { suggestion: null, related: [] }
  const holes = loose.map(() => '?').join(',')
  const looseRows = await query(
    `SELECT g.id, g.slug, g.title, g.title_zh, g.platform, g.year, g.icon, g.cover
       FROM games g
       JOIN (SELECT game_id, SUM(weight) AS score, COUNT(*) AS hits
               FROM game_search_tokens WHERE token IN (${holes})
              GROUP BY game_id) s ON s.game_id = g.id
      WHERE g.hidden = 0
      ORDER BY s.hits DESC, s.score DESC, g.plays DESC, g.id DESC
      LIMIT ${n}`,
    loose,
  )
  const related = looseRows.map((r) => ({
    slug: r.slug,
    title: r.title,
    titleZh: r.title_zh ?? null,
    platform: r.platform,
    year: Number(r.year) || null,
    icon: r.icon,
    cover: r.cover ?? null,
  }))

  // 第二步：拼写纠正。只对拉丁词做 —— 汉字打错一个字，编辑距离意义不大，
  // 上面那步「命中任意一个词」对中文更管用
  let suggestion = null
  const word = parsed.required
    .map((t) => t.token)
    .filter((t) => /^[a-z]{4,}$/.test(t))
    .sort((a, b) => b.length - a.length)[0]
  if (word) {
    const rows = await query(
      `SELECT DISTINCT token FROM game_search_tokens
        WHERE token LIKE ? AND CHAR_LENGTH(token) BETWEEN ? AND ?
        LIMIT 400`,
      [`${word[0]}%`, word.length - 2, word.length + 2],
    )
    let best = null
    let bestD = 3
    for (const r of rows) {
      const d = editDistance(word, r.token, 2)
      if (d < bestD && d > 0) {
        bestD = d
        best = r.token
      }
    }
    if (best) suggestion = best
  }
  return { suggestion, related }
}

/* ---------------- 平台级 BIOS ---------------- */

/**
 * 各平台配的 BIOS（平台 id -> 对象存储 key）。
 *
 * Neo Geo 这类平台不给 BIOS 根本起不来（拳皇、合金弹头都要 neogeo.zip），
 * 而同一份 BIOS 是整个平台共用的，挂到每一款游戏上纯属重复录入。
 * 返回的只是 key，前台再拼成 URL —— 和 ROM 的处理方式保持一致。
 */
export async function listPlatformBios() {
  const rows = await query('SELECT platform, object_key FROM platform_bios')
  const out = {}
  for (const r of rows) out[r.platform] = r.object_key
  return out
}

export async function setPlatformBios(platform, objectKey) {
  await query(
    `INSERT INTO platform_bios (platform, object_key) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE object_key = VALUES(object_key)`,
    [String(platform), String(objectKey)],
  )
}

export async function clearPlatformBios(platform) {
  await query('DELETE FROM platform_bios WHERE platform = ?', [String(platform)])
}

/**
 * 首页精选位：后台钦点了哪几款。
 *
 * 一款都没钦点时返回空数组 —— 调用方据此退回「按游玩次数自动排」，
 * 也就是这个功能加进来之前的行为。这样新装的站不需要先去后台点一遍才有首页。
 */
export async function listHomePicks(limit) {
  const n = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(limit) || 12))
  const rows = await query(
    `SELECT * FROM games WHERE hidden = 0 AND home_rank IS NOT NULL
      ORDER BY home_rank ASC, plays DESC, id DESC LIMIT ${n}`,
  )
  return attachRelations(rows)
}

/** 按 slug 取单款游戏（含关联数据）；不存在返回 undefined */
export async function getGameBySlug(slug) {
  const row = await queryOne('SELECT * FROM games WHERE slug = ?', [slug])
  if (!row) return undefined
  const [g] = await attachRelations([row])
  return g
}

/** 按一组 slug 取游戏，返回顺序与传入的 slugs 一致（用于收藏 / 最近列表） */
export async function getGamesBySlugs(slugs) {
  if (!slugs.length) return []
  const holes = slugs.map(() => '?').join(',')
  const rows = await query(`SELECT * FROM games WHERE slug IN (${holes})`, slugs)
  const games = await attachRelations(rows)
  const bySlug = new Map(games.map((g) => [g.slug, g]))
  return slugs.map((s) => bySlug.get(s)).filter(Boolean)
}

/** 各平台的上架游戏数（平台页 / 首页用） */
export function platformCounts() {
  return query('SELECT platform, COUNT(*) AS n FROM games WHERE hidden = 0 GROUP BY platform')
}

/** 各类型的上架游戏数 */
export function genreCounts() {
  return query(
    `SELECT gg.genre_id AS genre, COUNT(*) AS n
       FROM game_genres gg JOIN games g ON g.id = gg.game_id
      WHERE g.hidden = 0 GROUP BY gg.genre_id`,
  )
}

/**
 * 各开发商的上架游戏数，外加一款「代表作」（该开发商游玩次数最高的那款），
 * 开发商列表页用它做封面。
 *
 * 用窗口函数一次算出「计数 + 每组第一名」，避免为了拿封面把每个开发商的游戏
 * 再各查一遍 —— 那正是 v1 的做法（把全库拉进内存再 groupBy）。
 * MySQL 8.0+ / MariaDB 10.2+ 都支持 ROW_NUMBER()。
 */
export function developerCounts() {
  return query(
    `WITH RECURSIVE developer_parts AS (
       SELECT g.id, g.slug, g.title, g.title_zh, g.icon, g.cover, g.platform, g.plays,
              TRIM(SUBSTRING_INDEX(REPLACE(g.developer, '，', ','), ',', 1)) AS developer,
              CASE WHEN LOCATE(',', REPLACE(g.developer, '，', ',')) > 0
                   THEN SUBSTRING(REPLACE(g.developer, '，', ','), LOCATE(',', REPLACE(g.developer, '，', ',')) + 1)
                   ELSE '' END AS rest
         FROM games g
        WHERE g.hidden = 0 AND g.developer <> ''
       UNION ALL
       SELECT id, slug, title, title_zh, icon, cover, platform, plays,
              TRIM(SUBSTRING_INDEX(rest, ',', 1)) AS developer,
              CASE WHEN LOCATE(',', rest) > 0 THEN SUBSTRING(rest, LOCATE(',', rest) + 1) ELSE '' END AS rest
         FROM developer_parts
        WHERE rest <> ''
     )
     SELECT developer, n, slug, title, title_zh, icon, cover, platform
       FROM (
         SELECT developer, slug, title, title_zh, icon, cover, platform,
                COUNT(*)     OVER (PARTITION BY developer)                                 AS n,
                ROW_NUMBER() OVER (PARTITION BY developer ORDER BY plays DESC, id ASC)     AS rn
           FROM developer_parts
          WHERE developer <> ''
       ) ranked
      WHERE rn = 1
      ORDER BY n DESC, developer ASC`,
  )
}

/**
 * 后台概览要的全库聚合。
 *
 * 这些数字必须在数据库里算 —— 前端要算就得先把全库拉下来，正是 v2 要消灭的做法。
 */
export async function adminStats() {
  const [games, plays, rom, posts] = await Promise.all([
    queryOne('SELECT COUNT(*) AS total, SUM(hidden = 0) AS visible, SUM(hidden = 1) AS hidden FROM games'),
    // 全库之和：下架只是不对外展示，之前攒下的游玩次数还在，
    // 累计值不该因为下架一款热门游戏就往回跳
    queryOne('SELECT COALESCE(SUM(plays), 0) AS n FROM games'),
    // 一次查出「全库已绑 ROM」和「其中已上架的」：
    // 前者是录入进度（常见流程是先隐藏建条目、传完 ROM 再上架），
    // 后者用来反推「已上架但还缺 ROM」——那种条目点进去是玩不了的，属于要立刻修的
    queryOne(
      `SELECT COUNT(DISTINCT gr.game_id) AS total,
              COUNT(DISTINCT CASE WHEN g.hidden = 0 THEN gr.game_id END) AS visible
         FROM game_roms gr JOIN games g ON g.id = gr.game_id`,
    ),
    queryOne('SELECT COUNT(*) AS total, SUM(published = 1) AS published, SUM(published = 0) AS draft FROM posts'),
  ])
  return {
    games: {
      total: Number(games?.total ?? 0),
      visible: Number(games?.visible ?? 0),
      hidden: Number(games?.hidden ?? 0),
      withRom: Number(rom?.total ?? 0),
      visibleWithRom: Number(rom?.visible ?? 0),
    },
    plays: Number(plays?.n ?? 0),
    posts: {
      total: Number(posts?.total ?? 0),
      published: Number(posts?.published ?? 0),
      draft: Number(posts?.draft ?? 0),
    },
  }
}

/* ---------------- 写 ---------------- */

/** 关联表的写入：先全删再插，语义简单且天然幂等 */
async function writeRelations(run, gameId, game, only) {
  if (!only || only.genres) {
    await run('DELETE FROM game_genres WHERE game_id = ?', [gameId])
    const genres = [...new Set((game.genres ?? []).filter((x) => typeof x === 'string' && x))]
    if (genres.length) {
      await run(
        `INSERT INTO game_genres (game_id, genre_id) VALUES ${genres.map(() => '(?, ?)').join(', ')}`,
        genres.flatMap((gid) => [gameId, gid]),
      )
    }
  }
  if (!only || only.tags) {
    await run('DELETE FROM game_tags WHERE game_id = ?', [gameId])
    const tags = [...new Set((game.tags ?? []).map((t) => String(t).trim()).filter(Boolean))]
    if (tags.length) {
      await run(
        `INSERT INTO game_tags (game_id, tag) VALUES ${tags.map(() => '(?, ?)').join(', ')}`,
        tags.flatMap((t) => [gameId, t]),
      )
    }
  }
  if (!only || only.roms) {
    await run('DELETE FROM game_roms WHERE game_id = ?', [gameId])
    const roms = Object.entries(romsOf(game))
    if (roms.length) {
      await run(
        `INSERT INTO game_roms (game_id, lang, object_key) VALUES ${roms.map(() => '(?, ?, ?)').join(', ')}`,
        roms.flatMap(([lang, key]) => [gameId, lang, key]),
      )
    }
  }
}

/**
 * 重建一款游戏的搜索索引行。
 *
 * 每次写游戏都整条删掉重插，而不是算差量 —— 一款游戏也就几十个 token，
 * 删插比对比便宜得多，而且不会因为漏算差量留下过期 token
 * （改了译名之后旧译名还能搜到，是最难发现的那种 bug）。
 */
async function reindexGame(run, gameId, game) {
  await run('DELETE FROM game_search_tokens WHERE game_id = ?', [gameId])
  const tokens = buildGameTokens({
    title: game.title,
    title_zh: game.titleZh ?? game.title_zh,
    developer: game.developer,
    tags: game.tags,
    aliases: game.aliases,
  })
  if (!tokens.size) return
  const rows = [...tokens]
  // 分批插：一款游戏的 token 通常几十个，但标题特别长时可能上百，
  // 一条 INSERT 塞太多占位符会顶到 max_allowed_packet
  const CHUNK = 200
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK)
    await run(
      `INSERT INTO game_search_tokens (token, game_id, weight) VALUES ${part.map(() => '(?, ?, ?)').join(', ')}
       ON DUPLICATE KEY UPDATE weight = VALUES(weight)`,
      part.flatMap(([token, weight]) => [token, gameId, weight]),
    )
  }
}

/**
 * 新增 / 整体覆盖一款游戏（PUT）。主表和三张关联表在同一个事务里，
 * 中途失败不会留下「主表写了、类型没写」这种半成品。
 */
export async function upsertGame(slug, game) {
  return withTransaction(async (run) => {
    const row = gameApiToRow({ ...game, slug })
    const cols = Object.keys(row)
    const updates = cols.filter((c) => c !== 'slug').map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(', ')
    await run(
      `INSERT INTO games (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
       ON DUPLICATE KEY UPDATE ${updates}`,
      cols.map((c) => row[c]),
    )
    // 拿不到 insertId 时（走了 UPDATE 分支）再查一次
    const [{ id }] = await run('SELECT id FROM games WHERE slug = ?', [slug])
    await writeRelations(run, id, game)
    await reindexGame(run, id, { ...game, slug })
    return id
  })
}

/** 局部更新（PATCH）。只动请求里带到的列和关联表。 */
export async function patchGame(slug, patchRow, relations, game) {
  return withTransaction(async (run) => {
    const found = await run('SELECT id FROM games WHERE slug = ?', [slug])
    if (!found.length) return null
    const id = found[0].id
    if (Object.keys(patchRow).length) {
      const sets = Object.keys(patchRow).map((c) => `\`${c}\` = ?`).join(', ')
      await run(`UPDATE games SET ${sets} WHERE id = ?`, [...Object.values(patchRow), id])
    }
    if (relations.genres || relations.tags || relations.roms) {
      await writeRelations(run, id, game, relations)
    }
    // PATCH 可能只改了标题、也可能只改了标签，两者都会影响索引。
    // 与其判断「这次改动是否涉及可搜索字段」，不如从库里读回完整一行重建 ——
    // 判断漏一个字段就是搜不到，代价远大于多跑一次几十行的插入。
    const [row] = await run(
      'SELECT g.title, g.title_zh, g.developer FROM games g WHERE g.id = ?',
      [id],
    )
    const tagRows = await run('SELECT tag FROM game_tags WHERE game_id = ?', [id])
    await reindexGame(run, id, { ...row, tags: tagRows.map((t) => t.tag) })
    return id
  })
}

/** 删除游戏。关联表、收藏、最近游玩都有外键级联，数据库自己会清干净。 */
export async function deleteGame(slug) {
  const r = await query('DELETE FROM games WHERE slug = ?', [slug])
  return r.affectedRows > 0
}

/**
 * 记一次游玩。同一身份对同一款游戏只算一次，只对已上架的游戏生效。
 *
 * 去重靠 game_plays 的主键 (game_id, kind, identity)：
 * INSERT IGNORE 真插进去了才 +1；撞了唯一键说明这个人已经玩过，直接跳过。
 * 并发的两次上报也不会双记 —— 谁先插进去谁算数，这是数据库保证的，
 * 不是应用层「先查再写」判出来的（那中间有窗口，压测时必翻车）。
 *
 * 第一条语句用 INSERT ... SELECT 而不是先查 id 再插，省一次往返；
 * 游戏不存在或已下架时 SELECT 出不来行，自然什么也插不进去。
 *
 * 没放进事务里是有意的：这是全站写入最频繁的一条路径，而事务要独占一条
 * 连接池里的连接（池一共 10 条）。真正重要的不变式「不能重复计数」已经
 * 由唯一键锁死了；万一进程恰好在两条语句中间挂掉，最坏结果是某次游玩
 * 记进了名单但没加上计数 —— 一个热度数字少 1，可以接受。
 *
 * @param {string} slug     游戏
 * @param {'u'|'i'} kind    身份类型：账号 / IP，见 playcount.js
 * @param {string} identity 身份摘要（HMAC，不是明文）
 * @returns {Promise<boolean>} 这次有没有真的计上
 */
export async function recordPlay(slug, kind, identity) {
  const ins = await query(
    'INSERT IGNORE INTO game_plays (game_id, kind, identity) SELECT id, ?, ? FROM games WHERE slug = ? AND hidden = 0',
    [kind, identity, slug],
  )
  // 0 行 = 这个人已经玩过，或者这款游戏不存在 / 已下架
  if (ins.affectedRows === 0) return false
  await query('UPDATE games SET plays = plays + 1 WHERE slug = ? AND hidden = 0', [slug])
  return true
}

export { GENERIC_ROM_LANG, MAX_PAGE_SIZE }
