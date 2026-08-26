import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { queryOne } from './db.js'

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me'
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''

/**
 * ⚠️ 开发用后门：.env 里 ADMIN_AUTH_DISABLED=1 时，后台写操作（增删改游戏 / 文章 / 用户）不再校验身份。
 * 只在本机开发时开启。线上一定要删掉这行配置或设为 0，否则任何人都能删光你的数据。
 */
export const ADMIN_AUTH_DISABLED = /^(1|true|yes|on)$/i.test(process.env.ADMIN_AUTH_DISABLED || '')

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 10)
}
export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash)
}

export function signToken(userId) {
  return jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: '30d' })
}
export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET)
  } catch {
    return null
  }
}

function bearer(req) {
  const h = req.headers.authorization || ''
  return h.startsWith('Bearer ') ? h.slice(7).trim() : ''
}

/** 已登录用户（JWT）。失败返回 401。req.user = 用户行 */
export async function requireUser(req, res, next) {
  const token = bearer(req)
  const payload = token && verifyToken(token)
  if (!payload?.uid) return res.status(401).json({ error: '请先登录' })
  const user = await queryOne('SELECT * FROM users WHERE id = ?', [payload.uid])
  if (!user) return res.status(401).json({ error: '登录已失效' })
  if (user.status === 'banned') return res.status(403).json({ error: '账号已被封禁' })
  req.user = user
  next()
}

/** 可选登录：有 token 就解析，没有也放行（req.user 可能为空） */
export async function optionalUser(req, _res, next) {
  const token = bearer(req)
  const payload = token && verifyToken(token)
  if (payload?.uid) req.user = await queryOne('SELECT * FROM users WHERE id = ?', [payload.uid])
  next()
}

/**
 * 后台写操作鉴权：
 *   - 请求头带 Authorization: Bearer <ADMIN_TOKEN>（与 .env 一致），或
 *   - 登录用户的 role = 'admin'
 */
export async function requireAdmin(req, res, next) {
  // 开发后门：见文件顶部 ADMIN_AUTH_DISABLED 说明
  if (ADMIN_AUTH_DISABLED) return next()

  const token = bearer(req)
  if (ADMIN_TOKEN && token === ADMIN_TOKEN) return next()
  const payload = token && verifyToken(token)
  if (payload?.uid) {
    const user = await queryOne('SELECT * FROM users WHERE id = ?', [payload.uid])
    if (user?.role === 'admin' && user.status !== 'banned') {
      req.user = user
      return next()
    }
  }
  return res.status(403).json({ error: '需要管理员权限（后台口令或管理员账号）' })
}
