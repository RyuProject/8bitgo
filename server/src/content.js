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
import { listGames, getGameBySlug, platformCounts, genreCounts, developerCounts } from './games-repo.js'
import { query } from './db.js'
import { attachPostTags } from './routes/posts.js'

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

/** 首页「分类网格」下面那几栏各列几款游戏 */
const GENRE_COLUMNS = ['action', 'adventure', 'rpg', 'puzzle']

async function loadHome() {
  const [popular, newest, multiplayer, facets, ...samples] = await Promise.all([
    listGames({ sort: 'popular', pageSize: HOME_SIZE }),
    listGames({ sort: 'newest', pageSize: HOME_SIZE }),
    listGames({ multiplayer: true, sort: 'popular', pageSize: HOME_SIZE }),
    loadFacets(),
    ...GENRE_COLUMNS.map((id) => listGames({ genre: id, sort: 'popular', pageSize: 4 })),
  ])
  const genreSamples = {}
  GENRE_COLUMNS.forEach((id, i) => {
    if (samples[i].items.length) genreSamples[id] = samples[i].items
  })
  return {
    popular: popular.items,
    newest: newest.items,
    multiplayer: multiplayer.items,
    genreSamples,
    facets,
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
    // 带搜索词的组合太发散，不进缓存，免得把内存塞满
    const key = q.q ? null : `games:${JSON.stringify(q)}`
    const load = async () => ({ route: 'games', list: await listGames(q), facets: await loadFacets() })
    return key ? cached(key, load) : load()
  }

  // /platforms、/platforms/:id
  if (seg[0] === 'platforms') {
    if (seg[1]) {
      const id = decodeURIComponent(seg[1])
      return cached(`platform:${id}:${qs('page') ?? 1}`, async () => ({
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
      return cached(`genre:${id}:${qs('page') ?? 1}`, async () => ({
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
