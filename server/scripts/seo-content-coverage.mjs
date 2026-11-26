/**
 * 只读汇总公开游戏库的本地化 SEO 内容覆盖和合集索引质量。默认不输出游戏名；--todo 只列公开 slug/title，
 * --review 还会把只有自动翻译、缺少人工字段的项目列入校对队列；始终不输出 ROM key 或玩家数据。
 *
 * 用法：`cd server && npm run seo:coverage`
 *      `cd server && npm run seo:coverage -- --todo --limit 20`
 *      `cd server && npm run seo:coverage -- --review --limit 20`
 *
 * 这份报告把“有语言 ROM”“有本地化标题”“有独立简介”拆开计数，避免把
 * 机器回退文案误算成本地化完成；同时核对公开合集门槛与列表页的 noindex 链接规模，
 * 方便决定下一批该先补哪种语言的内容，以及是否需要调整合集索引入口。
 */
import 'dotenv/config'
import { pool, query } from '../src/db.js'
import { readI18nMap } from '../src/mappers.js'
import { collectionSeoCoverage, missingSeoContent, seoContentCoverage } from '../src/seo-content-coverage.js'
import { SITE_LANGUAGES } from '../../shared/site-languages.js'
import { isPlatformEnabledId } from '../../shared/site-taxonomy.js'

const text = (value) => typeof value === 'string' ? value.trim() : ''
const includeReview = process.argv.includes('--review')
const showTodo = process.argv.includes('--todo') || includeReview
const limitArg = process.argv.indexOf('--limit')
const todoLimit = limitArg >= 0 ? Math.max(1, Math.min(100, Number(process.argv[limitArg + 1]) || 20)) : 20

function mapOf(value) {
  return readI18nMap(value) ?? {}
}

function romLanguagesOf(value) {
  return new Set(text(value).split(',').map((code) => code.trim()).filter(Boolean))
}

function displayTitle(row, language) {
  const manual = mapOf(row.title_localized)
  const converted = mapOf(row.title_i18n)
  if (language === 'zh-Hans') return text(row.title_zh) || text(row.title)
  if (language === 'en') return text(row.title)
  if (language === 'zh-Hant') return text(manual[language]) || text(converted[language]) || text(row.title_zh) || text(row.title)
  return text(manual[language]) || text(row.title)
}

function percent(numerator, denominator) {
  return denominator ? `${(numerator * 100 / denominator).toFixed(1)}%` : '—'
}

try {
  const rows = await query(`
    SELECT g.slug, g.platform, g.title, g.title_zh, g.title_i18n, g.title_localized, g.plays,
           g.description, g.description_en, g.description_i18n, g.description_localized,
           COALESCE(GROUP_CONCAT(DISTINCT gr.lang ORDER BY gr.lang SEPARATOR ','), '') AS rom_languages
      FROM games g
      LEFT JOIN game_roms gr
        ON gr.game_id = g.id AND CHAR_LENGTH(TRIM(gr.object_key)) > 0
     WHERE g.hidden = 0
     GROUP BY g.id
     ORDER BY g.id
  `)
  const collectionRows = await query(`
    SELECT c.description, COUNT(DISTINCT g.id) AS visible_game_count
      FROM collections c
      LEFT JOIN collection_items ci ON ci.collection_id = c.id
      LEFT JOIN games g ON g.id = ci.game_id AND g.hidden = 0
     WHERE c.hidden = 0
     GROUP BY c.id, c.description
  `)
  const visible = rows.filter((row) => isPlatformEnabledId(String(row.platform)))
  const genericOnly = visible.filter((row) => {
    const languages = romLanguagesOf(row.rom_languages)
    return languages.has('*') && !SITE_LANGUAGES.some(({ code }) => languages.has(code))
  }).length

  console.log(`公开可见游戏：${visible.length}`)
  console.log(`只有通用 ROM（无明确站点语言槽）：${genericOnly}`)
  const collectionCoverage = collectionSeoCoverage(collectionRows)
  console.log(`公开合集：${collectionCoverage.total}；达到详情页/首页/sitemap 索引门槛：${collectionCoverage.indexable}；详情页 noindex：${collectionCoverage.noindex}`)
  console.log(`  仍会从 /collections 分页链接到 noindex 合集：${collectionCoverage.publicListLinksToNoindex}`)
  console.log('')
  console.log('说明：详情 sitemap 候选 = 精确语言 ROM + 本语言简介；缺标题会进入待办，但不会单独阻断有正文页。')
  console.log('语言 | 精确 ROM | 详情 sitemap 候选 | 标题有值 | 语言简介有值（含机翻） | 标题+简介+ROM | 非自动标题+简介+ROM')
  console.log('--- | ---: | ---: | ---: | ---: | ---: | ---:')

  for (const { code, label } of SITE_LANGUAGES) {
    const exactRom = visible.filter((row) => romLanguagesOf(row.rom_languages).has(code))
    const coverage = exactRom.map((row) => seoContentCoverage(row, code))
    const titles = coverage.filter((item) => item.hasTitle).length
    const descriptions = coverage.filter((item) => item.hasDescription).length
    const detailCandidates = descriptions
    const manualTitles = coverage.filter((item) => item.hasManualTitle).length
    const manualDescriptions = coverage.filter((item) => item.hasManualDescription).length
    const ready = coverage.filter((item) => item.hasTitle && item.hasDescription).length
    const curatedReady = coverage.filter((item) => item.hasManualTitle && item.hasManualDescription).length
    console.log(`${label} (${code}) | ${exactRom.length}/${visible.length} | ${detailCandidates}/${exactRom.length} (${percent(detailCandidates, exactRom.length)}) | ${titles}/${exactRom.length} (${percent(titles, exactRom.length)}) | ${descriptions}/${exactRom.length} (${percent(descriptions, exactRom.length)}) | ${ready}/${exactRom.length} (${percent(ready, exactRom.length)}) | ${curatedReady}/${exactRom.length} (${percent(curatedReady, exactRom.length)})`)
    console.log(`  有精确语言 ROM 但缺本语言简介（暂不进入详情 sitemap）：${exactRom.length - detailCandidates}；非自动字段：标题 ${manualTitles}/${exactRom.length}；简介 ${manualDescriptions}/${exactRom.length}`)
  }

  if (showTodo) {
    console.log('')
    console.log(`按游玩量排序的内容待办（每种语言最多 ${todoLimit} 款）`)
    for (const { code, label } of SITE_LANGUAGES) {
      const todos = visible
        .filter((row) => romLanguagesOf(row.rom_languages).has(code))
        .map((row) => ({
          row,
          missing: missingSeoContent(row, code, { includeReview }),
        }))
        .filter(({ missing }) => missing.length > 0)
        .sort((a, b) => Number(b.row.plays) - Number(a.row.plays))
        .slice(0, todoLimit)
      console.log(`\n${label} (${code})：`)
      if (!todos.length) {
        console.log('  无缺口')
        continue
      }
      for (const { row, missing } of todos) {
        console.log(`  ${row.slug} | ${displayTitle(row, code)} | ${Number(row.plays) || 0} 次游玩 | 缺少：${missing.join('、')}`)
      }
    }
  }
} catch (error) {
  console.error(`SEO 内容覆盖报告失败：${error?.message || error}`)
  process.exitCode = 1
} finally {
  await pool.end()
}
