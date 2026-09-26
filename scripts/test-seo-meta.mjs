#!/usr/bin/env node
/**
 * 页面标题、meta description 与 robots 的回归测试。跑：npm run test:seo-meta
 *
 * 病史（2026-09-11，Bing Webmaster Tools 报的三条「中度严重」里的两条）：
 *
 *   1. Meta descriptions on many of your pages are too short.
 *      线上实测 `/collections` 的描述只有 **11 个字**（「玩家自己整理的游戏清单」）——
 *      那句本来是页面上的小标题，被顺手拿来当 SEO 描述了。更糟的是合集**详情页**
 *      在「这个合集没写简介」时也回退到同一句，而大多数合集都没写简介 ——
 *      于是几乎每个合集页都挂着同一句过短的描述。
 *      顺带查出简体/繁体的 seo 文案整体比其他六种语言短一半（31~49 字），
 *      那几句是早期写的，后来其他语言重写过而中文没跟上。
 *
 *   2. Important pages using meta robots tag that need review.
 *      站内有几页是 noindex 而且挂在**全站导航**上（/rooms、/apps、/submit、/open）。
 *      noindex 是对的（实时房间列表 / 占位页 / 表单 / 控制台都不该收录），
 *      但当时一并给了 `nofollow` —— 那会把这些页面上的内链权重整个掐断，
 *      而 /rooms 整页都是通往游戏详情页的链接。
 *
 * ⚠️ 这两类问题都**不会报错**：页面照常渲染、测试照常绿，只有搜索引擎知道。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ❌ ${name}\n     ${e.message}`)
  }
}

const LANGS = ['zh-Hans', 'zh-Hant', 'en', 'ja', 'es', 'fr', 'de', 'it']

/**
 * `seo` 块里真正会被当成 meta description 用的那些 key。
 * 其余的（platformH1 / genreH1 / platformArticle / platformIntro）不是描述，不查。
 */
const DESC_KEYS = [
  'home', 'games', 'platforms', 'genres', 'developers', 'blog', 'playLocal',
  'collections', 'gameDesc', 'platformDesc', 'genreDesc', 'collectionDesc',
]

/**
 * 描述的最短长度。
 *
 * 50 是 Bing 判「too short」的那条线。按**码点**数，不是字节 ——
 * 中文一个字就是一个码点，50 个中文字已经是相当完整的一句；
 * 英文 50 个字符偏短，所以其他语言实际都在 100 以上，这条线只是兜底。
 */
const MIN_DESC = 50
const MIN_EXPANDED_DESC = 80
const MIN_CJK_TITLE = 22
const MIN_LATIN_TITLE = 35

function siteBlock(lang) {
  const src = read(`src/locales/${lang}.ts`)
  const i = src.indexOf('\n  site: {')
  assert.ok(i > 0, `${lang} 找不到 site 块`)
  const j = src.indexOf('\n  },', i)
  return src.slice(i, j)
}

function seoBlock(lang) {
  const src = read(`src/locales/${lang}.ts`)
  const i = src.indexOf('\n  seo: {')
  assert.ok(i > 0, `${lang} 找不到 seo 块`)
  const j = src.indexOf('\n  },', i)
  return src.slice(i, j)
}

function valueOf(block, key) {
  const single = block.match(new RegExp(`^\\s*${key}: '((?:[^'\\\\]|\\\\.)*)',$`, 'm'))
  if (single) return single[1]
  const dbl = block.match(new RegExp(`^\\s*${key}: "((?:[^"\\\\]|\\\\.)*)",$`, 'm'))
  return dbl ? dbl[1] : null
}

console.log('一、每种语言的页面标题都带搜索上下文')

for (const lang of LANGS) {
  const minTitle = ['zh-Hans', 'zh-Hant', 'ja'].includes(lang) ? MIN_CJK_TITLE : MIN_LATIN_TITLE
  check(`${lang}：默认标题和普通页面标题都 ≥ ${minTitle} 码点`, () => {
    const block = siteBlock(lang)
    const defaultTitle = valueOf(block, 'defaultTitle')
    const template = valueOf(block, 'titleTemplate')
    assert.ok(defaultTitle, `${lang} 缺 site.defaultTitle`)
    assert.ok(template, `${lang} 缺 site.titleTemplate`)
    const expanded = template.replace('{title}', 'Games').replace('{site}', '8BitGo')
    assert.ok([...defaultTitle.replace('{site}', '8BitGo')].length >= minTitle, `默认标题太短：${defaultTitle}`)
    assert.ok([...expanded].length >= minTitle, `普通页面标题太短：${expanded}`)
    assert.notEqual(template, '{title} - {site}', '仍是只有页面名和品牌名的旧模板')
  })
}

console.log('二、每种语言的每条描述都不能太短')

for (const lang of LANGS) {
  check(`${lang}：${DESC_KEYS.length} 条描述都 ≥ ${MIN_DESC} 码点`, () => {
    const block = seoBlock(lang)
    const short = []
    for (const key of DESC_KEYS) {
      const v = valueOf(block, key)
      assert.ok(v !== null, `${lang} 缺 seo.${key}`)
      const n = [...v].length
      if (n < MIN_DESC) short.push(`${key}=${n}`)
    }
    assert.equal(short.length, 0, `太短：${short.join(', ')}`)
  })
}

for (const lang of LANGS) {
  check(`${lang}：短简介补充文案足以把摘要扩展到 ${MIN_EXPANDED_DESC} 码点`, () => {
    const expansion = valueOf(seoBlock(lang), 'descriptionFallback')
    assert.ok(expansion, `${lang} 缺 seo.descriptionFallback`)
    assert.ok([...`短简介 — ${expansion}`].length >= MIN_EXPANDED_DESC, `补充后仍太短：${expansion}`)
  })
}

console.log('三、界面文案不能拿来当描述')

check('⚠️ 合集两个页面都不再用 collections.subtitle 当描述', () => {
  /*
    `t.collections.subtitle` 是页面上那行小标题（简体中文 11 个字）。
    它和 SEO 描述是两件事：小标题要短才好看，描述要够长才有用。
  */
  for (const rel of ['src/pages/CollectionsPage.tsx', 'src/pages/CollectionDetailPage.tsx']) {
    const src = code(rel)
    const i = src.indexOf('description:')
    assert.ok(i > 0, `${rel} 找不到 description`)
    const seg = src.slice(i, i + 200)
    assert.ok(!seg.includes('collections.subtitle'), `${rel} 还在拿小标题当描述`)
  }
})

check('合集详情页在没有简介时按标题和数量拼一句', () => {
  const src = code('src/pages/CollectionDetailPage.tsx')
  assert.match(src, /fmt\(t\.seo\.collectionDesc, \{ title: c\.title, n: c\.gameCount \}\)/, '回退的那句不是拼出来的')
})

check('首页合集卡片不再把「还没有描述」暴露给搜索摘要', () => {
  const src = code('src/components/game/CollectionCard.tsx')
  assert.ok(!src.includes('t.collections.noDescription'), '合集卡片仍在输出无意义占位文案')
  assert.match(
    src,
    /fmt\(t\.seo\.collectionDesc, \{ title: collection\.title, n: collection\.gameCount \}\)/,
    '空简介没有按标题和游戏数生成唯一摘要',
  )
})

console.log('四、短简介要补足上下文，过长简介要收敛成可读摘要')

check('短简介按 CJK / 拉丁语言分别收敛，再供 meta / Open Graph / Twitter 共用', () => {
  const src = code('src/services/seo.ts')
  assert.match(src, /META_DESCRIPTION_MIN_LENGTH = 80/, '短简介下限不再是 80 个 Unicode 码点')
  assert.match(src, /META_DESCRIPTION_MAX_LENGTH = 160/, '拉丁语摘要上限不再是 160 个 Unicode 码点')
  assert.match(src, /CJK_META_DESCRIPTION_MIN_LENGTH = 50/, 'CJK 摘要下限不再是 50 个 Unicode 码点')
  assert.match(src, /CJK_META_DESCRIPTION_MAX_LENGTH = 90/, 'CJK 摘要上限不再是 90 个 Unicode 码点')
  assert.match(src, /CJK_META_LANGUAGES\.has\(lang\)/, '没有按当前页面语言选择摘要长度')
  assert.match(
    src,
    /completeMetaDescription\([\s\S]*?description,[\s\S]*?t\.seo\.descriptionFallback,[\s\S]*?CJK_META_DESCRIPTION_MIN_LENGTH[\s\S]*?CJK_META_DESCRIPTION_MAX_LENGTH/,
    '页面描述没有使用当前语言的补充文案',
  )
  assert.match(src, /maxLength = META_DESCRIPTION_MAX_LENGTH/, '默认摘要上限没有复用统一常量')
  for (const tag of ["['name', 'description', shortDescription]", "['property', 'og:description', shortDescription]", "['name', 'twitter:description', shortDescription]"]) {
    assert.ok(src.includes(tag), `${tag} 没有使用同一份短摘要`)
  }
})

console.log('五、noindex 的页面要 follow，不能 nofollow')

check('⚠️ noindex 配的是 follow', () => {
  /*
    nofollow 会把这一页上的链接整个掐断。/rooms 整页都是通往游戏详情页的链接，
    搜索结果页（/games?q=）同理 —— 那些链接正是我们希望爬虫顺着走的。
  */
  const src = code('src/services/seo.ts')
  assert.match(src, /noindex \? 'noindex,follow'/, "noindex 的 robots 不是 'noindex,follow'")
  assert.ok(!src.includes('noindex,nofollow'), '还有 noindex,nofollow 残留')
})

check('可收录的页面照旧 index,follow + 大图预览', () => {
  const src = code('src/services/seo.ts')
  assert.match(src, /'index,follow,max-image-preview:large'/, '正常页面的 robots 被动了')
})

check('⚠️ noindex 的页面不写 canonical', () => {
  // 给一个不该被收录的页面写 canonical 等于自相矛盾，搜索引擎两条信号打架
  const src = code('src/services/seo.ts')
  assert.match(src, /if \(!noindex\) collected\.tags\.push\(`<link rel="canonical"/, 'noindex 页面又开始写 canonical 了')
})

check('⚠️ noindex 的页面不输出 JSON-LD', () => {
  const src = code('src/services/seo.ts')
  assert.match(src, /const visibleJsonLd = noindex \? \[\]/, 'noindex 页面仍可能输出结构化数据')
})

console.log('六、复用英文长正文的路由不能冒充独立译文')

check('关于页与法律页只声明简中、繁中、英文三份真实长正文', () => {
  const languages = code('src/config/languages.ts')
  assert.match(
    languages,
    /ENGLISH_FALLBACK_LONGFORM_LANGUAGES\s*=\s*\[\s*'zh-Hans',\s*'zh-Hant',\s*'en',?\s*\]/,
    '真实长正文语言清单必须只有 zh-Hans / zh-Hant / en',
  )

  for (const rel of ['src/pages/AboutPage.tsx', 'src/pages/LegalDoc.tsx']) {
    const src = code(rel)
    assert.match(src, /resolveSeoLanguagePlan\(lang, ENGLISH_FALLBACK_LONGFORM_LANGUAGES, 'en'\)/, `${rel} 没有把复用正文归到英文 canonical`)
    assert.match(src, /contentLanguages: seoLanguages\.contentLanguages/, `${rel} 没有限制 hreflang`)
    assert.match(src, /canonicalLanguage: seoLanguages\.canonicalLanguage/, `${rel} 没有同步 canonical`)
  }
})

check('法律页的结构化面包屑跟随同一条 canonical', () => {
  const src = code('src/pages/LegalDoc.tsx')
  assert.match(
    src,
    /breadcrumbSchema\([\s\S]*?seoLanguages\.canonicalLanguage\)/,
    'canonical 已切到英文时，面包屑 URL 仍可能留在重复语言路径',
  )
})

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过 ✅')
process.exit(failed ? 1 : 0)
