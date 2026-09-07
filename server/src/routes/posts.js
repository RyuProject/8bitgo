import { Router } from 'express'
import { jsonMemberPath, query, queryOne, withTransaction } from '../db.js'
import { requireAbility, hasAbility } from '../auth.js'
import { invalidateContent } from '../content.js'
import { publicApi } from '../cache.js'
import { postRowToApi, postApiToRow, dbFlag } from '../mappers.js'
import { queuePostSearchPush } from '../search-push.js'
import { isTranslateConfigured, translatePlan } from '../translate.js'
import { renderField, renderMarkdownField } from '../i18n-generate.js'

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
 * 列名虽然过了白名单，键名是变量，所以 lang 也得校验。
 * ⚠️ 路径一律走 `jsonMemberPath()` —— 直接写 `` `$.${lang}` `` 会让 `zh-Hant`
 * 抛 ER_INVALID_JSON_PATH（连字符不是合法标识符），繁体译文一条都写不进去。
 * 那个 bug 在线上活了一段时间，见 db.js 里 jsonMemberPath 的注释。
 *
 * text 限制 64KB：content 正文比游戏简介长得多，Markdown 一篇博客 30-50KB 很正常，
 * 64KB 够用；同时挡住有人手贱贴个 10MB 的测试。
 */
export async function writePostTranslation(slug, field, lang, text) {
  const ALLOWED = ['title_i18n', 'excerpt_i18n', 'content_i18n']
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
    [jsonMemberPath(lang), JSON.stringify(safeText), slug],
  )
  return r.affectedRows > 0
}

/**
 * 文章一发布，就把七种非简体语言的标题 / 摘要 / 正文补齐。
 *
 * ── 为什么不能等玩家点按钮 ──────────────────────────────
 * 「点了才翻」对玩家够用，对搜索引擎完全不够：爬虫不点按钮，SSR 吐出去的就是中文原文。
 * 于是 `/fr/blog`、`/de/blog/xxx` 八种语言的正文一模一样，Google 把它们合并成一个
 * 规范网页（2026-09-07 Search Console 的「重复网页，Google 选择的规范网页与用户
 * 指定的不同」，示例正是 /fr/blog）。译文必须在**内容发布的那一刻**就存在。
 *
 * ── 刻意不 await ───────────────────────────────────────
 * 后台点「保存」不该等七种语言 × 三个字段的翻译跑完（一篇长文能跑十几秒）。
 * 和 `queuePostSearchPush` 一个路数：丢出去、错误只记日志。
 * 漏掉的那些由 `server/scripts/pretranslate.mjs` 兜底 —— 它跳过已有的，重复跑安全。
 *
 * ⚠️ 只在**已发布**时调。草稿翻了纯属白花钱，撤下发布的也不必补。
 *
 * @param {string} slug
 */
function queuePostTranslations(slug) {
  const langs = ['zh-Hant', 'en', 'es', 'fr', 'it', 'de', 'ja']
  ;(async () => {
    const row = await queryOne(
      'SELECT title, excerpt, content, title_i18n, excerpt_i18n, content_i18n FROM posts WHERE slug = ?',
      [slug],
    )
    if (!row) return
    let wrote = 0
    for (const lang of langs) {
      // 源文一律中文（posts 没有英文列），所以 en 也要真翻一次
      const plan = translatePlan(lang, 'zh-Hans')
      if (!plan || plan.passthrough) continue
      // 繁体只要 OpenCC，火山没配也能做；其余语言没配就跳过，别在这里抛错
      if (!plan.convert && !isTranslateConfigured()) continue
      const jobs = [
        ['title_i18n', row.title, row.title_i18n, false],
        ['excerpt_i18n', row.excerpt, row.excerpt_i18n, false],
        ['content_i18n', row.content, row.content_i18n, true],
      ]
      for (const [field, source, cache, markdown] of jobs) {
        if (!source || !String(source).trim()) continue
        if (cache?.[lang]) continue
        try {
          const out = markdown ? await renderMarkdownField(source, plan) : await renderField(source, plan)
          // 简繁转换可能「什么都没变」（源文里没有要转的字）—— 那种不值得占一个键
          if (!out || !out.trim() || (plan.convert && out === source)) continue
          await writePostTranslation(slug, field, lang, out)
          wrote += 1
        } catch (e) {
          console.error(`[post i18n] ${slug} ${field} [${lang}] 失败：`, e?.code, e?.message)
        }
      }
    }
    // 有新译文才值得清缓存 —— 每次保存都清等于把这层缓存作废
    if (wrote) invalidateContent()
  })().catch((e) => console.error('[post i18n] 预生成整体失败：', e?.message))
}

/**
 * 把文章的标题 + 摘要 + 正文按需翻译成当前 UI 语言。和游戏的 `/:slug/translate-description`
 * 是同一个套路，但是文章的三个字段（title + excerpt + content）独立成功 / 失败，写缓存也是
 * 独立的 —— 翻译服务半挂这种边缘情况里，「部分译好」总比「全 502」对玩家更友好。
 *
 * 正常情况下这条路由**不该被用到**：文章发布时 `queuePostTranslations` 已经把七种非简体
 * 语言全补齐了。它现在的角色是兜底 —— 发布那会儿火山抽了、或者语言是后来才加的。
 *
 *   POST /api/posts/:slug/translate
 *   { "lang": "es" }
 *   → 200  { lang, title, excerpt, content, cached, partial }
 *         title / excerpt / content：译文；该字段翻译失败时为空字符串
 *         cached: true 表示三个字段都已经在库里、根本没调火山
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
    /**
     * 源文语言写死 `'zh-Hans'`：`posts` 表**没有任何英文列**，标题 / 摘要 / 正文
     * 三个字段的原文一律是中文。这一点和 games 不同（那边有 description_en）。
     *
     * 直接的后果是 **`en` 在文章这边不是 passthrough**：以前 `translatePlan('en')`
     * 无条件返回 passthrough，这条路由对英文一律 400，于是 `/en/blog` 永远显示中文。
     */
    const plan = translatePlan(lang, 'zh-Hans')
    if (!plan) return res.status(400).json({ error: `不支持的目标语言：${lang}` })
    if (plan.passthrough) return res.status(400).json({ error: `语言 ${lang} 不需要翻译` })
    // 繁体走本地 OpenCC，不需要 AK/SK
    if (!plan.convert && !isTranslateConfigured()) {
      return res.status(503).json({ error: '翻译服务未配置（缺 VOLC_AK / VOLC_SK）' })
    }

    // 直接读原始行而不是 postRowToApi —— 看 excerpt_i18n / content_i18n 是裸 JSON 列，
    // mysql2 已经解成对象了，访问起来比走 readI18nMap 一层过滤简单一点（这里我们
    // 需要的是「原值」（包括空字符串）来判断「缓存命中了但内容是空」这种边角）。
    const row = await queryOne(
      'SELECT title, excerpt, content, title_i18n, excerpt_i18n, content_i18n FROM posts WHERE slug = ?',
      [req.params.slug],
    )
    if (!row) return res.status(404).json({ error: '文章不存在' })

    const titleCached = row.title_i18n?.[lang] || ''
    const excerptCached = row.excerpt_i18n?.[lang] || ''
    const contentCached = row.content_i18n?.[lang] || ''
    if (titleCached && excerptCached && contentCached) {
      return res.json({
        lang,
        title: titleCached,
        excerpt: excerptCached,
        content: contentCached,
        cached: true,
        partial: false,
      })
    }

    const sourceTitle = (row.title || '').trim()
    const sourceExcerpt = (row.excerpt || '').trim()
    const sourceContent = (row.content || '').trim()
    if (!sourceTitle && !sourceExcerpt && !sourceContent) {
      return res.status(400).json({ error: '文章没有内容可翻译' })
    }

    let titleTranslation = ''
    let excerptTranslation = ''
    let contentTranslation = ''
    let anyFailed = false

    // 标题也要译（2026-09-07 加）。以前只译摘要和正文，于是八种语言的博客列表
    // 标题完全相同 —— GSC 把 /fr/blog 判成重复页，那是最主要的一块相同文本。
    if (!titleCached && sourceTitle) {
      try {
        titleTranslation = await renderField(sourceTitle, plan)
      } catch (e) {
        console.error('[post translate] title 失败：', e?.code, e?.message)
        anyFailed = true
      }
    } else {
      titleTranslation = titleCached
    }

    // excerpt 是短文，一次调用即可。失败就 fail（partial=true 表示）。
    if (!excerptCached && sourceExcerpt) {
      try {
        excerptTranslation = await renderField(sourceExcerpt, plan)
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
        contentTranslation = await renderMarkdownField(sourceContent, plan)
      } catch (e) {
        console.error('[post translate] content 失败：', e?.code, e?.message)
        anyFailed = true
      }
    } else {
      contentTranslation = contentCached
    }

    // 「一个字段都没成」-> 502（用户能感知失败，路由层也不该吞错）
    if (!titleTranslation && !excerptTranslation && !contentTranslation) {
      return res.status(502).json({ error: '翻译失败：所有字段都未翻译成功' })
    }

    // 写缓存：成功的字段写、失败的字段不写（保留「还没翻」状态，下次再点会重试）
    // 不 await：缓存失败不影响用户体验，下次点再撞就行
    if (titleTranslation && !titleCached) {
      writePostTranslation(req.params.slug, 'title_i18n', lang, titleTranslation).catch((e) =>
        console.error('[post translate] 写 title_i18n:', e?.message),
      )
    }
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
      title: titleTranslation,
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
    /**
     * 保存前的这一行。两处要用：
     *   1. `published` —— 决定这次要不要通知搜索引擎（见下面 queuePostSearchPush）
     *   2. 三个源文字段 —— 决定**哪几列的译文缓存该作废**（见事务里那段）
     */
    const before = await queryOne('SELECT published, title, excerpt, content FROM posts WHERE slug = ?', [slug])
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
      /**
       * 译文缓存只清**真正变了**的那几列。
       *
       * ⚠️ 以前是无条件三列全清，理由写的是「put 是整体替换」。那在「点了才翻」的年代
       * 只是浪费玩家的一次点击；2026-09-07 加了发布钩子之后它变成了**真金白银**：
       * 后台改一个错别字、甚至只调一下发布日期，都会把 7 种语言 × 3 个字段全部作废，
       * 紧接着钩子又把它们重新翻一遍（长文正文按段落算，一次几十个火山调用）。
       *
       * 逐字段比对，源文没动就把译文留着 —— 钩子那边本来就跳过已有的，
       * 于是「保存但没改内容」的成本正好是零。
       *
       * 新建文章走 before == null：三列本来就是 NULL，不用清。
       */
      if (before) {
        const dirty = []
        if (before.title !== row.title) dirty.push('title_i18n')
        if ((before.excerpt ?? '') !== (row.excerpt ?? '')) dirty.push('excerpt_i18n')
        if ((before.content ?? '') !== (row.content ?? '')) dirty.push('content_i18n')
        if (dirty.length) {
          // 列名全部来自上面这个字面量数组，没有一个字节来自请求 —— 拼进 SQL 是安全的
          await run(`UPDATE posts SET ${dirty.map((c) => `\`${c}\` = NULL`).join(', ')} WHERE id = ?`, [id])
        }
      }
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
    // 已发布才补译（草稿翻了白花钱）。异步、失败只记日志，见 queuePostTranslations。
    if (post.published) queuePostTranslations(slug)
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
