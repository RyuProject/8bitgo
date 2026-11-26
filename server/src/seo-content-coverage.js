import { readI18nMap } from './mappers.js'
import { shouldIndexCollection } from '../../shared/collection-seo.js'

const text = (value) => typeof value === 'string' ? value.trim() : ''

function mapOf(value) {
  return readI18nMap(value) ?? {}
}

/**
 * 分开判断页面可用的本地化字段与人工字段，避免机翻被报成已校对内容。
 */
export function seoContentCoverage(row, language) {
  const manualTitles = mapOf(row.title_localized)
  const convertedTitles = mapOf(row.title_i18n)
  const manualDescriptions = mapOf(row.description_localized)
  const translatedDescriptions = mapOf(row.description_i18n)

  let hasTitle
  let hasManualTitle
  if (language === 'zh-Hans') {
    hasTitle = hasManualTitle = Boolean(text(row.title_zh))
  } else if (language === 'en') {
    hasTitle = hasManualTitle = Boolean(text(row.title))
  } else if (language === 'zh-Hant') {
    hasManualTitle = Boolean(text(manualTitles[language]))
    hasTitle = hasManualTitle || Boolean(text(convertedTitles[language]))
  } else {
    hasManualTitle = Boolean(text(manualTitles[language]))
    hasTitle = hasManualTitle
  }

  let hasDescription
  let hasManualDescription
  if (language === 'zh-Hans') {
    hasDescription = hasManualDescription = Boolean(text(row.description))
  } else if (language === 'en') {
    hasManualDescription = Boolean(text(manualDescriptions.en) || text(row.description_en))
    hasDescription = hasManualDescription || Boolean(text(translatedDescriptions.en))
  } else {
    hasManualDescription = Boolean(text(manualDescriptions[language]))
    hasDescription = hasManualDescription || Boolean(text(translatedDescriptions[language]))
  }

  return { hasTitle, hasManualTitle, hasDescription, hasManualDescription }
}

/** 供 --todo 与 --review 共用，避免报告摘要和待办队列使用不同的质量判据。 */
export function missingSeoContent(row, language, { includeReview = false } = {}) {
  const coverage = seoContentCoverage(row, language)
  return [
    ...(!coverage.hasTitle ? ['本地化标题'] : []),
    ...(!coverage.hasDescription ? ['语言简介缺失'] : []),
    ...(includeReview && coverage.hasTitle && !coverage.hasManualTitle ? ['标题待人工校对'] : []),
    ...(includeReview && coverage.hasDescription && !coverage.hasManualDescription ? ['简介待人工校对'] : []),
  ]
}

/**
 * 汇总公开合集的索引质量。列表页为玩家保留所有公开清单，所以低信息合集虽然 noindex、
 * 不进首页和 sitemap，仍会从 `/collections` 分页被发现；报告把这批链接单独列出来，
 * 让站长先看实际规模，再决定是否需要调整列表入口。
 */
export function collectionSeoCoverage(rows = []) {
  const total = rows.length
  const indexable = rows.filter((row) => shouldIndexCollection({
    gameCount: row.visible_game_count ?? row.game_count ?? row.gameCount,
    description: row.description,
  })).length
  return {
    total,
    indexable,
    noindex: total - indexable,
    publicListLinksToNoindex: total - indexable,
  }
}
