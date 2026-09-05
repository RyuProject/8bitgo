/**
 * 角色定义在 shared/roles.js —— 服务端鉴权和后台导航读的是同一份，
 * 这里只是把类型接出来，别在这条线之外再写一份字面量联合。
 */
import type { UserRole } from '../shared/roles.js'

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
  | 'html5'
  | 'java'

/** js-dos 可选核心：普通 DOS 用 DOSBox，Windows 客体镜像用 DOSBox-X。 */
export type DosBackend = 'dosbox' | 'dosboxX'

/** Windows 3.x 仍是 Program Manager；Windows 9x 才有开始菜单，两者自启动快捷键不同。 */
export type DosWindowsVersion = '3x' | '9x'

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
  runtime: 'emulatorjs' | 'ruffle' | 'html5' | 'jsnes' | 'j2me' | 'jsdos' | 'webretro' | null
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
   * FBNeo RomData：一份 .dat 文本，把一个**不在驱动表里**的 romset 挂到现成的驱动上。
   *
   * 街机核心靠压缩包名认游戏，改版包（汉化、修改版）不在 FBNeo 的驱动表里，
   * 名字取什么都是「Romset is unknown」。RomData 就是官方给这种包留的口子：
   * dat 里写清楚 ZipName（包名）、DrvName（借哪个驱动跑）和整份 ROM 清单，
   * 核心会把该驱动的包名「寄生」成 ZipName，并整个换用 dat 里的清单 ——
   * 于是汉化包里那几个和原版对不上的 GFX ROM 也能按自己的长度和 CRC 加载。
   *
   * 触发方式见 adapters/emulatorjs.ts 的 installRomDataInjector：ROM 叫 wofcn.zip，
   * 就在虚拟文件系统里放一份同名的 /wofcn.dat，核心自己会找到。
   * 只对走 FBNeo 系核心的街机游戏有意义；留空 = 按普通 romset 处理。
   */
  arcadeRomData?: string
  /**
   * DOS 启动程序：zip 包内的相对路径（如 PARANOID.COM、NFS/TNFS.EXE）。
   * 留空由前端启发式去猜（src/lib/jsdosBundle.ts 的 pickExecutable）——
   * 共享软件时代的包里常混着安装器 / 评估版工具，猜错时在后台填这个字段一锤定音。
   * 只对 platform 为 dos 的游戏有意义。
   */
  dosExecutable?: string
  /**
   * DOS 运行核心。留空等同 dosbox；dosboxX 可启动 Windows 3.x / 9x 的 .jsdos 系统镜像。
   * 这里只切换 CPU/虚拟机核心；系统由 dosSystem 提供，游戏 ZIP 作为另一块 FAT 盘挂入。
   */
  dosBackend?: DosBackend
  /**
   * Windows 客体系统的共享 .jsdos 镜像（对象 key、站内路径或完整 URL）。
   *
   * 有值时，rom / roms 仍然只放这款游戏自己的 ZIP；播放器会把游戏作为独立 FAT 盘
   * 挂进系统镜像。这样 Windows 镜像可以被多款游戏复用，不必每款复制近百 MB。
   * 留空时保留旧行为：dosboxX 直接把 ROM 当成一份已经装好系统与游戏的完整镜像。
   */
  dosSystem?: string
  /** 客体 Windows 的桌面代次；留空按旧数据兼容为 9x。 */
  dosWindowsVersion?: DosWindowsVersion
  /**
   * 客体 Windows 切入图形模式后等待多少秒，再自动运行 dosExecutable。
   * 先等图形模式可以避开 BIOS / 启动画面；额外秒数用于等待桌面服务真正可接收快捷键。
   */
  dosLaunchDelay?: number
  /**
   * 这款 DOS 游戏怎么存档（如「按 F2 存档、F3 读档」「主菜单 → Save Game」）。
   *
   * js-dos 存的是盘上被改过的文件，玩家必须先在游戏里存盘，播放器的「保存进度」才有东西可存。
   * 通用说明只能给最常见的 ESC / F1；具体到某一款，只有后台填的这句话说得准。
   * 只对 platform 为 dos 的游戏有意义；留空只显示通用说明。
   */
  dosSaveHint?: string
  /**
   * DOSBox-X 游戏级配置覆盖，只保存允许调整的硬件 / 性能 INI 段。
   * [autoexec]、鼠标捕获模式和动态游戏盘参数由站点统一管理，不能从这里覆盖。
   */
  dosboxConfig?: string
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
  /**
   * 其余六种语言的按需翻译缓存。键是站点语言代码（zh-Hant / es / fr / it / de / ja），
   * 值是已经翻译好的简介。zh-Hans 走 description，en 走 descriptionEn —— 这两个 key 不会
   * 出现在这里。来源是详情页「翻译」按钮（POST /api/games/:slug/translate-description）。
   * 改写 description / descriptionEn 时后端会自动清掉（见 server/src/games-repo.js）。
   */
  descriptionI18n?: Record<string, string>
  tags?: string[]
  /** 上线日期，用于「最新」排序 */
  addedAt: string
  /** 内容最后更新时间（ISO 8601）；供搜索引擎时间因子使用 */
  updatedAt?: string
  /** 体感控制友好 */
  bodyControl?: boolean
  /** 成人内容：启动游戏前必须通过 18 岁出生日期验证 */
  adult?: boolean
  /** 后台下架：前台不展示 */
  hidden?: boolean
  /** ROM 在对象存储中的 key（如 nes/contra.zip）或完整 URL；留空则按约定路径探测。作为各语言 ROM 的回退 */
  rom?: string
  /** 各语言 ROM：按玩家语言自动选用，缺失依次回退英语、日语、中文，再兼容旧版 rom */
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
export type { UserRole }
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
  /**
   * 出生日期 YYYY-MM-DD（成人内容年龄验证）。
   * 首次游玩成人游戏时填写，记在账号上，填一次就锁定；null / 缺省 = 还没填。
   * 可选：老版本缓存在 localStorage 里的会话、以及升级前的本地模式账号都没有这个字段。
   */
  birthDate?: string | null
}

/** 对外暴露的用户信息（不含密码相关字段） */
export type PublicUser = Omit<User, 'passwordHash' | 'salt'> & {
  /**
   * 现在能不能玩成人内容 —— 由出生日期按今天现算（shared/age.js），未满 18 的账号到生日当天自动变 true。
   * 服务端给的是登录 / 拉取那一刻的值；真正放行与否以 GET /api/games/:slug/access 的实时结论为准。
   */
  adultVerified?: boolean
  /**
   * 有没有设过登录密码。
   *
   * 个人中心靠它决定「设置密码」还是「修改密码」（后者要先报旧密码）。
   * 回的是布尔值而不是哈希本身 —— 哈希是能离线爆破的，没有任何理由发到前端。
   *
   * 可选：旧版本缓存在 localStorage 里的会话没有这个字段，
   * 而本地演示模式（没配后端）也用同一个类型。
   */
  hasPassword?: boolean
}

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
  /** 内容最后更新时间（ISO 8601）；内置文章没有时回退到 date */
  updatedAt?: string
  published: boolean
}

/* ---------------- 游戏评论 ---------------- */

/** 评论作者。前台拿不到邮箱（评论区是公开的），只有后台那条接口会带上。 */
export interface CommentAuthor {
  id: string
  nickname: string
  /** 头像 emoji，和 users.avatar 同一个字段 */
  avatar: string
  email?: string
}

/**
 * 被引用的那条评论（平铺列表里的引用卡片）。
 * 只有一层 —— 卡片要的就是「回复谁、说了什么」，不是整棵回复树。
 */
export interface CommentQuote {
  id: string
  nickname: string
  avatar: string
  /** 已被隐藏 / 删除时为空串，前台显示占位文案 */
  content: string
  deleted: boolean
}

export interface GameComment {
  id: string
  /** 正文。被隐藏或删除时后端不下发内容（只有后台视角能拿到） */
  content: string
  /**
   * 发表那一刻的国家（ISO 3166-1 alpha-2，大写）。'XX' = 未知。
   * 是快照而不是用户资料：换个网络再来，历史评论上的国旗不会变。
   */
  country: string
  /** 被管理员隐藏 */
  hidden: boolean
  /** 已删除（作者自己删或管理员清理，都是软删除） */
  deleted: boolean
  /** 编辑过的时间；没编辑过就没有这个字段 */
  editedAt?: string
  createdAt: string
  author: CommentAuthor
  quote?: CommentQuote
  /** 后台列表才有：这条评论挂在哪款游戏下 */
  gameSlug?: string
  gameTitle?: string
}

/** 评论列表接口的响应 */
export interface CommentPage {
  total: number
  page: number
  pageSize: number
  items: GameComment[]
}
