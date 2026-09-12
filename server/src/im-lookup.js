/**
 * 「按邮箱找人」的纯逻辑。路由（routes/im.js）只负责限流、查库和把结果发出去，
 * 所有**判断**都在这里 —— 这样它能被真正地单元测试，而不是靠 grep 源码碰运气。
 *
 * ## 这个接口天生是一台「邮箱是否注册」的探针
 *
 * 它必须回答「这个邮箱在站里有没有账号」，而那正是撞库者想要的答案。
 * 这一点消不掉，只能把成本压到不值得利用：
 *
 *   1. **要登录**（imRouter.use(requireUser) 覆盖整个路由）。匿名脚本一条都探不到。
 *   2. **按账号限流**，比 /sig 紧得多（见下面两个常量）。
 *   3. **只认全等**。不做前缀、模糊、通配、不分页 —— 一次只能验证一个你**已经知道**的
 *      地址，而不能把库里的邮箱捞出来。SQL 里出现 LIKE 就等于把这条护栏拆了。
 *   4. **不存在和被封禁回同一个响应**（连字节都一样，见 lookupOutcome）。
 *      区分开的话，这个接口就顺带变成了「查某人是不是被封了」的公开查询。
 *   5. **只回三个字段**。角色、金币、注册时间、以及**把邮箱原样回显**，一个都不给 ——
 *      回显邮箱看着无害，但那等于确认了大小写/别名写法，是撞库者的免费校对器。
 *
 * ⚠️ 真要把探针彻底关掉，只有一条路：给 users 加一列「允许别人用邮箱找到我」，
 * 默认关，用户自己去设置里打开。那是产品决定，不是这一层能替它做的。
 */
import { isEmail } from '../../shared/email.js'

/** 窗口内允许查几次。正常人一天也找不了几个人；撞库要的是几千次 */
export const IM_LOOKUP_LIMIT = 20
export const IM_LOOKUP_WINDOW_MS = 3600_000

/** 和 routes/auth.js、routes/me.js 保持同一条：宽松到不误伤，严到挡住明显不是邮箱的串 */

/** users.email 是 VARCHAR(200)，比这更长的串在库里根本不可能存在 */
const EMAIL_MAX = 200

/**
 * 规范化并校验邮箱。**不合法一律返回空串**，调用方只需判空。
 *
 * 顺序是「先截断再校验」而不是反过来：先校验后截断的话，一个 300 字符的合法邮箱
 * 会被砍成 200 字符的另一个地址再拿去查库 —— 查的不是用户输的那个东西。
 * 现在超长直接判死。
 */
export function normalizeLookupEmail(raw) {
  const s = String(raw ?? '').trim().toLowerCase()
  // 这里比 isEmail 的 254 更紧：users.email 是 VARCHAR(200)，更长的串在库里不可能存在。
  // 两道都留着 —— isEmail 那道是防正则回溯的通用闸，这道是这张表自己的事实。
  if (s.length > EMAIL_MAX) return ''
  return isEmail(s) ? s : ''
}

/**
 * 查库结果 -> HTTP 响应。
 *
 * @param row     users 表的一行（只需要 id / nickname / avatar / status），查不到传 null
 * @param selfId  当前登录用户的 id
 * @param canChat 这个 id 能不能当腾讯 userID（注入 isValidImUserId，避免这里反向依赖签名模块）
 * @returns {{ status: number, body: object }}
 */
export function lookupOutcome(row, selfId, canChat = () => true) {
  /*
    自己排在最前面。**这不算泄露** —— 用户当然知道自己的邮箱有没有注册，
    而且不单独说一句的话，他会看到「没有这个用户」，然后开始怀疑自己的账号出了问题。
  */
  if (row && String(row.id) === String(selfId)) {
    return { status: 400, body: { error: '这是你自己的邮箱', code: 'self' } }
  }

  /*
    ⚠️ 查不到、和查到了但被封禁，返回**同一个对象**。

    写成两个分支（哪怕文案只差一个字、哪怕状态码相同）都会让这个接口变成
    「某某是不是被封了」的查询器 —— 封禁是审核信息，不该对任何普通用户开放。
    所以这里刻意共用一条 return，而不是两条长得一样的 return。
  */
  if (!row || row.status !== 'active') {
    return { status: 404, body: { error: '没有找到这个邮箱对应的用户', code: 'not_found' } }
  }

  /*
    id 形状不合腾讯 userID 规则（^[A-Za-z0-9_-]{1,32}$）时，会话根本建不起来。
    不能回 404 混过去：那会让用户以为是对方没注册，反复重输同一个邮箱。
    409 = 「这个人存在，但当前状态下办不到」。
  */
  if (!canChat(String(row.id))) {
    return { status: 409, body: { error: '这个账号暂时不能收发站内消息', code: 'unusable' } }
  }

  /*
    信息面到此为止：id、昵称、头像。
    别顺手把 row 展开（`...row`）—— 那会把邮箱、角色、金币、封禁状态一次性发到浏览器。
  */
  return {
    status: 200,
    body: {
      id: String(row.id),
      nickname: String(row.nickname ?? ''),
      // 和 mappers.js 的 userRowToPublic 同一个兜底，避免抽屉里出现一个空头像位
      avatar: String(row.avatar || '🕹️'),
    },
  }
}

/* ---------------- 按 id 批量取昵称 / 头像 ---------------- */

/**
 * 一次最多解析几个 id。会话列表通常十几条，50 够用，也够小到查询恒定廉价。
 */
export const MAX_PEER_IDS = 50

/**
 * 这个接口的额度要宽：会话列表每来一条新消息就会刷一次。
 * 前端有会话内缓存（只查没见过的 id），所以正常一次页面生命周期里只有一两次。
 */
export const IM_PEERS_LIMIT = 120
export const IM_PEERS_WINDOW_MS = 3600_000

/**
 * 规范化要解析的 id 列表：去重、剔掉形状不对的、截到上限。
 *
 * 形状用的是腾讯 userID 的规则（^[A-Za-z0-9_-]{1,32}$，见 im-sig.js）——
 * 能出现在会话列表里的 id 一定过得了这条，剔掉的都是伪造的。
 * **不抛异常**：一串里混进一个坏 id 不该让整次解析失败，
 * 那会让会话列表整体退回显示原始 id。
 */
export function normalizePeerIds(raw, isValid = () => true) {
  const list = Array.isArray(raw) ? raw : []
  const out = []
  const seen = new Set()
  for (const item of list) {
    const id = String(item ?? '').trim()
    if (!id || seen.has(id) || !isValid(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= MAX_PEER_IDS) break
  }
  return out
}

/**
 * users 行 -> 对外的 peer 形状。
 *
 * ⚠️ 和 lookupOutcome 的信息面**故意不一样**，这不是疏漏：
 *
 *   · lookupOutcome 回答的是「我能不能找这个人聊天」，所以被封禁的一律当查无此人 ——
 *     否则那个接口会顺带变成封禁状态查询器。
 *   · 这里回答的是「这条已经存在的会话，对面叫什么」。昵称和头像**本来就是公开的**
 *     （评论区每条都带着），而且调用方必须已经知道对方的 user id 才问得出来。
 *     把被封禁的人过滤掉不会保护任何东西，只会让界面上凭空出现一串原始 id。
 *
 * 所以这里不看 status。要改这条之前先想清楚上面两句。
 */
export function peerRowsToPublic(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    id: String(r.id),
    nickname: String(r.nickname ?? ''),
    // 和 mappers.js 的 userRowToPublic、lookupOutcome 同一个兜底
    avatar: String(r.avatar || '🕹️'),
  }))
}
