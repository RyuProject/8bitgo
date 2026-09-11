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
import { readdirSync, readFileSync, statSync } from 'node:fs'
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

console.log('四、useState 的初始化不许读浏览器状态')

/*
  #418 不止一种来法。上面三节修的是 React 19 资源提升那一种；这一节盯的是更常见的另一种：

    const [collapsed] = useState(readCollapsed)   // readCollapsed 读 localStorage

  useState 的初始化函数是在 **hydrate 的第一次渲染**里跑的。它要是读了 localStorage /
  matchMedia 这类只有浏览器才有的东西，服务端渲出来的 HTML 和客户端第一次渲染就必然不同。
  阴险的地方在于它**只对改过那个设置的人触发** —— 站长自己点开首页一切正常，
  而收起过侧栏的访客每次都在吃一次整树重建。ShellContext 就是这么来的（09-11 修）。

  所以这里不是钉某一处，是扫全仓库：任何 useState 的初始化函数只要碰浏览器全局，
  要么改掉，要么在下面的白名单里写清楚**为什么它不会被 SSR 渲染**。
*/
const BROWSER_GLOBAL = /\b(localStorage|sessionStorage|matchMedia|navigator|document|window)\b/

/** 例外：必须写明为什么安全，不能只写「没事」 */
const ALLOWED = new Map([
  [
    'src/emulator/LiveControls.tsx:readPrivate',
    '只有 status === "running" 之后才挂载（EmulatorPlayer 里那个条件渲染），SSR 的 HTML 里没有它；'
      + '而且这个值管的是「不公开直播」，改成 effect 补读会让私密局先推出去一帧',
  ],
])

function tsFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...tsFiles(full))
    else if (/\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

/** 从 `at` 往后取第一个花括号块（用来看一个函数体里有没有碰浏览器全局） */
function blockAt(src, at) {
  const start = src.indexOf('{', at)
  if (start < 0) return ''
  let depth = 0
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  return src.slice(start)
}

function scanHydrationUnsafeInitializers() {
  const hits = []
  for (const file of tsFiles(path.join(ROOT, 'src'))) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/')
    const src = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

    // 这个文件里哪些函数碰了浏览器全局
    const clientOnly = new Set()
    for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g))
      if (BROWSER_GLOBAL.test(blockAt(src, m.index))) clientOnly.add(m[1])
    for (const m of src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g))
      if (BROWSER_GLOBAL.test(blockAt(src, m.index))) clientOnly.add(m[1])

    for (const m of src.matchAll(/useState[^(]*\(([^)]*)\)/g)) {
      const arg = (m[1] || '').trim()
      if (!arg) continue
      const inline = BROWSER_GLOBAL.test(arg)
      if (!inline && !clientOnly.has(arg)) continue
      const line = src.slice(0, m.index).split('\n').length
      const key = `${rel}:${inline ? arg : arg}`
      hits.push({ key, rel, line, arg, inline })
    }
  }
  return hits
}

check('⚠️ 全仓库扫描：没有 useState 在初始化里读浏览器状态', () => {
  const bad = scanHydrationUnsafeInitializers().filter((h) => !ALLOWED.has(h.key))
  assert.equal(
    bad.length,
    0,
    '这些会在 hydrate 第一次渲染时读到服务端没有的值 → #418：\n     '
      + bad.map((h) => `${h.rel}:${h.line}  useState(${h.arg})`).join('\n     ')
      + '\n     改法：useState 里放和 SSR 一致的默认值，真正的值在 useEffect 里补读。'
      + '\n     确实不会被 SSR 渲染的，写进 ALLOWED 并说明理由。',
  )
})

check('⚠️ 白名单本身不许长草', () => {
  // 白名单里的条目如果已经不存在了（函数改名 / 组件删了），要及时清掉，
  // 否则下一个同名函数会白白继承这份豁免。
  const live = new Set(scanHydrationUnsafeInitializers().map((h) => h.key))
  const stale = [...ALLOWED.keys()].filter((k) => !live.has(k))
  assert.equal(stale.length, 0, `白名单里这些已经不存在了，删掉：${stale.join(', ')}`)
})

check('ShellContext 的侧栏折叠是在 effect 里补读的', () => {
  const src = code('src/components/layout/ShellContext.tsx')
  // ⚠️ 别写成 assert.match(src, /useState\(false\)/) —— 这文件里 mobileOpen / immersive
  // 本来就是 useState(false)，那条断言在改回旧写法之后照样通过（空断言）。
  assert.ok(
    !/useState[^(]*\(\s*readCollapsed\s*\)/.test(src),
    '又改回 useState(readCollapsed) 了：初始化函数会在 hydrate 第一次渲染里跑',
  )
  assert.match(src, /useEffect\(\(\) => \{\s*setCollapsedState\(readCollapsed\(\)\)/, '没有在 effect 里补读')
})

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过 ✅')
process.exit(failed ? 1 : 0)
