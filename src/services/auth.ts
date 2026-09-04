/**
 * 用户与登录。
 *
 * 两种模式：
 *   - 配置了 VITE_API_URL（后端可用）：注册 / 登录 / 收藏 / 最近 / 资料 / 后台用户管理 全部走后端 MySQL，
 *     登录态为 JWT（localStorage 8bitgo.token），当前用户信息缓存在 8bitgo.session.user。
 *   - 未配置后端：退回纯前端实现，用户存在 localStorage（8bitgo.users），密码存「盐 + SHA-256」，
 *     登录态只记用户 id（8bitgo.session）。行为与以前一致。
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { PublicUser, User, UserRole, UserStatus } from '@/types'
import { createLocalStore, randomId } from './localStore'
import { api, apiBase, apiEnabled, setToken, getToken } from './api'
import { pushGuestRecent } from './recents'
import { getT } from './i18n'

export const USERS_KEY = '8bitgo.users'
export const SESSION_KEY = '8bitgo.session'
export const SESSION_USER_KEY = '8bitgo.session.user'
export const WELCOME_COINS = 100

function isUser(x: unknown): x is User {
  const u = x as User
  return (
    typeof u === 'object' &&
    u !== null &&
    typeof u.id === 'string' &&
    typeof u.email === 'string' &&
    typeof u.nickname === 'string' &&
    typeof u.passwordHash === 'string' &&
    Array.isArray(u.favorites)
  )
}

export const usersStore = createLocalStore<User>({
  key: USERS_KEY,
  initial: [],
  getId: (u) => u.id,
  validate: isUser,
})

export function toPublic(u: User): PublicUser {
  const { passwordHash: _h, salt: _s, ...rest } = u
  // hasPassword 而不是哈希本身：界面只需要知道「要不要先问旧密码」
  return { ...rest, hasPassword: Boolean(u.passwordHash) }
}

/* ---------------- 密码哈希（仅本地模式用） ---------------- */

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function makeSalt(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/* ---------------- 当前用户 ---------------- */

const listeners = new Set<() => void>()
function notify() {
  for (const l of listeners) l()
}

// API 模式下的当前用户缓存
let apiUser: PublicUser | null = null
let apiUserLoaded = false

function readCachedApiUser(): PublicUser | null {
  try {
    const raw = localStorage.getItem(SESSION_USER_KEY)
    return raw ? (JSON.parse(raw) as PublicUser) : null
  } catch {
    return null
  }
}

function setCurrentUser(u: PublicUser | null) {
  apiUser = u
  apiUserLoaded = true
  try {
    if (u) localStorage.setItem(SESSION_USER_KEY, JSON.stringify(u))
    else localStorage.removeItem(SESSION_USER_KEY)
  } catch {
    /* ignore */
  }
  notify()
}

// 本地模式：从 usersStore + session id 派生，保持引用稳定
let localCache: { user: User | null; value: PublicUser | null } = { user: null, value: null }

function readSessionId(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY)
  } catch {
    return null
  }
}
function writeSessionId(id: string | null) {
  try {
    if (id) localStorage.setItem(SESSION_KEY, id)
    else localStorage.removeItem(SESSION_KEY)
  } catch {
    /* ignore */
  }
  notify()
}

export function getCurrentUser(): PublicUser | null {
  if (apiEnabled()) {
    if (!apiUserLoaded) {
      apiUser = readCachedApiUser()
      apiUserLoaded = true
    }
    return apiUser
  }
  const id = readSessionId()
  const user = id ? (usersStore.find(id) ?? null) : null
  if (!user || user.status === 'banned') {
    localCache = { user: null, value: null }
    return null
  }
  if (localCache.user !== user) localCache = { user, value: toPublic(user) }
  return localCache.value
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  const unsubUsers = usersStore.subscribe(listener)
  const onStorage = (e: StorageEvent) => {
    if (e.key === SESSION_KEY || e.key === USERS_KEY || e.key === SESSION_USER_KEY) {
      if (apiEnabled()) {
        apiUser = readCachedApiUser()
        apiUserLoaded = true
      }
      listener()
    }
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    unsubUsers()
    window.removeEventListener('storage', onStorage)
  }
}

/**
 * 当前用户。
 *
 * 第三个参数是「服务端快照」：SSR 以及客户端 hydration 的首次渲染都用它。
 * 服务端不知道访客是谁（登录态在 localStorage / JWT 里），所以统一按未登录渲染；
 * hydration 完成后再切到真实登录态。这样服务端与客户端首帧的 HTML 完全一致，
 * 不会触发 React 的 hydration 不匹配警告。
 */
export function useCurrentUser(): PublicUser | null {
  return useSyncExternalStore(subscribe, getCurrentUser, () => null)
}

/**
 * 登录态是否已经确定下来。
 *
 * useCurrentUser 的服务端快照恒为 null（见上面注释），所以 hydration 的首帧
 * 一定拿到「未登录」。凡是「没登录就弹登录框 / 跳转」的页面都不能直接信这一帧，
 * 否则已登录用户打开 /me、/login 会先被弹一次登录框再被弹回去。
 * 这个标记在 hydrateAuth() 跑完（或确定不需要跑）之后才为 true。
 */
let authReady = !apiEnabled()
const readyListeners = new Set<() => void>()

function setAuthReady() {
  if (authReady) return
  authReady = true
  for (const l of readyListeners) l()
}

export function useAuthReady(): boolean {
  return useSyncExternalStore(
    (l) => {
      readyListeners.add(l)
      return () => readyListeners.delete(l)
    },
    () => authReady,
    () => false,
  )
}

/** 开机时用已存的 token 换取用户信息（API 模式）。 */
export async function hydrateAuth(): Promise<void> {
  if (!apiEnabled()) {
    setAuthReady()
    return
  }
  if (!getToken()) {
    setCurrentUser(null)
    setAuthReady()
    return
  }
  try {
    const u = await api.get<PublicUser>('/api/auth/me')
    setCurrentUser(u)
  } catch {
    setToken(null)
    setCurrentUser(null)
  } finally {
    setAuthReady()
  }
}

/* ---------------- 注册 / 登录 / 退出 ---------------- */

export interface RegisterInput {
  email: string
  nickname: string
  password: string
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function register({ email, nickname, password }: RegisterInput): Promise<PublicUser> {
  const e = email.trim().toLowerCase()
  const n = nickname.trim()

  if (apiEnabled()) {
    const r = await api.post<{ token: string; user: PublicUser }>('/api/auth/register', { email: e, nickname: n, password })
    setToken(r.token)
    setCurrentUser(r.user)
    return r.user
  }

  if (!EMAIL_RE.test(e)) throw new Error(getT().errors.emailInvalid)
  if (n.length < 2 || n.length > 16) throw new Error(getT().errors.nicknameLength)
  if (password.length < 6) throw new Error(getT().errors.passwordShort)
  if (usersStore.load().some((u) => u.email === e)) throw new Error(getT().errors.emailTaken)

  const salt = makeSalt()
  const user: User = {
    id: randomId('u'),
    email: e,
    nickname: n,
    avatar: '🕹️',
    passwordHash: await sha256Hex(salt + password),
    salt,
    coins: WELCOME_COINS,
    role: 'user',
    status: 'active',
    createdAt: new Date().toISOString().slice(0, 10),
    favorites: [],
    recent: [],
  }
  usersStore.upsert(user)
  writeSessionId(user.id)
  return toPublic(user)
}

export async function login(email: string, password: string): Promise<PublicUser> {
  const e = email.trim().toLowerCase()

  if (apiEnabled()) {
    const r = await api.post<{ token: string; user: PublicUser }>('/api/auth/login', { email: e, password })
    setToken(r.token)
    setCurrentUser(r.user)
    return r.user
  }

  const user = usersStore.load().find((u) => u.email === e)
  if (!user) throw new Error(getT().errors.badCredentials)
  const hash = await sha256Hex(user.salt + password)
  if (hash !== user.passwordHash) throw new Error(getT().errors.badCredentials)
  if (user.status === 'banned') throw new Error(getT().errors.banned)
  writeSessionId(user.id)
  return toPublic(user)
}

export function logout() {
  if (apiEnabled()) {
    setToken(null)
    setCurrentUser(null)
  } else {
    writeSessionId(null)
  }
}

/* ---------------- 邮箱验证码 / 第三方登录 ---------------- */

const EMAIL_CODES_KEY = '8bitgo.emailcodes'
const CODE_TTL_MS = 10 * 60_000 // 验证码有效期 10 分钟
export const CODE_COOLDOWN = 60 // 再次发送冷却秒数

interface PendingCode {
  email: string
  code: string
  expires: number
}

function readPendingCodes(): PendingCode[] {
  try {
    const raw = localStorage.getItem(EMAIL_CODES_KEY)
    const list = raw ? (JSON.parse(raw) as PendingCode[]) : []
    return Array.isArray(list) ? list.filter((c) => c && c.expires > Date.now()) : []
  } catch {
    return []
  }
}

function writePendingCodes(list: PendingCode[]) {
  try {
    localStorage.setItem(EMAIL_CODES_KEY, JSON.stringify(list))
  } catch {
    /* ignore */
  }
}

function genCode(): string {
  const n = new Uint32Array(1)
  crypto.getRandomValues(n)
  return String(100000 + (n[0] % 900000))
}

function nicknameFromEmail(email: string): string {
  const base = email.split('@')[0].replace(/[^\w.-]/g, '').slice(0, 16)
  return base.length >= 2 ? base : getT().errors.defaultNickname
}

/** 找到或创建一个「无密码」用户（邮箱验证码 / 第三方登录用），并登录。 */
function loginOrCreateLocal(email: string, nickname: string, avatar: string): PublicUser {
  let user = usersStore.load().find((u) => u.email === email)
  if (!user) {
    user = {
      id: randomId('u'),
      email,
      nickname,
      avatar,
      passwordHash: '',
      salt: '',
      coins: WELCOME_COINS,
      role: 'user',
      status: 'active',
      createdAt: new Date().toISOString().slice(0, 10),
      favorites: [],
      recent: [],
    }
    usersStore.upsert(user)
  }
  if (user.status === 'banned') throw new Error(getT().errors.banned)
  writeSessionId(user.id)
  return toPublic(user)
}

export interface RequestCodeResult {
  /** 冷却秒数，倒计时用 */
  cooldown: number
  /** 本地演示模式下直接把验证码回传给界面显示（没有真实邮件服务器时）。API 模式为 undefined。 */
  devCode?: string
}

/** 请求邮箱验证码。API 模式请后端发邮件；本地模式生成验证码并回传显示。 */
export async function requestEmailCode(email: string): Promise<RequestCodeResult> {
  const e = email.trim().toLowerCase()
  if (!EMAIL_RE.test(e)) throw new Error(getT().errors.emailInvalid)

  if (apiEnabled()) {
    // 冷却秒数以服务端为准：两边各存一份常量的话，改了一边就会出现
    // 「按钮已经可以点了，服务端还在 429」这种对不上的情况
    const r = (await api.post('/api/auth/email/request-code', { email: e })) as { cooldown?: number } | null
    return { cooldown: Number(r?.cooldown) > 0 ? Number(r?.cooldown) : CODE_COOLDOWN }
  }

  const code = genCode()
  const list = readPendingCodes().filter((c) => c.email !== e)
  list.push({ email: e, code, expires: Date.now() + CODE_TTL_MS })
  writePendingCodes(list)
  return { cooldown: CODE_COOLDOWN, devCode: code }
}

/** 用邮箱 + 验证码登录（不存在则自动注册）。 */
export async function loginWithEmailCode(email: string, code: string): Promise<PublicUser> {
  const e = email.trim().toLowerCase()
  const c = code.trim()
  if (!/^\d{6}$/.test(c)) throw new Error(getT().errors.codeFormat)

  if (apiEnabled()) {
    const r = await api.post<{ token: string; user: PublicUser }>('/api/auth/email/verify', { email: e, code: c })
    setToken(r.token)
    setCurrentUser(r.user)
    return r.user
  }

  const list = readPendingCodes()
  const rec = list.find((x) => x.email === e)
  if (!rec) throw new Error(getT().errors.codeMissing)
  if (Date.now() > rec.expires) throw new Error(getT().errors.codeExpired)
  if (rec.code !== c) throw new Error(getT().errors.codeWrong)
  writePendingCodes(list.filter((x) => x.email !== e))
  return loginOrCreateLocal(e, nicknameFromEmail(e), '🕹️')
}

/* -------- Google 登录 -------- */

interface GoogleIdApi {
  accounts?: {
    id?: {
      initialize: (o: { client_id: string; callback: (r: { credential?: string }) => void }) => void
      prompt: () => void
    }
  }
}

let gisLoader: Promise<void> | null = null
function loadGis(): Promise<void> {
  if (gisLoader) return gisLoader
  gisLoader = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.defer = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error(getT().errors.googleLoadFailed))
    document.head.appendChild(s)
  })
  return gisLoader
}

async function getGoogleCredential(clientId: string): Promise<string> {
  await loadGis()
  const g = (window as unknown as { google?: GoogleIdApi }).google
  const id = g?.accounts?.id
  if (!id) throw new Error(getT().errors.googleUnavailable)
  return new Promise<string>((resolve, reject) => {
    id.initialize({
      client_id: clientId,
      callback: (r) => (r.credential ? resolve(r.credential) : reject(new Error(getT().errors.googleCancelled))),
    })
    id.prompt()
  })
}

/** 使用 Google 账号登录。 */
export async function loginWithGoogle(): Promise<PublicUser> {
  const clientId = (import.meta.env as Record<string, string | undefined>).VITE_GOOGLE_CLIENT_ID

  if (apiEnabled()) {
    if (!clientId) throw new Error(getT().errors.googleNotConfigured)
    const credential = await getGoogleCredential(clientId)
    const r = await api.post<{ token: string; user: PublicUser }>('/api/auth/google', { credential })
    setToken(r.token)
    setCurrentUser(r.user)
    return r.user
  }

  // 本地演示：创建 / 登录一个演示 Google 账户，便于在无后端时体验流程
  return loginOrCreateLocal('google.player@8bitgo.local', getT().errors.googleNickname, '🎮')
}

/* -------- Microsoft / Apple 登录（OIDC 授权码） -------- */

/**
 * 和 Google 那条完全不同：Google 是弹层里拿到 ID token 再 POST 上去，
 * 这两家走的是**整页跳转 + 服务端回调**：
 *
 *   startOAuthLogin() → 整页跳到 /api/auth/oauth/<provider>/start（后端 302 到对方）
 *   → 用户同意 → 对方回调后端 → 后端签好本站 JWT，302 回 /auth/callback#token=…
 *   → completeOAuthLogin() 收下令牌
 *
 * 为什么不做成弹窗：Apple 在带 name/email 的 scope 下强制 form_post，回调是 POST，
 * 前端根本收不到；而且移动端和微信内置浏览器对弹窗的支持一向不可靠。
 */

export type OAuthProvider = 'microsoft' | 'apple'

/** cst：本浏览器发起这次登录的凭据。跟着 state 走一圈回来，由这边比对 */
const OAUTH_STATE_KEY = '8bitgo.oauth.cst'
/** 授权前停在哪一页（含语言前缀）。登完送回去，而不是一律扔回首页 */
const OAUTH_RETURN_KEY = '8bitgo.oauth.return'

function randomState(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function readOnce(key: string): string {
  try {
    const v = sessionStorage.getItem(key) ?? ''
    sessionStorage.removeItem(key)
    return v
  } catch {
    return ''
  }
}

/** 本地演示模式（没配后端）下用的假账号 */
const DEMO: Record<OAuthProvider, { email: string; avatar: string }> = {
  microsoft: { email: 'microsoft.player@8bitgo.local', avatar: '🪟' },
  apple: { email: 'apple.player@8bitgo.local', avatar: '🍎' },
}

/**
 * 发起登录。顺利的话这个函数**不会返回** —— 页面已经跳走了。
 * 调用方不要在它后面接「登录成功」的收尾逻辑，那段只有在跳转前就出错时才跑得到。
 */
export function startOAuthLogin(provider: OAuthProvider, returnTo?: string): void {
  if (!apiEnabled()) {
    // 没有后端可换 token，直接建 / 登一个演示账号，便于走通界面流程
    const d = DEMO[provider]
    loginOrCreateLocal(d.email, provider === 'apple' ? getT().errors.appleNickname : getT().errors.microsoftNickname, d.avatar)
    return
  }
  const cst = randomState()
  try {
    sessionStorage.setItem(OAUTH_STATE_KEY, cst)
    sessionStorage.setItem(OAUTH_RETURN_KEY, returnTo || window.location.pathname + window.location.search)
  } catch {
    /* 无痕模式下写不进去。回调页会发现自己没存过 cst，按「无法校验」处理 */
  }
  // 用整页跳转而不是 fetch：/start 的响应是一个 302，要让浏览器自己跟过去
  window.location.assign(`${apiBase()}/api/auth/oauth/${provider}/start?cst=${encodeURIComponent(cst)}`)
}

/** 回调页调用：收下 # 里带回来的令牌，换出当前用户。 */
export async function completeOAuthLogin(token: string, cst: string): Promise<PublicUser> {
  const expected = readOnce(OAUTH_STATE_KEY)
  /**
   * 存过就必须对得上 —— 这是「这次登录确实是本浏览器发起的」唯一证据，
   * 少了它，别人可以把自己的登录结果塞给你（登录 CSRF）。
   * 没存过（无痕模式）只能放行，否则那批人永远登不进来。
   */
  if (expected && expected !== cst) throw new Error(getT().errors.oauthStateMismatch)
  if (!token) throw new Error(getT().errors.oauthNoToken)
  setToken(token)
  try {
    const user = await api.get<PublicUser>('/api/auth/me')
    setCurrentUser(user)
    return user
  } catch (e) {
    // 令牌换不出用户就别把它留在本地：留着的话下次开机会顶着一个坏令牌，处处 401
    setToken(null)
    throw e
  }
}

/** 取出授权前停留的页面，取完即清。没有就回首页。 */
export function takeOAuthReturnTo(): string {
  const to = readOnce(OAUTH_RETURN_KEY)
  // 只认站内的绝对路径：`//evil.com` 会被浏览器当成协议相对 URL 跳出站外
  return to.startsWith('/') && !to.startsWith('//') ? to : '/'
}

/* ---------------- 当前用户的操作 ---------------- */

function requireLocalUser(): User {
  const id = readSessionId()
  const user = id ? usersStore.find(id) : undefined
  if (!user) throw new Error(getT().errors.needLogin)
  return user
}

export async function updateProfile(patch: { nickname?: string; avatar?: string }): Promise<void> {
  if (apiEnabled()) {
    const u = await api.patch<PublicUser>('/api/me', patch)
    setCurrentUser(u)
    return
  }
  const user = requireLocalUser()
  const nickname = patch.nickname?.trim()
  if (nickname !== undefined && (nickname.length < 2 || nickname.length > 16)) throw new Error(getT().errors.nicknameLength)
  usersStore.update(user.id, {
    ...(nickname !== undefined ? { nickname } : {}),
    ...(patch.avatar ? { avatar: patch.avatar } : {}),
  })
}

export async function toggleFavorite(slug: string): Promise<boolean> {
  if (apiEnabled()) {
    const r = await api.post<{ favorited: boolean; favorites: string[] }>(`/api/me/favorites/${encodeURIComponent(slug)}`)
    if (apiUser) setCurrentUser({ ...apiUser, favorites: r.favorites })
    return r.favorited
  }
  const user = requireLocalUser()
  const has = user.favorites.includes(slug)
  usersStore.update(user.id, {
    favorites: has ? user.favorites.filter((s) => s !== slug) : [slug, ...user.favorites],
  })
  return !has
}

/**
 * 记录最近玩过。
 *
 * 登录了就记到账号上（后端 users.recent，换设备也能看到）；没登录不再丢掉，
 * 改记在这台浏览器里（services/recents.ts），侧边栏「曾经玩过」两种都读。
 */
export async function recordRecent(slug: string): Promise<void> {
  if (apiEnabled()) {
    if (!getToken()) return pushGuestRecent(slug)
    try {
      const r = await api.post<{ recent: string[] }>(`/api/me/recents/${encodeURIComponent(slug)}`)
      if (apiUser) setCurrentUser({ ...apiUser, recent: r.recent })
    } catch {
      /* 静默 */
    }
    return
  }
  const id = readSessionId()
  const user = id ? usersStore.find(id) : undefined
  if (!user) return pushGuestRecent(slug)
  const recent = [slug, ...user.recent.filter((s) => s !== slug)].slice(0, 12)
  if (recent.join() === user.recent.join()) return
  usersStore.update(user.id, { recent })
}

/* ---------------- 账号与安全 ---------------- */

/**
 * 换绑邮箱 / 改密码 / 退出所有设备之后，服务端会给一张**新令牌**——
 * 因为这三个动作都会把 users.token_version +1，手里那张旧的当场作废。
 * 忘了存新令牌的话，用户下一次请求就会被自己的操作踢下线。
 */
function acceptSession(r: { token: string; user: PublicUser }) {
  setToken(r.token)
  setCurrentUser(r.user)
}

/** 换绑邮箱第一步：往**新**邮箱发验证码（收得到才说明那个邮箱真是他的） */
export async function requestEmailChangeCode(email: string): Promise<RequestCodeResult> {
  const e = email.trim().toLowerCase()
  if (!EMAIL_RE.test(e)) throw new Error(getT().errors.emailInvalid)
  const me = getCurrentUser()
  if (me && e === me.email.toLowerCase()) throw new Error(getT().account.sameEmail)

  if (apiEnabled()) {
    const r = (await api.post('/api/me/email/request-code', { email: e })) as { cooldown?: number } | null
    return { cooldown: Number(r?.cooldown) > 0 ? Number(r?.cooldown) : CODE_COOLDOWN }
  }

  // 本地演示模式：没有邮件服务器，验证码直接回给界面显示
  if (usersStore.load().some((u) => u.email === e)) throw new Error(getT().errors.emailTaken)
  const code = genCode()
  const list = readPendingCodes().filter((c) => c.email !== e)
  list.push({ email: e, code, expires: Date.now() + CODE_TTL_MS })
  writePendingCodes(list)
  return { cooldown: CODE_COOLDOWN, devCode: code }
}

/** 换绑邮箱第二步：验码并落库。会把其它设备踢下线，当前设备换新令牌。 */
export async function changeEmail(email: string, code: string): Promise<PublicUser> {
  const e = email.trim().toLowerCase()
  const c = code.trim()
  if (!/^\d{6}$/.test(c)) throw new Error(getT().errors.codeFormat)

  if (apiEnabled()) {
    const r = await api.post<{ token: string; user: PublicUser }>('/api/me/email', { email: e, code: c })
    acceptSession(r)
    return r.user
  }

  const user = requireLocalUser()
  const list = readPendingCodes()
  const rec = list.find((x) => x.email === e)
  if (!rec) throw new Error(getT().errors.codeMissing)
  if (Date.now() > rec.expires) throw new Error(getT().errors.codeExpired)
  if (rec.code !== c) throw new Error(getT().errors.codeWrong)
  if (usersStore.load().some((u) => u.email === e && u.id !== user.id)) throw new Error(getT().errors.emailTaken)
  writePendingCodes(list.filter((x) => x.email !== e))
  usersStore.update(user.id, { email: e })
  return toPublic(usersStore.find(user.id) as User)
}

/**
 * 设置 / 修改登录密码。
 * 已经有密码的必须报出旧密码 —— 只凭一张令牌就能改密码的话，
 * 一台没锁屏的电脑就足够让别人把账号彻底接管过去。
 */
export async function setPassword(password: string, currentPassword?: string): Promise<void> {
  if (password.length < 6) throw new Error(getT().errors.passwordShort)

  if (apiEnabled()) {
    const r = await api.put<{ token: string; user: PublicUser }>('/api/me/password', {
      password,
      ...(currentPassword ? { currentPassword } : {}),
    })
    acceptSession(r)
    return
  }

  const user = requireLocalUser()
  if (user.passwordHash) {
    if (!currentPassword) throw new Error(getT().account.needCurrentPassword)
    const salt = user.salt || ''
    if ((await sha256Hex(salt + currentPassword)) !== user.passwordHash) {
      throw new Error(getT().account.wrongCurrentPassword)
    }
  }
  const salt = makeSalt()
  usersStore.update(user.id, { salt, passwordHash: await sha256Hex(salt + password) })
}

/**
 * 退出所有设备。
 * JWT 是无状态的，签出去就收不回来，所以服务端是把令牌版本号 +1 让旧的当场作废；
 * 当前设备立刻拿一张新的，不用重新登录。
 */
export async function logoutAllDevices(): Promise<void> {
  if (apiEnabled()) {
    acceptSession(await api.post<{ token: string; user: PublicUser }>('/api/me/logout-all'))
    return
  }
  // 本地模式只有这一个「设备」，退出当前会话就是全部
  writeSessionId(null)
}

/** 注销第一步：往当前邮箱发一封确认码 */
export async function requestDeleteCode(): Promise<RequestCodeResult> {
  if (apiEnabled()) {
    const r = (await api.post('/api/me/delete/request-code')) as { cooldown?: number } | null
    return { cooldown: Number(r?.cooldown) > 0 ? Number(r?.cooldown) : CODE_COOLDOWN }
  }
  const user = requireLocalUser()
  const code = genCode()
  const list = readPendingCodes().filter((c) => c.email !== user.email)
  list.push({ email: user.email, code, expires: Date.now() + CODE_TTL_MS })
  writePendingCodes(list)
  return { cooldown: CODE_COOLDOWN, devCode: code }
}

/**
 * 注销第二步：验码并删号，不可逆。
 * 收藏 / 最近 / 云存档挂在用户行的外键上（ON DELETE CASCADE），由数据库一并清掉。
 */
export async function deleteMyAccount(code: string): Promise<void> {
  const c = code.trim()
  if (!/^\d{6}$/.test(c)) throw new Error(getT().errors.codeFormat)

  if (apiEnabled()) {
    await api.del('/api/me', false, { code: c })
    setToken(null)
    setCurrentUser(null)
    return
  }

  const user = requireLocalUser()
  const list = readPendingCodes()
  const rec = list.find((x) => x.email === user.email)
  if (!rec) throw new Error(getT().errors.codeMissing)
  if (Date.now() > rec.expires) throw new Error(getT().errors.codeExpired)
  if (rec.code !== c) throw new Error(getT().errors.codeWrong)
  writePendingCodes(list.filter((x) => x.email !== user.email))
  usersStore.remove(user.id)
  writeSessionId(null)
}

/* ---------------- 游玩统计 ---------------- */

export interface MeStats {
  /** 加入至今的天数（含今天，最小 1） */
  days: number
  favorites: number
  recent: number
  /** null = 这个库还没有 saves 表，界面据此整块隐藏云存档，而不是显示「0 份」 */
  saves: { count: number; bytes: number } | null
  /** 最近游玩里出现最多的平台 id；没有记录时为 null */
  topPlatform: string | null
  lastPlayedAt: number | null
}

/** 个人中心顶部那几张小卡片的数据。拿不到就返回 null，界面退回只显示已知的几项。 */
export async function fetchMyStats(): Promise<MeStats | null> {
  const me = getCurrentUser()
  if (!me) return null

  if (apiEnabled()) {
    try {
      return await api.get<MeStats>('/api/me/stats')
    } catch {
      // 统计只是装饰，取不到不该让整页报错
      return null
    }
  }

  const day = 86_400_000
  const joined = Date.parse(`${me.createdAt}T00:00:00Z`)
  return {
    days: Number.isFinite(joined) ? Math.max(1, Math.floor((Date.now() - joined) / day) + 1) : 1,
    favorites: me.favorites.length,
    recent: me.recent.length,
    saves: null,
    topPlatform: null,
    lastPlayedAt: null,
  }
}

/* ---------------- 后台用户管理 ---------------- */

// API 模式下的用户列表缓存
let apiUsers: PublicUser[] = []
const usersListeners = new Set<() => void>()
function notifyUsers() {
  for (const l of usersListeners) l()
}

export async function hydrateUsers(): Promise<void> {
  if (!apiEnabled()) return
  try {
    // 必须带 admin 标记：GET /api/users 是管理员接口，
    // 只用「后台口令」登录后台时（还没建管理员账号的新部署就是这种情况）
    // 不带的话拿到 403，下面又被 catch 吞掉，后台会显示成「一个用户都没有」
    const list = await api.get<PublicUser[]>('/api/users', true)
    if (Array.isArray(list)) apiUsers = list
  } catch {
    // 拉取失败就保留上一次的结果 —— 清成空列表会让人以为用户被删光了
  }
  notifyUsers()
}

/**
 * 调整 G 币。**后台已经不再调它了** —— G 币功能整体没上线（FEATURES.coins = false），
 * 用户管理页那一列和那个按钮已经撤掉。
 *
 * 接口和这个函数都留着：服务端的 coinsDelta 一直在，users.coins 那一列也还在，
 * 哪天真要开 G 币，前端这条线是现成的。删掉它并不会让谁更安全，只会让重新开的时候
 * 再写一遍。
 */
export async function adminAdjustCoins(id: string, delta: number) {
  if (apiEnabled()) {
    await api.patch(`/api/users/${encodeURIComponent(id)}`, { coinsDelta: delta }, true)
    await hydrateUsers()
    return
  }
  usersStore.update(id, (u) => ({ ...u, coins: Math.max(0, u.coins + delta) }))
}

/**
 * 改角色（管理员 / 志愿者 / 玩家）。
 *
 * 服务端还压着三道护栏：要有 users:role 权限、不能给自己降级、
 * 不能把最后一个可用的管理员降下去。这里不重复实现 ——
 * 前端拦一遍只是省一次往返，真判断在 server/src/routes/users.js。
 */
export async function adminSetRole(id: string, role: UserRole) {
  if (apiEnabled()) {
    await api.patch(`/api/users/${encodeURIComponent(id)}`, { role }, true)
    await hydrateUsers()
    return
  }
  usersStore.update(id, { role })
}

export async function adminSetStatus(id: string, status: UserStatus) {
  if (apiEnabled()) {
    await api.patch(`/api/users/${encodeURIComponent(id)}`, { status }, true)
    await hydrateUsers()
    return
  }
  usersStore.update(id, { status })
  if (status === 'banned' && readSessionId() === id) writeSessionId(null)
}

export async function adminDeleteUser(id: string) {
  if (apiEnabled()) {
    await api.del(`/api/users/${encodeURIComponent(id)}`, true)
    await hydrateUsers()
    return
  }
  usersStore.remove(id)
  if (readSessionId() === id) writeSessionId(null)
}

export function useAllUsers(): PublicUser[] {
  const local = usersStore.useAll()
  const remote = useSyncExternalStore(
    (l) => {
      usersListeners.add(l)
      return () => usersListeners.delete(l)
    },
    () => apiUsers,
    () => apiUsers,
  )
  useEffect(() => {
    if (apiEnabled()) void hydrateUsers()
  }, [])
  return apiEnabled() ? remote : local.map(toPublic)
}
