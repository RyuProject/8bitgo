/**
 * 8BitGo Open Platform SDK —— 公共类型。
 *
 * 这些类型对应的是后端 `server/src/open/*` 返回**对外白名单形状**（见 open/mapper.js），
 * 不是站内 `mappers.js` 的形状：对外绝不暴露对象存储 key 原文、后台运行参数等。
 * 字段名用下划线，和整套开放接口保持一致。
 */

/** 开放平台 scope。app 级（client_credentials 可拿）/ user 级（需用户授权）两套。 */
export type OpenScope =
  | 'openid'
  | 'profile'
  | 'email'
  | 'games.read'
  | 'games.rom'
  | 'library.read'
  | 'library.write'
  | 'saves.read'
  | 'saves.write'

/** `POST /api/open/v1/token` 的响应（OAuth 风格）。 */
export interface TokenResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  scope: string
}

/** `GET /api/open/v1/me` 的自省响应：这枚令牌是谁的、有哪些 scope、何时过期。 */
export interface TokenInfo {
  client_id: string
  kind: string
  scope: string
  expires_at: string
}

/** 一款游戏（对外形状）。封面是绝对地址，拿不到时为 null。 */
export interface Game {
  slug: string
  title: string
  description: string
  /** 这次请求实际要的是哪一门语言 */
  lang_requested: string
  /** 标题 / 简介**实际**落到了哪一门（und = 原名，没有语言可言）；接入方据此决定要不要显示「暂无译文」 */
  lang_actual: { title: string; description: string }
  platform: string
  genres: string[]
  tags: string[]
  year: number
  developer: string
  players: number
  multiplayer: boolean
  /** emoji，没封面时的兜底显示 */
  icon: string
  /** 绝对地址；给不出来时是 null，**不给一个必然 404 的 URL** */
  cover: string | null
  rating: number
  rating_count: number
  plays: number
  added_at: string | null
  updated_at: string | null
  adult: boolean
  /** 这款游戏有哪些 ROM 语言可选（`*` = 通用件）。只报语言码，绝不报 object key */
  rom_langs: string[]
}

/** `GET /api/open/v1/games` 的分页列表。 */
export interface GameList {
  items: Game[]
  page: number
  page_size: number
  total: number
  total_pages: number
}

/** `GET /api/open/v1/games/:slug/rom` 返回的短期下载凭据。 */
export interface RomGrant {
  /** 兑换地址：URL 里没有 object key，抄走也只能下这一款、这几分钟 */
  url: string
  expires_in: number
  lang_requested: string | null
  lang_actual: string
  filename: string
}

/** `GET /api/open/v1/games/:slug/embed` 返回的签名嵌入地址。 */
export interface EmbedGrant {
  url: string
  expires_in: number
  allow: string
}

/** `GET /v1/games` 的查询参数。 */
export interface GameListParams {
  /** 语言码；不传用站内 hreflang 的 x-default（en） */
  lang?: string
  platform?: string
  genre?: string
  q?: string
  sort?: string
  page?: number
  /** 1–50，默认 24 */
  pageSize?: number
}

/* ---------------- 用户级令牌（设备码 / 授权码流程换来） ---------------- */

/** 一枚用户级令牌的响应。形状和 TokenResponse 一样，只是背后站着某个用户。 */
export interface UserTokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  scope: string
}

/**
 * `POST /api/open/v1/device/code` 的响应（RFC 8628）。
 * 设备拿 device_code 去轮询，用户拿 user_code 去网页上确认。
 */
export interface DeviceAuthorization {
  device_code: string
  user_code: string
  /** 用户要打开的确认页（输 user_code 用） */
  verification_uri: string
  /** 带好码的确认页完整地址，能显示二维码的设备直接编成码 */
  verification_uri_complete: string
  /** 这串码多久过期（秒） */
  expires_in: number
  /** 设备该隔多少秒轮询一次 */
  interval: number
}

/* ---------------- 用户数据（要用户级令牌） ---------------- */

/**
 * `GET /v1/library` —— 收藏与最近在玩。
 * 元素是和 Game 同一个形状（不是一串 slug），省得接入方再发十次请求换标题封面。
 */
export interface LibraryView {
  favorites: Game[]
  recent: Game[]
  /** 收藏被截断前的总数；据此判断要不要提示「还有更多」 */
  favorites_total: number
}

/** 一份存档的元信息（列表与单份 meta 共用）。 */
export interface SaveMeta {
  runtime: string
  game_slug: string
  slot: number
  /** 字节数 */
  size: number
  created_at: string
  updated_at: string
}

/** `GET /v1/saves` —— 存档清单（只给元信息，不含二进制）。 */
export interface SaveList {
  items: SaveMeta[]
}

/** `GET /v1/saves/:runtime/:slug` 取回的一份存档二进制。 */
export interface SaveData {
  runtime: string
  slug: string
  slot: number
  /** 原始存档字节（emulatorjs 快照 / jsdos 变更包等） */
  data: Uint8Array
  /** 服务端记录的更新时间（epoch ms），来自响应头 x-save-updated-at */
  updatedAt: number
}
