import type { Genre } from '@/types'

export const genres: Genre[] = [
  { id: 'action', name: '动作', icon: '⚔️', description: '横版清关、砍杀冒险，手感与爽快感的极致。' },
  { id: 'fighting', name: '格斗', icon: '👊', description: '一对一对决，连招、立回与读心术。' },
  { id: 'shooter', name: '射击', icon: '🔫', description: '弹幕、飞机与突突突，考验反应的时刻。' },
  { id: 'platformer', name: '平台跳跃', icon: '🏃', description: '跳跃、踩踏、收集，关卡设计的艺术。' },
  { id: 'adventure', name: '冒险', icon: '🗺️', description: '探索地图、解开谜题、寻找宝物。' },
  { id: 'rpg', name: '角色扮演', icon: '🐉', description: '升级、装备、剧情与回合制战斗。' },
  { id: 'strategy', name: '策略', icon: '♟️', description: '排兵布阵、运筹帷幄，脑力的较量。' },
  { id: 'racing', name: '竞速', icon: '🏎️', description: '漂移、道具与冲线，速度与激情。' },
  { id: 'sports', name: '体育', icon: '🏀', description: '滑雪、滑板、球类，运动的乐趣。' },
  { id: 'music', name: '音乐', icon: '🎵', description: '跟着节拍敲击，节奏游戏的魅力。' },
  { id: 'puzzle', name: '益智', icon: '🧩', description: '方块、消除、逻辑，小巧却上头。' },
  { id: 'card', name: '卡牌', icon: '🃏', description: '构筑、出牌与博弈。' },
]

export const genreMap: Record<string, Genre> = Object.fromEntries(genres.map((g) => [g.id, g]))
