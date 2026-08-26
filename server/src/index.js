import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'node:path'
import { ping } from './db.js'
import { ssrAvailable, renderPage, CLIENT_DIR } from './ssr.js'
import { j2meJarProxy, uploadJar, releaseJar, keepaliveJar, startSweeper, MAX_BYTES, TTL_MS } from './j2me.js'
import { ADMIN_AUTH_DISABLED } from './auth.js'
import { authRouter } from './routes/auth.js'
import { gamesRouter } from './routes/games.js'
import { postsRouter } from './routes/posts.js'
import { meRouter } from './routes/me.js'
import { usersRouter } from './routes/users.js'
import { adminRouter } from './routes/admin.js'
import { roomsRouter } from './routes/rooms.js'

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '4mb' }))

// CORS：ALLOWED_ORIGINS 为逗号分隔白名单，或 * 放行全部
const origins = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean)
app.use(
  cors({
    origin: origins.includes('*') ? true : origins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
)

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
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        }
      },
    }),
  )

  // J2ME：本地 public/j2me/jar/ 里没有的 .jar，转发到对象存储。
  // 必须注册在 express.static 之后 —— Express 按注册顺序匹配，
  // 放前面会让代理抢先，本地文件永远取不到。
  app.get('/j2me/jar/:name', j2meJarProxy)

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
  console.error('[api error]', err)
  res.status(500).json({ error: err?.message || '服务器内部错误' })
})

const PORT = Number(process.env.PORT || 8788)
startSweeper()

app.listen(PORT, () => {
  console.log(`8BitGo API 已启动：http://127.0.0.1:${PORT}`)
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
