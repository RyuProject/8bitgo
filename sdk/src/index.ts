/**
 * @8bitgo/open-sdk —— 8BitGo 开放平台官方 SDK（TypeScript）。
 *
 * 面向第三方开发者，封装 `/api/open/v1/*` 这套**应用级**接口：
 * 游戏元数据、封面、短期 ROM 下载凭据、签名嵌入播放器地址，以及令牌自省。
 *
 * 用法：
 *   import { BitgoOpenClient } from '@8bitgo/open-sdk'
 *   const client = new BitgoOpenClient({
 *     baseUrl: 'https://8bitgo.com',
 *     clientId: '<AppID>',
 *     clientSecret: '<AppKey>',
 *     scopes: ['games.read'],
 *   })
 *   const page = await client.games.list({ platform: 'nes', pageSize: 10 })
 */
export { BitgoOpenClient, type ClientOptions, buildQuery } from './client'
export { GamesResource } from './resources/games'
export { TokenResource } from './resources/token'
export { LibraryResource } from './resources/library'
export { SavesResource } from './resources/saves'
export { UserFlows, DEVICE_GRANT } from './flows'
export { requestToken, type TokenRequest } from './auth'
export { OpenApiError, type OpenApiErrorBody } from './errors'
export type {
  OpenScope,
  TokenResponse,
  TokenInfo,
  UserTokenResponse,
  DeviceAuthorization,
  Game,
  GameList,
  GameListParams,
  LibraryView,
  SaveMeta,
  SaveList,
  SaveData,
  RomGrant,
  EmbedGrant,
} from './types'
