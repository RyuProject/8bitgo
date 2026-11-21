/**
 * 文章译文缓存写入的两条守卫：
 *   1. 源文守卫 —— 翻译跑期间后台 PUT 改了正文（并清空 *_i18n），旧正文的译文不能再落库；
 *   2. 长度 —— 超限一律不缓存，不再 `slice(0, 64_000)` 静默截断后永久缓存半篇。
 *
 * 不连数据库：register() 钩子把 src/db.js 换成一个按 SQL 行为模拟 posts 表的假库。
 * 用法：cd server && npm run test:post-translation
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

/** 假的 posts 表：只有一行 */
const post = { slug: 'hello', title: '旧标题', excerpt: '旧摘要', content: '旧正文', content_i18n: null }
const sqlLog = []

globalThis.__fakeDb = {
  async query(sql, params = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim()
    sqlLog.push({ q, params })
    if (q.startsWith('UPDATE posts SET')) {
      const m = /WHERE slug = \?( AND COALESCE\(`(\w+)`, ''\) = \?)?$/.exec(q)
      assert.ok(m, `没认出的 UPDATE：${q}`)
      const [, , slug, guardSource] = [null, null, params[2], params[3]]
      if (slug !== post.slug) return { affectedRows: 0 }
      if (m[1] && String(post[m[2]] ?? '') !== guardSource) return { affectedRows: 0 }
      const col = /UPDATE posts SET `(\w+)`/.exec(q)[1]
      post[col] = { ...post[col], [params[0]]: JSON.parse(params[1]) }
      return { affectedRows: 1 }
    }
    return []
  },
}

const temp = await mkdtemp(path.join(tmpdir(), '8bitgo-post-i18n-'))
let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log('✅ ' + name)
  } catch (e) {
    failed++
    console.log('❌ ' + name + '\n   ' + (e?.message || e))
  }
}
try {
  const fakeDb = path.join(temp, 'fake-db.mjs')
  await writeFile(
    fakeDb,
    [
      'export const query = (sql, params) => globalThis.__fakeDb.query(sql, params)',
      'export const queryOne = async (sql, params) => (await globalThis.__fakeDb.query(sql, params))[0]',
      'export const withTransaction = async (fn) => fn((sql, params) => globalThis.__fakeDb.query(sql, params))',
      'export const ping = async () => true',
      'export const pool = { query: () => { throw new Error("测试不该直接用 pool") } }',
      'export function jsonMemberPath(name) { return "$." + JSON.stringify(String(name)) }',
      '',
    ].join('\n'),
    'utf8',
  )
  const hooks = path.join(temp, 'hooks.mjs')
  await writeFile(
    hooks,
    [
      `const FAKE = ${JSON.stringify(pathToFileURL(fakeDb).href)}`,
      'export async function resolve(specifier, context, next) {',
      '  const r = await next(specifier, context)',
      '  if (r.url.endsWith("/src/db.js")) return { ...r, url: FAKE, shortCircuit: true }',
      '  return r',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  register(pathToFileURL(hooks))
  const { writePostTranslation, POST_TRANSLATION_MAX_CHARS } = await import('../src/routes/posts.js')

  await check('源文没变：带守卫写入成功，SQL 里比的是对应的源列', async () => {
    assert.equal(await writePostTranslation('hello', 'content_i18n', 'en', 'old body', { source: '旧正文' }), true)
    assert.equal(post.content_i18n['$."en"'], 'old body')
    assert.match(sqlLog.at(-1).q, /AND COALESCE\(`content`, ''\) = \?$/)
  })

  await check('⭐ 翻译期间正文被 PUT 改掉：旧译文不落库，返回 false', async () => {
    post.content = '新正文'
    post.content_i18n = null // PUT 会清空 *_i18n
    assert.equal(await writePostTranslation('hello', 'content_i18n', 'fr', 'ancien', { source: '旧正文' }), false)
    assert.equal(post.content_i18n, null)
  })

  await check('标题 / 摘要各比各自的源列', async () => {
    await writePostTranslation('hello', 'title_i18n', 'ja', 'x', { source: '旧标题' })
    assert.match(sqlLog.at(-1).q, /COALESCE\(`title`, ''\)/)
    await writePostTranslation('hello', 'excerpt_i18n', 'ja', 'x', { source: '旧摘要' })
    assert.match(sqlLog.at(-1).q, /COALESCE\(`excerpt`, ''\)/)
  })

  await check('不带守卫（pretranslate 脚本那种）照旧无条件写', async () => {
    assert.equal(await writePostTranslation('hello', 'content_i18n', 'de', 'neu'), true)
    assert.doesNotMatch(sqlLog.at(-1).q, /COALESCE\(`content`/)
  })

  await check('⭐ 超长译文不截断写入，而是抛错、一条 SQL 都不发', async () => {
    const before = sqlLog.length
    const long = 'a'.repeat(POST_TRANSLATION_MAX_CHARS + 1)
    await assert.rejects(writePostTranslation('hello', 'content_i18n', 'it', long), /过长/)
    assert.equal(sqlLog.length, before)
  })

  await check('以前会被截断的 64KB+ 正文现在完整写入', async () => {
    const text = 'b'.repeat(80_000)
    assert.equal(await writePostTranslation('hello', 'content_i18n', 'es', text, { source: '新正文' }), true)
    assert.equal(post.content_i18n['$."es"'].length, 80_000)
  })
} finally {
  await rm(temp, { recursive: true, force: true })
}
if (failed) {
  console.log(`\n❌ ${failed} 项失败`)
  process.exitCode = 1
} else console.log('\n✅ 文章译文写入守卫测试通过')
