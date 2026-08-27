import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { apiEnabled } from '@/services/api'
import { gamesStore, hydrateGames } from '@/services/store'
import { postsStore, hydratePosts } from '@/services/posts'
import { hydrateAuth } from '@/services/auth'
import { setLangForRender, syncHtmlLang } from '@/services/lang'
import { langFromPath, langPrefix } from '@/config/languages'
import type { Game, Post } from '@/types'

interface Bootstrap {
  games?: Game[]
  posts?: Post[]
  lang?: string
}

/** 服务端渲染时嵌进 HTML 的数据；没有就是纯 SPA 模式 */
const boot: Bootstrap = (window as unknown as { __8BITGO__?: Bootstrap }).__8BITGO__ ?? {}
const ssr = Boolean(document.getElementById('root')?.hasChildNodes())

// 语言由 URL 决定，必须在渲染前定好，服务端与客户端才会得出同一份 HTML
const lang = langFromPath(window.location.pathname)
setLangForRender(lang)
syncHtmlLang()

// SSR 已经把游戏 / 文章塞进 HTML 了，直接灌进 store，
// 保证 hydration 时客户端看到的数据和服务端渲染用的完全一致（否则会不匹配）。
//
// 注意条件是「有没有这个字段」而不是「长度大于 0」：数据库为空时服务端渲染的是 0 款，
// 客户端如果因为数组是空的就跳过，load() 会回退到内置的 91 款 —— 两边对不上，
// hydration 失败，React 会丢掉整个首屏重新渲染。
// 用 seed 而不是 save：save 会写 localStorage，把「空」永久存进访客浏览器。
if (ssr) {
  if (Array.isArray(boot.games)) gamesStore.seed(boot.games)
  if (Array.isArray(boot.posts)) postsStore.seed(boot.posts)
}

const tree = (
  <StrictMode>
    <App basename={langPrefix(lang) || '/'} />
  </StrictMode>
)

const root = document.getElementById('root')!

if (ssr) {
  // 服务端已经渲染好首屏：直接 hydrate，不重新渲染
  hydrateRoot(root, tree)
  // 登录态是浏览器独有的，hydrate 之后再补
  if (apiEnabled()) void hydrateAuth()
} else {
  // 没有 SSR（纯静态托管 / 开发服务器）：退回原来的先取数再渲染
  const start = async () => {
    if (apiEnabled()) {
      const withTimeout = <T,>(p: Promise<T>, ms: number) =>
        Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))])
      await withTimeout(Promise.allSettled([hydrateGames(), hydratePosts(), hydrateAuth()]), 6000)
    }
    createRoot(root).render(tree)
  }
  void start()
}
