/**
 * 8BitGo Open Platform SDK —— 令牌资源（自省）。
 *
 * `GET /api/open/v1/me`：接入方排错的第一站，看这枚令牌是谁的、有哪些 scope、何时过期。
 * 不需要任何 scope 就能调（中间件只认令牌本身）。
 */
import { BitgoOpenClient } from '../client'
import type { TokenInfo } from '../types'

export class TokenResource {
  constructor(private readonly client: BitgoOpenClient) {}

  /** `GET /v1/me` —— 令牌自省。 */
  async introspect(): Promise<TokenInfo> {
    return this.client.request<TokenInfo>('/v1/me')
  }
}
