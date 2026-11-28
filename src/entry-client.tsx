import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import './index.css'
import { installTranslatorDomGuard } from '@/services/translatorDomGuard'
import App from './App'
import { apiEnabled } from '@/services/api'
import { hydrateAuth } from '@/services/auth'
import { setLangForRender, syncHtmlLang } from '@/services/lang'
import { langFromPath, langPrefix, stripLang } from '@/config/languages'
import { loadLegalLocale, loadLocale } from '@/locales'
import { initClarity } from '@/services/clarity'
import { installRouteReport } from '@/services/romRouteReport'
import { consumeOriginAssetsParam } from '@/services/moduleLinkRecovery'
import { startPageRecoveryWatch } from '@/services/pageRecovery'

// 页面翻译会挪动文本节点，React 删插时崩溃；必须在首次渲染前装上（见 translatorDomGuard.ts）
installTranslatorDomGuard()

// 大陆加速入口取不下来 chunk 后，兜底页带 __assets=origin 改用主站资源重新载入；路由读地址之前去掉参数
consumeOriginAssetsParam()
// 大陆玩家连优选 ROM 线路的成败回报给优选任务（只发计数，见 romRouteReport.ts）
installRouteReport()

// 上一份文档崩溃后自动刷新过：等这一页把同一个 chunk 加载上再补报「已恢复」，又崩了就并进那份报告（pageRecovery.ts）
startPageRecoveryWatch()

/**
 * 首屏数据由 services/pageData 在模块加载时从 window.__8BITGO__ 里读走，
 * 这里不用再处理 —— 页面组件用 usePageData() 拿它。
 */
const ssr = Boolean(document.getElementById('root')?.hasChildNodes())

// 语言由 URL 决定，必须在渲染前定好，服务端与客户端才会得出同一份 HTML
const lang = langFromPath(window.location.pathname)
setLangForRender(lang)
syncHtmlLang()

const root = document.getElementById('root')!

/**
 * 先把当前语言的文案取到手，再渲染。
 *
 * 所有语言都按需加载（见 locales/index.ts）。这里之所以要 await 而不是
 * 「先用中文渲染、加载完再切」：服务端吐出来的 HTML 已经是目标语言了，
 * 客户端要是拿中文去 hydrate，两边对不上，React 会把整棵树推倒重建 ——
 * 用户看到的就是页面先闪一下中文再变回英文。
 *
 * SSR 同样会预载当前语言；网络预载失败时 loader 会在此处尝试兜底语言。
 */
async function start() {
  await loadLocale(lang)
  const routePath = stripLang(window.location.pathname).replace(/\/+$/, '') || '/'
  if (routePath === '/terms' || routePath === '/privacy') await loadLegalLocale(lang)

  const tree = (
    <StrictMode>
      <App basename={langPrefix(lang) || '/'} />
    </StrictMode>
  )

  if (ssr) {
    // 服务端已经渲染好首屏：直接 hydrate，不重新渲染
    hydrateRoot(root, tree)
  } else {
    // 没有 SSR（纯静态托管 / 开发服务器）：页面组件自己会去调 /api/page 取数
    createRoot(root).render(tree)
  }

  // 登录态是浏览器独有的，渲染之后再补
  if (apiEnabled()) void hydrateAuth()

  // 放在水合之后，第三方分析加载失败或变慢都不能阻塞首屏。
  initClarity()
}

void start()
