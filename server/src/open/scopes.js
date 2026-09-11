/**
 * 开放平台的 scope 表与判定。**纯函数、零依赖**，可以在 node 里直接跑。
 *
 * 单独一个文件的理由：scope 是这套接口唯一的权限边界，它必须能被测试真的跑一遍，
 * 而不是散在路由里靠 grep 源码确认。
 */

/**
 * 全部 scope。`app` 表示应用级（client_credentials 就能拿），`user` 表示必须有用户授权。
 *
 * ⚠️ `games.rom` 单独一条、且默认**不批**：
 * 它是唯一一个能把游戏本体带出站的权限，和「读元数据」的风险量级完全不同。
 * 合在 `games.read` 里的话，任何一个申请了「我要展示游戏列表」的应用
 * 会顺带拿到整库 ROM 的下载权 —— 那不是授权，那是疏忽。
 */
export const OPEN_SCOPES = Object.freeze({
  openid: { kind: 'user', desc: '签发 id_token（登录的最小集）' },
  profile: { kind: 'user', desc: '昵称、头像、注册时间' },
  email: { kind: 'user', desc: '邮箱与是否已验证' },
  'games.read': { kind: 'app', desc: '游戏元数据、封面、嵌入地址' },
  'games.rom': { kind: 'app', desc: 'ROM 短期下载凭据', sensitive: true },
  'library.read': { kind: 'user', desc: '收藏与最近在玩' },
  'library.write': { kind: 'user', desc: '写收藏与最近在玩' },
  'saves.read': { kind: 'user', desc: '列出、下载云存档' },
  'saves.write': { kind: 'user', desc: '上传、覆盖、删除云存档', sensitive: true },
})

/** 需要人工审核才能批的（自助创建时拿不到） */
export const SENSITIVE_SCOPES = Object.freeze(
  Object.keys(OPEN_SCOPES).filter((s) => OPEN_SCOPES[s].sensitive),
)

/** 应用级 token（client_credentials）最多能拿哪些 —— 用户级 scope 一个都不能混进来 */
export const APP_SCOPES = Object.freeze(Object.keys(OPEN_SCOPES).filter((s) => OPEN_SCOPES[s].kind === 'app'))

export function isKnownScope(s) {
  return Object.prototype.hasOwnProperty.call(OPEN_SCOPES, String(s ?? ''))
}

/**
 * 把 scope 串解析成去重后的数组。空白分隔（OAuth 的规定），顺序按 OPEN_SCOPES 稳定输出。
 * 不认识的 scope **保留**在 unknown 里交给调用方决定怎么报错 —— 静默丢掉的话，
 * 接入方会以为自己申请到了。
 */
export function parseScopes(raw) {
  const list = String(raw ?? '').split(/[\s+]+/).filter(Boolean)
  const known = []
  const unknown = []
  for (const s of list) {
    if (!isKnownScope(s)) {
      if (!unknown.includes(s)) unknown.push(s)
    } else if (!known.includes(s)) known.push(s)
  }
  const order = Object.keys(OPEN_SCOPES)
  known.sort((a, b) => order.indexOf(a) - order.indexOf(b))
  return { scopes: known, unknown }
}

export function formatScopes(scopes) {
  return (Array.isArray(scopes) ? scopes : []).join(' ')
}

/**
 * 请求的 scope 是否全在已获批列表里。
 *
 * ⚠️ 返回的是「差集」而不是布尔：调用方要在错误里说清**差哪个**。
 * 而且**绝不做静默降级**（只发能给的那部分）—— 那会让接入方以为自己拿到了权限，
 * 直到线上某个功能莫名其妙失效才发现，且查不出原因。
 */
export function missingScopes(requested, approved) {
  const has = new Set(Array.isArray(approved) ? approved : [])
  return (Array.isArray(requested) ? requested : []).filter((s) => !has.has(s))
}

/** 令牌里有没有这个 scope。接口自己声明需要哪个，别在中间件里写死一张表 */
export function hasScope(tokenScopes, want) {
  const list = Array.isArray(tokenScopes) ? tokenScopes : String(tokenScopes ?? '').split(/\s+/)
  return list.includes(want)
}
