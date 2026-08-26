/**
 * 首页 banner 位的精选游戏（幻灯片顺序即数组顺序）。
 * slug 对应 games.ts 里的游戏；被后台隐藏的游戏会自动跳过。
 */
export interface FeaturedEntry {
  slug: string
  /** 标题上方的一句话推荐语 */
  tagline: string
}

export const featured: FeaturedEntry[] = [
  { slug: 'pokemon-emerald', tagline: '本周精选 · 丰缘地区的冒险再次启程' },
  { slug: 'chrono-trigger', tagline: '不朽 RPG · 十三种结局等你解锁' },
  { slug: 'the-king-of-fighters-97', tagline: '街机格斗 · 支持双人同乐' },
  { slug: 'zelda-ocarina-of-time', tagline: '3D 冒险的里程碑' },
  { slug: 'taiko-web', tagline: 'Flash 音游 · Ruffle 直接运行' },
]
