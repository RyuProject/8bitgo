import { Router } from 'express'
import { query, queryOne, withTransaction } from '../db.js'
import { requireAbility, hasAbility } from '../auth.js'
import { invalidateContent } from '../content.js'
import { publicApi } from '../cache.js'
import { postRowToApi, postApiToRow, dbFlag } from '../mappers.js'
import { queuePostSearchPush } from '../search-push.js'
import { isTranslateConfigured, translateMarkdown, translatePlan, translateText } from '../translate.js'

export const postsRouter = Router()

/** 给一批文章装配标签（批量，不做 N+1） */
export async function attachPostTags(rows) {
  if (!rows.length) return []
  const ids = rows.map((r) => r.id)
  const tagRows = await query(
    `SELECT post_id, tag FROM post_tags WHERE post_id IN (${ids.map(() => '?').join(',')})`,
    ids,
  )
  const tags = new Map()
  for (const r of tagRows) {
    const k = String(r.post_id)
    if (!tags.has(k)) tags.set(k, [])
    tags.get(k).push(r.tag)
  }
  return rows.map((r) => postRowToApi(r, { tags: tags.get(String(r.id)) ?? [] }))
}

async function writeTags(run, postId, tags) {
  await run('DELETE FROM post_tags WHERE post_id = ?', [postId])
  const list = [...new Set((tags ?? []).map((t) => String(t).trim()).filter(Boolean))]
  if (!list.length) return
  await run(
    `INSERT INTO post_tags (post_id, tag) VALUES ${list.map(() => '(?, ?)').join(', ')}`,
    list.flatMap((t) => [postId, t]),
  )
}

/**
 * 给某一列写一条翻译缓存。field 严格走白名单 —— 任何外部输入都不允许
 * 直接拼进 SQL，否则就是 SQL 注入。
 *
 * 列名虽然过了白名单，键名（`$.${lang}`）是变量，所以 lang 也得校验；
 * 校验同时给 key 兜底（中文 lang 用 BCP-47 是 `zh-Hans`，需要 JSON_QUOTE 包才能当 key 用）。
 *
 * text 限制 64KB：content 正文比游戏简介长得多，Markdown 一篇博客 30-50KB 很正常，
 * 64KB 够用；同时挡住有人手贱贴个 10MB 的测试。
 */
export async function writePostTranslation(slug, field, lang, text) {
  const ALLOWED = ['excerpt_i18n', 'content_i18n']
  if (!ALLOWED.includes(field)) throw new Error(`不支持的字段：${field}`)
  if (!/^[a-zA-Z-]{2,10}$/.test(lang)) throw new Error('lang 必须合法')
  const safeText = String(text ?? '').slice(0, 64_000)
  const column = '`' + field + '`'
  const r = await query(
    `UPDATE posts SET ${column} = JSON_SET(
       COALESCE(${column}, JSON_OBJECT()),
       ?,
       CAST(? AS JSON)
     ) WHERE slug = ?`,
    [`$.${lang}`, JSON.stringify(safeText), slug],
  )
  return r.affectedRows > 0
}

/**
 * 把文章的摘要 + 正文按需翻译成当前 UI 语言。和游戏的 `/:slug/translate-description`
 * 是同一个套路，但是文章的两个字段（excerpt + content）独立成功 / 失败，写缓存也是
 * 独立的 —— 翻译服务半挂这种边缘情况里，「部分译好」总比「全 502」对玩家更友好。
 *
 *   POST /api/posts/:slug/translate
 *   { "lang": "es" }
 *   → 200  { lang, excerpt, content, cached, partial }
 *         excerpt / content：译文；该字段翻译失败时为空字符串
 *         cached: true 表示两个字段都已经在库里、根本没调火山
 *         partial: true 表示只有一部分字段翻译成功
 *   → 400  语言不合法 / 帖子没有内容可翻译
 *   → 404  文章不存在
 *   → 502  两个字段都翻译失败
 *   → 503  翻译服务未配置（缺 VOLC_AK / VOLC_SK）
 *
 * 不要求登录：每篇文章每种语言只调一次（缓存命中即返），相当于一次性的 N×8 次公开调用，
 * 不该拦在登录门后。
 *
 * 必须注册在 `postsRouter.get('/:slug')` 之前 —— Express 按声明顺序匹配，
 * 否则「<slug>/translate」真有这么个 slug 的话会被当成 GET /:slug 处理掉。
 */
postsRouter.post('/:slug/translate', async (req, res, next) => {
  try {
    const lang = String(req.body?.lang ?? '').trim()
    const plan = translatePlan(lang)
    if (!plan) return res.status(400).json({ error: `不支持的目标语言：${lang}` })
    if (plan.passthrough) return res.status(400).json({ error: `语言 ${lang} 不需要翻译` })
    if (!isTranslateConfigured()) {
      return res.status(503).json({ error: '翻译服务未配置（缺 VOLC_AK / VOLC_SK）' })
    }

    // 直接读原始行而不是 postRowToApi —— 看 excerpt_i18n / content_i18n 是裸 JSON 列，
    // mysql2 已经解成对象了，访问起来比走 readI18nMap 一层过滤简单一点（这里我们
    // 需要的是「原值」（包括空字符串）来判断「缓存命中了但内容是空」这种边角）。
    const row = await queryOne('SELECT excerpt, content, excerpt_i18n, content_i18n FROM posts WHERE slug = ?', [req.params.slug])
    if (!row) return res.status(404).json({ error: '文章不存在' })

    const excerptCached = row.excerpt_i18n?.[lang] || ''
    const contentCached = row.content_i18n?.[lang] || ''
    if (excerptCached && contentCached) {
      return res.json({ lang, excerpt: excerptCached, content: contentCached, cached: true, partial: false })
    }

    const sourceExcerpt = (row.excerpt || '').trim()
    const sourceContent = (row.content || '').trim()
    if (!sourceExcerpt && !sourceContent) {
      return res.status(400).json({ error: '文章没有内容可翻译' })
    }

    let excerptTranslation = ''
    let contentTranslation = ''
    let anyFailed = false

    // excerpt 是短文，一次调用即可。失败就 fail（partial=true 表示）。
    if (!excerptCached && sourceExcerpt) {
      try {
        excerptTranslation = await translateText(sourceExcerpt, plan.source, plan.target)
      } catch (e) {
        console.error('[post translate] excerpt 失败：', e?.code, e?.message)
        anyFailed = true
      }
    } else {
      excerptTranslation = excerptCached
    }

    // content 长，按段落分块并发（translateMarkdown 内部限并发 3 避免撞火山 QPS）。
    // 失败同上：失败字段留空字符串、partial=true，用户再次点能再试一次，
    // 也能正常显示「已经翻译好的部分」。
    if (!contentCached && sourceContent) {
      try {
        contentTranslation = await translateMarkdown(sourceContent, plan.source, plan.target)
      } catch (e) {
        console.error('[post translate] content 失败：', e?.code, e?.message)
        anyFailed = true
      }
    } else {
      contentTranslation = contentCached
    }

    // 「两个字段都没有翻译成功」-> 502（用户能感知失败，路由层也不该吞错）
    if (!excerptTranslation && !contentTranslation) {
      return res.status(502).json({ error: '翻译失败：所有字段都未翻译成功' })
    }

    // 写缓存：成功的字段写、失败的字段不写（保留「还没翻」状态，下次再点会重试）
    // 不 await：缓存失败不影响用户体验，下次点再撞就行
    if (excerptTranslation && !excerptCached) {
      writePostTranslation(req.params.slug, 'excerpt_i18n', lang, excerptTranslation).catch((e) =>
        console.error('[post translate] 写 excerpt_i18n:', e?.message),
      )
    }
    if (contentTranslation && !contentCached) {
      writePostTranslation(req.params.slug, 'content_i18n', lang, contentTranslation).catch((e) =>
        console.error('[post translate] 写 content_i18n:', e?.message),
      )
    }

    invalidateContent()

    res.json({
      lang,
      excerpt: excerptTranslation,
      content: contentTranslation,
      cached: false,
      partial: anyFailed,
    })
  } catch (e) {
    next(e)
  }
})

/**
 * 文章列表。默认只返回已发布的；?all=1 返回全部（含草稿），需要管理员身份 ——
 * 以前无条件返回全部，草稿正文对任何人可读。
 *
 * 文章数量级远小于游戏（几十到几百），所以不做分页，一次给全。
 */
postsRouter.get('/', async (req, res, next) => {
  try {
    const wantAll = req.query.all === '1'
    if (wantAll && !(await hasAbility(req, 'content:edit'))) {
      return res.status(403).json({ error: '需要内容编辑权限才能查看草稿' })
    }
    const rows = await query(
      wantAll
        ? 'SELECT * FROM posts ORDER BY COALESCE(`date`, DATE(created_at)) DESC, id DESC'
        : 'SELECT * FROM posts WHERE published = 1 ORDER BY COALESCE(`date`, DATE(created_at)) DESC, id DESC',
    )
    if (!wantAll) publicApi(res)
    res.json(await attachPostTags(rows))
  } catch (e) {
    next(e)
  }
})

postsRouter.get('/:slug', async (req, res, next) => {
  try {
    const row = await queryOne('SELECT * FROM posts WHERE slug = ?', [req.params.slug])
    if (!row) return res.status(404).json({ error: '文章不存在' })
    const [post] = await attachPostTags([row])
    if (!post.published && !(await hasAbility(req, 'content:edit'))) {
      return res.status(404).json({ error: '文章不存在' })
    }
    if (post.published) publicApi(res)
    res.json(post)
  } catch (e) {
    next(e)
  }
})

postsRouter.put('/:slug', requireAbility('content:edit'), async (req, res, next) => {
  try {
    const slug = String(req.params.slug)
    if (!req.body?.title) return res.status(400).json({ error: '缺少标题' })
    // 保存前的发布状态。决定这次要不要通知搜索引擎时用得上（见下面 queuePostSearchPush 处）。
    const before = await queryOne('SELECT published FROM posts WHERE slug = ?', [slug])
    await withTransaction(async (run) => {
      const row = postApiToRow({ ...req.body, slug })
      const cols = Object.keys(row)
      const updates = cols.filter((c) => c !== 'slug').map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(', ')
      await run(
        `INSERT INTO posts (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
         ON DUPLICATE KEY UPDATE ${updates}`,
        cols.map((c) => row[c]),
      )
      const [{ id }] = await run('SELECT id FROM posts WHERE slug = ?', [slug])
      await writeTags(run, id, req.body.tags)
      // 清空按需翻译缓存：excerpt / content 都已被新数据整行覆盖（INSERT ... ON DUP 不带 i18n 列），
      // 旧译文留下来就和新的基准对不上。和 games 的 patchGame 同思路（见 AGENTS.md §2.17），
      // 但 put 是整体替换，无条件清就行，不用判断「哪几列变了」。
      await run('UPDATE posts SET excerpt_i18n = NULL, content_i18n = NULL WHERE id = ?', [id])
    })
    invalidateContent()
    const saved = await queryOne('SELECT * FROM posts WHERE slug = ?', [slug])
    const [post] = await attachPostTags([saved])
    /**
     * 只在这个 URL 对搜索引擎「可见过」时才推：
     *   - 现在是已发布 → 新发或改动，要推
     *   - 之前已发布、现在撤下 → URL 变成 404，更要推，否则搜索结果里会长期挂着死链
     *   - 草稿改草稿 → 从来没被收录过，推它只是白耗百度那点每日配额
     */
    if (post.published || dbFlag(before?.published)) queuePostSearchPush(post)
    res.json(post)
  } catch (e) {
    next(e)
  }
})

postsRouter.delete('/:slug', requireAbility('content:edit'), async (req, res, next) => {
  try {
    const slug = String(req.params.slug)
    // 删之前先看一眼发布状态：删完就查不到了，而「这篇是否被收录过」决定要不要推送。
    const before = await queryOne('SELECT published FROM posts WHERE slug = ?', [slug])
    // post_tags 有外键级联，跟着一起删
    const r = await query('DELETE FROM posts WHERE slug = ?', [slug])
    if (!r.affectedRows) return res.status(404).json({ error: '文章不存在' })
    invalidateContent()
    // 已发布的文章被删除，详情页变 404、博客列表也少了一条，两个都要让搜索引擎重抓。
    if (dbFlag(before?.published)) queuePostSearchPush({ slug })
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})
