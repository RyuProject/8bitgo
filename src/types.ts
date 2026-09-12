/**
 * 角色定义在 shared/roles.js —— 服务端鉴权和后台导航读的是同一份，
 * 这里只是把类型接出来，别在这条线之外再写一份字面量联合。
 */
import type { UserRole } from '../shared/roles.js'

import type { RomLang } from '@/config/languages'

/** 平台（主机）标识，同时也是 EmulatorJS 核心映射的键 */
export type PlatformId =
  | 'psx'
  | 'ps2'
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
  runtime: 'emulatorjs' | 'ruffle' | 'html5' | 'jsnes' | 'j2me' | 'jsdos' | 'webretro' | 'play' | null
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
  /**
   * 中文译名的繁体版，形状 `{ 'zh-Hant': '合金彈頭 3' }`。
   * **只有这一个键** —— 非中文界面刻意显示原名 `title`，见 i18nData.gameTitle。
   * 由 `server/scripts/pretranslate.mjs` 用 OpenCC 离线生成；没生成过就是 undefined，
   * gameTitle 会回退到简体译名。
   */
  titleI18n?: Record<string, string>
  platform: PlatformId
  genres: GenreId[]
  year: number
  developer: string
  /**
   * 评分（1~5 星）。由服务端按 game_ratings 聚合得出，登录票权重 1.0、匿名票 0.5，
   * 平均分 = SUM(score×weight) / SUM(weight)，保留一位小数。
   *
   * ⚠️ 一票都没有时两个都是 0。0 分在 1~5 分制里不是一个合法评分，是「还没人评过」——
   * 所以画星星和输出 schema.org 的 aggregateRating 之前都必须先判 ratingCount > 0，
   * 把 0 当成真实评分发出去会被 Google 判为虚假富媒体摘要。
   *
   * ⚠️ 后台表单里也**不要**手填这两个字段：下一次有人评分时服务端会按明细重算，手填的值会被覆盖。
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
  /**
   * DOS 附加文件（资料片 / 补丁 / 配置）清单，一行一个。
   *
   * 形状是 `对象key` 或 `对象key|游戏里的路径`（省略后半段 = 落到游戏根目录，
   * 文件名取 key 的最后一段）。播放器加载时把它们并进游戏 ZIP，仓库里的 ROM 不动 ——
   * 加一个资料片不必重打十几 MB 的包，也不用刷全站缓存。见 lib/dosExtras.ts。
   */
  dosExtras?: string[]
  /**
   * 可选附加文件（行首 `?` 的那些）在开始界面上的名字，如「隐秘行动」。
   * 体积由前端现场测，不存这里 —— 换一份文件自动跟着变。
   */
  dosExtrasLabel?: string
  /**
   * 同上的英文名（Covert Operations）。非中文界面用它。
   *
   * 开关那句话本身（「同时加载…」「额外 498 MB」）八种语言都有译文，只有这个
   * 名字是后台填的专有名词 —— 不给英文版的话，英文玩家会在一句英文里看到一个中文名。
   * 和 title / titleZh 一个路数：两个字段，不走按需翻译（专有名词不该被机器翻）。
   */
  dosExtrasLabelEn?: string
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
   * 只要有任意一款设了，首页最上面就多出「站长精选」一栏，只出这些游戏，
   * 并且不挂 #1 #2 的排名角标 —— 手挑的顺序不能顶着「按游玩次数排序」的说法。
   *
   * ⚠️ 它**不顶掉任何东西**。按游玩次数排的那份真榜一直在下面的
   * 「最多人玩的模拟器游戏」那一栏（MostPlayedSection，见 server/src/content.js 的 hottest）。
   * 一款都没设时精选那一栏整个不画，首页第一栏就是真榜。
   *
   * （2026-09-12 之前这两件事是同一栏在「变身」：填了精选，「最多人玩」这个标题就再也
   * 不出现，于是每次都有人来问「我的模块没了」。现在是并排的两栏，各自说各自的话。）
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
  /**
   * 最新一条可见评论的时间（ISO 8601）。没人回复过就没有这个字段。
   * 只有详情页接口会带上，列表页不查（见 games-repo.js 的 getGameBySlug）。
   */
  lastCommentAt?: string
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

export type SortKey = 'popular' | 'newest' | 'name' | 'rating'

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
  /**
   * 按需翻译缓存（站点八种语言里 zh-Hans 看原文，en / es / fr / it / de / ja 看 i18n[lang]）。
   * 注意 post 没有英文基准列（不像 game 有 description_en），所以 en 界面看到的也是中文原
   * 文，需要翻译按钮把中文翻成英文。没翻译过这几个字段就是 undefined —— 前端 postTitle /
   * postExcerpt / postContent 会自然回退到 title / excerpt / content。
   *
   * ⚠️ titleI18n 是 2026-09-07 加的。加之前标题永远只有中文一份，八种语言的博客列表
   * 标题一字不差 —— 那是 GSC 把 /fr/blog 判成重复页的主因。
   */
  titleI18n?: Record<string, string>
  excerptI18n?: Record<string, string>
  contentI18n?: Record<string, string>
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
  /**
   * 作者给这款游戏打的分（1~5）。没评过分就没有这个字段。
   *
   * 这是 join 出来的**当前**评分，不是发表时的快照 —— 他改了分，
   * 历史评论上的星星会跟着变。见服务端 routes/comments.js 的说明。
   */
  score?: number
  author: CommentAuthor
  quote?: CommentQuote
  /** 后台列表才有：这条评论挂在哪款游戏下 */
  gameSlug?: string
  gameTitle?: string
  /** 后台列表才有：这条评论挂在哪篇文章下 */
  postSlug?: string
  postTitle?: string
}

/** 一款游戏的评分汇总（GET /api/ratings?game=<slug>） */
export interface RatingSummary {
  /** 加权平均分，保留一位小数。一票都没有时是 null（不是 0） */
  average: number | null
  /** 评分人数，用于「N 人评分」 */
  count: number
  /** 权重合计（登录 1.0 + 匿名 0.5 之和）。展示用不到，调试对账时有用 */
  weight: number
  /** 1~5 星各有多少人，用来画分布柱 */
  distribution: Record<string, number>
  /** 我这一票。没评过是 null */
  mine: MyRating | null
}

export interface MyRating {
  score: number
  weight: number
  /** true = 这票是匿名投的（权重 0.5）。登录后再投会顶掉它 */
  anonymous: boolean
  updatedAt?: string | null
}

/** 评论列表接口的响应 */
export interface CommentPage {
  total: number
  page: number
  pageSize: number
  items: GameComment[]
}

/** 合集的作者（只取展示要用的几格，不暴露邮箱之类） */
export interface CollectionAuthor {
  id: string
  nickname: string
  /** 表情头像（users.avatar 存的就是一个 emoji，不是图片地址） */
  avatar: string
}

/** 用户自建的游戏合集 */
/**
 * 画一张封面需要的最少字段。GameCover 只认这几个，所以完整的 Game 和这个瘦身版都能喂它。
 * 合集封面、以后任何「只要图不要资料」的列表都用它，别为了画张图把整个 Game 传下来。
 */
export type CoverGame = Pick<Game, 'slug' | 'title' | 'titleZh' | 'platform' | 'icon' | 'cover' | 'video'>

export interface Collection {
  id: number
  title: string
  /**
   * 作者自己填的「类型」，可以是任意一行字（「系列」「通关向」「小时候的暑假」都行）。
   * 不是枚举 —— 产品上这一格就叫「可自定义」。没填时是空串。
   */
  kind: string
  description: string
  /** 里面一共多少款游戏（不是 covers 的长度） */
  gameCount: number
  /**
   * **多少人看过**（去重），不是累计打开次数 —— 站长 2026-09-07 拍板的语义。
   * 服务端按「登录看账号 / 未登录看 IP 的 HMAC 摘要」判重，复用游戏游玩量那一套
   * （见 server/src/playcount.js）；**作者本人的浏览不计**。
   * 表还没迁移时服务端容错返回 0，所以这个字段不会缺，只可能是 0。
   */
  viewCount: number
  /**
   * 最新放入的游戏，最新的在最前，**最多 12 款**（服务端 COVER_POOL）。
   * 前 4 张拼封面四宫格；其余给卡片轮播用 —— 每隔几秒把一格换成合集里的另一款，
   * 访客不点进去也看得出这个合集大概装了什么。不足四款时就是实际数量。
   * 是瘦身版（CoverGame），不是完整 Game：首页那一栏十几个合集 × 12 张，带简介的话几百 KB。
   */
  covers: CoverGame[]
  author: CollectionAuthor
  /** 被管理员下架了。普通访客根本看不到这种合集，只有作者和审核者拿得到 */
  hidden: boolean
  updatedAt: string
  createdAt: string
  /** 当前登录的人就是作者。没登录 / 不是本人时不带这个字段 */
  mine?: boolean
}

/** 合集列表接口的响应 */
export interface CollectionPage {
  items: Collection[]
  total: number
  page: number
  pageSize: number
}

/** 合集详情接口的响应 */
export interface CollectionDetail {
  collection: Collection
  /** 合集里的全部游戏。作者排过的按他排的顺序在前；没排过的垫后、最新放入的在前 */
  games: Game[]
  /** 当前访客有没有审核权（能下架 / 删别人的合集） */
  canReview: boolean
}
