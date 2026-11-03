import assert from 'node:assert/strict'
import { extractGameKeywords } from '../src/admin/gameKeywords.ts'

assert.deepEqual(
  extractGameKeywords('A classic action adventure about space pirates. Space pirates explore ancient planets and fight alien forces.'),
  ['space', 'pirates', 'action', 'adventure', 'explore', 'ancient', 'planets', 'fight'],
  '提取主题词、按出现频次稳定排序，并剔除常见英文虚词和泛化文案',
)
assert.deepEqual(extractGameKeywords('The and is a game, for the players.'), [], '没有信息量的英文简介不生成噪声标签')
assert.deepEqual(extractGameKeywords('A hero protects the galaxy.', 2), ['hero', 'protects'], '可限制关键词数量')
assert.deepEqual(extractGameKeywords('Space space space galaxy galaxy'), ['space', 'galaxy'], '重复主题词去重并按频率排序')
assert.deepEqual(extractGameKeywords('A 3D action RPG with fast combat.'), ['3d', 'action', 'rpg', 'fast', 'combat'], '保留有实际意义的 2D / 3D 与游戏类型缩写')

console.log('英文简介关键词提取回归通过')
