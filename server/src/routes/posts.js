import { Router } from 'express'
import { query, queryOne, withTransaction } from '../db.js'
import { requireAdmin, isAdminRequest } from '../auth.js'
import { invalidateContent } from '../content.js'
import { publicApi } from '../cache.js'
import { postRowToApi, postApiToRow, dbFlag } from '../mappers.js'
import { queuePostSearchPush } from '../search-push.js'

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
 * 文章列表。默认只返回已发布的；?all=1 返回全部（含草稿），需要管理员身份 ——
 * 以前无条件返回全部，草稿正文对任何人可读。
 *
 * 文章数量级远小于游戏（几十到几百），所以不做分页，一次给全。
 */
postsRouter.get('/', async (req, res, next) => {
  try {
    const wantAll = req.query.all === '1'
    if (wantAll && !(await isAdminRequest(req))) {
      return res.status(403).json({ error: '需要管理员权限才能查看草稿' })
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
    if (!post.published && !(await isAdminRequest(req))) {
      return res.status(404).json({ error: '文章不存在' })
    }
    if (post.published) publicApi(res)
    res.json(post)
  } catch (e) {
    next(e)
  }
})

postsRouter.put('/:slug', requireAdmin, async (req, res, next) => {
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

postsRouter.delete('/:slug', requireAdmin, async (req, res, next) => {
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
