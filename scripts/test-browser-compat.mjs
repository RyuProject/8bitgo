/**
 * 浏览器兼容回归：守住构建下限和几条最容易重新写回去的「现代 API 直调」。
 *
 * 用法：
 *   npm run test:browser-compat
 *   npm run test:browser-compat -- --dist   # 客户端构建后再验 legacy 标签和产物
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cssEscape } from '../src/lib/cssEscape.ts'

const root = new URL('..', import.meta.url).pathname
const read = (file) => readFileSync(join(root, file), 'utf8')

const config = read('vite.config.ts')
for (const target of [
  'Chrome >= 64',
  'ChromeAndroid >= 64',
  'Edge >= 79',
  'Firefox >= 67',
  'Safari >= 12',
  'iOS >= 12',
  'Samsung >= 9',
]) {
  assert.ok(config.includes(`'${target}'`), `旧浏览器构建漏了目标：${target}`)
}
assert.match(config, /additionalLegacyPolyfills:[\s\S]*'wicg-inert'/)
assert.match(config, /additionalLegacyPolyfills:[\s\S]*'abortcontroller-polyfill\/dist\/polyfill-patch-fetch'/)
assert.match(config, /cssTarget:\s*LEGACY_CSS_TARGETS/)

const css = read('src/index.css')
assert.match(css, /min-height:\s*100vh;\s*min-height:\s*100dvh;/)
assert.match(css, /@supports not \(height:\s*100dvh\)/)

const hScroll = read('src/components/ui/HScroll.tsx')
assert.match(hScroll, /typeof ResizeObserver === 'function'/)
assert.match(hScroll, /window\.addEventListener\('resize', update/)

const mediaQuery = read('src/lib/mediaQuery.ts')
assert.match(mediaQuery, /typeof media\.addEventListener === 'function'/)
for (const file of [
  'src/components/layout/ShellContext.tsx',
  'src/lib/motion.ts',
  'src/emulator/EmulatorPlayer.tsx',
]) {
  assert.doesNotMatch(read(file), /\b(?:mq|media)\.addEventListener\('change'/, `${file} 绕过了旧 Safari 媒体查询退路`)
}

for (const file of [
  'src/emulator/adapters/ppsspp.ts',
  'src/emulator/adapters/html5.ts',
  'src/emulator/adapters/dolphin.ts',
]) {
  assert.doesNotMatch(read(file), /\.replaceChildren\(/, `${file} 又用了 Safari 13.1 才有的 replaceChildren`)
}

const sources = [
  'src/components/tv/FocusScope.tsx',
  'src/components/game/SortableGameGrid.tsx',
].map(read).join('\n')
assert.doesNotMatch(sources, /CSS\.escape\(/, '业务组件不要直调 CSS.escape，旧电视内核没有它')
assert.equal(cssEscape('a"b'), 'a\\"b')
assert.equal(cssEscape('1abc'), '\\31 abc')

if (process.argv.includes('--dist')) {
  const htmlFile = join(root, 'dist/client/index.html')
  assert.ok(existsSync(htmlFile), '没有 dist/client/index.html；请先跑客户端构建')
  const html = readFileSync(htmlFile, 'utf8')
  assert.match(html, /nomodule/, '构建产物没有旧浏览器 nomodule 入口')
  assert.match(html, /vite-legacy-polyfill/, '构建产物没有 legacy polyfill 入口')

  const polyfillUrl = html.match(/id="vite-legacy-polyfill"[^>]+src="([^"]+)"/)?.[1]
  assert.ok(polyfillUrl, '找不到 legacy polyfill 文件地址')
  const polyfills = readFileSync(join(root, 'dist/client', polyfillUrl.replace(/^\//, '')), 'utf8')
  assert.match(polyfills, /AbortController/, '旧浏览器补丁包漏了 AbortController / fetch 取消支持')
  assert.match(polyfills, /inert/, '旧浏览器补丁包漏了 inert 焦点隔离')

  const legacy = [...html.matchAll(/<script[^>]+src="([^"]+-legacy-[^"]+\.js)"/g)].map((m) => m[1])
  assert.ok(legacy.length > 0, '构建产物没有 legacy JS chunk')
  for (const url of legacy) {
    const file = join(root, 'dist/client', url.replace(/^\//, ''))
    assert.ok(existsSync(file), `HTML 指向了不存在的 legacy chunk：${url}`)
  }
}

console.log(`✅ 浏览器兼容回归通过${process.argv.includes('--dist') ? '（含生产产物）' : ''}`)
