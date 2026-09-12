/**
 * 测试用的假 fetch —— 不发真实网络请求，按 handler 回 canned 响应。
 * SDK 的 BitgoOpenClient 接收 fetchImpl，所以把 mockFetch 塞进去就能离线测。
 */
import type { OpenApiErrorBody } from '../src/index'

export type MockResponse = {
  status?: number
  /** JSON 响应体（会被 JSON.stringify） */
  body?: unknown
  /** 二进制响应体（不走 JSON，用于存档下载等）。给了 rawBody 就优先用它 */
  rawBody?: Uint8Array
  headers?: Record<string, string>
}

export type FetchHandler = (url: string, init: RequestInit) => MockResponse

export function mockFetch(handler: FetchHandler): typeof fetch {
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url
    const r = handler(url, init)
    if (r.rawBody) {
      return new Response(r.rawBody, { status: r.status ?? 200, headers: { ...(r.headers ?? {}) } })
    }
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...(r.headers ?? {}) },
    })
  }
  return fn as unknown as typeof fetch
}

/** 拼一个 OAuth 风格错误体。 */
export function oauthError(
  error: string,
  description: string,
  extra: Partial<OpenApiErrorBody> = {},
): OpenApiErrorBody {
  return { error, error_description: description, ...extra }
}

/** 一枚永远有效的应用级令牌，省得每个用例都写一遍。 */
export const OK_TOKEN = {
  access_token: 'tok',
  token_type: 'Bearer' as const,
  expires_in: 3600,
  scope: 'games.read',
}
