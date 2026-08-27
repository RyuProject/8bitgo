import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { apiEnabled } from '@/services/api'
import { hydrateAuth } from '@/services/auth'
import { syncHtmlLang } from '@/services/lang'

/**
 * 纯客户端入口（没有 SSR 时用，比如 vite dev）。
 *
 * v1 会在渲染前把**整个游戏库和全部文章**拉下来，等它回来才渲染。
 * v2 改成各页面自己按需取数（见 services/pageData.ts），这里就只剩恢复登录态，
 * 而且不用再等 —— 页面骨架可以先出来。
 */
syncHtmlLang()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
if (apiEnabled()) void hydrateAuth()
