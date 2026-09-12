/**
 * SSR 的取数层（schema v2）。
 *
 * v1 是「把整个游戏库和全部文章查出来，塞进每一个页面的 HTML」。91 款时无所谓，
 * 上千款时每次打开首页都要下载整个目录 —— 首屏体积和内存都会失控。
 *
 * v2 改成**按路由取数**：每个页面只查自己要渲染的那部分，
 * 注入 HTML 的也只有这部分。首页几十条、列表页一页、详情页一款 + 相关推荐。
 *
 * 仍然保留一层短缓存（SSR_CACHE_MS，默认 60 秒），但缓存的是「每个路由的结果」
 * 而不是整个库，且带容量上限，不会被爬虫翻页翻到内存爆掉。
 */
import { listGames, listHomePicks, getGameBySlug, platformCounts, genreCounts, developerCounts } from './games-repo.js'
import { topCollections } from './routes/collections.js'
import { query } from './db.js'
import { attachPostTags } from './routes/posts.js'
import { listPublicFriendLinks } from './friend-links.js'

const TTL = Number(process.env.SSR_CACHE_MS || 60_000)
/** 缓存最多存多少个路由的结果 */
const MAX_ENTRIES = Number(process.env.SSR_CACHE_MAX || 500)

/** key -> { at, generation, data } */
const cache = new Map()
const inflight = new Map()
/**
 * 缓存代数。后台写数据时 +1；正在飞的那次查询回来时如果代数变了，
 * 说明它读到的是写库**之前**的数据，直接丢弃不写进缓存 ——
 * 否则后台明明改完了，前台还会拿旧数据顶满一个 TTL。
 */
let generation = 0

export function invalidateContent() {
  generation += 1
  cache.clear()
}

async function cached(key, loader) {
  const hit = cache.get(key)
  if (hit && hit.generation === generation && Date.now() - hit.at < TTL) return hit.data
  const flying = inflight.get(key)
  if (flying) return flying
  const startedAt = generation
  const p = loader()
    .then((data) => {
      if (startedAt === generation) {
        // 超量就丢掉最早写入的那批（Map 按插入顺序迭代）
        if (cache.size >= MAX_ENTRIES) {
          for (const k of cache.keys()) {
            cache.delete(k)
            if (cache.size < MAX_ENTRIES) break
          }
        }
        cache.set(key, { at: Date.now(), generation, data })
      }
      return data
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

/** 首页要用到的几组列表。数量刻意压得很小 —— 首屏只需要这些。 */
const HOME_SIZE = 12
/**
 * 「最热门」那一栏摆几款。5 列 × 2 行，所以是 10。
 * 必须 ≤ HOME_SIZE —— 它是从那次查询的结果里切出来的，不另跑一次 SQL。
 */
const HOT_SIZE = 10

/** 首页「分类网格」下面那几栏各列几款游戏 */
const GENRE_COLUMNS = ['action', 'adventure', 'rpg', 'puzzle']

async function loadHome() {
  const [picks, popular, newest, multiplayer, facets, collections, friendLinks, ...samples] = await Promise.all([
    // 首页第一栏：后台钦点的优先
    listHomePicks(HOME_SIZE),
    listGames({ sort: 'popular', pageSize: HOME_SIZE }),
    listGames({ sort: 'newest', pageSize: HOME_SIZE }),
    listGames({ multiplayer: true, sort: 'popular', pageSize: HOME_SIZE }),
    loadFacets(),
    // 合集那一栏。取 8 个：首页一行最多摆 4 个，多取一些是为了万一有空合集（还没加游戏）
    // 也能凑够一行；建不出来（表还没迁移）时不能把整个首页拖垮，所以单独兜一层
    topCollections(8).catch(() => []),
    // 新代码可能先于迁移上线。特别鸣谢缺表时只隐藏这一栏，不能拖垮整个首页。
    listPublicFriendLinks().catch(() => []),
    ...GENRE_COLUMNS.map((id) => listGames({ genre: id, sort: 'popular', pageSize: 4 })),
  ])
  const genreSamples = {}
  GENRE_COLUMNS.forEach((id, i) => {
    if (samples[i].items.length) genreSamples[id] = samples[i].items
  })
  /**
   * 一款都没钦点时退回按游玩次数自动排 —— 也就是这个功能加进来之前的行为，
   * 新装的站不用先去后台点一遍才有首页。
   *
   * curated 要一路带到前台：手挑出来的列表不能再顶着「按累计游玩次数排序」，
   * 也不该挂 #1 #2 的排名角标。那和站里刚清理掉的假数据是同一类问题 ——
   * 界面在陈述一个并不成立的事实。
   */
  const curated = picks.length > 0

  return {
    popular: curated ? picks : popular.items,
    popularCurated: curated,
    /**
     * 「最热门」那一栏：**始终**是按游玩次数排出来的那份真榜。
     *
     * 为什么不让前台直接用上面的 popular：后台一旦钦点了首页排序，popular 整栏
     * 会变成「站长精选」（人排的顺序），那份真榜在首页上就没有了。这一栏补的正是它。
     *
     * 切的是同一次查询的结果，**不多跑一次 SQL**。没钦点精选时这十款和上面那栏
     * 的前十款是同一批 —— 是同一个排序依据，重复是意料之中的，
     * 要消掉得改产品（开精选、或者给其中一栏换个指标），不是改这里。
     */
    hottest: popular.items.slice(0, HOT_SIZE),
    newest: newest.items,
    multiplayer: multiplayer.items,
    genreSamples,
    facets,
    collections,
    friendLinks,
    total: popular.total,
  }
}

export async function loadFacets() {
  const [platforms, genres, developers] = await Promise.all([platformCounts(), genreCounts(), developerCounts()])
  return {
    platforms: platforms.map((r) => ({ id: r.platform, count: Number(r.n) })),
    genres: genres.map((r) => ({ id: r.genre, count: Number(r.n) })),
    developers: developers.map((r) => ({
      name: r.developer,
      count: Number(r.n),
      // 后台填了就用自定义 logo，没填前台自己退回代表作封面
      logo: r.logo || undefined,
      description: r.description || undefined,
      descriptionEn: r.description_en || undefined,
      homepage: r.homepage || undefined,
      topGame: r.slug
        ? { slug: r.slug, title: r.title, titleZh: r.title_zh || undefined, icon: r.icon, cover: r.cover || undefined, platform: r.platform }
        : undefined,
    })),
  }
}

async function loadPublishedPosts() {
  const rows = await query(
    'SELECT * FROM posts WHERE published = 1 ORDER BY COALESCE(`date`, DATE(created_at)) DESC, id DESC',
  )
  return attachPostTags(rows)
}

/**
 * 按路由取数。返回的对象会被原样注入 HTML，供客户端 hydrate。
 *
 * @param {string} pathname 已经剥掉语言前缀的路径
 * @param {URLSearchParams} search
 */
/**
 * 把 `?page=` 规整成缓存 key 能用的样子。
 *
 * ## 为什么缓存 key 不能直接用原始值
 *
 * 真正生效的页码在下游被夹过（games-repo：`min(max(1, n), totalPages)` 再取整），
 * 所以 `?page=1`、`?page=99999`、`?page=abc`、`?page=1.0` **拿到的是同一份数据**，
 * 而缓存 key 是四个。缓存只有 500 格、FIFO 淘汰 —— 一个 for 循环打 500 个不同的
 * page 就能把整个 SSR 缓存冲干净，之后每一个真实首屏都直穿数据库（每次两条查询：
 * count + select）。而这两条入口（/api/page 和 SSR）都是**未认证、无限流**的。
 *
 * 这里只做「规整」不做「夹到 totalPages」：那个上界要先查出总数才知道，
 * 而缓存 key 必须在查询之前就定下来。规整到整数 + 一个明显过大的上界，
 * 已经把可用的 key 空间从「无穷」压到几百个 —— 超出的那些全部塌缩成同一个 key，
 * 而它们本来就都会被下游夹成最后一页。
 */
const MAX_CACHE_PAGE = 500
export function cachePage(raw) {
  const n = Math.trunc(Number(raw))
  if (!Number.isFinite(n) || n <= 1) return 1
  return Math.min(n, MAX_CACHE_PAGE)
}

export async function loadForRoute(pathname, search) {
  const seg = pathname.split('/').filter(Boolean)
  const qs = (k) => search?.get(k) ?? undefined

  // 首页
  if (seg.length === 0) return cached('home', async () => ({ route: 'home', ...(await loadHome()) }))

  // /games、/games/:slug
  if (seg[0] === 'games') {
    if (seg[1]) {
      const slug = decodeURIComponent(seg[1])
      return cached(`game:${slug}`, async () => {
        const game = await getGameBySlug(slug)
        if (!game || game.hidden) return { route: 'game', game: null }
        // 相关推荐：同平台的其它游戏，够用且只要一条索引
        const related = await listGames({ platform: game.platform, sort: 'popular', pageSize: 9 })
        return { route: 'game', game, related: related.items.filter((g) => g.slug !== slug).slice(0, 8) }
      })
    }
    const q = {
      platform: qs('platform'), genre: qs('genre'), developer: qs('developer'),
      multiplayer: qs('multiplayer') === '1', coin: qs('coin') === '1',
      q: qs('q'), sort: qs('sort'), page: qs('page'),
    }
    // 带搜索词的组合太发散，不进缓存，免得把内存塞满。
    // ⚠️ page 要规整过再进 key，理由见 cachePage
    const key = q.q ? null : `games:${JSON.stringify({ ...q, page: cachePage(q.page) })}`
    const load = async () => ({ route: 'games', list: await listGames(q), facets: await loadFacets() })
    return key ? cached(key, load) : load()
  }

  // /platforms、/platforms/:id
  if (seg[0] === 'platforms') {
    if (seg[1]) {
      const id = decodeURIComponent(seg[1])
      return cached(`platform:${id}:${cachePage(qs('page'))}`, async () => ({
        route: 'platform',
        id,
        list: await listGames({ platform: id, sort: 'popular', page: qs('page') }),
      }))
    }
    return cached('platforms', async () => ({ route: 'platforms', facets: await loadFacets() }))
  }

  // /genres、/genres/:id
  if (seg[0] === 'genres') {
    if (seg[1]) {
      const id = decodeURIComponent(seg[1])
      return cached(`genre:${id}:${cachePage(qs('page'))}`, async () => ({
        route: 'genre',
        id,
        list: await listGames({ genre: id, sort: 'popular', page: qs('page') }),
      }))
    }
    return cached('genres', async () => ({ route: 'genres', facets: await loadFacets() }))
  }

  if (seg[0] === 'developers') return cached('developers', async () => ({ route: 'developers', facets: await loadFacets() }))

  // 博客：数量级小，一次给全
  if (seg[0] === 'blog') {
    return cached('blog', async () => ({ route: 'blog', posts: await loadPublishedPosts() }))
  }

  // 其余页面（/play-local、/rooms、/me、静态页…）不需要预取游戏数据
  return cached('facets-only', async () => ({ route: 'other', facets: await loadFacets() }))
}
