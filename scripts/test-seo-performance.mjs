#!/usr/bin/env node
/**
 * SEO 首屏性能与 SSR 可用性守卫。跑：npm run test:seo-performance
 *
 * 这些问题不会让页面功能测试失败：视频照样能播、字体照样好看、部署最后也会成功；
 * 但移动端 LCP 会被数 MB 资源拖慢，或构建窗口里让爬虫偶发拿到 500，所以单独守住。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CACHE } from '../server/src/cache.js'
import { earlyHintLinks } from '../server/src/early-hints.js'

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

check('侧栏微型封面不在开局时下载和解码宣传视频', () => {
  const src = read('src/components/layout/Sidebar.tsx')
  const compactCovers = src.match(/<GameCover[^>]+still \/>/g) ?? []
  assert.equal(compactCovers.length, 2, '稍后玩和曾经玩过的两种微型封面都必须固定为静态图')
  assert.ok(compactCovers.some((tag) => tag.includes('ratio="square"')), '稍后玩的方形微缩图仍会加载视频')
  assert.ok(compactCovers.some((tag) => tag.includes('ratio="landscape"')), '曾经玩过的横版微缩图仍会加载视频')
})

check('550KB 中文字体不再 preload，也不强制慢网下载', () => {
  const html = read('index.html')
  const css = read('src/index.css')
  assert.doesNotMatch(html, /rel="preload"[\s\S]{0,180}ark-pixel/, 'Ark Pixel 仍在关键资源 preload')
  const face = css.match(/@font-face \{[\s\S]*?font-family: 'Ark Pixel';[\s\S]*?\}/)?.[0] ?? ''
  assert.match(face, /font-display: optional/, 'Ark Pixel 慢网仍会强制 swap')
  const theme = css.match(/@theme \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.doesNotMatch(theme, /'Ark Pixel'/, '移动端基础字体栈仍会触发 Ark Pixel 下载')
  const desktop = css.match(/@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.match(desktop, /'Ark Pixel'/, '桌面端没有保留 Ark Pixel 品牌字体')
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

check('Early Hints：从构建模板提取入口 JS / CSS / 首屏字体 / 封面域预连接', () => {
  const template = `<html><head>
<link rel="preconnect" href="https://image.8bitgo.com">
<link
  rel="preload"
  href="/fonts/geist-pixel/geist-pixel-latin.woff2"
  as="font"
  type="font/woff2"
  crossorigin
/>
<script type="module" crossorigin src="/assets/index-CL8i0tUz.js"></script>
<link rel="modulepreload" crossorigin href="/assets/react-vendor-mkkrrnzo.js">
<link rel="modulepreload" crossorigin href="/assets/api-D2I2rW4W.js">
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
      '</fonts/geist-pixel/geist-pixel-latin.woff2>; rel=preload; as=font; type="font/woff2"; crossorigin',
    ].join(', '),
  )
  // 没有构建产物（开发态模板）时不发 Link，不能预载不存在的文件
  assert.equal(earlyHintLinks('<html><head></head></html>'), '')
  const src = read('server/src/ssr.js')
  assert.match(src, /Link: earlyHints/, 'SSR 200 响应没有带 Early Hints 的 Link 头')
})

console.log(failed ? `\n${failed} 项失败` : '\n全部通过 ✅')
process.exit(failed ? 1 : 0)
