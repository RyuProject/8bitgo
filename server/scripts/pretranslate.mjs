/**
 * 把游戏简介 / 游戏中文译名 / 博客文章批量预生成成各语言版本。
 *
 * 用法（在 server/ 下跑，或 `node server/scripts/pretranslate.mjs`）：
 *   npm run pretranslate -- --dry-run              先看要做多少、花多少次 API
 *   npm run pretranslate -- --langs=zh-Hant        只补繁体（**不花钱**，纯本地 OpenCC）
 *   npm run pretranslate -- --yes                  全部语言，真的写库
 *   npm run pretranslate -- --only=posts --yes     只做文章
 *   npm run pretranslate -- --slug=kof97 --force --yes   重做某一条（覆盖已有译文）
 *
 * ── 为什么要有这个脚本 ──────────────────────────────────────
 * 译文本来只在**玩家点「翻译」按钮**时才生成。对玩家够用，对搜索引擎完全不够：
 * 爬虫不点按钮，SSR 出去的就是中文原文。于是八种语言的同一个页面正文一模一样，
 * Search Console 报「重复网页，Google 选择的规范网页与用户指定的不同」——
 * 2026-09-07 的两个示例是 /fr/blog 和 /zh-Hant/platforms/arcade。
 *
 * 预生成一遍之后，每个语言前缀下的页面才有各自的正文，hreflang 那一簇才立得住。
 *
 * ── 成本 ────────────────────────────────────────────────
 *   zh-Hant  —— OpenCC 本地转换，**零成本**，随便跑
 *   其余语言 —— 每个字段一次火山 TranslateText（文章正文按段落切，一段一次）
 * 所以默认**不动手**：先打印计划和「要调多少次火山」，看清楚了再加 `--yes`。
 * 已经有译文的字段一律跳过（想重做加 `--force`），重复跑是安全的。
 *
 * ⚠️ 跑完要让前台看见，得清两层缓存：
 *   1. 服务端进程内的内容缓存 —— 重启 node，或在后台随便改存一次内容（会调 invalidateContent）
 *   2. Cloudflare 边缘的 HTML —— 手动 Purge，否则最多 PAGE_S_MAXAGE 秒内前台还是旧的
 */
import 'dotenv/config'
import { pool, query } from '../src/db.js'
import { translatePlan, isTranslateConfigured, volcCode } from '../src/translate.js'
import { renderField, renderMarkdownField, gameDescriptionSource } from '../src/i18n-generate.js'
import { isZhConvertAvailable } from '../src/zh-convert.js'
import { writeDescriptionTranslation, writeTitleTranslation } from '../src/games-repo.js'
import { writePostTranslation } from '../src/routes/posts.js'

/* ---------------- 参数 ---------------- */

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name, dflt = '') => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}

const DRY = flag('dry-run') || !flag('yes')
const FORCE = flag('force')
const ONLY = opt('only') // '' | 'games' | 'posts'
const SLUG = opt('slug')
const LIMIT = Number(opt('limit', '0')) || 0

/**
 * 默认目标语言。
 *
 * `zh-Hans` 不在里面：它是**基准**，前端对 zh-Hans 直接读 description / title_zh /
 * excerpt / content，i18n 里那个键一辈子不会被读到，生成它纯属浪费。
 *
 * `en` 对两类内容的含义不同，所以由下面各自的 plan 决定要不要真做：
 *   游戏 —— 有 description_en 这个基准列，en 是 passthrough，跳过；
 *   文章 —— 没有英文列，en 必须真翻一次，否则 /en/blog 永远是中文。
 */
const DEFAULT_LANGS = ['zh-Hant', 'en', 'es', 'fr', 'it', 'de', 'ja']
const LANGS = (opt('langs') ? opt('langs').split(',') : DEFAULT_LANGS).map((x) => x.trim()).filter(Boolean)

for (const l of LANGS) {
  if (l === 'zh-Hans') {
    console.error('zh-Hans 是基准语言，没有译文可生成 —— 从 --langs 里去掉它')
    process.exit(1)
  }
  if (!volcCode(l) && l !== 'zh-Hant') {
    console.error(`不认识的语言：${l}`)
    process.exit(1)
  }
}

/* ---------------- 计数 ---------------- */

const stat = { volc: 0, opencc: 0, skipped: 0, failed: 0, wrote: 0 }
/** 逐条打印会淹掉输出，失败的单独攒起来最后一起报 */
const failures = []

/**
 * 生成一个字段并写库。
 *
 * @param {object} a
 * @param {string} a.what     日志用的人类可读标识，例如 `游戏 kof97 简介 [fr]`
 * @param {string} a.source   源文
 * @param {object} a.plan     translatePlan 的结果
 * @param {boolean} a.cached  这个字段已经有译文了
 * @param {boolean} a.markdown 按 Markdown 分段处理（文章正文）
 * @param {(text: string) => Promise<unknown>} a.write 真正落库
 */
async function doField({ what, source, plan, cached, markdown = false, write }) {
  if (!source || !source.trim()) return
  if (cached && !FORCE) {
    stat.skipped += 1
    return
  }
  if (plan.convert) stat.opencc += 1
  // 火山的调用次数：正文按段落切，所以是段数而不是 1 —— 预估成本时这个数字才是对的
  else stat.volc += markdown ? source.split(/\n\n+/).filter((x) => x.trim()).length : 1

  if (DRY) return
  try {
    const out = markdown ? await renderMarkdownField(source, plan) : await renderField(source, plan)
    if (!out || !out.trim()) throw new Error('生成结果为空')
    // 简繁转换有一种「什么都没变」的正常情况：源文里没有需要转的字（纯英文标题、
    // 纯数字）。写进去只是让 JSON 列多一个和原文一样的键，没有害但也没有用。
    if (plan.convert && out === source) {
      stat.skipped += 1
      return
    }
    await write(out)
    stat.wrote += 1
  } catch (e) {
    stat.failed += 1
    failures.push(`${what}：${e?.code || ''} ${e?.message || e}`)
  }
}

/* ---------------- 游戏 ---------------- */

async function runGames() {
  const rows = await query(
    `SELECT slug, title, title_zh, title_i18n, description, description_en, description_i18n
       FROM games ${SLUG ? 'WHERE slug = ?' : ''} ORDER BY id ${LIMIT ? 'LIMIT ' + LIMIT : ''}`,
    SLUG ? [SLUG] : [],
  )
  console.log(`\n▌游戏 ${rows.length} 款`)
  for (const r of rows) {
    // mysql2 会把 JSON 列解成对象，但直接改过库的行可能是字符串 —— 两种都收
    const titleI18n = typeof r.title_i18n === 'string' ? JSON.parse(r.title_i18n || '{}') : r.title_i18n || {}
    const descI18n =
      typeof r.description_i18n === 'string' ? JSON.parse(r.description_i18n || '{}') : r.description_i18n || {}
    const game = { description: r.description, descriptionEn: r.description_en }
    const source = gameDescriptionSource(game)

    for (const lang of LANGS) {
      /**
       * 译名只做繁体。非中文界面**刻意**用原名 `title`（见 i18nData.gameTitle 的注释）——
       * 给英文页配一个中文译名反而会造出「Play 超级马力欧兄弟 Online」。
       */
      if (lang === 'zh-Hant' && r.title_zh) {
        const plan = translatePlan(lang, 'zh-Hans')
        await doField({
          what: `游戏 ${r.slug} 译名 [${lang}]`,
          source: r.title_zh,
          plan,
          cached: Boolean(titleI18n[lang]),
          write: (text) => writeTitleTranslation(r.slug, lang, text),
        })
      }

      if (!source) continue
      const plan = translatePlan(lang, source.lang)
      // passthrough：目标语言就是源文语言（游戏填了 description_en 时的 en）
      if (!plan || plan.passthrough) continue
      await doField({
        what: `游戏 ${r.slug} 简介 [${lang}]`,
        source: source.text,
        plan,
        cached: Boolean(descI18n[lang]),
        write: (text) => writeDescriptionTranslation(r.slug, lang, text),
      })
    }
  }
}

/* ---------------- 文章 ---------------- */

async function runPosts() {
  const rows = await query(
    `SELECT slug, title, title_i18n, excerpt, excerpt_i18n, content, content_i18n
       FROM posts WHERE published = 1 ${SLUG ? 'AND slug = ?' : ''} ORDER BY id ${LIMIT ? 'LIMIT ' + LIMIT : ''}`,
    SLUG ? [SLUG] : [],
  )
  console.log(`\n▌已发布文章 ${rows.length} 篇`)
  // 草稿一律不做：没被收录过，翻它只是白花钱；发布的那一刻钩子会补上（routes/posts.js）
  for (const r of rows) {
    const j = (v) => (typeof v === 'string' ? JSON.parse(v || '{}') : v || {})
    const titleI18n = j(r.title_i18n)
    const excerptI18n = j(r.excerpt_i18n)
    const contentI18n = j(r.content_i18n)

    for (const lang of LANGS) {
      // 文章源文一律中文 —— posts 表没有任何英文列，所以 en 不是 passthrough
      const plan = translatePlan(lang, 'zh-Hans')
      if (!plan || plan.passthrough) continue
      await doField({
        what: `文章 ${r.slug} 标题 [${lang}]`,
        source: r.title,
        plan,
        cached: Boolean(titleI18n[lang]),
        write: (text) => writePostTranslation(r.slug, 'title_i18n', lang, text),
      })
      await doField({
        what: `文章 ${r.slug} 摘要 [${lang}]`,
        source: r.excerpt,
        plan,
        cached: Boolean(excerptI18n[lang]),
        write: (text) => writePostTranslation(r.slug, 'excerpt_i18n', lang, text),
      })
      await doField({
        what: `文章 ${r.slug} 正文 [${lang}]`,
        source: r.content,
        plan,
        cached: Boolean(contentI18n[lang]),
        markdown: true,
        write: (text) => writePostTranslation(r.slug, 'content_i18n', lang, text),
      })
    }
  }
}

/* ---------------- 主流程 ---------------- */

const t0 = Date.now()
try {
  const needVolc = LANGS.some((l) => l !== 'zh-Hant')
  const openccOk = await isZhConvertAvailable()

  console.log(`目标语言：${LANGS.join(', ')}`)
  console.log(`简繁转换（OpenCC）：${openccOk ? '可用' : '⚠️ 不可用 —— npm i opencc-js'}`)
  console.log(`火山翻译：${isTranslateConfigured() ? '已配置' : '⚠️ 未配置（缺 VOLC_AK / VOLC_SK）'}`)
  if (LANGS.includes('zh-Hant') && !openccOk) {
    console.error('\n繁体是这次的目标之一，但 opencc-js 没装 —— 先 npm i opencc-js')
    process.exit(1)
  }
  if (needVolc && !isTranslateConfigured() && !DRY) {
    console.error('\n目标里有需要翻译的语言，但火山未配置。只想补繁体的话：--langs=zh-Hant')
    process.exit(1)
  }

  if (ONLY !== 'posts') await runGames()
  if (ONLY !== 'games') await runPosts()

  console.log(
    `\n${DRY ? '【试运行，什么都没写】' : '完成'}` +
      `\n  OpenCC 转换 ${stat.opencc} 项（免费）` +
      `\n  火山调用   ${stat.volc} 次${DRY ? '（预估，正文按段落算）' : ''}` +
      `\n  已有跳过   ${stat.skipped} 项` +
      (DRY ? '' : `\n  实际写入   ${stat.wrote} 项`) +
      `\n  失败       ${stat.failed} 项` +
      `\n  耗时       ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  )
  if (failures.length) {
    console.log('\n失败明细：')
    for (const f of failures.slice(0, 40)) console.log('  ·', f)
    if (failures.length > 40) console.log(`  …还有 ${failures.length - 40} 条`)
  }
  if (DRY) console.log('\n看清楚了就加 --yes 真跑。只补繁体不花钱：--langs=zh-Hant --yes')
  else console.log('\n⚠️ 别忘了：重启 node（清进程内容缓存）+ 清一次 Cloudflare 缓存，前台才会变')
} catch (e) {
  console.error('挂了：', e)
  process.exitCode = 1
} finally {
  await pool.end()
}
