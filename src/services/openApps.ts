/**
 * 开发者控制台（/open）与后台审核共用的接口客户端。
 *
 * 两套端点，权限完全不同，所以函数名上带了前缀：
 *   my*     `/api/open-apps/*`        —— 我自己的应用（登录即可）
 *   review* `/api/admin/open-apps/*`  —— 审核（权限点 apps:review）
 *
 * ⚠️ `my*` 一律**不传** api 的 admin 标志（第二 / 第三个参数）。
 * 传了的话 authHeaders 会优先用后台口令（`getAdminApiToken()`）——
 * 而那把口令在 `requireUser` 那里没有 uid，结果是「明明登录着却 401」。
 * `review*` 相反：它走后台，要让口令优先。
 */
import { api, apiEnabled } from './api'

export type AppStatus = 'sandbox' | 'live' | 'suspended'
export type ReviewState = 'none' | 'pending' | 'rejected'

export interface OpenAppLimits {
  redirectUris: number
  testers: number
  qps: number
  callsPerDay: number
}

export interface OpenApp {
  id: string
  name: string
  description: string
  homepage: string
  privacyUrl: string
  clientType: 'confidential' | 'public'
  redirectUris: string[]
  embedOrigins: string[]
  /** 现在真的能用的 */
  approvedScopes: string[]
  /** 申请了、还没批的 */
  requestedScopes: string[]
  status: AppStatus
  reviewState: ReviewState
  reviewNote: string
  /** 打回 / 停用的理由，原样来自审核人 */
  reviewReason: string
  rateTier: string
  limits: OpenAppLimits
  submittedAt: string | null
  reviewedAt: string | null
  createdAt: string | null
}

export interface OpenAppSecret {
  id: string
  /** 末 6 位。**明文只在创建 / 轮换那一刻返回一次** */
  hint: string
  createdAt: string | null
  revokedAt: string | null
  lastUsedAt: string | null
  active: boolean
}

export interface OpenAppTester {
  id: string
  nickname: string
  /** 打码过的 */
  email: string
  addedAt: string | null
}

export interface OpenAppReview {
  id: number
  action: 'submit' | 'withdraw' | 'approve' | 'reject' | 'suspend' | 'restore'
  detail: string
  at: string | null
  actor: string
}

export interface OpenAppDetail {
  app: OpenApp
  secrets: OpenAppSecret[]
  testers: OpenAppTester[]
  reviews: OpenAppReview[]
}

/** 创建 / 轮换的回包。`secret` 是**唯一一次**能看到明文的机会 */
export interface SecretIssued {
  secret: string
  secretNotice: string
  app?: OpenApp
  secrets?: OpenAppSecret[]
}

export interface OpenAppInput {
  name: string
  description?: string
  homepage?: string
  privacyUrl?: string
  clientType?: 'confidential' | 'public'
  redirectUris?: string[]
  embedOrigins?: string[]
  scopes?: string
}

/* ---------------- 我的应用 ---------------- */

export async function myApps(): Promise<{ items: OpenApp[]; maxApps: number }> {
  if (!apiEnabled()) return { items: [], maxApps: 0 }
  return api.get('/api/open-apps')
}

export async function myApp(id: string): Promise<OpenAppDetail> {
  return api.get(`/api/open-apps/${encodeURIComponent(id)}`)
}

export async function createMyApp(input: OpenAppInput): Promise<SecretIssued> {
  return api.post('/api/open-apps', input)
}

export async function patchMyApp(id: string, patch: Partial<OpenAppInput>): Promise<{ app: OpenApp }> {
  return api.patch(`/api/open-apps/${encodeURIComponent(id)}`, patch)
}

export async function rotateSecret(id: string): Promise<SecretIssued> {
  return api.post(`/api/open-apps/${encodeURIComponent(id)}/secrets`, {})
}

export async function revokeSecret(id: string, secretId: string): Promise<{ secrets: OpenAppSecret[] }> {
  return api.del(`/api/open-apps/${encodeURIComponent(id)}/secrets/${encodeURIComponent(secretId)}`)
}

export async function addTester(id: string, email: string): Promise<{ testers: OpenAppTester[] }> {
  return api.post(`/api/open-apps/${encodeURIComponent(id)}/testers`, { email })
}

export async function removeTester(id: string, userId: string): Promise<{ testers: OpenAppTester[] }> {
  return api.del(`/api/open-apps/${encodeURIComponent(id)}/testers/${encodeURIComponent(userId)}`)
}

export async function submitForReview(id: string, note: string, scopes?: string): Promise<OpenAppDetail> {
  return api.post(`/api/open-apps/${encodeURIComponent(id)}/submit`, { note, ...(scopes ? { scopes } : {}) })
}

export async function withdrawReview(id: string): Promise<OpenAppDetail> {
  return api.post(`/api/open-apps/${encodeURIComponent(id)}/withdraw`, {})
}

/* ---------------- 审核（后台） ---------------- */

export interface ReviewQueueItem extends OpenApp {
  owner: { id: string; nickname: string; email: string }
  /** 申请单里的敏感 scope，界面上要标出来 */
  sensitive: string[]
}

export async function reviewQueue(state = 'pending'): Promise<{ items: ReviewQueueItem[]; sensitiveScopes: string[] }> {
  return api.get(`/api/admin/open-apps?state=${encodeURIComponent(state)}`, true)
}

export async function reviewApp(id: string): Promise<OpenAppDetail & { app: ReviewQueueItem; sensitive: string[] }> {
  return api.get(`/api/admin/open-apps/${encodeURIComponent(id)}`, true)
}

export async function approveApp(id: string, scopes: string, note?: string) {
  return api.post(`/api/admin/open-apps/${encodeURIComponent(id)}/approve`, { scopes, note }, true)
}

export async function rejectApp(id: string, reason: string) {
  return api.post(`/api/admin/open-apps/${encodeURIComponent(id)}/reject`, { reason }, true)
}

export async function suspendApp(id: string, reason: string): Promise<{ notice?: string }> {
  return api.post(`/api/admin/open-apps/${encodeURIComponent(id)}/suspend`, { reason }, true)
}

export async function restoreApp(id: string) {
  return api.post(`/api/admin/open-apps/${encodeURIComponent(id)}/restore`, {}, true)
}

/* ---------------- 展示用的小工具 ---------------- */

/** 状态 -> 中文标签 + 颜色语义。界面别自己拼这套映射，容易两处不一致 */
export function statusLabel(app: Pick<OpenApp, 'status' | 'reviewState'>): { text: string; tone: 'ok' | 'warn' | 'bad' | 'dim' } {
  if (app.status === 'suspended') return { text: '已停用', tone: 'bad' }
  if (app.reviewState === 'pending') return { text: '审核中', tone: 'warn' }
  if (app.reviewState === 'rejected') return { text: '已打回', tone: 'bad' }
  if (app.status === 'live') return { text: '已上产', tone: 'ok' }
  return { text: '沙箱', tone: 'dim' }
}

/** 这个 scope 要不要审核才能拿 */
export const SELF_SERVE = ['games.read']
export const SCOPE_LABELS: Record<string, string> = {
  openid: '登录（签发 id_token）',
  profile: '昵称、头像',
  email: '邮箱',
  'games.read': '游戏元数据、封面、嵌入地址',
  'games.rom': 'ROM 短期下载凭据',
  'library.read': '读收藏与最近在玩',
  'library.write': '写收藏与最近在玩',
  'saves.read': '读云存档',
  'saves.write': '写云存档',
}

/* ---------------- 设备码流程：用户确认那一步 ---------------- */

export interface DeviceScope {
  id: string
  desc: string
  sensitive: boolean
}
export interface DeviceAuthInfo {
  app: { id: string; name: string; logo: string | null; homepage: string | null; status: string }
  scopes: DeviceScope[]
  /** 沙箱应用只能授权给开发者本人和登记过的测试账号，见 apps-repo.canAuthorize */
  allowed: boolean
  reason: string
}

/** 这串码是哪个应用要的、要哪些权限 */
export async function deviceAuthInfo(code: string): Promise<DeviceAuthInfo> {
  return api.get(`/api/open-device/${encodeURIComponent(code)}`)
}

/** 同意 / 拒绝 */
export async function decideDeviceAuth(code: string, approve: boolean): Promise<{ ok: boolean; approved: boolean }> {
  return api.post(`/api/open-device/${encodeURIComponent(code)}`, { approve })
}

/* ---------------- 授权码流程：用户同意页（/open/authorize） ---------------- */

/**
 * 同意页要展示的东西：哪个应用、要哪些权限、沙箱没放行时为什么灰按钮。
 * 形状和服务端 routes/oauth.js 的 `GET /api/oauth/authorize`（Accept: json）回包一致。
 */
export interface AuthorizeScope {
  id: string
  desc: string
  sensitive: boolean
}
export interface AuthorizeInfo {
  client_id: string
  app: { id: string; name: string; logo: string | null; homepage: string | null; status: AppStatus }
  scopes: AuthorizeScope[]
  redirect_uri: string
  state: string
  /** 沙箱应用只能授权给开发者本人和测试账号；false 时同意按钮要灰掉 */
  allowed: boolean
  reason: string
}
/** 点了同意 / 拒绝后的回包：SPA 拿到后自己 302 跳回第三方 redirect_uri */
export interface AuthorizeResult {
  redirect_uri: string
  state: string | null
  code: string | null
  error: string | null
}

/** 取这枚授权请求要展示的内容（把地址里的 OAuth 参数原样传回去） */
export async function authorizeInfo(params: Record<string, string>): Promise<AuthorizeInfo> {
  const qs = new URLSearchParams(params).toString()
  return api.get(`/api/oauth/authorize?${qs}`)
}

/** 同意 / 拒绝。decision 之外要把原始 OAuth 参数一起带回去，服务端会再校验一遍 */
export async function decideAuthorize(params: Record<string, string>, approve: boolean): Promise<AuthorizeResult> {
  return api.post(`/api/oauth/authorize`, { ...params, decision: approve ? 'approve' : 'deny' })
}
