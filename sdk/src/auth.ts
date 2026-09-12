/**
 * 8BitGo Open Platform SDK —— 取令牌（client_credentials）。
 *
 * 只支持应用级 `grant_type=client_credentials`：后端 `POST /api/open/v1/token`。
 * 用户级令牌（授权码 + PKCE）是另一条路（/api/oauth/*），不在这里。
 *
 * 后端这一条路由额外接受 JSON 请求体（全局 express.json 已解好），所以这里发 JSON 即可。
 */
import { OpenApiError, type OpenApiErrorBody } from './errors'
import type { TokenResponse } from './types'

export interface TokenRequest {
  baseUrl: string
  clientId: string
  clientSecret: string
  scopes?: string[]
  /** 自定义 fetch（测试 / 换运行时用），默认全局 fetch */
  fetchImpl?: typeof fetch
}

/** 取一枚应用级令牌。任何非 2xx 都会抛 OpenApiError。 */
export async function requestToken(req: TokenRequest): Promise<TokenResponse> {
  const url = `${req.baseUrl.replace(/\/+$/, '')}/api/open/v1/token`
  const doFetch = req.fetchImpl ?? fetch
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: req.clientId,
      client_secret: req.clientSecret,
      ...(req.scopes && req.scopes.length ? { scope: req.scopes.join(' ') } : {}),
    }),
  })

  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    throw toError(res.status, data)
  }
  return data as TokenResponse
}

function toError(status: number, data: unknown): OpenApiError {
  if (isErrorBody(data)) return new OpenApiError(status, data)
  return new OpenApiError(status, {
    error: 'unknown',
    error_description: typeof data === 'string' ? data : '无法解析的响应',
  })
}

function isErrorBody(v: unknown): v is OpenApiErrorBody {
  return typeof v === 'object' && v !== null && typeof (v as OpenApiErrorBody).error === 'string'
}
