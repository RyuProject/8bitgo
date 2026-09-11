#!/usr/bin/env node
/**
 * SSR 输出里那几条 `<link rel="preload">` 的回归测试。跑：npm run test:ssr-hoist
 *
 * 病史（2026-09-11，站长在控制台看到的）：
 *
 *     index-DuOcoNxs.js:9 Uncaught Error: Minified React error #418
 *     https://react.dev/errors/418?args[]=HTML&args[]=
 *     （Hydration failed because the server rendered HTML didn't match the client）
 *
 * 病因不在业务代码里，在 React 19 的资源提升上：它会为树里的 `<img src>` **自动生成**
 * `<link rel="preload" as="image">`。流式渲染会把这些提进 `<head>`，而同步的
 * `renderToString` 手里没有 document，只能原样吐在返回字符串最前面 → 落进 `#root`。
 * 客户端 hydrate 时 React 又照规矩把它们提到 `<head>`，于是 `#root` 的头几个子节点
 * 服务端有、客户端没有。线上实测：SSR 的 #root 有 6 个子节点，浏览器里只有 2 个，
 * 差的正是 logo 和「随机游戏」按钮那三张 SVG 的 4 条 preload。
 *
 * ⚠️ 这个 bug**不会让页面看起来坏掉** —— React 把整棵树推倒重建一次，用户只觉得
 * 首屏慢半拍。也就是说没有这组断言，改回去谁都不会发现。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitHoistedHead } from '../src/services/seo.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const code = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ❌ ${name}\n     ${e.message}`)
  }
}

/** 09-11 线上那一份的原样（4 条 preload + 正文） */
const REAL = '<link rel="preload" as="image" href="/ui/logo-8bitgo.png"/>'
  + '<link rel="preload" as="image" href="/ui/random-button/left.svg"/>'
  + '<link rel="preload" as="image" href="/ui/random-button/middle.svg"/>'
  + '<link rel="preload" as="image" href="/ui/random-button/right.svg"/>'
  + '<div aria-hidden="true" class="pointer-events-none"></div><div class="min-h-dvh"></div>'

console.log('一、摘出来')

check('线上那一份：4 条 preload 全摘走，正文一字不动', () => {
  const { hoisted, body } = splitHoistedHead(REAL)
  assert.equal(hoisted.length, 4, `摘到 ${hoisted.length} 条`)
  assert.ok(hoisted.every((t) => t.startsWith('<link rel="preload"')), hoisted.join('\n'))
  assert.ok(body.startsWith('<div aria-hidden'), `正文被切坏了：${body.slice(0, 60)}`)
  assert.ok(!body.includes('<link'), '正文里还留着 link')
})

check('没有可摘的就原样返回（大多数页面走这一支）', () => {
  const plain = '<div class="min-h-dvh">hi</div>'
  const { hoisted, body } = splitHoistedHead(plain)
  assert.equal(hoisted.length, 0)
  assert.equal(body, plain)
})

check('meta 也收（React 提升的不止 link）', () => {
  const { hoisted, body } = splitHoistedHead('<meta name="x" content="1"/><div>a</div>')
  assert.deepEqual(hoisted, ['<meta name="x" content="1"/>'])
  assert.equal(body, '<div>a</div>')
})

console.log('二、不该多摘的一律不摘')

check('⚠️ 只从开头连续地摘，不全文扫描', () => {
  /*
    全文扫的话，正文中间任何一个 <link> 都会被搬进 head —— 那是**内容丢失**，
    比多一次 hydration 警告严重得多，而且同样不会报错。
  */
  const mid = '<div>a</div><link rel="preload" as="image" href="/x.png"/><div>b</div>'
  const { hoisted, body } = splitHoistedHead(mid)
  assert.equal(hoisted.length, 0, '把正文中间的 link 也摘走了')
  assert.equal(body, mid, '正文被改动了')
})

check('⚠️ <title> 故意不收（head.title 已经有一个了）', () => {
  const withTitle = '<title>不该被搬走</title><div>a</div>'
  const { hoisted, body } = splitHoistedHead(withTitle)
  assert.equal(hoisted.length, 0, '收了 title，页面会出现两个 <title>')
  assert.equal(body, withTitle)
})

check('摘到第一个非 head 标签就停', () => {
  const { hoisted, body } = splitHoistedHead('<link rel="a"/><div>x</div><meta name="y"/>')
  assert.equal(hoisted.length, 1)
  assert.equal(body, '<div>x</div><meta name="y"/>')
})

console.log('三、entry-server 真的用上了')

check('⚠️ entry-server 把摘出来的塞进 head.tags，并且返回摘完的正文', () => {
  const src = code('src/entry-server.tsx')
  assert.match(src, /splitHoistedHead\(/, '根本没调用')
  assert.match(src, /head\.tags\.push\(\.\.\.hoisted\)/, '摘出来了却没放进 head —— 那 4 条 preload 就凭空消失了')
  assert.match(src, /return \{ html: body,/, '还在返回未摘的 html，等于没修')
})

check('⚠️ 提升发生在 renderToString 这条路上才需要这个补丁', () => {
  // 哪天换成 renderToPipeableStream，React 自己就会把这些放进 head，
  // 这块补丁就该整段删掉（留着会把流式渲染吐的正文头部误判）
  const src = code('src/entry-server.tsx')
  assert.match(src, /renderToString/, '渲染方式换了，splitHoistedHead 这块要重新评估')
})

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过 ✅')
process.exit(failed ? 1 : 0)
