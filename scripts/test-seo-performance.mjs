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
import { createContext, runInContext } from 'node:vm'
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

check('游戏库和专题只把首张 LCP 封面提升到高优先级，首页延后加载下方栏目封面', () => {
  const card = read('src/components/game/GameCard.tsx')
  const wideCard = read('src/components/game/GameCardWide.tsx')
  const games = read('src/pages/GamesPage.tsx')
  const collections = read('src/pages/CollectionPage.tsx')
  const home = read('src/components/home/sections.tsx')
  const homeBanner = read('src/components/home/HomeBanner.tsx')
  const cover = read('src/components/game/GameCover.tsx')
  const collectionCard = read('src/components/game/CollectionCard.tsx')
  const rankCard = read('src/components/game/GameRankCard.tsx')
  assert.match(card, /priority\?: boolean/, '普通游戏卡没有 LCP 优先级入口')
  assert.match(card, /<GameCover[^>]+priority=\{priority\}/, '普通游戏卡没有把优先级传给封面')
  assert.match(card, /sizes=\{coverSizes \?\? \(priority \|\| eager \? GAME_CARD_IMAGE_SIZES : undefined\)\}/, '首屏方卡应按实际卡宽选择封面档，不能默认按 100vw 下载')
  assert.match(card, /deferMedia=\{deferCover\}/, '普通游戏卡没有把延迟挂载策略传给封面')
  assert.match(wideCard, /<GameCover[^>]+priority=\{priority\}/, '首页宽卡没有把优先级传给封面')
  assert.match(wideCard, /deferMedia=\{deferCover\}/, '首页宽卡没有把延迟挂载策略传给封面')
  assert.match(games, /priority=\{i === 0\}/, '游戏库没有只提升首张封面')
  assert.match(collections, /priority=\{i === 0\}/, '平台、类型与 ROM 语言专题没有只提升首张封面')
  assert.match(home, /<GameCard key=\{g\.slug\} game=\{g\} priority=\{i === 0\} eager=\{i === 1\}/, '首页精选区只给第一张可见封面最高优先级，第二张仍立即加载')
  assert.match(homeBanner, /sourceMedia=\{HERO_STACK_QUERY\}/, '桌面 Hero 封面没有按桌面断点选源，移动端会下载隐藏图片')
  assert.match(cover, /<source\s+media=\{sourceMedia\}\s+srcSet=\{srcSet \|\| imgSrc\}/, '响应式 Hero 图片源没有绑定桌面媒体条件')
  assert.match(cover, /src=\{sourceMedia \? undefined : imgSrc\}/, '媒体条件不匹配时 img 仍提供了移动端回退源')
  assert.match(home, /priority=\{i === 0\} eager=\{i === 1\} deferCover=\{i >= 2\}/, '精选区首张提升优先级、第二张立即加载，其余封面靠近视口后再挂载')
  assert.match(home, /<GameCardWide key=\{g\.slug\} game=\{g\} isNew=\{i < 3\} deferCover=\{i !== 0\}/, '首页最新栏目不抢首屏优先级，其余封面延后挂载')
  assert.match(wideCard, /sizes="\(min-width: 640px\) 288px, 256px"/, '首页宽卡必须按真实展示宽度挑选封面档位')
  assert.match(home, /rank=\{i \+ 1\}\s+deferCover/, '首页榜单封面没有延后挂载')
  assert.match(home, /<GameCardWide[^>]+deferCover/, '首页最新游戏封面具有延后挂载入口')
  assert.match(home, /<GameCard key=\{g\.slug\} game=\{g\} deferCover \/>/, '首页一起玩封面没有延后挂载')
  assert.match(home, /<CollectionCard key=\{c\.id\} collection=\{c\} deferCover \/>/, '首页合集封面没有延后挂载')
  assert.match(home, /deferMedia\s+className="h-11/, '首页分类示例封面没有延后挂载')
  assert.match(cover, /\{ rootMargin: '280px' \}/, '封面媒体应在进入视口前 280px 挂载，避免原生 lazy 抢跑')
  assert.match(rankCard, /deferMedia=\{deferCover\}/, '榜单卡没有把延迟挂载策略传给封面')
  assert.match(collectionCard, /deferMedia=\{deferCover && !priority\}/, '合集轮播没有保留首屏优先图并延后其它格子')
  assert.match(cover, /coverImageUrl\(coverSrc, thumb \? 96 : coverPosterWidth\(coverSizes\)\)/, '小图 poster 固定使用 96px，其它 poster 按实际布局尺寸转换')
  assert.match(cover, /preload\(posterSrc, \{[\s\S]*imageSrcSet: posterSrcSet, imageSizes: posterSizes[\s\S]*\}\)/, '首屏视频 poster 预加载必须和卡片使用同一组响应式候选')
  assert.match(cover, /srcSet=\{activePosterSrcSet \|\| undefined\}/, '视频 poster 必须根据卡片尺寸选择响应式图片')
  assert.match(cover, /sizes=\{activePosterSrcSet \? posterSizes : undefined\}/, '视频 poster 必须按真实卡片宽度选择图片档位')
  assert.match(cover, /loading=\{priority \? 'eager' : 'lazy'\}/, '非首屏视频 poster 必须参与原生懒加载')
  assert.match(cover, /fallbackPoster/, '图片转换失败时视频 poster 必须退回源图')
  assert.match(read('src/services/roms.ts'), /const COVER_WIDTH_SCALES = \[2 \/ 3, 1, 4 \/ 3, 2\]/, '封面宽度必须从实际 sizes 与密度倍率生成，不能维护固定像素表')
  assert.match(read('src/services/roms.ts'), /const COVER_WIDTH_BUCKETS = \[96, 160, 240, 320, 480\]/, '自动生成的卡片宽度必须归并到有限共享档，避免每种尺寸都产生独立变换')
  assert.match(read('src/services/roms.ts'), /const MAX_COVER_WIDTH = COVER_WIDTH_BUCKETS\[COVER_WIDTH_BUCKETS\.length - 1\]/, '最大变换尺寸必须有明确上限，避免产生超大派生图')
  assert.match(read('src/services/roms.ts'), /function coverWidthBucket\(width: number\): number/, '共享宽度归并必须保留比当前展示目标更大的候选')
  assert.match(cover, /const coverSizes = sizes \|\| \(thumb \? '96px' : ''\)/, '缺失缩略图回退到主图时也必须按小尺寸选择变换候选')
  assert.match(cover, /thumb && !transformFailed \? coverImageUrl\(coverSrc, 96\)/, '标准缩略图必须直接缩放主图，避免加载额外 -96 对象')
  assert.match(cover, /const srcSet = !thumb && !useLegacyAvifThumb && !transformFailed/, '96px 小图不能再下载多余的高分辨率候选')
  assert.match(cover, /transformFallbackAvailable = !useLegacyAvifThumb && !transformFailed && \(Boolean\(srcSet\) \|\| imgSrc !== coverSrc\)/, '单档小图的 CDN 变换失败时也必须退回原图')
  assert.match(cover, /else if \(transformFallbackAvailable\) setTransformFailed\(true\)/, '变换失败回退不能依赖 srcset 是否存在')
  assert.match(read('src/services/roms.ts'), /function transformedCoverUrl[\s\S]*width=\$\{boundedWidth\},quality=75,format=\$\{format\},fit=scale-down/, 'poster 转换必须限制最大宽度并保留小体积和不放大策略')
})

check('ROM 语言数量使用足够对比度的继承色', () => {
  const links = read('src/components/game/RomLanguageLinks.tsx')
  assert.match(links, /<span>\{count\}<\/span>/, 'ROM 语言计数应继承 chip 的前景色')
  assert.doesNotMatch(links, /opacity-60/, '低对比度透明度不能用于小号计数')
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

check('首页轮播只在可轮换时预热，并复用封面转码档与实际尺寸', () => {
  const src = read('src/components/home/HomeBanner.tsx')
  assert.match(src, /const HERO_STACK_QUERY = '\(min-width: 768px\)'/, '轮播断点必须和 CSS 的 md 卡堆一致')
  assert.match(src, /if \(!heroStackVisible \|\| reduced \|\| paused \|\| pool\.length < 2\)/, '卡堆隐藏时不应轮换标题')
  assert.match(src, /const HERO_COVER_SIZES = '\(min-width: 1280px\) 211px, \(min-width: 1024px\) 158px, 141px'/)
  assert.match(src, /if \(!heroStackVisible \|\| pool\.length < 2 \|\| \(base\.length > 1/)
  assert.match(src, /document\.hidden \|\| !allowsSpeculativePlayerPreload\(connection\)\) return/)
  assert.match(src, /const srcSet = coverSrcSet\(src, undefined, undefined, HERO_COVER_SIZES\)/, '预热必须按与实际卡片相同的 sizes 生成缩放候选')
  assert.match(src, /img\.sizes = HERO_COVER_SIZES/)
  assert.match(src, /if \(srcSet\) img\.srcset = srcSet/)
  assert.match(src, /sizes=\{HERO_COVER_SIZES\}/, '实际卡片与预热的 sizes 必须一致')
  assert.doesNotMatch(src, /romUrlForKey/, '预热不能绕过游戏媒体地址与缩放图路径')
})

check('首页所有尺寸的轮换游戏名固定两行，避免长标题周期性推移正文', () => {
  const src = read('src/components/home/HomeBanner.tsx')
  assert.match(src, /min-h-\[2\.5em\]/, '标题槽必须预留两行高度')
  assert.match(src, /line-clamp-2(?! md:line-clamp-none)/, '所有尺寸的标题都限制在两行内')
  assert.match(src, /setInterval\(\(\) => \{/, '布局守卫应对应会周期轮换的横幅标题')
})

check('Clarity 授权横幅进入 SSR 首屏，已选择过的访客首次绘制前仍隐藏', () => {
  const component = read('src/components/privacy/ClarityConsentBanner.tsx')
  const html = read('index.html')
  const css = read('src/index.css')
  assert.match(component, /const \[open, setOpen\] = useState\(true\)/, '横幅必须和 SSR 首帧一起渲染')
  assert.match(component, /clarity-consent-banner fixed/, '横幅应保持固定定位，不推移页面内容')
  assert.match(component, /clarity-consent-banner[^\n]+bg-surface p-4/, 'LCP 横幅应使用不透明底色减少首屏合成')
  assert.doesNotMatch(component, /backdrop-blur/, 'LCP 横幅不能在首屏用 backdrop-filter 采样背景')
  assert.match(html, /localStorage\.getItem\('8bit\.clarity\.consent\.v1'\)/, '首绘脚本必须读取原有本地授权键')
  assert.match(html, /data-clarity-consent/, '首绘脚本没有标记已选择过的访客')
  assert.match(css, /html\[data-clarity-consent\] \.clarity-consent-banner\s*\{\s*visibility:\s*hidden/, '已有选择的访客仍会闪出授权横幅')
  assert.doesNotMatch(html, /document\.cookie[^\n]*clarity|8bitgo_clarity_consent/, '授权状态不得改存 Cookie')
})

check('非中文、首页、游戏详情和弱网不请求第三方字体，中文其它页面只在空闲时加载', () => {
  const html = read('index.html')
  const css = read('src/index.css')
  const fontUrl = 'https://fontsapi.zeoseven.com/214/main/result.css'
  const loader = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .find((script) => script.includes("id = 'zeoseven-fonts'"))
  assert.ok(loader, 'index.html 没有字体按需加载器')
  assert.match(loader, /document\.documentElement\.lang[^\n]*\.startsWith\('zh'\)/, '非中文页面仍会下载未使用的字体 CSS')
  assert.match(loader, /window\.location\.pathname/, '字体策略没有按游戏详情页路径跳过')
  assert.ok(loader.includes("sitePath === '/"), '首页应跳过会触发全页换字的晚到字体')
  assert.match(loader, /games\\\/\[\^\/\]\+/, '本地化游戏详情页也必须跳过字体下载')
  assert.match(loader, /saveData|slow-2g|downlink|rtt/, '弱网 / 流量节省模式没有跳过字体请求')
  assert.match(loader, /addEventListener\('load', afterLoad/, '字体请求在页面 load 前启动')
  assert.match(loader, /requestIdleCallback\(loadFonts, \{ timeout: 5000 \}\)/, '没有优先等页面空闲')
  assert.match(loader, /link\.href = 'https:\/\/fontsapi\.zeoseven\.com/, '空闲回调没有设置字体 CDN')
  assert.doesNotMatch(html, /<link\b[^>]*fontsapi\.zeoseven\.com[^>]*rel="preload"/, '字体 CSS 仍占用首屏预载队列')
  assert.equal(loader.includes(fontUrl), true, '字体地址改变时需要同步更新法律说明')
  assert.doesNotMatch(css, /@font-face|Geist Pixel|Ark Pixel|\/fonts\/(?:geist|ark)-pixel/, '主 CSS 仍引用已移除的自托管字体')
  const theme = css.match(/@theme \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.match(theme, /'Sarasa UI SC'/, '基础字体栈没有使用 ZeoSeven 的 Sarasa UI SC')
  assert.match(theme, /ui-sans-serif, system-ui/, '基础字体栈没有系统字体兜底')

  const requestedFonts = (lang, pathname, connection = { effectiveType: '4g', downlink: 10, rtt: 50 }) => {
    const requested = []
    const document = {
      documentElement: { lang },
      readyState: 'complete',
      getElementById: () => null,
      createElement: () => ({}),
      head: { appendChild: (link) => requested.push(link.href) },
    }
    const window = {
      location: { pathname },
      setTimeout: (fn) => { fn(); return 1 },
      requestIdleCallback: (fn) => fn(),
    }
    runInContext(loader, createContext({ document, window, navigator: { connection } }))
    return requested
  }
  assert.deepEqual(requestedFonts('en', '/en'), [], '英文页仍请求字体')
  assert.deepEqual(requestedFonts('zh-Hans', '/search'), [fontUrl], '适合网络的中文内容页没有加载字体')
  assert.deepEqual(requestedFonts('zh-Hans', '/zh-Hans'), [], '本地化首页请求了字体')
  assert.deepEqual(requestedFonts('zh-Hant', '/zh-Hant/games/contra'), [], '中文游戏详情页请求了字体')
  assert.deepEqual(requestedFonts('zh-Hans', '/', { effectiveType: '2g', downlink: 0.3, rtt: 800 }), [], '弱网仍请求字体')
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
      locales: {
        en: 'assets/en-EFGH5678.js',
        'zh-Hans': 'assets/zh-Hans-MNOP3456.js',
        'zh-Hant': 'assets/zh-Hant-IJKL9012.js',
      },
    }))
    const template = '<script type="module" crossorigin src="/assets/index-ABCD1234.js"></script>'
    assert.equal(
      localePreloadTag(template, 'en', clientDir),
      '<link rel="modulepreload" crossorigin data-8bitgo-locale-preload="true" href="/assets/en-EFGH5678.js">',
    )
    const preloaded = localePreloadTag(template, 'en', clientDir)
    assert.match(retargetStaticToCnEdge(preloaded, 'https://cn.8bitgo.com'), /href="https:\/\/cn\.8bitgo\.com\/_cn\/assets\/en-EFGH5678\.js"/)
    assert.match(retargetStaticToOrigin(preloaded, 'https://8bitgo.com'), /href="https:\/\/8bitgo\.com\/assets\/en-EFGH5678\.js"/)
    assert.equal(
      localePreloadTag(template, 'zh-Hans', clientDir),
      '<link rel="modulepreload" crossorigin data-8bitgo-locale-preload="true" href="/assets/zh-Hans-MNOP3456.js">',
      '简体中文现在也是动态 chunk，SSR 必须提前预载以免首屏水合多等一个 RTT',
    )
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
  assert.match(ssr, /localePreload\n\s*\? injectOnce\(templatePage, SSR_HEAD_MARKER/, '预载链接在大陆线路改写前通过固定槽位注入')
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
