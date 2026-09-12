/**
 * 8BitGo Open Platform SDK —— 客户端核心。
 *
 * 负责三件事：
 *   1. 维护应用级令牌（自动取、临近过期自动刷新，带缓冲秒数）；
 *   2. 拼接 baseUrl + 路径、挂 Bearer、发 JSON；
 *   3. 把非 2xx 翻成 OpenApiError，并把限流（429）的 Retry-After 透传给调用方。
 *
 * 框架无关：直接用全局 fetch，Node 18+ 与浏览器都能跑。
 */
import { OpenApiError, type OpenApiErrorBody } from './errors'
import { requestToken } from './auth'
import type { OpenScope, TokenInfo, TokenResponse, UserTokenResponse } from './types'
import { GamesResource } from './resources/games'
import { TokenResource } from './resources/token'
import { UserFlows } from './flows'
import { LibraryResource } from './resources/library'
import { SavesResource } from './resources/saves'

export interface ClientOptions {
  /** 站点根地址，如 https://8bitgo.com（不带结尾斜杠） */
  baseUrl: string
  clientId: string
  clientSecret: string
  /** 要申请的 scope；不传则取应用获批的全部应用级 scope */
  scopes?: OpenScope[]
  /** 令牌提前刷新的缓冲秒数，默认 60 */
  tokenRefreshBufferSec?: number
  /** 自定义 fetch（测试 / 换运行时用），默认全局 fetch */
  fetchImpl?: typeof fetch
  /**
   * 已取得的**用户级**令牌（设备码 / 授权码流程换来）。设置了就能直接调
   * `library` / `saves` 这类要用户授权的接口，不必再走一遍授权流程。
   */
  userToken?: string
  /** userToken 的剩余寿命（秒），配合 userToken 用 */
  userTokenExpiresIn?: number
}

interface CachedToken {
  token: string
  /** 本地过期时间（epoch ms） */
  expiresAt: number
}

export class BitgoOpenClient {
  readonly games: GamesResource
  readonly token: TokenResource
  /** 用户级授权流程：设备码（RFC 8628）+ 授权码 + PKCE */
  readonly user: UserFlows
  readonly library: LibraryResource
  readonly saves: SavesResource

  readonly baseUrl: string
  readonly clientId: string
  private readonly clientSecret: string
  private readonly scopes: OpenScope[]
  private readonly bufferSec: number
  private readonly fetchImpl: typeof fetch

  private cache: CachedToken | null = null
  private userCache: CachedToken | null = null

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.clientId = opts.clientId
    this.clientSecret = opts.clientSecret
    this.scopes = opts.scopes ?? []
    this.bufferSec = opts.tokenRefreshBufferSec ?? 60
    this.fetchImpl = opts.fetchImpl ?? fetch
    if (opts.userToken) {
      this.userCache = {
        token: opts.userToken,
        expiresAt: Date.now() + Math.max(0, (opts.userTokenExpiresIn ?? 0) - this.bufferSec) * 1000,
      }
    }

    this.games = new GamesResource(this)
    this.token = new TokenResource(this)
    this.user = new UserFlows(this)
    this.library = new LibraryResource(this)
    this.saves = new SavesResource(this)
  }

  /** 当前（已确保有效的）**应用级** Bearer 令牌；首次调用会去取。 */
  async getAccessToken(): Promise<string> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.token
    const res: TokenResponse = await requestToken({
      baseUrl: this.baseUrl,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      scopes: this.scopes.length ? this.scopes : undefined,
      fetchImpl: this.fetchImpl,
    })
    // 留一点缓冲，别卡着点过期去用
    this.cache = {
      token: res.access_token,
      expiresAt: Date.now() + Math.max(0, res.expires_in - this.bufferSec) * 1000,
    }
    return res.access_token
  }

  /** 当前（已确保有效的）**用户级** Bearer 令牌；未授权会抛错。 */
  async getUserAccessToken(): Promise<string> {
    if (this.userCache && this.userCache.expiresAt > Date.now()) return this.userCache.token
    throw new Error(
      '尚未取得用户级令牌：请先通过 client.user.deviceCode / client.user.authorizationCode 完成用户授权',
    )
  }

  /** 内部：用户流程成功后写入用户级令牌。 */
  setUserToken(token: string, expiresIn: number): void {
    this.userCache = {
      token,
      expiresAt: Date.now() + Math.max(0, expiresIn - this.bufferSec) * 1000,
    }
  }

  /** 内部给资源用：发一个带**应用级**鉴权的请求，并把非 2xx 翻成 OpenApiError。 */
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.getAccessToken()
    const res = await this.fetchImpl(`${this.baseUrl}/api/open${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    })

    if (res.status === 401 && this.cache) {
      // 令牌被服务端判无效 —— 清掉重取一次再试，避免一直用一把失效的令牌
      this.cache = null
      const token2 = await this.getAccessToken()
      const res2 = await this.fetchImpl(`${this.baseUrl}/api/open${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token2}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      })
      return handle(res2)
    }
    return handle<T>(res)
  }

  /**
   * 内部给资源用：发一个带**用户级**鉴权的请求（library / saves 用）。
   * 用户令牌失效直接报错、清缓存，不静默重试（重走授权流程是调用方的事）。
   */
  async requestUser<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.getUserAccessToken()
    const res = await this.fetchImpl(`${this.baseUrl}/api/open${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    })
    if (res.status === 401) {
      this.userCache = null
      throw new OpenApiError(401, { error: 'invalid_token', error_description: '用户令牌无效或已过期' })
    }
    return handle<T>(res)
  }

  /** 同 requestUser，但把原始 Response 交回（取存档二进制用，不走 JSON 解析）。 */
  async requestUserRaw(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.getUserAccessToken()
    const res = await this.fetchImpl(`${this.baseUrl}/api/open${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    })
    if (res.status === 401) {
      this.userCache = null
      throw new OpenApiError(401, { error: 'invalid_token', error_description: '用户令牌无效或已过期' })
    }
    return res
  }

  /**
   * 内部：往令牌类端点（/api/open/v1/device/code、/api/open/v1/token、
   * /api/oauth/token）发 form-urlencoded，带 Basic 客户端认证。
   * 非 2xx 翻成 OpenApiError（设备码轮询的 authorization_pending / slow_down 也在其中）。
   */
  async postForm(path: string, params: Record<string, string>): Promise<any> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicAuth(this.clientId, this.clientSecret),
      },
      body: new URLSearchParams(params).toString(),
    })
    const text = await res.text()
    const data: unknown = text ? safeJson(text) : null
    if (!res.ok) {
      if (isErrorBody(data)) return Promise.reject(new OpenApiError(res.status, data))
      return Promise.reject(
        new OpenApiError(res.status, { error: 'unknown', error_description: typeof data === 'string' ? data : `HTTP ${res.status}` }),
      )
    }
    return data as UserTokenResponse
  }
}

/** Basic 认证头的值。client_id / client_secret 都是 ASCII（密钥是 base64url），btoa 直接可用。 */
function basicAuth(id: string, secret: string): string {
  return `Basic ${btoa(`${id}:${secret}`)}`
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function handle<T>(res: Response): Promise<T> {
  const text = await res.text()
  const data: unknown = text ? JSON.parse(text) : null
  if (!res.ok) {
    throw toError(res.status, data, res.headers.get('Retry-After'))
  }
  return data as T
}

function toError(status: number, data: unknown, retryAfter: string | null): OpenApiError {
  if (isErrorBody(data)) {
    if (retryAfter && !data.retry_after) data.retry_after = Number(retryAfter) || undefined
    return new OpenApiError(status, data)
  }
  return new OpenApiError(status, {
    error: 'unknown',
    error_description: typeof data === 'string' ? data : `HTTP ${status}`,
  })
}

function isErrorBody(v: unknown): v is OpenApiErrorBody {
  return typeof v === 'object' && v !== null && typeof (v as OpenApiErrorBody).error === 'string'
}

/** 给资源拼查询串用的小工具（跳过 undefined / 空串）。 */
export function buildQuery(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}
