import type { RomLang } from '@/config/languages'

/** 平台（主机）标识，同时也是 EmulatorJS 核心映射的键 */
export type PlatformId =
  | 'psx'
  | 'arcade'
  | 'n64'
  | 'nes'
  | 'snes'
  | 'nds'
  | 'gba'
  | 'gb'
  | 'gbc'
  | 'segaMD'
  | 'dos'
  | 'ws'
  | 'flash'
  | 'java'

export type GenreId =
  | 'action'
  | 'fighting'
  | 'shooter'
  | 'platformer'
  | 'adventure'
  | 'rpg'
  | 'strategy'
  | 'racing'
  | 'sports'
  | 'music'
  | 'puzzle'
  | 'card'

export interface Platform {
  id: PlatformId
  /** 完整名称 */
  name: string
  /** 卡片上的短名 */
  shortName: string
  /** 中文别名 */
  nameZh: string
  manufacturer: string
  year: number
  /**
   * 使用哪个运行时（模拟器）；null 表示暂不支持在线运行。
   * 取值与 src/emulator/types.ts 的 RuntimeId 一致（cloudgame 不在这里选，
   * 它由用户在播放器里切到联机模式时才用）。
   */
  runtime: 'emulatorjs' | 'ruffle' | 'jsnes' | 'j2me' | 'jsdos' | 'webretro' | null
  /** EmulatorJS 核心名（仅 runtime 为 emulatorjs 时有意义） */
  core: string | null
  /** 接受的 ROM 文件后缀 */
  romExtensions: string[]
  /** 封面主色调 */
  color: string
  /** 没有自制图标时的兜底 emoji */
  icon: string
  /**
   * 自制平台图标（public/ui/ 下的路径，如 '/ui/NES.svg'）。
   * 填了就用图，没填退回 icon 的 emoji —— 图标可以一个平台一个平台地慢慢补，
   * 不用等全部做完才能上。
   */
  image?: string
  description: string
}

export interface Genre {
  id: GenreId
  name: string
  icon: string
  description: string
}

export interface Game {
  slug: string
  title: string
  /** 中文译名（可选） */
  titleZh?: string
  platform: PlatformId
  genres: GenreId[]
  year: number
  developer: string
  /**
   * 评分。站内目前**没有**评分功能，这两个字段一律为 0，界面上也不展示。
   * 保留下来是给将来的真实评分系统用（用户评分 -> 服务端聚合）。
   * 在那之前不要手填，更不要输出到 schema.org —— 编造的聚合评分会被 Google 判为虚假富媒体摘要。
   */
  rating: number
  ratingCount: number
  /** 玩过这款游戏的人数：玩家把游戏跑起来时由后端累加，同一个人只算一次（POST /api/games/:slug/play） */
  plays: number
  /** 最大玩家数 */
  players: 1 | 2 | 3 | 4
  /** 是否支持联机同玩 */
  multiplayer: boolean
  /** 通关或达成成就可获得的 G 币，0 表示不参与 */
  coinReward: number
  /** 封面上展示的 emoji */
  icon: string
  /** 若有真实封面图可填写：对象存储 key（如 covers/contra.jpg）或完整 URL；留空则用程序生成封面 */
  cover?: string
  /** 卡片视频：对象存储 key（如 videos/contra.mp4）或完整 URL；4:3 横版最佳。有则优先于封面图播放 */
  video?: string
  /**
   * 模拟器核心覆盖。没有这个字段就用平台默认（platforms.ts 的 core）。
   *
   * 街机必须能按游戏覆盖：同一个「街机」平台底下其实是好几套硬件，
   * 拳皇（Neo Geo）走 fbneo，街霸 2（CPS2）走 fbalpha2012_cps2，
   * 更老的板子可能只有 mame2003_plus 跑得动。
   */
  core?: string
  /**
   * 首页精选位的排序号（数字小的排前面）。没有这个字段就是不上首页。
   * 只要有任意一款设了，首页第一栏就只出这些，标题也会从「最多人玩」换成「最热门的游戏」——
   * 手挑的顺序不能顶着「按游玩次数排序」的说法。
   */
  homeRank?: number
  /** 基准简介。后台写什么语言就是什么语言，其余语言没有译文时也用它兜底 */
  description: string
  /**
   * 英文简介。非中文访客优先看这个 —— 和 title / titleZh 是同一套路数：
   * 一个基准 + 一个译文，而不是给八种语言各开一个字段。
   */
  descriptionEn?: string
  tags?: string[]
  /** 上线日期，用于「最新」排序 */
  addedAt: string
  /** 体感控制友好 */
  bodyControl?: boolean
  /** 后台下架：前台不展示 */
  hidden?: boolean
  /** ROM 在对象存储中的 key（如 nes/contra.zip）或完整 URL；留空则按约定路径探测。作为各语言 ROM 的回退 */
  rom?: string
  /** 各语言 ROM：按玩家语言自动选用，缺失回退英语，再回退 rom */
  roms?: Partial<Record<RomLang, string>>
}

export interface FaqItem {
  q: string
  a: string
}

export type SortKey = 'popular' | 'newest' | 'name'

export interface GameQuery {
  q?: string
  platform?: PlatformId
  genre?: GenreId
  developer?: string
  multiplayer?: boolean
  coin?: boolean
  sort?: SortKey
  page?: number
  pageSize?: number
}

/* ---------------- 用户 ---------------- */
export type UserRole = 'user' | 'admin'
export type UserStatus = 'active' | 'banned'

export interface User {
  id: string
  email: string
  nickname: string
  /** 头像 emoji */
  avatar: string
  /** SHA-256(salt + password) 的十六进制 */
  passwordHash: string
  salt: string
  coins: number
  role: UserRole
  status: UserStatus
  createdAt: string
  /** 收藏的游戏 slug */
  favorites: string[]
  /** 最近浏览的游戏 slug（最新在前，最多 12 个） */
  recent: string[]
}

/** 对外暴露的用户信息（不含密码相关字段） */
export type PublicUser = Omit<User, 'passwordHash' | 'salt'>

/* ---------------- 博客 ---------------- */
export interface Post {
  slug: string
  title: string
  excerpt: string
  /** 正文：支持简化 Markdown（## 标题、- 列表、> 引用、**加粗**、`代码`、[链接](url)） */
  content: string
  /** 封面 emoji */
  icon: string
  tags: string[]
  author: string
  /** YYYY-MM-DD */
  date: string
  published: boolean
}
