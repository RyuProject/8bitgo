/**
 * 收藏与最近在玩（用户级，要 library.read）。
 *
 * 元素是和 Game 同一个形状——省得接入方拿到一串 slug 之后再发十次请求换标题封面。
 * 没登录 / 没授权会直接报错，不会静默给你一个空列表（那比报错更坑）。
 */
import { buildQuery } from '../client'
import type { BitgoOpenClient } from '../client'
import type { LibraryView } from '../types'

export class LibraryResource {
  constructor(private readonly client: BitgoOpenClient) {}

  /** `GET /v1/library` —— 收藏（截顶 100 款）+ 最近在玩。 */
  list(opts: { lang?: string } = {}): Promise<LibraryView> {
    return this.client.requestUser<LibraryView>(`/v1/library${buildQuery({ lang: opts.lang })}`)
  }
}
