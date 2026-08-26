/**
 * 后端 API 客户端。
 *
 * 只有配置了 VITE_API_URL 时才启用；留空则整个前端退回到「浏览器本地存储」模式，
 * 行为和以前完全一致（方便离线 / 无后端时开发）。
 *
 * 注意：只填站点根地址，**不要带 /api**（下面的 path already 自带 /api/…，重复会变成 /api/api/…）。
 *   VITE_API_URL=https://你的域名      （或本地 http://127.0.0.1:8788）
 *
 * 令牌：
 *   - 用户登录后拿到的 JWT，存在 localStorage(8bitgo.token)，随请求带上。
 *   - 后台写操作用「管理员 API 口令」（后台账号登录也行）：localStorage(8bitgo.api.admintoken)，
 *     对应后端 .env 里的 ADMIN_TOKEN；没设时退回用当前用户的 JWT（该用户需为 admin）。
 */
import { getT, fmt } from './i18n'

const API_URL = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '')

/** 后端根地址（不带 /api）。未配置时返回空串。 */
export function apiBase(): string {
  return API_URL
}

export function apiEnabled(): boolean {
  return Boolean(API_URL)
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
    return localStorage.getItem(ADMIN_TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}
export function setAdminApiToken(token: string | null) {
  try {
    if (token) localStorage.setItem(ADMIN_TOKEN_KEY, token)
    else localStorage.removeItem(ADMIN_TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

function authHeaders(admin: boolean): Record<string, string> {
  const token = admin ? getAdminApiToken() || getToken() : getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

interface ReqOptions {
  body?: unknown
  admin?: boolean
}

async function request<T>(method: string, path: string, { body, admin = false }: ReqOptions = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...authHeaders(admin),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  const data = text ? (JSON.parse(text) as unknown) : null
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error || fmt(getT().errors.requestFailed, { status: res.status })
    throw new Error(msg)
  }
  return data as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown, admin = false) => request<T>('POST', path, { body, admin }),
  put: <T>(path: string, body?: unknown, admin = false) => request<T>('PUT', path, { body, admin }),
  patch: <T>(path: string, body?: unknown, admin = false) => request<T>('PATCH', path, { body, admin }),
  del: <T>(path: string, admin = false) => request<T>('DELETE', path, { admin }),
}
