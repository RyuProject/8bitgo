import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'node:path'
import { ping } from './db.js'
import { ssrAvailable, renderPage, CLIENT_DIR } from './ssr.js'
import { ADMIN_AUTH_DISABLED } from './auth.js'
import { authRouter } from './routes/auth.js'
import { gamesRouter } from './routes/games.js'
import { postsRouter } from './routes/posts.js'
import { meRouter } from './routes/me.js'
import { usersRouter } from './routes/users.js'
import { adminRouter } from './routes/admin.js'

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

  // 除 /api 外的所有 GET 都交给 SSR（/admin 也走，但它本身是 noindex 的后台）
  app.get(/^(?!\/api\/).*/, renderPage)

  console.log('[ssr] 已启用服务端渲染')
} else {
  console.log('[ssr] 未找到 dist/client 或 dist/server —— 只提供 API。先在项目根目录跑 npm run build')
}

// 兜底错误处理
app.use((err, _req, res, _next) => {
  console.error('[api error]', err)
  res.status(500).json({ error: err?.message || '服务器内部错误' })
})

const PORT = Number(process.env.PORT || 8788)
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
