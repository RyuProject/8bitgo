/**
 * 后端 API 客户端。
 *
 * 只有配置了 VITE_API_URL 时才启用；留空则整个前端退回到「浏览器本地存储」模式，
 * 行为和以前完全一致（方便离线 / 无后端时开发）。
 *
 * 三种填法：
 *   VITE_API_URL=same-origin       ← 推荐。前端和 API 由同一个 Express 进程提供时用这个，
 *                                    请求走相对路径 /api/…，换域名、上 CDN 都不用重新构建。
 *   VITE_API_URL=https://你的域名   ← 前后端不同域时填后端根地址
 *   VITE_API_URL=                  ← 留空 = 不连后端，用浏览器本地存储
 *
 * 注意：填地址时**不要带 /api**（下面的 path 自带 /api/…，重复会变成 /api/api/…）。
 *
 * 另外提醒：填 http://127.0.0.1:8788 会被打进前端包里，访客的浏览器会去请求**他们自己**的
 * 127.0.0.1，线上必然失败。只有你本机开发时才该这么填；部署到服务器请用 same-origin。
 *
 * 令牌：
 *   - 用户登录后拿到的 JWT，存在 localStorage(8bitgo.token)，随请求带上。
 *   - 后台写操作用「管理员 API 口令」（后台账号登录也行）：sessionStorage(8bitgo.api.admintoken)，
 *     对应后端 .env 里的 ADMIN_TOKEN；没设时退回用当前用户的 JWT（该用户需为 admin）。
 */
import { getT, fmt } from './i18n'

const RAW_API_URL = (import.meta.env.VITE_API_URL || '').trim()
/** same-origin / 单个斜杠：走相对路径，同一个域名下的 /api/… */
const SAME_ORIGIN = RAW_API_URL === 'same-origin' || RAW_API_URL === '/'
const API_URL = SAME_ORIGIN ? '' : RAW_API_URL.replace(/\/+$/, '')

/** 后端根地址（不带 /api）。same-origin 与未配置时都返回空串，用 apiEnabled() 区分。 */
export function apiBase(): string {
  return API_URL
}

export function apiEnabled(): boolean {
  return SAME_ORIGIN || Boolean(API_URL)
}

/** 给界面显示用的后端地址描述 */
export function apiLabel(): string {
  if (SAME_ORIGIN) return '同域（same-origin）'
  return API_URL
}

const TOKEN_KEY = '8bitgo.token'
const ADMIN_TOKEN_KEY = '8bitgo.api.admintoken'

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}
export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ignore */
  }
}
export function getAdminApiToken(): string {
  try {
    return sessionStorage.getItem(ADMIN_TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}
export function setAdminApiToken(token: string | null) {
  try {
    // 管理员密钥只活在当前标签页；关闭标签页后自动失效，避免长期留在浏览器磁盘里。
    if (token) sessionStorage.setItem(ADMIN_TOKEN_KEY, token)
    else sessionStorage.removeItem(ADMIN_TOKEN_KEY)
    // 清掉旧版本曾经写入 localStorage 的长期副本，升级后不继续遗留管理员密钥。
    localStorage.removeItem(ADMIN_TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * ⚠️ 后台口令**优先于**登录令牌，这是有意的（口令是给没有账号的人留的），
 * 但它有个危险的副作用：一个填错 / 过期 / 服务端换过的口令，会把一个完全正常的
 * 管理员登录态整个盖掉，于是每一次后台写操作都报「权限不足」。
 *
 * 处置不在这里，而在 request() 里：服务端认出「带了东西但既不是站内令牌也不是口令」
 * 时会回 `code: 'invalid_admin_token'`，那边收到就把这个口令清掉并用登录令牌重试一次。
 * 光在这里调换优先级是不行的 —— 客户端没法自己判断一个口令对不对。
 */
function authHeaders(admin: boolean, skipAdminToken = false): Record<string, string> {
  const token = admin && !skipAdminToken ? getAdminApiToken() || getToken() : getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

interface ReqOptions {
  body?: unknown
  admin?: boolean
}

/** 带上状态码与响应体的请求错误。调用方想细分处理时用 instanceof 判一下即可。 */
export class ApiError extends Error {
  readonly status: number
  readonly data: unknown
  constructor(message: string, status: number, data: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.data = data
  }
}

async function request<T>(
  method: string,
  path: string,
  { body, admin = false }: ReqOptions = {},
  skipAdminToken = false,
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      // 整个 API 都是 JSON；显式声明让 /api/oauth/authorize 这类按 Accept 分流的端点回 JSON 而不是 HTML
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...authHeaders(admin, skipAdminToken),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  // 网关的 502 页面、被静态服务器兜底成 index.html 的 /api 请求，返回的都是 HTML。
  // 以前在这里直接 JSON.parse，用户看到的报错是「Unexpected token '<'」，
  // 而不是设计好的「请求失败：502」。解析失败当作没有结构化数据处理。
  let data: unknown = null
  try {
    data = text ? (JSON.parse(text) as unknown) : null
  } catch {
    data = null
  }
  if (!res.ok) {
    /*
      后台口令是坏的：清掉它，改用登录令牌重试一次。

      为什么要自愈而不是只报错：这个口令存在 sessionStorage 里，不清掉的话**后面每一次
      写操作都会继续被它盖住**，而人看到的只是一句莫名其妙的「权限不足」。

      ⚠️ 只重试这一种情况（服务端明说的 invalid_admin_token）、只重试一次、
      而且只在确实还有登录令牌可用时。403 意味着服务端**什么都没做**，所以重试一个
      PUT / POST 不会写两遍 —— 换成别的状态码就不成立了，别顺手放宽。
    */
    const code = (data as { code?: string } | null)?.code
    if (code === 'invalid_admin_token' && !skipAdminToken && getAdminApiToken() && getToken()) {
      setAdminApiToken(null)
      return request<T>(method, path, { body, admin }, true)
    }
    const msg = (data as { error?: string } | null)?.error || fmt(getT().errors.requestFailed, { status: res.status })
    // 抛 ApiError 而不是裸 Error：状态码和响应体不能在这里丢掉 ——
    // 比如发验证码被限流时，服务端会连 retryAfter 一起回来，UI 要靠它倒计时。
    // 继承自 Error，所以 `err instanceof Error ? err.message : ...` 这类老写法照常能用。
    throw new ApiError(msg, res.status, data)
  }
  if (data === null && text) {
    throw new Error(fmt(getT().errors.requestFailed, { status: res.status }))
  }
  return data as T
}

export const api = {
  get: <T>(path: string, admin = false) => request<T>('GET', path, { admin }),
  post: <T>(path: string, body?: unknown, admin = false) => request<T>('POST', path, { body, admin }),
  put: <T>(path: string, body?: unknown, admin = false) => request<T>('PUT', path, { body, admin }),
  patch: <T>(path: string, body?: unknown, admin = false) => request<T>('PATCH', path, { body, admin }),
  /**
   * DELETE。第三个参数是请求体 —— 注销账号要把邮箱验证码带上（DELETE /api/me）。
   *
   * ⚠️ body 放在 admin 后面而不是像 post/patch 那样放第二个：
   * 已有十几处在用 `api.del(path, true)`，把 body 插到第二位会让那个 true
   * 悄悄变成请求体，而 admin 变成 undefined —— 后台的删除全部 403，且不报错在明面上。
   */
  del: <T>(path: string, admin = false, body?: unknown) => request<T>('DELETE', path, { admin, body }),
}
