import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { apiEnabled } from '@/services/api'
import { hydrateGames } from '@/services/store'
import { hydratePosts } from '@/services/posts'
import { hydrateAuth } from '@/services/auth'
import { syncHtmlLang } from '@/services/lang'

/**
 * 配置了后端（VITE_API_URL）时，先把数据库里的游戏 / 文章拉下来、恢复登录态，
 * 再渲染页面——这样首屏就是数据库数据。未配置后端时立即渲染（走本地存储，行为不变）。
 * 后端异常也不会卡住页面：最多等 6 秒就先渲染，用内置数据兜底。
 */
async function boot() {
  syncHtmlLang()
  if (apiEnabled()) {
    const withTimeout = <T,>(p: Promise<T>, ms: number) =>
      Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))])
    await withTimeout(Promise.allSettled([hydrateGames(), hydratePosts(), hydrateAuth()]), 6000)
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void boot()
