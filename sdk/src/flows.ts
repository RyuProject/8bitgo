/**
 * 用户级授权流程：设备码（RFC 8628）+ 授权码 + PKCE。
 *
 * 应用级（client_credentials）令牌背后没有用户，拿不到 library.* / saves.* 这类 scope。
 * 要调用户的收藏、云存档，必须先用这里其中一条流程换一枚**用户级**令牌
 * （sub = 用户 id，kind = 'user'）—— 服务端据此在 `WHERE user_id = ?` 里圈定数据。
 *
 * 两条流程换来的令牌都会写回 client，之后 `client.library` / `client.saves` 自动带上它。
 */
import { OpenApiError } from './errors'
import type { BitgoOpenClient } from './client'
import type { DeviceAuthorization, OpenScope, UserTokenResponse } from './types'

/** RFC 8628 规定的设备码 grant_type，一个字都不能改。 */
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

export class UserFlows {
  constructor(private readonly client: BitgoOpenClient) {}

  /* ---------------- 设备码流程（RFC 8628） ---------------- */

  /**
   * 第一步：向设备要一串码。
   *
   * 设备（没有浏览器、接不住回调地址的东西）拿 device_code 去轮询，
   * 用户拿 user_code 去 `verification_uri` 输进去点同意。
   */
  async startDeviceAuthorization(opts: { scopes?: OpenScope[] } = {}): Promise<DeviceAuthorization> {
    const body: Record<string, string> = {}
    if (opts.scopes?.length) body.scope = opts.scopes.join(' ')
    return this.client.postForm('/api/open/v1/device/code', body)
  }

  /**
   * 第二步：轮询直到用户批准（或明确失败）。
   *
   * ⚠️ `authorization_pending` / `slow_down` **不是失败**——它们的意思是「接着等」。
   * 这两个分支会继续轮询；`access_denied` / `expired_token` / `invalid_grant` 才抛错。
   * 成功后把用户级令牌写回 client 并返回。
   *
   * @param interval 起始轮询间隔（秒），默认按服务端给的 5；收到 slow_down 会自动加大
   * @param signal   取消轮询（AbortController）
   * @param onPending 每次「还没批准」时回调，便于 UI 提示
   */
  async pollDeviceToken(
    deviceCode: string,
    opts: { interval?: number; signal?: AbortSignal; onPending?: (info: { interval: number }) => void } = {},
  ): Promise<UserTokenResponse> {
    const base = opts.interval ?? 5
    let interval = base
    for (;;) {
      if (opts.signal?.aborted) throw new Error('设备码轮询已取消')
      await sleep(interval * 1000, opts.signal)
      try {
        const r = await this.client.postForm('/api/open/v1/token', {
          grant_type: DEVICE_GRANT,
          device_code: deviceCode,
        })
        this.client.setUserToken(r.access_token, r.expires_in)
        return r
      } catch (e) {
        if (!(e instanceof OpenApiError)) throw e
        if (e.code === 'authorization_pending') {
          opts.onPending?.({ interval })
          continue
        }
        // 服务端说 slow_down：把间隔加大一点再继续（不重置已等的时间）
        if (e.code === 'slow_down') {
          interval = Number((e.body as { interval?: number })?.interval) || interval + base
          opts.onPending?.({ interval })
          continue
        }
        // 其余（access_denied / expired_token / invalid_grant）= 真失败
        throw e
      }
    }
  }

  /* ---------------- 授权码 + PKCE（Web 应用） ---------------- */

  /**
   * 生成 PKCE 的 code_verifier / code_challenge。
   *
   * 公开客户端（纯前端）藏不住密钥，全靠 PKCE 防「授权码被截获后被人拿去换令牌」。
   * 用 Web Crypto（Node 18+ 与浏览器都自带），不引入 node 专属依赖。
   */
  static async generatePkce(): Promise<{ codeVerifier: string; codeChallenge: string }> {
    const verifier = randomVerifier()
    const challenge = await sha256Base64Url(verifier)
    return { codeVerifier: verifier, codeChallenge: challenge }
  }

  /**
   * 拼出用户要打开的授权页地址（第一步，给浏览器用）。
   * 用户在网页上登录并点同意后，会带着 ?code=...&state=... 跳回 redirectUri。
   */
  authorizationCodeUrl(opts: {
    scopes?: OpenScope[]
    redirectUri: string
    state?: string
    codeChallenge: string
  }): string {
    const u = new URL(`${this.client.baseUrl}/api/oauth/authorize`)
    u.searchParams.set('client_id', this.client.clientId)
    u.searchParams.set('response_type', 'code')
    u.searchParams.set('code_challenge', opts.codeChallenge)
    u.searchParams.set('code_challenge_method', 'S256')
    u.searchParams.set('redirect_uri', opts.redirectUri)
    if (opts.scopes?.length) u.searchParams.set('scope', opts.scopes.join(' '))
    if (opts.state) u.searchParams.set('state', opts.state)
    return u.href
  }

  /**
   * 第三步：用回调里的 code + 当初的 code_verifier 换用户级令牌。
   * 成功后写回 client。
   */
  async exchangeAuthorizationCode(opts: {
    code: string
    codeVerifier: string
    redirectUri: string
  }): Promise<UserTokenResponse> {
    const r = await this.client.postForm('/api/oauth/token', {
      grant_type: 'authorization_code',
      code: opts.code,
      code_verifier: opts.codeVerifier,
      redirect_uri: opts.redirectUri,
    })
    this.client.setUserToken(r.access_token, r.expires_in)
    return r
  }
}

/* ---------------- 与运行时无关的密码学小工具 ---------------- */

function randomVerifier(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return base64UrlEncode(new Uint8Array(digest))
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new Error('aborted'))
      },
      { once: true },
    )
  })
}
