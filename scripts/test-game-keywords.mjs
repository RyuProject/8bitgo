import assert from 'node:assert/strict'
import { extractGameKeywords, extractGameKeywordsFromDescriptions } from '../src/admin/gameKeywords.ts'

assert.deepEqual(
  extractGameKeywords('A classic action adventure about space pirates. Space pirates explore ancient planets and fight alien forces.'),
  ['space', 'pirates', 'action', 'adventure', 'explore', 'ancient', 'planets', 'fight'],
  '提取主题词、按出现频次稳定排序，并剔除常见英文虚词和泛化文案',
)
assert.deepEqual(extractGameKeywords('The and is a game, for the players.'), [], '没有信息量的英文简介不生成噪声标签')
assert.deepEqual(extractGameKeywords('A hero protects the galaxy.', 2), ['hero', 'protects'], '可限制关键词数量')
assert.deepEqual(extractGameKeywords('Space space space galaxy galaxy'), ['space', 'galaxy'], '重复主题词去重并按频率排序')
assert.deepEqual(extractGameKeywords('A 3D action RPG with fast combat.'), ['3d', 'action', 'rpg', 'fast', 'combat'], '保留有实际意义的 2D / 3D 与游戏类型缩写')

const localizedKeywords = extractGameKeywordsFromDescriptions({
  'zh-Hans': '驾驶战机穿越宇宙，击败外星舰队。横版射击。',
  'zh-Hant': '操控星際戰機探索銀河，擊敗外星敵人。',
  en: 'Pilot a spaceship through the galaxy, battle alien fleets in a space shooter.',
  ja: '戦闘機を操縦して宇宙を飛び、敵の艦隊を撃破するシューティングゲーム。',
  fr: 'Pilotez un vaisseau spatial dans une aventure de combat.',
  de: 'Ein Weltraum-Abenteuer mit Raumschiffen und Kampf.',
  es: 'Pilota una nave espacial y combate fuerzas alienígenas.',
  it: 'Pilota una nave spaziale e combatti le forze aliene.',
}, 32)
for (const expected of ['战机', '星際', 'pilot', '戦闘機', 'vaisseau', 'weltraum', 'combate', 'combatti']) {
  assert.ok(localizedKeywords.includes(expected), `关键词应包含对应语言的主题词：${expected}`)
}
assert.ok(!localizedKeywords.includes('战机宇宙'), '短语不能跨过原文中的动词拼接')
assert.ok(!localizedKeywords.includes('pilot spaceship'), '英文短语不能跨过原文中的介词拼接')
assert.ok(localizedKeywords.every((keyword) => [...keyword].length <= 60), '生成标签必须符合数据库字段长度')

const longEnglish = Array.from({ length: 20 }, () => 'A classic action adventure game with heroes, battles, worlds and levels.').join(' ')
const fairKeywords = extractGameKeywordsFromDescriptions({
  en: longEnglish,
  'zh-Hans': '星际战机探索银河。',
  ja: '戦闘機で宇宙を探索する。',
}, 12)
assert.ok(fairKeywords.some((keyword) => /[\p{Script=Han}]/u.test(keyword)), '长英文简介不能挤掉中文 / 日文关键词')
assert.ok(fairKeywords.includes('戦闘機'), '日文主题词应公平进入结果，即使关键词中不含假名')
assert.ok(fairKeywords.length <= 12, '多语言关键词总量遵守限制')

const deduplicated = extractGameKeywordsFromDescriptions({ en: 'space pirates', 'en-GB': 'space pirates' })
assert.equal(new Set(deduplicated.map((keyword) => keyword.toLowerCase())).size, deduplicated.length, '跨语言重复关键词去重')

console.log('英文及多语言简介关键词提取回归通过')
