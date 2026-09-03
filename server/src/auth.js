import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { queryOne } from './db.js'
import { can, isRole } from '../../shared/roles.js'

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

/**
 * 签发登录令牌。
 *
 * payload 里的 tv = users.token_version。JWT 是**无状态**的，签出去之后服务端就管不着了 ——
 * 「退出所有设备」「改完密码把旧会话踢下线」都没法靠删 token 实现（我们手里没有那张列表）。
 * 所以在用户行上放一个版本号：想让所有旧令牌立刻失效，就把它 +1，
 * 下一次带旧 tv 的请求在 requireUser 里对不上，直接 401。
 *
 * 老令牌（这个字段还不存在的年代签的）没有 tv，下面按 0 处理 ——
 * 所以这次上线不会把所有人踢下线。
 */
export function signToken(userId, tokenVersion = 0) {
  return jwt.sign({ uid: userId, tv: Number(tokenVersion) || 0 }, JWT_SECRET, { expiresIn: '30d' })
}

/** 用户行 -> 当前令牌版本。列还没迁移出来时按 0 算，行为和以前一致 */
export function tokenVersionOf(userRow) {
  return Number(userRow?.token_version || 0)
}

/** 令牌里的版本号和用户行上的一致吗 */
function versionMatches(payload, userRow) {
  return (Number(payload?.tv) || 0) === tokenVersionOf(userRow)
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

/**
 * 已登录用户（JWT）。失败返回 401。req.user = 用户行
 *
 * ⚠️ 这三个中间件都是 async 且里面 await 数据库。Express 4 不会捕获 async 中间件抛出的
 * rejection，Node 22 又默认把未处理的 rejection 当未捕获异常处理 —— 数据库一抖
 * （重启、连接打满、网络闪断），一条带 token 的请求就能把整个进程带走，API 和 SSR 一起挂。
 * 所以必须自己 try/catch 后交给 Express 的错误处理器。
 */
export async function requireUser(req, res, next) {
  try {
    const token = bearer(req)
    const payload = token && verifyToken(token)
    if (!payload?.uid) return res.status(401).json({ error: '请先登录' })
    const user = await queryOne('SELECT * FROM users WHERE id = ?', [payload.uid])
    if (!user) return res.status(401).json({ error: '登录已失效' })
    // 「退出所有设备」/ 改密码之后，旧令牌的 tv 落后于用户行，到这里被挡掉
    if (!versionMatches(payload, user)) return res.status(401).json({ error: '登录已在别处退出，请重新登录' })
    if (user.status === 'banned') return res.status(403).json({ error: '账号已被封禁' })
    req.user = user
    next()
  } catch (e) {
    next(e)
  }
}

/** 可选登录：有 token 就解析，没有也放行（req.user 可能为空） */
export async function optionalUser(req, _res, next) {
  try {
    const token = bearer(req)
    const payload = token && verifyToken(token)
    if (payload?.uid) {
      const user = await queryOne('SELECT * FROM users WHERE id = ?', [payload.uid])
      // 版本对不上就当没登录 —— 可选登录的接口不该因为一个过期令牌而报错，
      // 但也绝不能把它当成有效身份
      if (user && versionMatches(payload, user)) req.user = user
    }
    next()
  } catch (e) {
    next(e)
  }
}

/**
 * 这次请求是以什么角色来的。
 *
 * 三种来源，返回的都是 shared/roles.js 里的角色名，认不出来就是 null：
 *   - 开发后门 ADMIN_AUTH_DISABLED（见文件顶部）    -> 'admin'
 *   - Authorization: Bearer <ADMIN_TOKEN>（与 .env 一致） -> 'admin'
 *   - 登录用户的 users.role                          -> 该用户的角色
 *
 * 被封禁的账号一律当作没登录 —— 封号之后手里那张令牌还没过期，
 * 不在这里拦住的话它还能接着写后台。
 *
 * ⚠️ 后台口令（ADMIN_TOKEN）这条路径没有 req.user：它不对应任何一个账号。
 * 「不能封禁自己」这类以 req.user 为准的护栏对它自然不适用，
 * 「不能封掉最后一个管理员」那种以数据库为准的护栏才拦得住它。
 */
export async function roleOfRequest(req) {
  if (ADMIN_AUTH_DISABLED) return 'admin'

  const token = bearer(req)
  if (ADMIN_TOKEN && token === ADMIN_TOKEN) return 'admin'
  const payload = token && verifyToken(token)
  if (payload?.uid) {
    const user = await queryOne('SELECT * FROM users WHERE id = ?', [payload.uid])
    if (user && versionMatches(payload, user) && user.status !== 'banned') {
      req.user = user
      return isRole(user.role) ? user.role : null
    }
  }
  return null
}

/**
 * 后台写操作鉴权：请求头带对了 ADMIN_TOKEN，或者登录用户的 role = 'admin'。
 *
 * 志愿者**不算**。要放志愿者进来的接口用 requireAbility(...)，
 * 明说它需要哪个权限点，而不是把这里放宽 —— 那样等于一次性把整个后台交出去。
 */
export async function isAdminRequest(req) {
  return (await roleOfRequest(req)) === 'admin'
}

export async function requireAdmin(req, res, next) {
  try {
    if (await isAdminRequest(req)) return next()
    return res.status(403).json({ error: '需要管理员权限（后台口令或管理员账号）' })
  } catch (e) {
    next(e)
  }
}

/**
 * 「这次请求有没有这个权限点」的直接问法。
 *
 * 给那些**不是拦路、而是分叉**的地方用：同一个接口，有权限的看得到草稿 / 已下架，
 * 没权限的看到 404。这类判断写成中间件反而绕。
 */
export async function hasAbility(req, ability) {
  return can(await roleOfRequest(req), ability)
}

/**
 * 按权限点鉴权：`router.put('/:slug', requireAbility('content:edit'), …)`。
 *
 * 谁有哪个权限点写在 shared/roles.js 的 ROLE_ABILITIES 里，前后端读的是同一份 ——
 * 后台隐藏按钮只是体面，真正说了算的是这里。
 */
export function requireAbility(ability) {
  return async (req, res, next) => {
    try {
      const role = await roleOfRequest(req)
      if (can(role, ability)) return next()
      // 401 和 403 在前端是两回事：AdminLayout 见到这两个码都会把后台重新锁上，
      // 所以这里统一给 403，并且把「缺哪一项」说清楚，免得排查时只看见一句「没权限」
      return res.status(403).json({ error: `权限不足：需要 ${ability}` })
    } catch (e) {
      next(e)
    }
  }
}
