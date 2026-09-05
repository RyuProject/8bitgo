import { Router } from 'express'
import { requireAbility, hasAbility, optionalUser } from '../auth.js'
import { invalidateContent } from '../content.js'
import { publicApi } from '../cache.js'
import { playIdentity } from '../playcount.js'
import { gameApiToPartialRow, relationsInPatch, dateOnly } from '../mappers.js'
import { isAdultByBirthDate } from '../../../shared/age.js'
import { query } from '../db.js'
import { attachRelations, writeDescriptionTranslation } from '../games-repo.js'
import { queueGameSearchPush } from '../search-push.js'
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
import { isTranslateConfigured, translatePlan, translateText } from '../translate.js'

export const gamesRouter = Router()

const truthy = (v) => v === '1' || v === 'true'

// 数据库里的布尔列走 mysql2，tinyint(1) 回来的是数字 1/0，不是字符串。
// 别用上面那个 truthy() —— 它只认查询串里的 '1'/'true'，套在数据行上会一律判 false。
export const dbFlag = (v) => v === 1 || v === true || v === '1'

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
    if (wantAll && !(await hasAbility(req, 'content:edit'))) {
      return res.status(403).json({ error: '需要内容编辑权限才能查看全部游戏' })
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
        // 后台填了就用自定义 logo，没填前台自己退回代表作封面
        logo: r.logo || undefined,
        description: r.description || undefined,
        descriptionEn: r.description_en || undefined,
        homepage: r.homepage || undefined,
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
 * 游玩前实时确认：这款游戏是不是成人游戏，以及**这个人**现在能不能玩。
 *
 * 游戏详情 HTML 和公开内容接口会经过 Cloudflare 缓存；后台刚勾选“成人游戏”时，旧详情页
 * 可能还会存活几分钟。这个极小的接口故意不套 publicApi()，让播放器每次挂载前都直接确认
 * 数据库里的当前值，避免缓存窗口成为绕过年龄门的路径。
 *
 * 成人游戏的放行条件由这里统一给出（前端只画结论，不自己算）：
 *   - 没登录                       -> allowed: false, reason: 'login'
 *   - 登录了、账号上没记出生日期     -> allowed: false, reason: 'birthDate'
 *   - 记了出生日期、未满 18          -> allowed: false, reason: 'underage'
 *   - 年满 18                       -> allowed: true
 * 非成人游戏一律 allowed: true。`adult` 字段保留 —— 旧前端产物只认它。
 *
 * 用 optionalUser 而不是 requireUser：非成人游戏游客也要能问，而且失效的令牌
 * 在这里只该被当成「没登录」，不该让整个播放器报错。
 */
gamesRouter.get('/:slug/access', optionalUser, async (req, res, next) => {
  try {
    const rows = await query('SELECT adult, hidden FROM games WHERE slug = ? LIMIT 1', [req.params.slug])
    const game = rows[0]
    if (!game || dbFlag(game.hidden)) return res.status(404).json({ error: '游戏不存在' })
    res.setHeader('Cache-Control', 'no-store')
    res.json(adultAccessVerdict(dbFlag(game.adult), req.user))
  } catch (e) {
    next(e)
  }
})

/**
 * 成人游戏的放行判定。抽成纯函数是为了让 scripts/test-age-gate.mjs 不连库就能把四种情形跑一遍。
 * @param {boolean} adult   这款游戏是不是成人游戏
 * @param {object|undefined} user  users 表的一行；未登录为空
 */
export function adultAccessVerdict(adult, user) {
  if (!adult) return { adult: false, allowed: true, reason: null }
  if (!user) return { adult: true, allowed: false, reason: 'login' }
  const birthDate = user.birth_date ? dateOnly(user.birth_date) : null
  if (!birthDate) return { adult: true, allowed: false, reason: 'birthDate' }
  if (!isAdultByBirthDate(birthDate)) return { adult: true, allowed: false, reason: 'underage' }
  return { adult: true, allowed: true, reason: null }
}

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
    // 已下架的对外当作不存在，只有能编辑内容的人（管理员 / 志愿者）取得到
    if (game.hidden && !(await hasAbility(req, 'content:edit'))) {
      return res.status(404).json({ error: '游戏不存在' })
    }
    if (!game.hidden) publicApi(res)
    res.json(game)
  } catch (e) {
    next(e)
  }
})

/**
 * 按需把游戏简介翻成当前 UI 语言，并缓存到 description_i18n。
 *
 *   POST /api/games/:slug/translate-description
 *   Content-Type: application/json
 *   { "lang": "es" }                        ← 站点语言代码，详 src/config/languages.ts
 *   → 200 { lang: "es", text: "...", cached: bool }
 *   → 400 { error: "语言 es 不需要翻译" }    ← passthrough（zh-Hans / en）
 *   → 400 { error: "不支持的目标语言：xx" }
 *   → 400 { error: "游戏没有简介可翻译" }
 *   → 404 { error: "游戏不存在" }
 *   → 502 { error: "翻译失败：…" }           ← 火山 API 报错
 *   → 503 { error: "翻译服务未配置（缺 VOLC_AK / VOLC_SK）" }
 *
 * 不要求登录：翻译是公开内容，每款游戏每种语言在缓存命中后只调一次，
 * 把这条功能拦在登录门后没收益（反而把不登录的访客挡在门外）。
 *
 * 必须注册在 /:slug 之前 —— Express 按声明顺序匹配，
 * "kof97/translate-description" 真有这种 slug 的话会被当成游戏查询。
 */
gamesRouter.post('/:slug/translate-description', async (req, res, next) => {
  try {
    const lang = String(req.body?.lang ?? '').trim()
    const plan = translatePlan(lang)
    if (!plan) return res.status(400).json({ error: `不支持的目标语言：${lang}` })
    if (plan.passthrough) return res.status(400).json({ error: `语言 ${lang} 不需要翻译` })
    if (!isTranslateConfigured()) {
      return res.status(503).json({ error: '翻译服务未配置（缺 VOLC_AK / VOLC_SK）' })
    }

    // 用「游戏不存在」涵盖简介空着的情况 —— 没东西好翻，
    // 让前端按"按钮可点但报失败"反而是把诊断难度推给访客。
    const game = await getGameBySlug(req.params.slug)
    if (!game) return res.status(404).json({ error: '游戏不存在' })

    // 已经缓存就直返回 —— 同款游戏同语言第二次之后都不再调火山，
    // 这是这套设计的核心防刷：成本 = N 种语言各一次（其中 zh-Hant 不完美，详 translate.js）
    if (game.descriptionI18n?.[lang]) {
      return res.json({ lang, text: game.descriptionI18n[lang], cached: true })
    }

    // 源文：description_en 优先，没有再退到 description（中文），再没有就报错
    const source =
      (game.descriptionEn && game.descriptionEn.trim()) || (game.description && game.description.trim())
    if (!source) return res.status(400).json({ error: '游戏没有简介可翻译' })

    let translated
    try {
      translated = await translateText(source, plan.source, plan.target)
    } catch (e) {
      // 火山那边的错误码透传：AuthFailure / SignatureDoesNotMatch 是 AK/SK 错，
      // LimitExceeded 是 QPS 超限，QuotaExceeded 是欠费。
      // 这些都是运营问题，给 502（"翻译服务暂时不可用"）而不是 500，
      // 客户端的视图是「点完显示失败提示」，不该看到内部错误码
      console.error('[translate] 火山 API 调用失败：', e?.code, e?.message)
      return res.status(502).json({ error: `翻译失败：${e?.message || '未知错误'}` })
    }

    // 写库失败也得先把译文回给前端：UI 已经更新了，DB 写失败只是下次还得再调一次火山。
    // 不能让用户点完了界面上不变还得翻个网络错误。
    try {
      await writeDescriptionTranslation(req.params.slug, lang, translated)
    } catch (e) {
      console.error('[translate] 写 description_i18n 失败：', e?.message)
    }

    // 简介变了 —— 详情页是 SSR，缓存要刷，否则下一个访客拿到的是旧 HTML（带着无翻译的页面）。
    invalidateContent()

    res.json({ lang, text: translated, cached: false })
  } catch (e) {
    next(e)
  }
})

/** 新增 / 整体覆盖一款游戏（后台）。主表与三张关联表在同一个事务里。 */
gamesRouter.put('/:slug', requireAbility('content:edit'), async (req, res, next) => {
  try {
    const slug = String(req.params.slug)
    if (!req.body?.title) return res.status(400).json({ error: '缺少标题' })
    if (!req.body?.platform) return res.status(400).json({ error: '缺少平台' })
    await upsertGame(slug, req.body)
    invalidateContent()
    const saved = await getGameBySlug(slug)
    queueGameSearchPush(saved)
    res.json(saved)
  } catch (e) {
    next(e)
  }
})

/**
 * 局部更新（切换上下架、绑定 ROM …）。
 * 只写请求里带到的列 —— 整行回写会把 plays 之类的值按旧数据盖回去。
 */
gamesRouter.patch('/:slug', requireAbility('content:edit'), async (req, res, next) => {
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
    const saved = await getGameBySlug(slug)
    queueGameSearchPush(saved)
    res.json(saved)
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
gamesRouter.delete('/:slug', requireAbility('content:edit'), async (req, res, next) => {
  try {
    // 删除前先保留平台 / 类型，删除后除了详情 404，聚合页的内容和数量也发生了变化。
    const previous = await getGameBySlug(req.params.slug)
    if (!(await deleteGame(req.params.slug))) return res.status(404).json({ error: '游戏不存在' })
    invalidateContent()
    queueGameSearchPush(previous)
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})
