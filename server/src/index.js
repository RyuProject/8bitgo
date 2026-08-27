import 'dotenv/config'
import express from 'express'
import { createServer } from 'node:http'
import cors from 'cors'
import { ping } from './db.js'
import { ssrAvailable, renderPage, CLIENT_DIR } from './ssr.js'
import { j2meJarProxy, uploadJar, releaseJar, keepaliveJar, startSweeper, MAX_BYTES, TTL_MS } from './j2me.js'
import { ADMIN_AUTH_DISABLED } from './auth.js'
import { CACHE, noStore, staticCacheHeaders } from './cache.js'
import { authRouter } from './routes/auth.js'
import { gamesRouter } from './routes/games.js'
import { postsRouter } from './routes/posts.js'
import { meRouter } from './routes/me.js'
import { usersRouter } from './routes/users.js'
import { adminRouter } from './routes/admin.js'
import { roomsRouter } from './routes/rooms.js'
import { pageRouter } from './routes/page.js'
import { platformBiosRouter } from './routes/platform-bios.js'
import { checkSchema } from './schema-check.js'
import { savesRouter } from './routes/saves.js'
import { attachNetplay } from './netplay.js'
import { attachLive, liveRoom, liveRooms } from './live.js'
import { iceRouter } from './routes/ice.js'

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

app.use('/api/auth', authRouter)
app.use('/api/games', gamesRouter)
app.use('/api/posts', postsRouter)
app.use('/api/me', meRouter)
app.use('/api/users', usersRouter)
app.use('/api/admin', adminRouter)
app.use('/api/rooms', roomsRouter)
// 按路由取数：SSR 与客户端共用同一份定义（见 routes/page.js）
app.use('/api/page', pageRouter)
app.use('/api/platform-bios', platformBiosRouter)
// 云存档（必须登录，见 routes/saves.js）
app.use('/api/saves', savesRouter)
// P2P 联机的 ICE / TURN 配置（短期凭证，见 routes/ice.js）
app.use('/api/netplay/ice', iceRouter)

// 正在直播的房间列表。?game=<slug> 只看某个游戏的
app.get('/api/live/rooms', (req, res) => {
  res.json(liveRooms({ gameSlug: typeof req.query.game === 'string' ? req.query.game : undefined }))
})
app.get('/api/live/rooms/:roomId', (req, res) => {
  const room = liveRoom(req.params.roomId)
  if (!room) return res.status(404).json({ error: 'room not found' })
  res.json(room)
})

/* ---------------- J2ME 临时上传 ---------------- */
// 请求体就是 jar 原始字节，用 express.raw 收，省掉 multipart 依赖。
// 上限在这里也卡一道，避免超大请求先被完整读进内存再拒绝。
app.post('/api/j2me/upload', express.raw({ type: '*/*', limit: MAX_BYTES }), uploadJar)
// 页面关闭时由 navigator.sendBeacon 调用，只能是 POST。
app.post('/api/j2me/release', express.text({ type: '*/*', limit: '1kb' }), releaseJar)
// 还在玩的时候续期，避免长时间游戏中途文件被清扫
app.post('/api/j2me/keepalive', express.text({ type: '*/*', limit: '1kb' }), keepaliveJar)
// 前端据此决定心跳间隔
app.get('/api/j2me/config', (_req, res) => res.json({ ttlMs: TTL_MS }))

/* ---------------- 前端：静态资源 + 服务端渲染 ---------------- */
if (ssrAvailable()) {
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

  // 构建产物找不到就老实回 404。交给下面的 SSR 会返回一段 HTML，
  // 浏览器按 module 加载时只会报一句含糊的 MIME 错误，白屏还查不出原因。
  app.get(/^\/assets\//, (_req, res) => res.status(404).set('Cache-Control', CACHE.none).type('text/plain').send('Not Found'))

  // 除 /api 外的所有 GET 都交给 SSR（/admin 也走，但它本身是 noindex 的后台）
  app.get(/^(?!\/api\/).*/, renderPage)

  console.log('[ssr] 已启用服务端渲染')
} else {
  console.log('[ssr] 未找到 dist/client 或 dist/server —— 只提供 API。先在项目根目录跑 npm run build')
}

// 兜底错误处理
app.use((err, _req, res, _next) => {
  // body-parser 的超限错误要回 413，不然前端只看到一个含糊的 500
  if (err?.type === 'entity.too.large' || err?.status === 413) {
    return res.status(413).json({ error: '文件过大' })
  }
  // JSON 解析失败等客户端错误，body-parser 给的是 4xx，别一律降级成 500
  const status = Number(err?.status || err?.statusCode || 0)
  if (status >= 400 && status < 500) {
    return res.status(status).json({ error: '请求格式不正确' })
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
