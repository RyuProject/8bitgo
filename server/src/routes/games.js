import { Router } from 'express'
import { requireAdmin, isAdminRequest, optionalUser } from '../auth.js'
import { invalidateContent } from '../content.js'
import { publicApi } from '../cache.js'
import { playIdentity } from '../playcount.js'
import { gameApiToPartialRow, relationsInPatch } from '../mappers.js'
import { query } from '../db.js'
import { attachRelations } from '../games-repo.js'
import {
  listGames,
  getGameBySlug,
  getGamesBySlugs,
  upsertGame,
  patchGame,
  deleteGame,
  recordPlay,
  platformCounts,
  genreCounts,
  developerCounts,
  suggestGames,
  searchFallback,
} from '../games-repo.js'

export const gamesRouter = Router()

const truthy = (v) => v === '1' || v === 'true'

/**
 * 游戏列表。
 *
 * 所有筛选、排序、分页都在数据库里做，返回的是**一页**数据：
 *   { items, total, page, pageSize, totalPages }
 *
 * v1 是无条件把整库返回、由浏览器过滤，上千款游戏时首屏要下载整个目录。
 *
 * ?all=1 返回全部（含已下架），需要管理员身份 —— 否则「下架」形同虚设，
 * 任何人 curl 一下就能看到你下架的游戏。
 */
gamesRouter.get('/', async (req, res, next) => {
  try {
    const wantAll = req.query.all === '1'
    if (wantAll && !(await isAdminRequest(req))) {
      return res.status(403).json({ error: '需要管理员权限才能查看全部游戏' })
    }
    const result = await listGames({
      platform: req.query.platform,
      genre: req.query.genre,
      developer: req.query.developer,
      multiplayer: truthy(req.query.multiplayer),
      coin: truthy(req.query.coin),
      q: req.query.q,
      sort: req.query.sort,
      page: req.query.page,
      pageSize: req.query.pageSize,
      includeHidden: wantAll,
      // 只有管理员视角才认这个（上架 / 下架），公开列表永远只给上架的
      status: wantAll ? req.query.status : undefined,
      // 后台「只看首页位」筛选。home=1 只看钦点的，home=0 只看没钦点的
      home: wantAll && req.query.home != null ? truthy(req.query.home) : undefined,
    })
    // 只有公开视角能缓存：管理员视角带着身份，缓存下来等于把下架游戏发给所有人
    if (!wantAll) publicApi(res)
    res.json(result)
  } catch (e) {
    next(e)
  }
})

/**
 * 搜索框联想。
 *
 *   GET /api/games/suggest?q=塞尔&limit=8
 *
 * 刻意做得比 /api/games 轻：只回列表要显示的那几列，不带类型/标签/ROM，也不分页。
 * 用户每敲一个字就会调一次，多查一次关联表就是多一轮往返。
 * 注意要注册在 /:slug 之前，否则会被当成 slug 吃掉。
 */
gamesRouter.get('/suggest', async (req, res, next) => {
  try {
    const items = await suggestGames(req.query.q, { limit: req.query.limit })
    publicApi(res)
    res.json({ items })
  } catch (e) {
    next(e)
  }
})

/**
 * 一个都没搜到时的补救。
 *
 *   GET /api/games/search-fallback?q=zeldaa
 *   → { suggestion: 'zelda', related: [...] }
 *
 * 单独一条接口而不是塞进 /api/games 的返回里：只有真搜不到时才需要，
 * 塞进去等于给每一次正常搜索都加两条查询。
 */
gamesRouter.get('/search-fallback', async (req, res, next) => {
  try {
    const out = await searchFallback(req.query.q, { limit: req.query.limit })
    publicApi(res)
    res.json(out)
  } catch (e) {
    next(e)
  }
})

/**
 * 按一组 slug 批量取游戏，返回顺序与传入一致。
 *
 *   GET /api/games/by-slugs?slugs=contra,super-mario-bros
 *
 * 首页轮播、侧边栏「稍后玩」、联机房间卡片都是「我有几个 slug，要对应的游戏」，
 * 一个个查会打出一串请求，所以给一条批量的。下架的游戏不会返回。
 * 注意要注册在 /:slug 之前，否则会被当成 slug 吃掉。
 */
gamesRouter.get('/by-slugs', async (req, res, next) => {
  try {
    const slugs = String(req.query.slugs || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 60) // 挡住一次要几千个的请求
    if (!slugs.length) return res.json([])
    const games = (await getGamesBySlugs(slugs)).filter((g) => !g.hidden)
    publicApi(res)
    res.json(games)
  } catch (e) {
    next(e)
  }
})

/**
 * 随机一款上架游戏。
 *
 *   GET /api/games/random?exclude=<slug>
 *
 * v1 是把整库拉到浏览器再随机取下标；v2 不再全量加载，改成让数据库随机排一条。
 * ORDER BY RAND() 在几千行的量级上完全够用（一次全表扫 + 排序，毫秒级）；
 * 真到几十万行再换成「先随机取 id 区间」的做法。
 *
 * 「能不能在线运行」由前端的平台白名单决定，后端不认识那套配置，
 * 所以这里只保证是上架游戏，前端拿到后自己判断，不合适就再点一次。
 */
gamesRouter.get('/random', async (req, res, next) => {
  try {
    const exclude = String(req.query.exclude || '')
    const rows = await query(
      'SELECT * FROM games WHERE hidden = 0 AND slug <> ? ORDER BY RAND() LIMIT 1',
      [exclude],
    )
    if (!rows.length) return res.status(404).json({ error: '还没有可玩的游戏' })
    const [game] = await attachRelations(rows)
    res.json(game)
  } catch (e) {
    next(e)
  }
})

/** 各维度的数量统计（平台页 / 类型页 / 开发商页的列表） */
gamesRouter.get('/facets', async (_req, res, next) => {
  try {
    const [platforms, genres, developers] = await Promise.all([platformCounts(), genreCounts(), developerCounts()])
    publicApi(res)
    res.json({
      platforms: platforms.map((r) => ({ id: r.platform, count: Number(r.n) })),
      genres: genres.map((r) => ({ id: r.genre, count: Number(r.n) })),
      developers: developers.map((r) => ({
        name: r.developer,
        count: Number(r.n),
        // 代表作：该开发商游玩次数最高的一款，列表页拿它当封面
        topGame: r.slug
          ? { slug: r.slug, title: r.title, titleZh: r.title_zh || undefined, icon: r.icon, cover: r.cover || undefined, platform: r.platform }
          : undefined,
      })),
    })
  } catch (e) {
    next(e)
  }
})

/**
 * 游玩前实时确认是否属于成人游戏。
 *
 * 游戏详情 HTML 和公开内容接口会经过 Cloudflare 缓存；后台刚勾选“成人游戏”时，旧详情页
 * 可能还会存活几分钟。这个极小的接口故意不套 publicApi()，让播放器每次挂载前都直接确认
 * 数据库里的当前值，避免缓存窗口成为绕过年龄门的路径。
 */
gamesRouter.get('/:slug/access', async (req, res, next) => {
  try {
    const rows = await query('SELECT adult, hidden FROM games WHERE slug = ? LIMIT 1', [req.params.slug])
    const game = rows[0]
    if (!game || truthy(game.hidden)) return res.status(404).json({ error: '游戏不存在' })
    res.setHeader('Cache-Control', 'no-store')
    res.json({ adult: truthy(game.adult) })
  } catch (e) {
    next(e)
  }
})

/**
 * 记录一次真实游玩。前端在模拟器真的跑起来（onReady）时调用。
 *
 * 一个人对一款游戏只算一次：登录了按账号去重，没登录按 IP 去重
 * （身份怎么定、为什么这么定，见 playcount.js 开头）。
 *
 * 用 optionalUser 而不是 requireUser —— 游客也能玩、也要算数，
 * 只是带了 token 的时候顺手认出是谁，好让同一个人换设备不重复计数。
 *
 * 刻意**不**调 invalidateContent()：游玩上报是高频写，每次都清 SSR 缓存
 * 等于把缓存关掉；次数本来就允许有一个 TTL 的延迟。
 *
 * 注意这条要注册在 /:slug 之前，否则 'xxx/play' 会被当成 slug 吃掉。
 */
gamesRouter.post('/:slug/play', optionalUser, async (req, res, next) => {
  try {
    const who = playIdentity(req)
    // 既没登录、又拿不到任何 IP：宁可不记，也不要把这类请求全塞进同一个身份里
    if (!who) return res.json({ ok: true, counted: false })
    res.json({ ok: true, counted: await recordPlay(req.params.slug, who.kind, who.identity) })
  } catch (e) {
    next(e)
  }
})

gamesRouter.get('/:slug', async (req, res, next) => {
  try {
    const game = await getGameBySlug(req.params.slug)
    if (!game) return res.status(404).json({ error: '游戏不存在' })
    // 已下架的对外当作不存在，只有管理员能取到
    if (game.hidden && !(await isAdminRequest(req))) {
      return res.status(404).json({ error: '游戏不存在' })
    }
    if (!game.hidden) publicApi(res)
    res.json(game)
  } catch (e) {
    next(e)
  }
})

/** 新增 / 整体覆盖一款游戏（后台）。主表与三张关联表在同一个事务里。 */
gamesRouter.put('/:slug', requireAdmin, async (req, res, next) => {
  try {
    const slug = String(req.params.slug)
    if (!req.body?.title) return res.status(400).json({ error: '缺少标题' })
    if (!req.body?.platform) return res.status(400).json({ error: '缺少平台' })
    await upsertGame(slug, req.body)
    invalidateContent()
    res.json(await getGameBySlug(slug))
  } catch (e) {
    next(e)
  }
})

/**
 * 局部更新（切换上下架、绑定 ROM …）。
 * 只写请求里带到的列 —— 整行回写会把 plays 之类的值按旧数据盖回去。
 */
gamesRouter.patch('/:slug', requireAdmin, async (req, res, next) => {
  try {
    const slug = String(req.params.slug)
    const patchRow = gameApiToPartialRow(req.body)
    const relations = relationsInPatch(req.body)
    if (!Object.keys(patchRow).length && !relations.genres && !relations.tags && !relations.roms) {
      return res.status(400).json({ error: '没有可更新的字段' })
    }
    const id = await patchGame(slug, patchRow, relations, req.body)
    if (!id) return res.status(404).json({ error: '游戏不存在' })
    invalidateContent()
    res.json(await getGameBySlug(slug))
  } catch (e) {
    next(e)
  }
})

/**
 * 删除游戏。类型 / 标签 / ROM 绑定、收藏、最近游玩都有外键级联，
 * 数据库自己会清干净 —— v1 里这些孤儿行要靠应用层记得去删。
 *
 * R2 里的 ROM / 封面 / 视频文件不会被删除（可能被多款游戏共用），
 * 需要清理请到「后台 → ROM 存储」里手动删。
 */
gamesRouter.delete('/:slug', requireAdmin, async (req, res, next) => {
  try {
    if (!(await deleteGame(req.params.slug))) return res.status(404).json({ error: '游戏不存在' })
    invalidateContent()
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})
