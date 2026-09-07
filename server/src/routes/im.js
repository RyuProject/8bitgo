/**
 * 即时通信 IM 的凭证接口。`GET /api/im/sig`
 *
 * 这个文件的存在理由和 routes/ice.js 一模一样：**密钥不能进前端包**。
 * SDKAppID 必须给到浏览器（SDK 初始化要用），它不是机密；SecretKey 是主密钥 ——
 * 拿到它就能给这个 SDKAppID 下的任意 userID 签发 UserSig，也就是可以冒充任何用户。
 * 所以密钥只留在服务器，浏览器每次拿一份**只对自己有效、有到期时间**的 sig。
 *
 * ## 为什么必须 requireUser
 *
 * userID 一律取 `req.user.id`，**不接受请求参数**。这是本文件最要紧的一行：
 * 如果允许调用方指定 userID，那这个接口就等于把主密钥的能力原样开放出去了 ——
 * 任何人都能签一份别人的 sig，然后以对方身份登录 IM、读对方的会话。
 *
 * ## 没配的时候
 *
 * 回 501 而不是 500：前端据此让 openIm() 保持未注册状态，顶栏继续显示
 * 「即将上线」占位面板 —— 也就是没配置时行为和接入之前完全一样，不会出现
 * 一颗点了报错的按钮。501 的语义正是「这个功能服务端没实现/没启用」。
 */
import { Router } from 'express'
import { requireUser } from '../auth.js'
import { take } from '../rateLimit.js'
import { CACHE } from '../cache.js'
import { genUserSig, imConfigFrom, isValidImUserId } from '../im-sig.js'

export const imRouter = Router()
imRouter.use(requireUser)

/** 配置缺失只提醒一次，别让每次请求都往日志里刷一行 */
let warnedMissing = false

/**
 * 按账号限流。
 *
 * 这个接口每次调用都要过一次 requireUser（一条数据库查询）再算一遍 HMAC，
 * 一个登录用户按住刷新就能白耗后端。正常用量极低：登录后空闲时一次，
 * sig 过期（7 天）时一次，用户手点「重新连接」若干次 —— 每小时 30 次绰绰有余。
 *
 * 按 **userId** 而不是 IP：这个路由已经要求登录，用 IP 会让同一个校园网 / 公司网
 * 后面的所有人共享一个额度。
 */
const SIG_LIMIT = 30
const SIG_WINDOW_MS = 3600_000

imRouter.get('/sig', async (req, res, next) => {
  try {
    // ⚠️ take() 返回的是 { ok, retryAfter } 对象，不是布尔 ——
    // 写成 `if (!take(...))` 的话对象恒为真，限流会静默失效
    const gate = take(`im:sig:${req.user.id}`, SIG_LIMIT, SIG_WINDOW_MS)
    if (!gate.ok) {
      return res
        .status(429)
        .set('Retry-After', String(gate.retryAfter))
        .json({ error: '请求过于频繁，请稍后再试', retryAfter: gate.retryAfter })
    }
    const cfg = imConfigFrom()
    if (!cfg) {
      if (!warnedMissing) {
        warnedMissing = true
        console.warn('[im] 未配置 TENCENT_IM_SDK_APPID / TENCENT_IM_SECRET_KEY，站内消息保持关闭')
      }
      // 不回显任何配置内容 —— 连「哪个变量没配」都不说，那是服务端信息
      return res.status(501).json({ error: 'IM 未启用' })
    }

    const userId = String(req.user.id)
    if (!isValidImUserId(userId)) {
      // 宁可 500 也不签一份非法 sig：那样前端只会拿到一个看不懂的数字错误码，
      // 而这一行日志直接指出是哪个账号的 id 形状不对。
      console.error('[im] 账号 id 不符合腾讯 userID 规则，无法签发：', userId)
      return res.status(500).json({ error: 'IM 账号标识不合法' })
    }

    const { userSig, sdkAppId, expiresAt } = genUserSig({
      sdkAppId: cfg.sdkAppId,
      secretKey: cfg.secretKey,
      userId,
      expire: cfg.ttl,
    })

    /*
      昵称和头像**不在这里同步**。

      同步到腾讯需要用管理员账号调 REST 接口（v4/profile/portrait_set），那要再配一个
      管理员 userID、再签一份管理员 sig，而且每次改昵称都得记得调一次。
      前端登录成功后自己调 chat.updateMyProfile 就够了 —— 数据源头是同一个 /api/me，
      少一条会不同步的链路。这里只回签名和身份。
    */
    res
      .set('Cache-Control', CACHE.none)
      .json({ sdkAppId, userId, userSig, expiresAt })
  } catch (e) {
    // async 中间件抛出的 rejection Express 4 不会捕获，Node 22 会直接杀进程 ——
    // 见 server/src/auth.js 顶部那段。必须自己接住再交给错误处理器。
    next(e)
  }
})
