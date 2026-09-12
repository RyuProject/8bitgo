import 'dotenv/config'
import express from 'express'
import { createServer } from 'node:http'
import cors from 'cors'
import { ping } from './db.js'
import { ssrAvailable, renderPage, CLIENT_DIR } from './ssr.js'
import { normalizeUrl } from './url-normalize.js'
import { playShell } from './routes/play.js'
import { j2meJarProxy, uploadGate, uploadJar, releaseJar, keepaliveJar, startSweeper, MAX_BYTES, TTL_MS } from './j2me.js'
import { ADMIN_AUTH_DISABLED, adminBackdoorFatal } from './auth.js'
import { CACHE, noStore, staticCacheHeaders } from './cache.js'
import { authRouter } from './routes/auth.js'
import { gamesRouter } from './routes/games.js'
import { postsRouter } from './routes/posts.js'
import { commentsRouter } from './routes/comments.js'
import { ratingsRouter } from './routes/ratings.js'
import { collectionsRouter } from './routes/collections.js'
import { meRouter } from './routes/me.js'
import { usersRouter } from './routes/users.js'
import { adminRouter } from './routes/admin.js'
import { roomsRouter } from './routes/rooms.js'
import { pageRouter } from './routes/page.js'
import { platformBiosRouter } from './routes/platform-bios.js'
import { developersRouter } from './routes/developers.js'
import { friendLinksRouter } from './routes/friend-links.js'
import { IN, friendLinkHostMap, hostOf, normalizeHost, recordFriendLinkHit } from './friend-link-hits.js'
import { isCrawlerUa } from './sseGuard.js'
import { checkSchema } from './schema-check.js'
import { savesRouter } from './routes/saves.js'
import { attachNetplay } from './netplay.js'
import { attachLive, liveRoom, liveRooms, subscribeLiveRooms } from './live.js'
import { admitSse } from './sseGuard.js'
import { iceRouter, registerTurnProbeTargets } from './routes/ice.js'
import { startTurnHealth } from './turnProbe.js'
import { imRouter } from './routes/im.js'
import { openRouter } from './routes/open.js'
import { openErrorMiddleware } from './open/errors.js'
import { publicSiteUrl } from './site-urls.js'
import { openAppsRouter } from './routes/open-apps.js'
import { openDeviceRouter } from './routes/open-device.js'
import { oauthRouter } from './routes/oauth.js'
import { adminOpenAppsRouter } from './routes/admin-open-apps.js'
import { diagRouter } from './routes/diag.js'
import { submitGameRouter } from './routes/submit-game.js'
import { mailProvider, submitMailProvider } from './mail.js'
import { gameSitemap, postSitemap, sitemapIndex, taxonomySitemap } from './routes/sitemaps.js'
import { logSearchPushStatus } from './search-push.js'

const app = express()
app.disable('x-powered-by')

/**
 * 反代信任设置 —— 决定 req.ip 拿到的是真实访客还是 nginx。
 *
 * 默认 'loopback'：只有当直连过来的是 127.0.0.1（也就是同机的 nginx）时才采信
 * X-Forwarded-For。这条默认值是安全的 —— 万一哪天这个进程被直接暴露到公网，
 * 对端不是 loopback，伪造的 X-Forwarded-For 会被忽略，不会把限流骗过去。
 *
 * ⚠️ Cloudflare 在 nginx 前面时，nginx 那边要把真实 IP 透传下来：
 *      proxy_set_header X-Forwarded-For $http_cf_connecting_ip;
 *    只写 $remote_addr 的话这里拿到的是 Cloudflare 边缘节点的地址，
 *    按 IP 限流会退化成「全 Cloudflare 共用一个额度」。
 */
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback')

// CORS：ALLOWED_ORIGINS 为逗号分隔白名单，或 * 放行全部
// ⚠️ 必须注册在 express.json 之前。body 解析失败时会直接 next(err)，跳过后面所有
// 普通中间件 —— cors 排在后面的话，413 / 400 这类响应就没有跨域头，
// 浏览器只报一句 CORS 错误，前端根本读不到「文件过大」这种真正的原因。
const origins = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean)
app.use(
  cors({
    origin: origins.includes('*') ? true : origins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    /**
     * 跨域时浏览器默认只把七个「安全」响应头交给 JS，自定义头一律读不到 ——
     * res.headers.get('x-save-updated-at') 会返回 null，而且不报任何错。
     *
     * 前端拿这个头判断云存档是什么时候的（services/saves.ts 的 pullSave）。
     * 少了它，VITE_API_URL 填绝对地址（前后端分域）的部署里，云存档的时间
     * 永远退回成「刚刚」。same-origin 部署碰不到，所以很容易一直没人发现。
     */
    exposedHeaders: ['x-save-updated-at'],
  }),
)

app.use(express.json({ limit: '4mb' }))

// /api 默认一律不缓存。公开只读接口（games / posts）会自己覆盖成短缓存 ——
// 默认安全：漏配只是少一层缓存，配反了就可能把某个用户的数据缓存给下一个人。
app.use('/api', noStore)

// 健康检查
app.get('/api/health', async (_req, res) => {
  try {
    const ok = await ping()
    res.json({ service: '8bitgo-api', db: ok })
  } catch (e) {
    res.status(500).json({ service: '8bitgo-api', db: false, error: String(e.message || e) })
  }
})

/*
  开放平台。**挂在最前面**是有意的：它有自己的一套 CORS（放开到任意 Origin）、
  自己的一套令牌（RS256，与站内互不相认）、自己的错误体（OAuth 风格）。
  和站内路由混在一起最容易出的事就是顺手复用了某个中间件 —— 见 routes/open.js 的文件头。
*/
app.use('/api/open', openRouter)

/*
  开发者控制台与后台审核。**这两条是站内接口**（登录态 + 站内 CORS 白名单），
  和上面那个 /api/open 不是一套 —— 挂到 openRouter 下面会顺带把「管理应用、轮换密钥」
  也放开到任意 Origin，那等于任何网站都能拿着受害者的登录态替他建应用。
  ⚠️ admin-open-apps 必须挂在 /api/admin 之前：adminRouter 里有 /:id 这类通配路由。
*/
app.use('/api/open-apps', openAppsRouter)
/*
  设备码流程里「用户确认」那一步。**站内接口**，和上面那条同一个性质：
  要登录态、走站内 CORS 白名单。放开到任意 Origin 的话，任何网站都能拿着
  受害者的登录态替他批准一台设备 —— 那是这套流程最坏的失败方式。
*/
app.use('/api/open-device', openDeviceRouter)
/*
  用户级令牌那一半：授权码 + PKCE（OIDC 授权码流程）。设备码那一半在 routes/open.js 的
  /api/open/v1/token 里。两者共用同一套 RS256 令牌与 scope，但入口分开、安全模型不同。
*/
app.use('/api/oauth', oauthRouter)
app.use('/api/admin/open-apps', adminOpenAppsRouter)

app.use('/api/auth', authRouter)
app.use('/api/games', gamesRouter)
app.use('/api/posts', postsRouter)
// 游戏评论：读公开、发表必须登录、后台可隐藏（见 routes/comments.js）
app.use('/api/comments', commentsRouter)
// 游戏评分：1~5 星，登录 1.0 / 匿名 0.5 权重（见 routes/ratings.js）
app.use('/api/ratings', ratingsRouter)
app.use('/api/collections', collectionsRouter)
app.use('/api/me', meRouter)
app.use('/api/users', usersRouter)
app.use('/api/admin', adminRouter)
app.use('/api/rooms', roomsRouter)
// 按路由取数：SSR 与客户端共用同一份定义（见 routes/page.js）
app.use('/api/page', pageRouter)
app.use('/api/platform-bios', platformBiosRouter)
app.use('/api/developers', developersRouter)
// 首页「特别鸣谢」的后台管理；公开列表跟着 /api/page 的首页数据返回
app.use('/api/friend-links', friendLinksRouter)
// 云存档（必须登录，见 routes/saves.js）
app.use('/api/saves', savesRouter)
// P2P 联机的 ICE / TURN 配置（短期凭证，见 routes/ice.js）
app.use('/api/netplay/ice', iceRouter)
// 站内消息的 IM 凭证（短期 UserSig，密钥不出服务器，见 routes/im.js）
app.use('/api/im', imRouter)
// 自查：房间卡片的国旗 / 网络格子为什么是 ❓（见 routes/diag.js）
app.use('/api/diag', diagRouter)
// 用户提交游戏：登录后上传 ROM（multipart），ROM 作为邮件附件发出，不落存储
app.use('/api/submit-game', submitGameRouter)

// 游戏 sitemap 直接读数据库。放在静态资源之前，后台刚上架的游戏不必等下次构建才出现。
app.get('/sitemaps/games-:language.xml', gameSitemap)
// 文章同理：后台随时能发文，之前它们只在构建时烘进 sitemap-static.xml，
// 不重新部署就永远进不了 sitemap。
app.get('/sitemaps/posts-:language.xml', postSitemap)
// 平台页 / 类型页：「哪些平台和类型有游戏」同样只有数据库知道。烘在构建期的后果
// 已经真实发生过 —— 线上 sitemap 长期只剩 flash 和 html5 两个平台页、类型页一条没有。
app.get('/sitemaps/taxonomy-:language.xml', taxonomySitemap)
/**
 * sitemap 索引同样接管掉，覆盖构建产物里的 public/sitemap.xml。
 * 那份静态文件里游戏 sitemap 的 lastmod 停在构建当天，之后上架多少游戏都不变，
 * 搜索引擎据此认为子 sitemap 没动过，就不会回来重抓（见 routes/sitemaps.js 的注释）。
 * 纯静态托管（只有 CDN、没有这个后端）时仍然由那份文件兜底。
 */
app.get('/sitemap.xml', sitemapIndex)

// 正在直播的房间列表。?game=<slug> 只看某个游戏的
app.get('/api/live/rooms', (req, res) => {
  res.json(liveRooms({ gameSlug: typeof req.query.game === 'string' ? req.query.game : undefined }))
})
app.get('/api/live/rooms/:roomId', (req, res) => {
  const room = liveRoom(req.params.roomId)
  if (!room) return res.status(404).json({ error: 'room not found' })
  res.json(room)
})

/**
 * 直播列表的事件流（SSE）。取代大厅那个 8 秒一次的轮询。
 *
 * 侧边栏挂在每个页面上，轮询等于每个在线访客都在持续打请求，而列表绝大多数时候没变。
 * 和 netplay 的 /api/netplay/events 是同一套做法（那边更早改的）。
 * 用 SSE 不用 WebSocket：单向推送够用，浏览器自带断线重连，也不用再引依赖。
 */
app.get('/api/live/events', (req, res) => {
  // 准入闸：爬虫直接拒、per-IP 与总量上限、最长存活时间。响应头也由它写。
  // 没有这道闸时爬虫会把这条流挂满源站，见 sseGuard.js 顶部那段病史。
  if (!admitSse(req, res)) return

  const unsubscribe = subscribeLiveRooms(res)
  const beat = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {
      clearInterval(beat)
      unsubscribe()
    }
  }, 25_000)
  beat.unref?.()

  req.on('close', () => {
    clearInterval(beat)
    unsubscribe()
  })
})

/* ---------------- J2ME 临时上传 ---------------- */
// 请求体就是 jar 原始字节，用 express.raw 收，省掉 multipart 依赖。
// 上限在这里也卡一道，避免超大请求先被完整读进内存再拒绝。
/*
  ⚠️ uploadGate **必须排在 express.raw 之前**。

  express.raw 一跑完，20MB 就已经整个进内存了 —— 被拒的请求和被放行的一样要先吃掉它。
  限流原来写在 uploadJar 的开头（注释还写着「挡掉的请求不该再花任何 CPU 或磁盘」），
  但在中间件顺序下那句话不成立。拆出来挂前面，429 才是在读 body 之前发出去的。
*/
app.post('/api/j2me/upload', uploadGate, express.raw({ type: '*/*', limit: MAX_BYTES }), uploadJar)
// 页面关闭时由 navigator.sendBeacon 调用，只能是 POST。
app.post('/api/j2me/release', express.text({ type: '*/*', limit: '1kb' }), releaseJar)
// 还在玩的时候续期，避免长时间游戏中途文件被清扫
app.post('/api/j2me/keepalive', express.text({ type: '*/*', limit: '1kb' }), keepaliveJar)
// 前端据此决定心跳间隔
app.get('/api/j2me/config', (_req, res) => res.json({ ttlMs: TTL_MS }))

/* ---------------- 前端：静态资源 + 服务端渲染 ---------------- */

if (ssrAvailable()) {
  // ⚠️ 必须在 express.static 之前 —— 见 url-normalize.js 里 /index.html 那一段
  app.use(normalizeUrl)

  // 带哈希的构建产物可以长期缓存；index.html 不能缓存（每次都要走 SSR）
  app.use(
    express.static(CLIENT_DIR, {
      index: false,
      // 带哈希的产物永久缓存；字体、模拟器内核、图片各有各的时长，
      // 具体规则见 cache.js
      setHeaders: staticCacheHeaders,
    }),
  )

  // J2ME：本地 public/j2me/jar/ 里没有的 .jar，转发到对象存储。
  // 必须注册在 express.static 之后 —— Express 按注册顺序匹配，
  // 放前面会让代理抢先，本地文件永远取不到。
  app.get('/j2me/jar/:name', j2meJarProxy)

  /**
   * 跨源隔离的整页游玩外壳。必须注册在 SSR 兜底之前 —— 那条 catch-all 吃掉除 /api 外
   * 的所有 GET。没登记的 slug 会 next() 下去由 SSR 渲染 404，见 routes/play.js。
   */
  app.get('/play/:slug', playShell)
  app.get('/:lang/play/:slug', playShell)

  // 构建产物找不到就老实回 404。交给下面的 SSR 会返回一段 HTML，
  // 浏览器按 module 加载时只会报一句含糊的 MIME 错误，白屏还查不出原因。
  app.get(/^\/assets\//, (_req, res) => res.status(404).set('Cache-Control', CACHE.none).type('text/plain').send('Not Found'))

  /**
   * 入站友链统计：有人从友链对方的站点点进来了。
   *
   * 挂在 SSR 兜底**之前**，因为到这一步静态资源已经被 express.static 吃掉了，
   * 剩下的才是真正的页面请求。
   *
   * ⚠️ **先 next() 再统计**，顺序不能反：这是首屏渲染的必经之路，
   * 一次写库（哪怕 5ms）也不该挂在用户等首字节的那条线上。所以这里不 await 就放行，
   * 统计在后面自己慢慢做完，失败了也只是少一条数据。
   *
   * ⚠️ 站内跳转要排除：站内每一次前进都会带上自己的域名当 Referer，
   * 不排除的话，只要有一条友链填的是自己的域名（或者哪天做了多域名），数字会离谱地虚高。
   */
  app.get(/^(?!\/api\/).*/, (req, _res, next) => {
    next()
    void (async () => {
      try {
        const ref = req.headers?.referer || req.headers?.referrer
        if (!ref) return
        // 爬虫会带着上一跳的地址挨个抓，算进来的话热门友链全是蜘蛛
        if (isCrawlerUa(req.headers?.['user-agent'])) return
        const host = hostOf(ref)
        if (!host || host === normalizeHost(req.hostname)) return
        const id = (await friendLinkHostMap()).get(host)
        if (!id) return
        await recordFriendLinkHit(id, IN, req)
      } catch {
        /* 统计失败不该惊动任何人 */
      }
    })()
  })

  // 除 /api 外的所有 GET 都交给 SSR（/admin 也走，但它本身是 noindex 的后台）
  app.get(/^(?!\/api\/).*/, renderPage)

  console.log('[ssr] 已启用服务端渲染')
} else {
  console.log('[ssr] 未找到 dist/client 或 dist/server —— 只提供 API。先在项目根目录跑 npm run build')
}

// 兜底错误处理
/**
 * 开放平台的错误体是 OAuth 形状（RFC 6749 §5.2），**和站内不是一套**。
 *
 * 路由里那些错误走 routes/open.js 的 fail()，形状一直是对的；
 * 但**请求体解析失败的到不了路由** —— express.json 挂在全局（上面几十行），
 * 畸形 JSON 在进 openRouter 之前就 next(err) 了。不单独接一下的话，
 * 第三方拿到的是下面那句站内风格的「请求格式不正确」，而它的 OAuth 库只认
 * error 码，只会报一句「无法解析的响应」—— 真正的原因一个字都没传达到。
 *
 * ⚠️ **必须排在下面那个站内错误处理之前**：站内那个会把 413 先截走。
 * 不是开放平台的请求它原样 next(err) 放行，对站内没有任何影响。
 */
app.use(openErrorMiddleware(publicSiteUrl))

app.use((err, _req, res, _next) => {
  // body-parser 的超限错误要回 413，不然前端只看到一个含糊的 500
  if (err?.type === 'entity.too.large' || err?.status === 413) {
    return res.status(413).json({ error: '文件过大' })
  }
  // multer 单文件超限：ROM 上传走 multipart，超限是常见错误，给明确提示
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: '文件过大：单个 ROM 不能超过 25MB' })
  }
  // JSON 解析失败等客户端错误，body-parser 给的是 4xx，别一律降级成 500
  const status = Number(err?.status || err?.statusCode || 0)
  if (status >= 400 && status < 500) {
    return res.status(status).json({ error: err?.expose ? String(err.message) : '请求格式不正确' })
  }
  /**
   * 「列不存在」几乎只有一个原因：代码更新了、库没跑迁移。
   * 这种错如果也吞成「服务器内部错误」，表现就是后台点保存毫无反应，
   * 排查方向会被带到前端去 —— 所以单独挑出来，直接告诉人该跑什么。
   * 这里只回列名不回表结构，泄露面和普通报错一致。
   */
  if (err?.code === 'ER_BAD_FIELD_ERROR') {
    console.error('[api error] 表结构落后于代码：', err.sqlMessage || err.message)
    return res.status(500).json({
      error: '数据库结构落后于代码（缺列），请在 server 目录执行 npm run migrate 后重试',
    })
  }
  // 完整信息只进服务器日志。以前直接把 err.message 回给客户端，
  // 数据库报错会连表名、列名、索引名（uniq_email 之类）一起泄露出去。
  console.error('[api error]', err)
  res.status(500).json({ error: '服务器内部错误' })
})

/**
 * 最后一道保险。代码里该 try/catch 的地方都补了，但只要漏一处，
 * Node 22 默认就会把未处理的 rejection 当未捕获异常，直接结束进程 ——
 * 对一个同时扛着 API 和 SSR 的进程来说，那就是整站 502。
 * 这里只记录不退出；真正的问题去日志里看。
 */
process.on('unhandledRejection', (reason) => {
  console.error('[未处理的 Promise 异常]', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[未捕获异常]', err)
})

/*
  ⚠️ 后台鉴权后门 + 非本机站点地址 = **拒绝启动**。

  roleOfRequest 的第一行就是 `if (ADMIN_AUTH_DISABLED) return 'admin'`，在读 token 之前 ——
  这个组合意味着一条不带凭证的请求就能提权和删库。
  原来这里只打一段警告，而警告拦不住任何事：2026-09-12 审计时，它正开在一份
  PUBLIC_SITE_URL 指向正式域名、DB 连着生产库的 .env 里。

  判断在 auth.js 的 adminBackdoorFatal（纯函数，有测试）。这里只负责把进程停掉，
  而且要停在 **listen 之前** —— 端口一旦开了，后门就已经对外可达了。
*/
const backdoorFatal = adminBackdoorFatal()
if (backdoorFatal) {
  console.error('')
  console.error('  ❌ 拒绝启动：' + backdoorFatal)
  console.error('')
  process.exit(1)
}

const PORT = Number(process.env.PORT || 8788)

// P2P 联机信令：画面不经过服务器，这里只转发 WebRTC 握手（见 src/netplay.js）
const httpServer = createServer(app)
const io = attachNetplay(httpServer, app, origins)
// 直播（一人玩多人看）。和 netplay 共用同一个 socket.io 服务，但走各自的命名空间。
// 画面同样不经过服务器，这里只转发 WebRTC 握手（见 src/live.js）
attachLive(io)
startSweeper()

/**
 * DOS 联机（js-dos 的 IPX 中继，见 src/ipx.js）。
 *
 * 默认跟主站共用端口，路径 /ipx/<房间> —— 前提是 public/jsdos 里的 js-dos.js
 * 打过补丁（scripts/copy-jsdos.mjs 复制时自动打，去掉写死的 1900 端口）。
 * 这样 IPX 走的就是 443，橙云代理、现成证书都能直接用。
 *
 * 如果你用的是没打补丁的原版 js-dos，把 IPX_PORT 设成 1900，会退回独立端口模式
 * —— 那种情况下 Cloudflare 代理不了这个端口，见 README。
 */
if (/^(1|true|yes|on)$/i.test(process.env.IPX_ENABLED || '')) {
  try {
    const { attachIpx, attachIpxToServer } = await import('./ipx.js')
    if (process.env.IPX_PORT) attachIpx({ port: Number(process.env.IPX_PORT), host: process.env.IPX_PUBLIC_HOST || '127.0.0.1' })
    else attachIpxToServer(httpServer, { publicHost: process.env.IPX_PUBLIC_HOST || 'ipx' })
  } catch (e) {
    console.warn(`[ipx] DOS 联机中继未启用：${e.message}`)
  }
}

httpServer.listen(PORT, () => {
  console.log(`8BitGo API 已启动：http://127.0.0.1:${PORT}`)
  // 表结构落后于代码时，读接口一切正常、写接口全 500，症状极具误导性。
  // 启动时对一遍，把话说在前面
  void checkSchema()
  console.log('P2P 联机信令已就绪：/netplay（socket.io）')
  /**
   * TURN 主动探活。
   *
   * 「自建挂了自动换 CF」这件事在浏览器那侧本来就是自动的（所有 ICE 服务器一起下发），
   * 但**没人会知道它发生了** —— turnSources 照报两路齐全，CF 从兜底变成扛 100% 流量，
   * 只有账单上看得出来。这个循环拿即将下发的凭证真的走一遍 Allocate，
   * 探到死的那路就不再下发，并在 /api/netplay/ice 和 /api/diag 里写明原因。
   *
   * 只在这里显式起（不接在请求路径上，也不在 import 时自启）——
   * 测试直接 import 路由时不会顺带对着假地址发出探测包。TURN_PROBE=off 可关。
   */
  void registerTurnProbeTargets()
    .then(() => startTurnHealth())
    .catch((e) => console.warn('[turn] 探活没起来（不影响下发）：', e?.message || e))
  logSearchPushStatus()
  /**
   * 发信通路配错时会静默退回「只打印日志」，症状是「用户说收不到验证码」
   * 而服务器一切正常 —— 最难查的那类故障。所以启动时把结论直接说出来。
   */
  const from = process.env.MAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER || '(未设置 MAIL_FROM)'
  const MAIL_LABEL = {
    resend: `[mail] 验证码走 Resend，发件 ${from}`,
    cloudflare: `[mail] 验证码走 Cloudflare Email Service，发件 ${from}`,
    smtp: `[mail] 验证码走 SMTP：${process.env.SMTP_HOST}，发件 ${from}`,
  }
  console.log(MAIL_LABEL[mailProvider()] || '[mail] ⚠️  未配置发信通道，验证码只会打印到日志（正式环境请配 RESEND_API_KEY + MAIL_FROM）')
  /**
   * 「提交游戏」那封信可以走另一条通路（SUBMIT_MAIL_PROVIDER）。同样要在启动时说出来 ——
   * 不说的话，「我明明配了 SMTP」和「信还是从 Resend 发出去的」这两件事永远对不上号，
   * 而且只有在附件超过 Resend 上限、整封发不出去的时候才会暴露。
   */
  try {
    const sp = submitMailProvider()
    const to = process.env.SUBMIT_GAME_TO_EMAIL || ''
    const toLabel = to ? to : `${from}（⚠️ 未设 SUBMIT_GAME_TO_EMAIL，退回用发件地址，多半收不到）`
    if (sp === 'none') {
      console.log('[mail] 玩家提交游戏：未配置发信通道，只会打印到日志')
    } else if (sp === 'cloudflare') {
      console.warn(`[mail] ⚠️  玩家提交游戏走 Cloudflare Email Service —— 这条通路不支持附件，带 ROM 文件的提交会被拒。请配 SMTP 并设 SUBMIT_MAIL_PROVIDER=smtp`)
    } else {
      console.log(`[mail] 玩家提交游戏走 ${sp === 'smtp' ? `SMTP：${process.env.SMTP_HOST}` : 'Resend'}，收件 ${toLabel}`)
    }
  } catch (e) {
    console.error(`[mail] ⚠️  SUBMIT_MAIL_PROVIDER 配置有误，提交游戏会失败：${e.message}`)
  }
  if (ADMIN_AUTH_DISABLED) {
    console.warn('')
    console.warn('  ****************************************************************')
    console.warn('  *  ⚠️  警告：后台鉴权已关闭（ADMIN_AUTH_DISABLED=1）              *')
    console.warn('  *  任何人都可以增删改你的游戏 / 文章 / 用户数据。                 *')
    console.warn('  *  这只能用于本机开发，上线前务必在 .env 中删除该项或设为 0。      *')
    console.warn('  ****************************************************************')
    console.warn('')
  }
})
