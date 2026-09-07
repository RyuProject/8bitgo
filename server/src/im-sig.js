/**
 * 腾讯云即时通信 IM 的 UserSig 签发。
 *
 * 单独一个文件、零 express 依赖，是为了能被 server/scripts/test-im-sig.mjs 直接 import
 * 跑单测 —— 签名算错的症状是前端 login 报一个纯数字错误码，从那个码几乎倒推不回来
 * 是哪一步错了，所以这一层必须有测试。
 *
 * ## 为什么自己实现，不装 tls-sig-api-v2
 *
 * 官方那个包一共就 zlib + crypto 两个内置模块，核心逻辑二十来行；而这个仓库里
 * routes/ice.js 已经在手写 HMAC 签 TURN 凭证了（同一类问题、同一个原语）。
 * 为二十行代码引一个第三方包，换来的是一个必须跟着升级的供应链依赖 —— 不值。
 * 下面的实现逐行对照官方 tencentyun/tls-sig-api-v2-node 的 TLSSigAPIv2.js 写的，
 * 三处**必须一字不差**的地方在注释里标了出来。
 *
 * ## 密钥
 *
 * SecretKey 是**主密钥**：拿到它就能给这个 SDKAppID 下的任意 userID 签发 UserSig，
 * 也就是可以冒充任何用户。所以：
 *   - 只放 server/.env（已在 .gitignore 里），永远不进 VITE_ 前缀的任何变量；
 *   - 不写日志、不进错误响应（下面的 error 只说「没配」，不回显值）；
 *   - SDKAppID 不是机密，它必须给到浏览器（SDK 初始化要用），走接口返回。
 */
import { createHmac } from 'node:crypto'
import { deflateSync } from 'node:zlib'

/**
 * 腾讯对 userID 的硬限制：**最长 32 字节，只允许大小写字母、数字、下划线、连词符**。
 *
 * 本站的 users.id 是 `u_` + 6 字节随机的十六进制 = 14 个字符，全落在这个字符集里，
 * 所以可以直接当 userID 用，不需要再映射一层（多一层映射就多一张表要维护，
 * 而且注销账号时会留下一条对不上的孤儿记录）。
 *
 * 但**必须校验**而不是假设：数据库里可能有历史手工插入的账号，
 * 而一个非法 userID 签出来的 sig 会在浏览器里换成一个看不懂的错误码。
 * 这里宁可 500 也不签 —— 服务器日志里一句「userID 不合法」比前端一个数字码好查一万倍。
 */
const USER_ID_RE = /^[A-Za-z0-9_-]{1,32}$/

export function isValidImUserId(userId) {
  return USER_ID_RE.test(String(userId ?? ''))
}

/**
 * 官方那套 base64 变体。**不是标准 base64url**：
 *   标准 base64url 是 + -> -、/ -> _、= 去掉
 *   腾讯这套是   + -> *、/ -> -、= -> _
 * 抄错一个字符，签名在服务端算得再对，腾讯那边也解不开。
 */
function tencentBase64Escape(b64) {
  return b64.replace(/\+/g, '*').replace(/\//g, '-').replace(/=/g, '_')
}

/**
 * 签发一份 UserSig。
 *
 * @param {object} o
 * @param {string|number} o.sdkAppId 控制台里的 SDKAppID
 * @param {string} o.secretKey 控制台里的密钥
 * @param {string} o.userId 用户标识，必须满足 USER_ID_RE
 * @param {number} o.expire **有效时长（秒）**，不是到期时间戳
 * @param {number} [o.now] 签发时刻（秒），只给测试用
 * @returns {{ userSig: string, sdkAppId: number, userId: string, issuedAt: number, expiresAt: number }}
 */
export function genUserSig({ sdkAppId, secretKey, userId, expire, now }) {
  if (!sdkAppId) throw new Error('缺少 SDKAppID')
  if (!secretKey) throw new Error('缺少 SecretKey')
  if (!isValidImUserId(userId)) throw new Error(`userID 不合法（只允许 A-Za-z0-9_- 且不超过 32 字节）：${userId}`)
  const appId = Number(sdkAppId)
  if (!Number.isInteger(appId) || appId <= 0) throw new Error(`SDKAppID 不是正整数：${sdkAppId}`)
  const ttl = Math.floor(Number(expire))
  if (!Number.isInteger(ttl) || ttl <= 0) throw new Error(`expire 不是正整数：${expire}`)

  const currTime = Math.floor(now ?? Date.now() / 1000)

  /*
    被签名的原文。**逐字对照官方实现**，四个要点：
      1. 字段顺序固定：identifier / sdkappid / time / expire
      2. 每一行末尾都有 \n，最后一行也有
      3. sdkappid 和 time / expire 都是十进制、无前导零
      4. 本站不用 userbuf（那是 TRTC 进房权限用的），所以不追加 TLS.userbuf 那一行 ——
         官方实现里那一行是 `if (null != base64UserBuf)` 才加的，加了就签不对
  */
  const contentToBeSigned =
    `TLS.identifier:${userId}\n` + `TLS.sdkappid:${appId}\n` + `TLS.time:${currTime}\n` + `TLS.expire:${ttl}\n`

  const sig = createHmac('sha256', secretKey).update(contentToBeSigned).digest('base64')

  /*
    ⚠️ 这个对象的**键名和值类型都不能改**：
    identifier 是字符串，sdkappid / time / expire 是**数字**（不是字符串），ver 是 '2.0'。
    腾讯服务端解开之后会拿这些字段重算一遍 HMAC 再比对 —— 把 sdkappid 写成字符串，
    JSON 里就多了一对引号，重算出来的原文和这里的 contentToBeSigned 不一致，验签失败。
  */
  const sigDoc = {
    'TLS.ver': '2.0',
    'TLS.identifier': String(userId),
    'TLS.sdkappid': appId,
    'TLS.time': currTime,
    'TLS.expire': ttl,
    'TLS.sig': sig,
  }

  const userSig = tencentBase64Escape(deflateSync(Buffer.from(JSON.stringify(sigDoc))).toString('base64'))

  return { userSig, sdkAppId: appId, userId: String(userId), issuedAt: currTime, expiresAt: currTime + ttl }
}

/** 默认有效时长。腾讯建议不短于 24 小时；给 7 天，前端到期前会自己换一份。 */
export const IM_SIG_TTL_DEFAULT = 7 * 24 * 3600
/** 上下限。太短会让前端反复换签，太长意味着一份泄露的 sig 长期可用。 */
export const IM_SIG_TTL_MIN = 3600
export const IM_SIG_TTL_MAX = 30 * 24 * 3600

/** 从 env 读出一份规整后的配置。没配 SDKAppID 或密钥时返回 null —— 调用方据此回 501。 */
export function imConfigFrom(env = process.env) {
  const sdkAppId = Number(String(env.TENCENT_IM_SDK_APPID || '').trim())
  const secretKey = String(env.TENCENT_IM_SECRET_KEY || '').trim()
  if (!Number.isInteger(sdkAppId) || sdkAppId <= 0 || !secretKey) return null
  const raw = Number(env.TENCENT_IM_SIG_TTL_SEC)
  const ttl = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : IM_SIG_TTL_DEFAULT
  return { sdkAppId, secretKey, ttl: Math.max(IM_SIG_TTL_MIN, Math.min(IM_SIG_TTL_MAX, ttl)) }
}
