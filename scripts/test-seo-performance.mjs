#!/usr/bin/env node
/**
 * SEO 首屏性能与 SSR 可用性守卫。跑：npm run test:seo-performance
 *
 * 这些问题不会让页面功能测试失败：视频照样能播、字体照样好看、部署最后也会成功；
 * 但移动端 LCP 会被数 MB 资源拖慢，或构建窗口里让爬虫偶发拿到 500，所以单独守住。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CACHE } from '../server/src/cache.js'
import { earlyHintLinks, retargetCoverHints } from '../server/src/early-hints.js'
import { localePreloadTag } from '../server/src/locale-preload.js'
import { retargetStaticToCnEdge, retargetStaticToOrigin } from '../shared/cover-cdn-hint.js'

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')
let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ❌ ${name}\n     ${error.message}`)
  }
}

check('移动端封面视频不进入首屏下载队列', () => {
  const src = read('src/components/game/GameCover.tsx')
  assert.match(src, /matchMedia\('\(hover: hover\) and \(pointer: fine\)'\)\.matches/)
  assert.match(src, /if \(!hoverCapable\) return/)
  assert.match(src, /preload="none"/)
  assert.doesNotMatch(src, /preload=\{priority \? 'metadata'/)
})

check('游戏库、语言专题和首页只把首张 LCP 封面提升到高优先级', () => {
  const card = read('src/components/game/GameCard.tsx')
  const wideCard = read('src/components/game/GameCardWide.tsx')
  const games = read('src/pages/GamesPage.tsx')
  const collections = read('src/pages/CollectionPage.tsx')
  const home = read('src/components/home/sections.tsx')
  const cover = read('src/components/game/GameCover.tsx')
  assert.match(card, /priority\?: boolean/, '普通游戏卡没有 LCP 优先级入口')
  assert.match(card, /<GameCover[^>]+priority=\{priority\}/, '普通游戏卡没有把优先级传给封面')
  assert.match(wideCard, /<GameCover[^>]+priority=\{priority\}/, '首页宽卡没有把优先级传给封面')
  assert.match(games, /priority=\{i === 0\}/, '游戏库没有只提升首张封面')
  assert.match(collections, /priority=\{i === 0\}/, '平台、类型与 ROM 语言专题没有只提升首张封面')
  assert.match(home, /<GameCardWide[^>]+priority=\{i === 0\}/, '首页最新卡没有只提升首张封面')
  assert.match(cover, /preload\(coverSrc, \{ as: 'image', fetchPriority: 'high' \}\)/, '视频 poster 没有高优先级图片预加载')
})

check('桌面端封面视频等页面加载完、空闲后才自动拉流，弱网不自动拉', () => {
  const src = read('src/components/game/GameCover.tsx')
  // 2026-11-20 首页：两段预览 3.5MB 水合后就下载，和 32 张封面抢带宽，最后一张封面 11.9 秒才到
  assert.match(src, /window\.addEventListener\('load', idle, \{ once: true \}\)/)
  assert.match(src, /whenIdle\(resolve, \{ timeout: 3000, fallbackMs: 1500 \}\)/)
  assert.match(src, /if \(!previewAutoplayAllowed\(\)\) return/)
  assert.match(src, /allowsSpeculativePlayerPreload\(connection\)/)
  // 视口回调本身不再直接 play：只有页面安定后（settled）才开始
  assert.match(src, /else if \(settled\) start\(\)/)
  assert.match(src, /settled = true\s*\n\s*if \(visible\) start\(\)/)
  // 悬停是玩家自己要看的，不受这两条限制
  assert.match(src, /onMouseEnter=\{\(\) => void ref\.current\?\.play\(\)/)
})

check('侧栏微型封面不在开局时下载和解码宣传视频', () => {
  const src = read('src/components/layout/Sidebar.tsx')
  const compactCovers = src.match(/<GameCover[^>]+still \/>/g) ?? []
  assert.equal(compactCovers.length, 2, '稍后玩和曾经玩过的两种微型封面都必须固定为静态图')
  assert.ok(compactCovers.some((tag) => tag.includes('ratio="square"')), '稍后玩的方形微缩图仍会加载视频')
  assert.ok(compactCovers.some((tag) => tag.includes('ratio="landscape"')), '曾经玩过的横版微缩图仍会加载视频')
})

check('ZeoSeven 字体非阻塞加载，首屏先显示系统字体', () => {
  const html = read('index.html')
  const css = read('src/index.css')
  const fontUrl = 'https://fontsapi.zeoseven.com/214/main/result.css'
  const preload = html.match(/<link\b[^>]*fontsapi\.zeoseven\.com\/214\/main\/result\.css[^>]*>/)?.[0] ?? ''
  assert.ok(preload, 'index.html 没有引用 ZeoSeven 的 Sarasa UI SC 字体样式表')
  assert.match(preload, /rel="preload"/, '字体样式表不是 preload')
  assert.match(preload, /as="style"/, '字体样式表的 preload 类型不正确')
  assert.match(preload, /crossorigin/, '跨域预载与 stylesheet 的凭证模式不一致')
  assert.match(preload, /onload="this\.onload=null;this\.rel='stylesheet'"/, 'CSS 下载完成后没有再应用为 stylesheet')
  assert.match(html, new RegExp(`<noscript>\\s*<link[^>]+href="${fontUrl.replaceAll('.', '\\.')}"`), '禁用 JavaScript 时没有字体样式表兜底')
  assert.doesNotMatch(css, /@font-face|Geist Pixel|Ark Pixel|\/fonts\/(?:geist|ark)-pixel/, '主 CSS 仍引用已移除的自托管字体')
  const theme = css.match(/@theme \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.match(theme, /'Sarasa UI SC'/, '基础字体栈没有使用 ZeoSeven 的 Sarasa UI SC')
  assert.match(theme, /ui-sans-serif, system-ui/, '基础字体栈没有系统字体兜底')
})

check('SSR 在启动时预热模板和渲染入口，部署窗口继续用内存副本', () => {
  const src = read('server/src/ssr.js')
  const available = src.match(/export function ssrAvailable\(\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.match(available, /primeTemplate\(\)/, '启动时没有缓存 HTML 模板')
  assert.match(available, /loadRender\(\)/, '启动时没有预加载 SSR 渲染入口')
  assert.match(src, /if \(template !== null\) return template/, '构建时模板消失后不会退回内存副本')
  assert.match(src, /let renderPromise = null/, '并发首访可能重复导入渲染入口')
})

check('SSR HTML 允许边缘改压缩（Email Obfuscation 已在区域关闭，见 cache.js CACHE.page）', () => {
  // no-transform 会让 HTML 永远停在源站 gzip，拿不到 Cloudflare 的 Brotli / zstd。
  assert.doesNotMatch(CACHE.page, /no-transform/)
})

check('头条收录脚本不抢首屏资源，且跳过爬虫、后台、登录和隔离播放器', () => {
  const html = read('index.html')
  const pushScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .find((script) => script.includes("el.id = 'ttzz'"))
  assert.ok(pushScript, '找不到头条收录脚本')
  assert.match(pushScript, /addEventListener\('load', afterLoad/, '首屏加载前就安排了第三方脚本')
  assert.match(pushScript, /requestIdleCallback\(inject, \{ timeout: 5000 \}\)/, '未优先使用空闲时间提交')
  assert.match(pushScript, /bot\|crawl\|spider/, '搜索爬虫仍会下载不需要的收录脚本')
  assert.match(pushScript, /admin\|embed\|play\|auth\|login\|me/, '非公开落地页仍会触发提交')
})

check('Early Hints：从构建模板提取入口 JS / CSS / 本地字体和封面域预连接', () => {
  const template = `<html><head>
<link rel="preconnect" href="https://image.8bitgo.com">
<link
  rel="preload"
  href="/fonts/demo.woff2"
  as="font"
  type="font/woff2"
  crossorigin
/>
<script type="module" crossorigin src="/assets/index-CL8i0tUz.js"></script>
<link rel="modulepreload" crossorigin href="/assets/react-vendor-mkkrrnzo.js">
<link rel="modulepreload" crossorigin href="/assets/api-D2I2rW4W.js">
<link rel="modulepreload" crossorigin data-8bitgo-locale-preload="true" href="/assets/en-D3.js">
<link rel="stylesheet" crossorigin href="/assets/index-g-Tc-3Xd.css">
<script nomodule crossorigin id="vite-legacy-polyfill" src="/assets/polyfills-legacy-Bd8zl_rk.js"></script>
</head></html>`
  assert.equal(
    earlyHintLinks(template),
    [
      '<https://image.8bitgo.com>; rel=preconnect',
      '</assets/index-g-Tc-3Xd.css>; rel=preload; as=style; crossorigin',
      '</assets/index-CL8i0tUz.js>; rel=preload; as=script; crossorigin',
      '</assets/react-vendor-mkkrrnzo.js>; rel=preload; as=script; crossorigin',
      '</assets/en-D3.js>; rel=preload; as=script; crossorigin',
      '</fonts/demo.woff2>; rel=preload; as=font; type="font/woff2"; crossorigin',
    ].join(', '),
  )
  // 没有构建产物（开发态模板）时不发 Link，不能预载不存在的文件
  assert.equal(earlyHintLinks('<html><head></head></html>'), '')
  const src = read('server/src/ssr.js')
  assert.match(src, /Link: earlyHints/, 'SSR 200 响应没有带 Early Hints 的 Link 头')
  // 2026-11-18 /rooms：Cloudflare 的 Early Hints 不分大陆 / 非大陆两份资源写法，主站有大陆加速入口时不能发 Link
  assert.match(src, /const assetVariants = !cnSite && Boolean\(cnEdgeOrigin\(publicSiteUrl\(\)\)\)/)
  assert.match(src, /const earlyHints = notFound \|\| assetVariants \? '' : earlyHintsFor\(page\)/)
})

check('SSR 预载当前语言 chunk，失败或旧构建时安全退回现有按需加载', () => {
  const clientDir = mkdtempSync(path.join(tmpdir(), '8bitgo-locale-preload-'))
  try {
    mkdirSync(path.join(clientDir, 'assets'))
    writeFileSync(path.join(clientDir, 'assets', 'integrity-ABCD1234.json'), JSON.stringify({
      v: 2,
      alg: 'sha256',
      entry: 'index-ABCD1234.js',
      locales: { en: 'assets/en-EFGH5678.js', 'zh-Hant': 'assets/zh-Hant-IJKL9012.js' },
    }))
    const template = '<script type="module" crossorigin src="/assets/index-ABCD1234.js"></script>'
    assert.equal(
      localePreloadTag(template, 'en', clientDir),
      '<link rel="modulepreload" crossorigin data-8bitgo-locale-preload="true" href="/assets/en-EFGH5678.js">',
    )
    const preloaded = localePreloadTag(template, 'en', clientDir)
    assert.match(retargetStaticToCnEdge(preloaded, 'https://cn.8bitgo.com'), /href="https:\/\/cn\.8bitgo\.com\/_cn\/assets\/en-EFGH5678\.js"/)
    assert.match(retargetStaticToOrigin(preloaded, 'https://8bitgo.com'), /href="https:\/\/8bitgo\.com\/assets\/en-EFGH5678\.js"/)
    assert.equal(localePreloadTag(template, 'zh-Hans', clientDir), '', '基准语言已经在入口包里，不额外预载')
    assert.equal(localePreloadTag(template, 'invalid', clientDir), '', '不接受 URL 中的任意语言值')
    assert.equal(
      localePreloadTag('<script type="module" src="/assets/index-OLD12345.js"></script>', 'en', clientDir),
      '',
      '旧构建或发布窗口缺少清单时不生成坏链接',
    )
    writeFileSync(path.join(clientDir, 'assets', 'integrity-MNOP3456.json'), JSON.stringify({
      v: 2, alg: 'sha256', entry: 'index-ABCD1234.js', locales: { en: 'assets/../../private.js' },
    }))
    const malformedTemplate = '<script type="module" src="/assets/index-MNOP3456.js"></script>'
    assert.equal(localePreloadTag(malformedTemplate, 'en', clientDir), '', '清单路径不能逃出 assets 目录')
  } finally {
    rmSync(clientDir, { recursive: true, force: true })
  }

  const ssr = read('server/src/ssr.js')
  assert.match(ssr, /localePreloadTag\(templatePage, lang, CLIENT_DIR\)/, 'SSR 按本页语言生成 preload')
  assert.match(ssr, /localePreload\n\s*\? injectOnce\(templatePage, '<\/head>'/, '预载链接在大陆线路改写前注入')
})

check('大陆入口：封面 preconnect / dns-prefetch 换成 EdgeOne 封面域，其余不动', () => {
  const tpl = [
    '<link rel="dns-prefetch" href="https://image.8bitgo.com">',
    '<link rel="preconnect" href="https://image.8bitgo.com">',
    '<link rel="preconnect" href="https://fonts.example.com">',
    '<meta content="https://image.8bitgo.com">',
  ].join('\n')
  const out = retargetCoverHints(tpl, 'https://image.8bitgo.com', 'https://image-cn.8bitgo.com')
  assert.match(out, /rel="dns-prefetch" href="https:\/\/image-cn\.8bitgo\.com"/)
  assert.match(out, /rel="preconnect" href="https:\/\/image-cn\.8bitgo\.com"/)
  assert.match(out, /fonts\.example\.com/)
  assert.match(out, /<meta content="https:\/\/image\.8bitgo\.com">/, '非 link 标签不该被改')
  // 主站：两边相同或任一为空都原样返回
  assert.equal(retargetCoverHints(tpl, 'https://image.8bitgo.com', 'https://image.8bitgo.com'), tpl)
  assert.equal(retargetCoverHints(tpl, 'https://image.8bitgo.com', ''), tpl)
  const src = read('server/src/ssr.js')
  assert.match(src, /retargetCoverHints\(getTemplate\(\)/, 'SSR 没有按本次封面域改写模板')
  assert.match(src, /render\(\{ url, data, tvHost, cnSite, coverHint \}\)/, 'SSR 没把大陆入口与封面域标记传给 render')
})

console.log(failed ? `\n${failed} 项失败` : '\n全部通过 ✅')
process.exit(failed ? 1 : 0)
