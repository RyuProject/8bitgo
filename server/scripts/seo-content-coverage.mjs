/**
 * 只读汇总公开游戏库的本地化 SEO 内容覆盖。默认不输出游戏名；--todo 只列公开 slug/title，
 * 始终不输出 ROM key 或玩家数据。
 *
 * 用法：`cd server && npm run seo:coverage`
 *      `cd server && npm run seo:coverage -- --todo --limit 20`
 *
 * 这份报告把“有语言 ROM”“有本地化标题”“有独立简介”拆开计数，避免把
 * 机器回退文案误算成本地化完成，也方便决定下一批该先补哪种语言的内容。
 */
import 'dotenv/config'
import { pool, query } from '../src/db.js'
import { readI18nMap } from '../src/mappers.js'
import { SITE_LANGUAGES } from '../../shared/site-languages.js'
import { isPlatformEnabledId } from '../../shared/site-taxonomy.js'

const text = (value) => typeof value === 'string' ? value.trim() : ''
const showTodo = process.argv.includes('--todo')
const limitArg = process.argv.indexOf('--limit')
const todoLimit = limitArg >= 0 ? Math.max(1, Math.min(100, Number(process.argv[limitArg + 1]) || 20)) : 20

function mapOf(value) {
  return readI18nMap(value) ?? {}
}

function romLanguagesOf(value) {
  return new Set(text(value).split(',').map((code) => code.trim()).filter(Boolean))
}

function hasLocalizedTitle(row, language) {
  const manual = mapOf(row.title_localized)
  const converted = mapOf(row.title_i18n)
  if (language === 'zh-Hans') return Boolean(text(row.title_zh))
  if (language === 'en') return Boolean(text(row.title))
  if (language === 'zh-Hant') return Boolean(text(manual[language]) || text(converted[language]))
  return Boolean(text(manual[language]))
}

function hasManualTitle(row, language) {
  if (language === 'zh-Hans') return Boolean(text(row.title_zh))
  if (language === 'en') return Boolean(text(row.title))
  return Boolean(text(mapOf(row.title_localized)[language]))
}

function hasIndependentDescription(row, language) {
  const manual = mapOf(row.description_localized)
  const translated = mapOf(row.description_i18n)
  if (language === 'zh-Hans') return Boolean(text(row.description))
  if (language === 'en') return Boolean(text(manual.en) || text(translated.en) || text(row.description_en))
  return Boolean(text(manual[language]) || text(translated[language]))
}

function hasManualDescription(row, language) {
  if (language === 'zh-Hans') return Boolean(text(row.description))
  if (language === 'en') return Boolean(text(mapOf(row.description_localized).en) || text(row.description_en))
  return Boolean(text(mapOf(row.description_localized)[language]))
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
  const visible = rows.filter((row) => isPlatformEnabledId(String(row.platform)))
  const genericOnly = visible.filter((row) => {
    const languages = romLanguagesOf(row.rom_languages)
    return languages.has('*') && !SITE_LANGUAGES.some(({ code }) => languages.has(code))
  }).length

  console.log(`公开可见游戏：${visible.length}`)
  console.log(`只有通用 ROM（无明确站点语言槽）：${genericOnly}`)
  console.log('')
  console.log('语言 | 精确 ROM | 标题已本地化 | 独立简介 | 标题+简介+该语言 ROM')
  console.log('--- | ---: | ---: | ---: | ---:')

  for (const { code, label } of SITE_LANGUAGES) {
    const exactRom = visible.filter((row) => romLanguagesOf(row.rom_languages).has(code))
    const titles = exactRom.filter((row) => hasLocalizedTitle(row, code)).length
    const descriptions = exactRom.filter((row) => hasIndependentDescription(row, code)).length
    const manualTitles = exactRom.filter((row) => hasManualTitle(row, code)).length
    const manualDescriptions = exactRom.filter((row) => hasManualDescription(row, code)).length
    const ready = exactRom.filter((row) => hasLocalizedTitle(row, code) && hasIndependentDescription(row, code)).length
    console.log(`${label} (${code}) | ${exactRom.length}/${visible.length} | ${titles}/${exactRom.length} (${percent(titles, exactRom.length)}) | ${descriptions}/${exactRom.length} (${percent(descriptions, exactRom.length)}) | ${ready}/${exactRom.length} (${percent(ready, exactRom.length)})`)
    console.log(`  人工校对：标题 ${manualTitles}/${exactRom.length}；简介 ${manualDescriptions}/${exactRom.length}`)
  }

  if (showTodo) {
    console.log('')
    console.log(`按游玩量排序的内容待办（每种语言最多 ${todoLimit} 款）`)
    for (const { code, label } of SITE_LANGUAGES) {
      const todos = visible
        .filter((row) => romLanguagesOf(row.rom_languages).has(code))
        .map((row) => ({
          row,
          missing: [
            ...(!hasLocalizedTitle(row, code) ? ['本地化标题'] : []),
            ...(!hasIndependentDescription(row, code) ? ['独立简介'] : []),
          ],
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
