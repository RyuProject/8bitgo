import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { apiEnabled } from '@/services/api'
import { hydrateAuth } from '@/services/auth'
import { setLangForRender, syncHtmlLang } from '@/services/lang'
import { langFromPath, langPrefix } from '@/config/languages'

/**
 * 首屏数据由 services/pageData 在模块加载时从 window.__8BITGO__ 里读走，
 * 这里不用再处理 —— 页面组件用 usePageData() 拿它。
 */
const ssr = Boolean(document.getElementById('root')?.hasChildNodes())

// 语言由 URL 决定，必须在渲染前定好，服务端与客户端才会得出同一份 HTML
const lang = langFromPath(window.location.pathname)
setLangForRender(lang)
syncHtmlLang()

const tree = (
  <StrictMode>
    <App basename={langPrefix(lang) || '/'} />
  </StrictMode>
)

const root = document.getElementById('root')!

if (ssr) {
  // 服务端已经渲染好首屏：直接 hydrate，不重新渲染
  hydrateRoot(root, tree)
} else {
  // 没有 SSR（纯静态托管 / 开发服务器）：页面组件自己会去调 /api/page 取数
  createRoot(root).render(tree)
}

// 登录态是浏览器独有的，渲染之后再补
if (apiEnabled()) void hydrateAuth()
