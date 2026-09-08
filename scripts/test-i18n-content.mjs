/**
 * 「八种语言的同一个页面不许是同一份正文」的守卫。
 *
 * ── 为什么要有这个测试 ────────────────────────────────────
 * 2026-09-07 Search Console 报「重复网页，Google 选择的规范网页与用户指定的不同」，
 * 示例是 `/fr/blog` 和 `/zh-Hant/platforms/arcade`。病因不是标签写错，而是**正文真的一样**：
 *   - `BlogPage.tsx` 直接渲染 `post.title` / `post.excerpt`，一个字都不看语言；
 *   - `gameTitle` 对 zh-Hant 返回的就是简体译名。
 * 两处都是「有译文的列，但页面没读」。这类 bug 页面自己打开一切正常、控制台不报错、
 * tsc 也拦不住 —— 只有去读渲染结果才看得出来，所以必须有断言盯着。
 *
 * 分三节：
 *   1. 回退链单测：每个语言取到的到底是哪个字段
 *   2. 「八种语言互不相同」：译文齐了之后，主体文本必须两两不等
 *   3. 源码扫描：列表页 / 详情页不许把原文字段直接写进 JSX
 *
 * 跑：`npm run test:i18n-content`
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SITE_LANGUAGES, SITE_DEFAULT_LANGUAGE } from '../shared/site-languages.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const { gameTitle, postTitle, postExcerpt, postContent, needsPostTranslation } = await import(
  '../src/services/i18nData.ts'
)

let pass = 0
const fails = []
const ok = (name) => {
  pass += 1
  console.log(`  ✓ ${name}`)
}
const bad = (name, e) => {
  fails.push(name)
  console.log(`  ✗ ${name}\n    ${e?.message || e}`)
}

const LANGS = SITE_LANGUAGES.map((l) => l.code)

/* ---------------- 0. 前提 ---------------- */
try {
  assert.equal(SITE_DEFAULT_LANGUAGE, 'zh-Hans', '基准语言变了的话下面所有回退链断言都要重写')
  assert.ok(LANGS.includes('zh-Hant'), '语言表里必须有 zh-Hant')
  assert.equal(LANGS.length, 8, `站点语言数变成 ${LANGS.length} 了，检查一下 pretranslate 的目标语言表`)
  ok(`前提：8 种语言、基准是 ${SITE_DEFAULT_LANGUAGE}`)
} catch (e) {
  bad('前提：语言表形状', e)
}

/* ---------------- 1. 游戏名的回退链 ---------------- */
try {
  const full = { title: 'Metal Slug 3', titleZh: '合金弹头 3', titleI18n: { 'zh-Hant': '合金彈頭 3' } }
  assert.equal(gameTitle(full, 'zh-Hant'), '合金彈頭 3', '繁体必须优先取 titleI18n')
  assert.equal(gameTitle(full, 'zh-Hans'), '合金弹头 3')
  // 非中文界面**刻意**用原名，不然会出现「Play 合金弹头 3 Online」这种中英夹杂
  for (const lang of ['en', 'es', 'fr', 'it', 'de', 'ja']) {
    assert.equal(gameTitle(full, lang), 'Metal Slug 3', `${lang} 必须用原名`)
  }

  // 没生成过繁体译名：回退到简体译名（能读，但那正是被判重复的状态）
  const noHant = { title: 'Metal Slug 3', titleZh: '合金弹头 3' }
  assert.equal(gameTitle(noHant, 'zh-Hant'), '合金弹头 3')
  // 连中文译名都没有：回退到原名。空串和 null 都算「没有」（用 || 不是 ??）
  assert.equal(gameTitle({ title: 'Tekken 3', titleZh: '' }, 'zh-Hans'), 'Tekken 3')
  assert.equal(gameTitle({ title: 'Tekken 3', titleZh: null }, 'zh-Hant'), 'Tekken 3')
  assert.equal(gameTitle({ title: 'Tekken 3' }, 'zh-Hant'), 'Tekken 3')
  ok('gameTitle：繁体取译名，其余语言用原名，三种「没有」都落回原名')
} catch (e) {
  bad('gameTitle 回退链', e)
}

/* ---------------- 2. 文章三个字段的回退链 ---------------- */
try {
  const post = {
    title: '欢迎来到8bitgo',
    excerpt: '这是摘要',
    content: '# 正文',
    titleI18n: { 'zh-Hant': '歡迎來到8bitgo', fr: 'Bienvenue', en: 'Welcome' },
    excerptI18n: { fr: 'Le résumé' },
    contentI18n: { fr: '# Le corps' },
  }
  // 基准语言直取原文，不看 i18n
  assert.equal(postTitle(post, 'zh-Hans'), '欢迎来到8bitgo')
  assert.equal(postExcerpt(post, 'zh-Hans'), '这是摘要')
  assert.equal(postContent(post, 'zh-Hans'), '# 正文')
  // 有译文就用译文
  assert.equal(postTitle(post, 'fr'), 'Bienvenue')
  assert.equal(postExcerpt(post, 'fr'), 'Le résumé')
  assert.equal(postContent(post, 'fr'), '# Le corps')
  assert.equal(postTitle(post, 'zh-Hant'), '歡迎來到8bitgo')
  /**
   * **en 必须走 i18n**。posts 表没有任何英文列，所以英文界面拿不到「英文基准」——
   * 这一条以前是反的（translatePlan 把 en 当 passthrough），`/en/blog` 因此永远是中文。
   */
  assert.equal(postTitle(post, 'en'), 'Welcome')
  // 没译过的语言落回中文原文（能读，但会被判重复）
  assert.equal(postTitle(post, 'de'), '欢迎来到8bitgo')
  assert.equal(postExcerpt(post, 'en'), '这是摘要')
  // 空值不许变成 undefined
  assert.equal(postTitle({}, 'fr'), '')
  assert.equal(postExcerpt({}, 'fr'), '')
  assert.equal(postContent({}, 'fr'), '')
  ok('postTitle / postExcerpt / postContent：en 也走 i18n，缺译文落回中文')
} catch (e) {
  bad('文章字段回退链', e)
}

/* ---------------- 3. 翻译按钮的判据要含标题 ---------------- */
try {
  const done = { titleI18n: { fr: 'a' }, excerptI18n: { fr: 'b' }, contentI18n: { fr: 'c' } }
  assert.equal(needsPostTranslation(done, 'fr'), false, '三个字段都齐了才该隐藏按钮')
  assert.equal(needsPostTranslation(done, 'zh-Hans'), false, '基准语言永远不显示按钮')
  /**
   * 只缺标题时按钮**必须还在**。这一条以前是漏的：判据只看 excerpt/content，
   * 两者齐了就把按钮藏了 —— 于是标题永远没有译文，而且没有任何入口能补。
   */
  const noTitle = { excerptI18n: { fr: 'b' }, contentI18n: { fr: 'c' } }
  assert.equal(needsPostTranslation(noTitle, 'fr'), true, '只缺标题时按钮必须还在')
  assert.equal(needsPostTranslation({ titleI18n: { fr: 'a' } }, 'fr'), true, '只有标题也不算齐')
  ok('needsPostTranslation：标题也在判据里')
} catch (e) {
  bad('needsPostTranslation 判据', e)
}

/* ---------------- 4. 八种语言互不相同 ---------------- */
try {
  /**
   * 这一节是整件事的**目的本身**：译文齐了之后，同一篇文章在八个语言前缀下的
   * 标题必须两两不等。相同就意味着 Google 会把它们合并成一个规范网页。
   */
  const titles = Object.fromEntries(LANGS.map((l) => [l, `T-${l}`]))
  const post = { title: '中文标题', titleI18n: titles }
  const rendered = LANGS.map((l) => postTitle(post, l))
  // zh-Hans 取原文，其余取各自译文 —— 八个值必须互不相同
  assert.equal(new Set(rendered).size, LANGS.length, `八种语言渲染出 ${new Set(rendered).size} 个不同标题，应该是 ${LANGS.length}`)

  /**
   * 反向：**译文一片空白时它们必然全都一样**。
   * 这条断言不是在测代码有没有 bug，是把「为什么必须预生成译文」钉在测试里 ——
   * 有人把 pretranslate / 发布钩子删了，看到这条红就知道后果是什么。
   */
  const bare = { title: '中文标题' }
  const allSame = LANGS.map((l) => postTitle(bare, l))
  assert.equal(new Set(allSame).size, 1, '没有译文时八种语言本来就该是同一份 —— 这正是被判重复的状态')
  ok('译文齐了之后八种语言的标题两两不等（这就是修这件事的目的）')
} catch (e) {
  bad('八种语言互不相同', e)
}

/* ---------------- 5. 源码扫描：不许直呈原文字段 ---------------- */
try {
  /**
   * ⚠️ 必须先剥注释。这两个文件里现在有好几处注释在讲「以前直接渲染 post.title」，
   * 不剥就会对着自己的注释报错（robots 那个扫描踩过同一个坑）。
   * `//` 那条前面要求一个非 `:` 字符，否则 `https://…` 会被当成行注释起点。
   */
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  /** 递归收 .tsx；后台（src/admin）不算 —— 那里给编辑看的就该是中文原文 */
  const collect = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) {
        if (name !== 'admin') collect(full, out)
      } else if (name.endsWith('.tsx')) {
        out.push(full)
      }
    }
    return out
  }

  // JSX 里把文章原文字段直接插值 = 八种语言同一份正文
  const FORBIDDEN = [
    /\{\s*post\.title\s*\}/,
    /\{\s*post\.excerpt\s*\}/,
    /\{\s*post\.content\s*\}/,
    /\{\s*p\.title\s*\}/,
    /\{\s*p\.excerpt\s*\}/,
  ]
  const offenders = []
  for (const file of collect(path.join(ROOT, 'src'))) {
    const src = stripComments(readFileSync(file, 'utf8'))
    for (const re of FORBIDDEN) {
      if (re.test(src)) offenders.push(`${path.relative(ROOT, file)} 命中 ${re}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `这些地方把文章原文字段直接写进了 JSX，必须过 postTitle / postExcerpt / postContent：\n    ${offenders.join('\n    ')}`,
  )

  // 反过来：两个页面必须真的用上了那几个辅助函数（防止有人把插值改成变量绕过上面的扫描）
  for (const rel of ['src/pages/BlogPage.tsx', 'src/pages/PostPage.tsx']) {
    const src = stripComments(readFileSync(path.join(ROOT, rel), 'utf8'))
    assert.ok(src.includes('postTitle('), `${rel} 必须调用 postTitle()`)
    assert.ok(src.includes('postExcerpt('), `${rel} 必须调用 postExcerpt()`)
  }
  ok('源码扫描：没有页面把文章原文字段直呈，两个页面都用上了按语言取值')
} catch (e) {
  bad('源码扫描：不许直呈原文字段', e)
}

/* ---------------- 4. 译文源文按目标语言挑（繁体走中文原文） ---------------- */
/*
  2026-09-08 线上实测的病例：/zh-Hant/games/1942 的简介仍是简体。
  1942 两份简介都有（中文基准 + description_en），而源文挑的是英文 →
  繁体只能让上游从英文翻 → 没配 VOLC_AK/SK 就整批跳过（NOT_CONFIGURED）。
  填了英文简介的游戏全都卡在这里，而那正是站上占比最大的一批。
*/
try {
  const { gameDescriptionSource } = await import('../server/src/i18n-generate.js')
  const both = { description: '《1942》是卡普空的纵向卷轴射击游戏。', descriptionEn: '1942 is a shooter.' }
  assert.deepEqual(gameDescriptionSource(both, 'zh-Hant'), { text: both.description, lang: 'zh-Hans' },
    '繁体必须拿中文原文 —— 本地 OpenCC 免费，而且那是原文')
  for (const lang of ['de', 'es', 'fr', 'it', 'ja', 'en']) {
    assert.equal(gameDescriptionSource(both, lang).lang, 'en', `${lang} 仍应优先英文简介`)
  }
  // 不传目标语言 = 老行为
  assert.equal(gameDescriptionSource(both).lang, 'en')
  // 只有英文那份时，繁体只能从英文翻（拿不到就该报 NOT_CONFIGURED，不是静默出错文）
  assert.equal(gameDescriptionSource({ descriptionEn: 'only english' }, 'zh-Hant').lang, 'en')
  // 只有中文
  assert.equal(gameDescriptionSource({ description: '只有中文' }, 'de').lang, 'zh-Hans')
  // 什么都没有
  assert.equal(gameDescriptionSource({}, 'zh-Hant'), null)
  assert.equal(gameDescriptionSource(null, 'de'), null)
  ok('译文源文按目标语言挑：繁体取中文原文，其余取英文')
} catch (e) {
  bad('译文源文按目标语言挑', e)
}

try {
  const src = readFileSync(path.join(ROOT, 'server/scripts/pretranslate.mjs'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const loop = code.indexOf('for (const lang of LANGS)')
  const call = code.indexOf('gameDescriptionSource(')
  assert.ok(loop > 0 && call > 0, 'pretranslate 里应当有语言循环和源文调用')
  assert.ok(call > loop,
    '源文必须在语言循环**内**算 —— 提到循环外算一次，繁体又会拿英文那份去走上游翻译')
  assert.match(code.slice(call, call + 40), /gameDescriptionSource\(game, lang\)/, '要把目标语言传进去')
  ok('源码扫描：pretranslate 在语言循环内按目标语言取源文')
} catch (e) {
  bad('源码扫描：pretranslate 按目标语言取源文', e)
}

if (fails.length) {
  console.error(`\n❌ ${fails.length} 项失败：${fails.join('、')}`)
  process.exit(1)
}
console.log(`\n✅ 多语言正文差异：${pass} 项检查通过`)
