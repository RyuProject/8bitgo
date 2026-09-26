#!/usr/bin/env node
/**
 * SEO 首屏性能与 SSR 可用性守卫。跑：npm run test:seo-performance
 *
 * 这些问题不会让页面功能测试失败：视频照样能播、字体照样好看、部署最后也会成功；
 * 但移动端 LCP 会被数 MB 资源拖慢，或构建窗口里让爬虫偶发拿到 500，所以单独守住。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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

check('550KB 中文字体不再 preload，也不强制慢网下载', () => {
  const html = read('index.html')
  const css = read('src/index.css')
  assert.doesNotMatch(html, /rel="preload"[\s\S]{0,180}ark-pixel/, 'Ark Pixel 仍在关键资源 preload')
  const face = css.match(/@font-face \{[\s\S]*?font-family: 'Ark Pixel';[\s\S]*?\}/)?.[0] ?? ''
  assert.match(face, /font-display: optional/, 'Ark Pixel 慢网仍会强制 swap')
})

check('SSR 在启动时预热模板和渲染入口，部署窗口继续用内存副本', () => {
  const src = read('server/src/ssr.js')
  const available = src.match(/export function ssrAvailable\(\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.match(available, /primeTemplate\(\)/, '启动时没有缓存 HTML 模板')
  assert.match(available, /loadRender\(\)/, '启动时没有预加载 SSR 渲染入口')
  assert.match(src, /if \(template !== null\) return template/, '构建时模板消失后不会退回内存副本')
  assert.match(src, /let renderPromise = null/, '并发首访可能重复导入渲染入口')
})

console.log(failed ? `\n${failed} 项失败` : '\n全部通过 ✅')
process.exit(failed ? 1 : 0)
