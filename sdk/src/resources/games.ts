/**
 * 8BitGo Open Platform SDK —— 游戏资源。
 *
 * 对应后端 `/api/open/v1/games*` 与 `/api/open/v1/rom/:grant`、`/api/open/v1/games/:slug/embed`。
 * 全部需要 `games.read`（ROM 凭据还需 `games.rom`）—— 令牌里没有对应 scope 时后端回 403。
 */
import { BitgoOpenClient, buildQuery } from '../client'
import type { EmbedGrant, Game, GameList, GameListParams, RomGrant } from '../types'

export class GamesResource {
  constructor(private readonly client: BitgoOpenClient) {}

  /** `GET /v1/games` —— 分页列表。成人内容默认排除。 */
  async list(params: GameListParams = {}): Promise<GameList> {
    const q = buildQuery({
      lang: params.lang,
      platform: params.platform,
      genre: params.genre,
      q: params.q,
      sort: params.sort,
      page: params.page,
      page_size: params.pageSize,
    })
    return this.client.request<GameList>(`/v1/games${q}`)
  }

  /** `GET /v1/games/:slug` —— 单款游戏。下架 / 成人 / 不存在对外都是 404。 */
  async get(slug: string, params: { lang?: string } = {}): Promise<Game> {
    const q = buildQuery({ lang: params.lang })
    return this.client.request<Game>(`/v1/games/${encodeURIComponent(slug)}${q}`)
  }

  /** `GET /v1/games/:slug/rom?lang=ja` —— 取一张分钟级过期的 ROM 下载凭据。需 `games.rom`。 */
  async rom(slug: string, params: { lang?: string } = {}): Promise<RomGrant> {
    const q = buildQuery({ lang: params.lang })
    return this.client.request<RomGrant>(`/v1/games/${encodeURIComponent(slug)}/rom${q}`)
  }

  /** `GET /v1/games/:slug/embed` —— 取一个带签名、会过期的嵌入播放器地址。 */
  async embed(slug: string, params: { lang?: string } = {}): Promise<EmbedGrant> {
    const q = buildQuery({ lang: params.lang })
    return this.client.request<EmbedGrant>(`/v1/games/${encodeURIComponent(slug)}/embed${q}`)
  }
}
