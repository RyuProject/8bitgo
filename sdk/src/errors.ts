/**
 * 8BitGo Open Platform SDK —— 错误类型。
 *
 * 后端所有错误体都是 OAuth 风格：
 *   { error, error_description, error_uri?, scope?, retry_after? }
 * 见 `server/src/routes/open.js` 的 `fail()`。
 */

export interface OpenApiErrorBody {
  error: string
  error_description: string
  error_uri?: string
  /** insufficient_scope 时带，告诉你需要哪个 scope */
  scope?: string
  /** rate_limited 时带，对应响应头 Retry-After */
  retry_after?: number
}

/** 所有非 2xx 响应都会抛这个。 */
export class OpenApiError extends Error {
  /** HTTP 状态码 */
  readonly status: number
  /** 错误码，如 invalid_token / insufficient_scope / rate_limited / not_found */
  readonly code: string
  readonly description: string
  readonly errorUri?: string
  readonly scope?: string
  readonly retryAfter?: number
  /** 原始响应体 */
  readonly body: OpenApiErrorBody

  constructor(status: number, body: OpenApiErrorBody) {
    super(`${body.error}: ${body.error_description}`)
    this.name = 'OpenApiError'
    this.status = status
    this.code = body.error
    this.description = body.error_description
    this.errorUri = body.error_uri
    this.scope = body.scope
    this.retryAfter = body.retry_after
    this.body = body
  }

  /** 令牌无效 / 过期（401）。 */
  get isAuthError(): boolean {
    return this.status === 401
  }

  /** 缺 scope（403）。 */
  get isScopeError(): boolean {
    return this.status === 403
  }

  /** 触发了限流（429）。 */
  get isRateLimited(): boolean {
    return this.status === 429
  }
}
