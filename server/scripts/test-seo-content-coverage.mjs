import assert from 'node:assert/strict'
import { collectionSeoCoverage, missingSeoContent, seoContentCoverage } from '../src/seo-content-coverage.js'
import { hasIndexableGameLanguage } from '../src/routes/sitemaps.js'

const machineTranslated = {
  title: 'Pokémon FireRed',
  title_localized: { ja: 'ポケットモンスター ファイアレッド' },
  description_i18n: { ja: '自動翻訳の紹介文' },
}
assert.deepEqual(seoContentCoverage(machineTranslated, 'ja'), {
  hasTitle: true,
  hasManualTitle: true,
  hasDescription: true,
  hasManualDescription: false,
})
assert.deepEqual(missingSeoContent(machineTranslated, 'ja'), [])
assert.deepEqual(missingSeoContent(machineTranslated, 'ja', { includeReview: true }), ['简介待人工校对'])

// 覆盖报告标出的详情页候选必须与 sitemap 实际门槛同判；否则报表会给运营错误的补录数字。
const eligibleJapanese = { ...machineTranslated, description: '简体中文基准简介', rom_languages: 'ja' }
assert.equal(seoContentCoverage(eligibleJapanese, 'ja').hasDescription, hasIndexableGameLanguage(eligibleJapanese, 'ja'))
assert.equal(hasIndexableGameLanguage({ ...eligibleJapanese, rom_languages: 'en' }, 'ja'), false)

const convertedTraditional = {
  title_zh: '宝可梦 火红',
  title_i18n: { 'zh-Hant': '寶可夢 火紅' },
  description_i18n: { 'zh-Hant': '自動轉換的介紹' },
}
assert.deepEqual(missingSeoContent(convertedTraditional, 'zh-Hant', { includeReview: true }), [
  '标题待人工校对',
  '简介待人工校对',
])

const emptyGerman = { title: 'Pokémon FireRed' }
assert.deepEqual(missingSeoContent(emptyGerman, 'de'), ['本地化标题', '语言简介缺失'])

assert.deepEqual(collectionSeoCoverage([
  { visible_game_count: 0, description: '' },
  { visible_game_count: 1, description: '说明'.repeat(149) },
  { visible_game_count: 1, description: '说明'.repeat(150) },
  { visible_game_count: 3, description: '说明'.repeat(120) },
  { visible_game_count: 5, description: '' },
]), {
  total: 5,
  indexable: 3,
  noindex: 2,
  publicListLinksToNoindex: 2,
})

console.log('✅ 本地化覆盖、人工校对队列与合集索引覆盖：6 项检查通过')
