import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { queryOne } from './db.js'
import { can, isRole } from '../../shared/roles.js'

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me'
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''

/**
 * ⚠️ 开发用后门：.env 里 ADMIN_AUTH_DISABLED=1 时，后台写操作（增删改游戏 / 文章 / 用户）不再校验身份。
 * 只在本机开发时开启。
 *
 * ## 为什么它现在会让进程**起不来**，而不只是打一行警告
 *
 * roleOfRequest 的第一行就是 `if (ADMIN_AUTH_DISABLED) return 'admin'` —— 在读 token
 * **之前**。也就是说这个开关一开，一条不带任何凭证的
 * `PATCH /api/users/<id> {"role":"admin"}` 就能提权，`DELETE /api/games/<slug>` 就能删库。
 *
 * 原来的保护只有启动时的一段警告。而这个仓库的 .env 是**连同注释一起带上服务器**的
 * （里面写着「部署到那台服务器上运行时，把 DB_PORT 改回 3306」）—— 靠人记得改掉
 * 其中一行，这件事已经失败过一次：2026-09-12 审计时发现它在一份 PUBLIC_SITE_URL
 * 指向正式域名、DB 连着生产库的 .env 里开着。
 *
 * 所以改成硬护栏：**只要站点地址不是本机，带着这个开关启动就直接退出**。
 * 误伤的代价是「本地用了个非 localhost 的域名调试，得多设一个环境变量」；
 * 漏掉的代价是整个数据库。
 */
export const ADMIN_AUTH_DISABLED = /^(1|true|yes|on)$/i.test(process.env.ADMIN_AUTH_DISABLED || '')

/**
 * 这个站点地址是不是「本机」。localhost / 127.x / ::1 / *.local / 私网地址都算。
 *
 * 纯函数，单独导出是为了能被测试真的跑一遍 —— 这道护栏要是自己判错了，
 * 要么线上起不来，要么后门照样能开，两种都很糟。
 */
export function isLocalSiteUrl(raw) {
  let host
  try {
    host = new URL(String(raw || '')).hostname.toLowerCase()
  } catch {
    // 地址本身就不合法：当成「不是本机」。宁可拦住启动，也不能猜成本机放行
    return false
  }
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true
  if (host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (/^127\./.test(host)) return true
  // 私网段：10.x / 192.168.x / 172.16-31.x
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true
  return false
}

/**
 * 后门开着、而站点地址不是本机 —— 这种组合绝不允许跑起来。
 *
 * @returns {string} 空串 = 可以启动；否则是要打印的那段话
 */
export function adminBackdoorFatal(env = process.env) {
  if (!ADMIN_AUTH_DISABLED) return ''
  const site = env.PUBLIC_SITE_URL || env.VITE_SITE_URL || ''
  if (isLocalSiteUrl(site)) return ''
  /*
    留一个逃生口：确实要在非本机域名上开着后门调试（比如内网测试机用了自定义域名）。
    名字写得很难被手滑打出来，而且它自己就是一句话的说明 ——
    有人在生产环境设了这个，那是明知故犯，不是漏配。
  */
  if (/^(1|true|yes|on)$/i.test(env.I_KNOW_ADMIN_AUTH_IS_DISABLED || '')) return ''
  return (
    `后台鉴权后门（ADMIN_AUTH_DISABLED）开着，而 PUBLIC_SITE_URL 是「${site || '未设置'}」——\n` +
    '     这不是本机地址，任何人都能不带凭证删光你的游戏 / 文章 / 用户。\n' +
    '     把 .env 里的 ADMIN_AUTH_DISABLED 删掉或设为 0 再启动。\n' +
    '     确实要在非本机域名上开着它调试：额外设 I_KNOW_ADMIN_AUTH_IS_DISABLED=1。'
  )
}

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
/**
 * 验站内登录令牌。
 *
 * ⚠️ 两道**白名单式**的收紧（2026-09-11 加，配合开放平台）：
 *
 * 1. `algorithms: ['HS256']` 写死。不写的话，「密钥是字符串就只认 HS」是 jsonwebtoken 的
 *    实现细节而不是它的承诺 —— 安全边界不该押在别人的实现细节上。
 * 2. **带 `aud` / `scope` / `cid` 的一律拒绝**。这三个字段只有开放平台的 access token 才有
 *    （见 server/src/open/tokens.js）。本仓库实测过：一个 HS256 签的、payload 里带 uid 的令牌，
 *    哪怕再多带 aud/scope，这里原来也会**原样接受并取出 uid** —— 也就是说，开放平台哪天
 *    图省事复用了 JWT_SECRET，一枚「只读昵称」的第三方令牌立刻等价于完整账号令牌。
 *    换算法换密钥本身已经挡住了，这一条是纵深防御：两边都做白名单，不写成「不是 A 就当 B」。
 */
export function verifyToken(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] })
    if (payload && typeof payload === 'object') {
      if (payload.aud !== undefined || payload.scope !== undefined || payload.cid !== undefined) return null
    }
    return payload
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
    const why = authFailure(req, await roleOfRequest(req))
    if (why) return res.status(403).json(why)
    return res.status(403).json({ error: '需要管理员权限（后台口令或管理员账号）' })
  } catch (e) {
    next(e)
  }
}

/**
 * 这次请求带的 Bearer **是什么东西**。用来把「你权限不够」和「你这张凭证根本没生效」分开。
 *
 * ⚠️ 这个区分不是为了好看。后台有两种入场方式：登录的管理员账号，和一个不对应任何账号的
 * 后台口令（ADMIN_TOKEN）。前端取值时**后台口令优先**（见 src/services/api.ts 的 authHeaders），
 * 于是一个填错 / 过期 / 服务端换过的后台口令，会把一个完全正常的管理员登录态**整个盖掉**：
 *   · `token === ADMIN_TOKEN` 不成立
 *   · 那串又不是 JWT，verifyToken 验不过
 *   · roleOfRequest 一路走到 return null
 *   · requireAbility 报「权限不足：需要 content:edit」
 * 排查的人于是去查角色、查 ROLE_ABILITIES、查数据库 —— 而真正的问题在口令上。
 * 界面陈述的事实必须成立，报错也是界面。
 *
 * 只读请求多半是公开的，所以症状还特别偏：后台看得见、一保存就没权限。
 */
export function bearerKind(req) {
  const token = bearer(req)
  if (!token) return 'none'
  if (ADMIN_TOKEN && token === ADMIN_TOKEN) return 'admin-token'
  if (verifyToken(token)) return 'session'
  // 带了东西，但既不是合法的站内令牌，也不等于后台口令
  return 'invalid'
}

/**
 * 鉴权失败时说**真正**的原因。返回 null 表示「确实是权限不够」，照常报权限点。
 *
 * code 是给前端用的机器可读标记：拿到 invalid_admin_token 就该把存着的那个口令清掉，
 * 否则它会继续盖住登录态，每一次写操作都失败（见 api.ts 里的重试）。
 */
function authFailure(req, role) {
  const kind = bearerKind(req)
  if (kind === 'invalid') {
    return { code: 'invalid_admin_token', error: '后台口令无效或已过期。清掉它就会改用你的登录身份。' }
  }
  if (kind === 'none') return { code: 'not_signed_in', error: '未登录' }
  // 令牌本身是合法 JWT，但 roleOfRequest 没认出角色 —— 账号被封、令牌被作废（改密码 / 退出所有设备）
  if (kind === 'session' && role === null) {
    return { code: 'session_expired', error: '登录已失效，请重新登录' }
  }
  return null
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
      const why = authFailure(req, role)
      if (why) return res.status(403).json(why)
      return res.status(403).json({ error: `权限不足：需要 ${ability}` })
    } catch (e) {
      next(e)
    }
  }
}
