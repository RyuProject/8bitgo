// 8bitgo.com 上的大陆访客从 EdgeOne 取静态 / 只读 API（server/src/cn-edge.js + shared/cover-cdn-hint.js）。不联网。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cnEdgeOrigin, retargetStaticToCnEdge } from '../../shared/cover-cdn-hint.js'
import { createCnEdgeMiddleware, rewriteCssFontUrls } from '../src/cn-edge.js'

let passed = 0
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`) }

assert.equal(cnEdgeOrigin('https://8bitgo.com'), 'https://cn.8bitgo.com')
assert.equal(cnEdgeOrigin('https://www.8bitgo.com/'), 'https://cn.8bitgo.com')
assert.equal(cnEdgeOrigin('http://localhost:5173'), '')
assert.equal(cnEdgeOrigin(''), '')
ok('由站点地址推出大陆加速入口')

const tpl = `<html><head>
<link rel="preload" href="/fonts/geist-pixel/a.woff2" as="font" crossorigin>
<link rel="stylesheet" href="/fonts/ark-pixel/split/faces.css" media="(hover: hover)" />
<script type="module" crossorigin src="/assets/index-A.js"></script>
<link rel="modulepreload" crossorigin href="/assets/react-B.js">
<link rel="stylesheet" crossorigin href="/assets/index-C.css">
<link rel="icon" href="/favicon.ico">
<script nomodule crossorigin id="vite-legacy-entry" data-src="/assets/index-legacy-D.js">x</script>
</head><body></body></html>`
const out = retargetStaticToCnEdge(tpl, 'https://cn.8bitgo.com')
const B = 'https://cn.8bitgo.com/_cn'
assert.match(out, /<head>\n<link rel="preconnect" href="https:\/\/cn\.8bitgo\.com" crossorigin>/)
assert.ok(out.includes(`href="${B}/fonts/geist-pixel/a.woff2"`))
assert.ok(out.includes(`src="${B}/assets/index-A.js" onerror=`), '入口脚本带同源回退')
assert.ok(out.includes(`s.src='/assets/index-A.js'`))
assert.ok(out.includes(`href="${B}/assets/react-B.js"`))
assert.ok(out.includes(`href="${B}/assets/index-C.css" onerror="this.onerror=null;this.href='/assets/index-C.css'"`))
assert.ok(out.includes(`href="${B}/fonts/ark-pixel/split/faces.css" media="(hover: hover)" onerror=`))
assert.ok(out.includes(`data-src="${B}/assets/index-legacy-D.js"`))
assert.ok(out.includes('href="/favicon.ico"'), '其它静态不动')
assert.equal(retargetStaticToCnEdge(tpl, ''), tpl)
ok('模板里的 assets / fonts 改指加速入口，入口脚本与样式表能退回同源')

assert.equal(rewriteCssFontUrls(`a{src:url('/fonts/x.woff2')}b{src:url(/fonts/y.woff2)}c{src:url("/fonts/z")}d{src:url(/img/q.png)}`),
  `a{src:url('/_cn/fonts/x.woff2')}b{src:url(/_cn/fonts/y.woff2)}c{src:url("/_cn/fonts/z")}d{src:url(/img/q.png)}`)
ok('CSS 里的 /fonts/ 改到 /_cn/fonts/（避开 EdgeOne 上没 CORS 头的旧缓存）')

// ── 中间件 ──
const dir = mkdtempSync(path.join(tmpdir(), 'cn-edge-'))
mkdirSync(path.join(dir, 'assets'))
writeFileSync(path.join(dir, 'assets', 'index-C.css'), `@font-face{src:url(/fonts/a.woff2)}`)
const mw = createCnEdgeMiddleware({ clientDir: dir, siteOrigin: 'https://8bitgo.com' })
function run(url, method = 'GET') {
  return new Promise((resolve) => {
    const headers = {}
    const res = {
      statusCode: 200,
      setHeader: (k, v) => { headers[k.toLowerCase()] = v },
      removeHeader: (k) => { delete headers[k.toLowerCase()] },
      set(obj) { for (const [k, v] of Object.entries(typeof obj === 'string' ? { [obj]: arguments[1] } : obj)) headers[k.toLowerCase()] = v; return this },
      status(c) { this.statusCode = c; return this },
      type() { return this },
      send(b) { resolve({ status: this.statusCode, headers, body: b, next: false }) },
      end() { resolve({ status: this.statusCode, headers, body: '', next: false }) },
    }
    const req = { url, method, originalUrl: url }
    mw(req, res, () => resolve({ next: true, req, headers }))
  })
}
let r = await run('/assets/x.js')
assert.equal(r.next, true); assert.equal(r.req.url, '/assets/x.js'); assert.equal(r.req.cnEdge, undefined)
r = await run('/_cn/assets/x.js')
assert.equal(r.next, true); assert.equal(r.req.url, '/assets/x.js'); assert.equal(r.req.originalUrl, '/assets/x.js')
assert.equal(r.headers['access-control-allow-origin'], 'https://8bitgo.com')
assert.equal(r.headers['cross-origin-resource-policy'], 'cross-origin')
r = await run('/_cn/api/games?x=1')
assert.equal(r.req.url, '/api/games?x=1')
assert.equal(r.headers.vary, 'Origin')
r = await run('/_cn/emulatorjs/cores/fbneo-legacy-wasm.data?v=x')
assert.equal(r.next, true); assert.equal(r.req.url, '/emulatorjs/cores/fbneo-legacy-wasm.data?v=x')
assert.equal(r.headers.vary, undefined, '静态文件不带 Vary: Origin，预热与 <script> 共用一条缓存')
assert.equal(r.headers['access-control-allow-origin'], 'https://8bitgo.com')
ok('/_cn 前缀剥掉后交给原路由，固定带 CORS / CORP 头（含模拟器引擎 / 核心）')
r = await run('/_cn/admin/x'); assert.equal(r.status, 404)
r = await run('/_cn/../server/.env'); assert.equal(r.status, 404)
r = await run('/_cn/assets/..%2f..%2fetc%2fpasswd.css'); assert.equal(r.status, 404)
ok('只放行 assets / fonts / api / emulatorjs，路径穿越 404')
r = await run('/_cn/assets/index-C.css')
assert.equal(r.status, 200); assert.equal(r.body, '@font-face{src:url(/_cn/fonts/a.woff2)}')
assert.match(r.headers['cache-control'], /immutable/)
ok('样式表现场改写字体地址')

// ── 接线 ──
const ssr = readFileSync(new URL('../src/ssr.js', import.meta.url), 'utf8')
assert.match(ssr, /coverHint === 'cn' && !cnSite\) page = retargetStaticToCnEdge/)
const api = readFileSync(new URL('../../src/services/api.ts', import.meta.url), 'utf8')
assert.match(api, /SAME_ORIGIN && method === 'GET' && !admin \? cnEdgeApiBase\(\)/, '只有只读、非后台请求走加速入口')
assert.match(api, /markCnEdgeApiFailed\(\)/)
const vite = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8')
assert.match(vite, /if \(hostType === 'html'\) return undefined[\s\S]*?return \{ relative: true \}/, 'chunk 预加载要相对引用方解析，否则大陆页面会下两遍')
assert.match(vite, /Worker-\[\\w-\]\+\\\.js\$\/\.test\(filename\)\) \{\s*return \{ runtime: `self\.location\.origin\+/, 'Worker 必须同源加载：浏览器禁止跨源 Worker')
const paths = readFileSync(new URL('../../src/emulator/paths.ts', import.meta.url), 'utf8')
assert.match(paths, /const edge = cnEdgeApiBase\(\)\s*return edge \? `\$\{edge\}\$\{EJS_PATH\}`/, '大陆访客的引擎 / 核心走加速入口')
assert.match(paths, /`\$\{ejsBase\(\)\}\$\{name\}\?v=/)
assert.match(paths, /`\$\{ejsBase\(\)\}\$\{relativePath\}\?v=/)
const ejs = readFileSync(new URL('../../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
assert.match(ejs, /EJS_pathtodata: ejsBase\(\)/)
assert.match(ejs, /if \(usedEjsEdge\) markEjsEdgeFailed\(\)\s*options\.onError/, '开局失败后自动重试退回同源')
ok('SSR / API / 构建配置 / 模拟器引擎接线')

console.log(`\n${passed} 项通过`)
