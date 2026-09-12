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
import { clientKey, isMeaningfulIp, take } from '../rateLimit.js'
import { CACHE } from '../cache.js'
import { genUserSig, imConfigFrom, isValidImUserId } from '../im-sig.js'
import { query, queryOne } from '../db.js'
import {
  IM_LOOKUP_GLOBAL_LIMIT,
  IM_LOOKUP_IP_LIMIT,
  IM_LOOKUP_LIMIT,
  IM_LOOKUP_WINDOW_MS,
  IM_PEERS_LIMIT,
  IM_PEERS_WINDOW_MS,
  lookupOutcome,
  normalizeLookupEmail,
  normalizePeerIds,
  peerRowsToPublic,
} from '../im-lookup.js'

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

/**
 * 按邮箱找人，用来主动发起一段会话。`POST /api/im/lookup`
 *
 * 判断全在 im-lookup.js 里（那份能被单元测试），这里只做三件事：
 * 配置检查、限流、查库。
 *
 * ## 为什么是 POST 而不是 GET
 *
 * 查询串会原样进 nginx 的 access log，也会跟着 Referer 漏给第三方。
 * 这里传的是**别人的邮箱** —— 把它写进一份按天轮转、还要备份的日志里没有必要。
 * POST 的 body 不进 access log，也不会被任何一层缓存命中（顺带避开 CDN）。
 *
 * ## 为什么没配 IM 时也要拦
 *
 * 没配 IM 时抽屉根本打不开，这个接口不会有正常调用方。既然如此就别让它开着 ——
 * 一个用不上的「邮箱是否注册」探针，是净负债。
 */
imRouter.post('/lookup', async (req, res, next) => {
  try {
    if (!imConfigFrom()) return res.status(501).json({ error: 'IM 未启用', code: 'disabled' })

    /*
      三道闸，缺一道这个探针的单价就被打下来了（2026-09-12 补的后两道）。

      按账号那道原本是唯一的一道 —— 而**账号在这个站上很便宜**：邮箱验证码即注册，
      Google / Apple 登录更便宜。攻击者在一台机器上持有 100 个账号并发跑，
      就是 2000 次/小时的「这个邮箱注册过没有」，而服务端**没有任何一条计数
      能把这些请求关联起来刹车**。站里别的敏感接口（验证码、评分、评论、投稿、ice）
      全都是两三个维度，只有 IM 这三个接口是单维度。

      ⚠️ take() 返回 { ok, retryAfter } 对象，写成 `if (!take(...))` 会恒真，限流静默失效。
      ⚠️ 拿不到真实 IP 时跳过按 IP 那道 —— 反代没透传时所有人塌缩成一个地址，
         按 IP 限会把真实用户全锁在门外（同 routes/auth.js）。
    */
    const gate = take(`im:lookup:${req.user.id}`, IM_LOOKUP_LIMIT, IM_LOOKUP_WINDOW_MS)
    if (!gate.ok) {
      return res
        .status(429)
        .set('Retry-After', String(gate.retryAfter))
        .json({ error: '查得太频繁了，稍后再试', code: 'rate_limited', retryAfter: gate.retryAfter })
    }
    const ip = clientKey(req)
    if (isMeaningfulIp(ip)) {
      const perIp = take(`im:lookup:ip:${ip}`, IM_LOOKUP_IP_LIMIT, IM_LOOKUP_WINDOW_MS)
      if (!perIp.ok) {
        return res
          .status(429)
          .set('Retry-After', String(perIp.retryAfter))
          .json({ error: '查得太频繁了，稍后再试', code: 'rate_limited', retryAfter: perIp.retryAfter })
      }
    }
    const global = take('im:lookup:global', IM_LOOKUP_GLOBAL_LIMIT, IM_LOOKUP_WINDOW_MS)
    if (!global.ok) {
      return res
        .status(429)
        .set('Retry-After', String(global.retryAfter))
        .json({ error: '查得太频繁了，稍后再试', code: 'rate_limited', retryAfter: global.retryAfter })
    }

    const email = normalizeLookupEmail(req.body?.email)
    if (!email) return res.status(400).json({ error: '邮箱格式不正确', code: 'bad_email' })

    /*
      只取要用的四列，不要 `SELECT *`。
      不是为了省那点带宽 —— 是为了让「密码哈希、令牌版本、出生日期跟着进内存、
      再被谁顺手 res.json(row) 出去」这件事在源头上不可能发生。

      ⚠️ 只能是 `=`。这里一旦出现 LIKE / 通配 / 前缀匹配，这个接口就从
      「验证一个你已知的地址」变成「把库里的邮箱捞出来」。
    */
    const row = await queryOne('SELECT id, nickname, avatar, status FROM users WHERE email = ?', [email])
    // selfId 只能取自 req.user.id —— 和 /sig 同一条铁律，绝不接受请求参数
    const out = lookupOutcome(row, String(req.user.id), isValidImUserId)
    res.status(out.status).set('Cache-Control', CACHE.none).json(out.body)
  } catch (e) {
    next(e)
  }
})

/**
 * 按 user id 批量取昵称 / 头像。`POST /api/im/peers`
 *
 * ## 为什么需要它 —— 腾讯的 profile 是缓存，不是真相
 *
 * 会话列表里的 `userProfile.nick` 来自腾讯，而那份数据只有在对方**自己连上 IM**、
 * 由他的浏览器调 `chat.updateMyProfile` 时才会写。于是三种情况下它必然是错的：
 *
 *   1. **对方从没打开过聊天** —— 那边是空的，界面上只能显示一串 user id；
 *   2. **对方改过昵称** —— 腾讯留着旧的，而且要等他**下一次连 IM** 才会更新。
 *      真实案例：一个 583476160@qq.com 注册的号，注册时昵称被 nicknameFromEmail()
 *      切成 `583476160`，那个值先被推给了腾讯；他后来改成 `LL`，
 *      对方的聊天窗标题却一直是 `583476160`。
 *   3. 头像同理。
 *
 * `users` 表才是权威源，而且随时是最新的。所以昵称一律从这里取，
 * 腾讯那份只当拿不到时的兜底。
 *
 * 不需要「我和这个人有没有会话」的校验：昵称和头像本来就是公开信息
 * （评论区每条都带着），而且调用方必须先知道对方的 user id 才问得出来 ——
 * 那串 id 是随机的，不像邮箱可以撞库。
 */
imRouter.post('/peers', async (req, res, next) => {
  try {
    if (!imConfigFrom()) return res.status(501).json({ error: 'IM 未启用', code: 'disabled' })

    // ⚠️ 同上面两处：take() 返回 { ok, retryAfter } 对象，别当布尔用
    const gate = take(`im:peers:${req.user.id}`, IM_PEERS_LIMIT, IM_PEERS_WINDOW_MS)
    if (!gate.ok) {
      return res
        .status(429)
        .set('Retry-After', String(gate.retryAfter))
        .json({ error: '请求过于频繁，请稍后再试', code: 'rate_limited', retryAfter: gate.retryAfter })
    }

    const ids = normalizePeerIds(req.body?.ids, isValidImUserId)
    // 空列表回空数组而不是 400：前端把「一条会话都没有」和「id 全被剔掉」
    // 当同一件事处理（都退回腾讯那份），没必要为此多一条错误路径
    if (!ids.length) return res.set('Cache-Control', CACHE.none).json({ peers: [] })

    /*
      占位符按仓库既有写法逐个铺开（见 games-repo.js 的 attachRelations）。
      ⚠️ 不能写成 `IN (?)` 指望 mysql2 展开数组 —— db.js 用的是 pool.query，
      而这类展开在 prepared statement 上并不成立，别在这里赌它。

      只取三列。理由和 /lookup 一样：不让密码哈希、邮箱、封禁状态有机会跟着进内存。
      **这里刻意不筛 status** —— 见 peerRowsToPublic 的注释。
    */
    const holes = ids.map(() => '?').join(',')
    const rows = await query(`SELECT id, nickname, avatar FROM users WHERE id IN (${holes})`, ids)

    // 查不到的 id 直接不出现在结果里，前端据此退回腾讯那份 —— 不回 null 占位，
    // 那会让调用方多写一条判空
    res.set('Cache-Control', CACHE.none).json({ peers: peerRowsToPublic(rows) })
  } catch (e) {
    next(e)
  }
})
