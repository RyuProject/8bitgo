#!/usr/bin/env node

/**
 * 校验 /web/terraria 的产物（prebuild / postbuild:client 都会跑）。
 *
 * 这个页面的失败形态都很安静，所以检查项都是「安静地坏掉」那一类：
 *
 *  1. **补丁掉了一处**。上游是构建产物，我们用字符串定点替换（见 patch-terraria-web.mjs）。
 *     漏一处 service worker 注册，就会给整个 8bitgo.com 装一个全局 SW；
 *     漏一处 libcurl 接线，站内请求会绕道第三方代理。这些都不会报错，只会「不太对」。
 *  2. **子路径写错**。`/_framework/dotnet.js` 这种根绝对路径在 /web/terraria 下就是 404，
 *     页面白屏且控制台只有一句含糊的模块加载失败。
 *  3. **dist 里是旧拷贝**。入口文件名不带内容哈希，肉眼分不出新旧（同 AGENTS.md §2.5）。
 *
 * `_framework/` 不在检查范围：生产中它在 R2，由 server/src/terraria.js 代理回源，
 * 本机想跑起来时把上游那份放到 public/web/terraria/_framework/（已 gitignore）即可。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { builtinWebGameFor } from '../shared/builtin-web-games.js'
import { isolatedEmbedFor } from '../shared/isolated-embeds.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = join(root, 'public/web/terraria')
const useDist = process.argv.includes('--dist')
const runtimeDir = useDist ? join(root, 'dist/client/web/terraria') : publicDir
const fail = (message) => { console.error(`✖ Terraria 检查失败：${message}`); process.exit(1) }

if (builtinWebGameFor('terraria')?.entry !== '/web/terraria') fail('内置 Web 游戏注册表没有识别 terraria')
if (isolatedEmbedFor('terraria')?.embed !== '/web/terraria') fail('terraria 没注册到隔离薄壳（SharedArrayBuffer 会不可用）')

const indexFile = join(runtimeDir, 'index.html')
if (!existsSync(indexFile)) fail(`缺少 ${indexFile}（先跑 npm run terraria:patch）`)
const index = readFileSync(indexFile, 'utf8')

if (!index.includes('<base href="/web/terraria/')) fail('index.html 缺 <base href="/web/terraria/">')
if (index.includes('canonical" href="https://terraria.mercurywork.shop')) fail('index.html 的 canonical 还指向上游站点')

// index.html 里的每个引用都要落在磁盘上。相对路径按 /web/terraria/ 解析
// （这正是 <base> 的作用，生产 URL 不带尾斜杠时"diablo 当成文件"那个坑同源）。
const referenced = []
for (const match of index.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const url = match[1].replace(/^\.\//, '')
  if (/^(?:https?:|data:|#)/.test(url)) continue
  const relative = url.startsWith('/web/terraria/') ? url.slice('/web/terraria/'.length) : url.replace(/^\//, '')
  referenced.push(relative)
}
for (const relative of referenced) {
  const file = join(runtimeDir, relative.split('?')[0])
  if (!existsSync(file) || statSync(file).size === 0) fail(`index.html 引用了不存在的文件：${relative}`)
}

const bundleFile = join(runtimeDir, 'assets/index.js')
if (!existsSync(bundleFile)) fail('缺少 assets/index.js')
const bundle = readFileSync(bundleFile, 'utf8')

// 补丁必须在位（与 patch-terraria-web.mjs 的 FORBIDDEN_AFTER_PATCH 同源）
const forbidden = [
  ['navigator.serviceWorker.register', 'service worker 注册（根作用域，绝对不能发出去）'],
  ['staging2.velzie.rip', '第三方 wisp 代理地址'],
  ['cdn.jsdelivr.net', '第三方 CDN'],
  ['Download Assets from Steam', 'Steam 下载入口'],
  ['import("/_framework/', '根绝对路径的 _framework 入口'],
  // 对外 URL 都必须在 /web/terraria 下；`/tmp`、`/dev` 那些是 Emscripten 的虚拟文件系统路径，不算。
  [/url\(\/(?!web\/terraria\/)/i, 'CSS 里的根绝对路径'],
  [/src:"\/(?!web\/terraria\/)/, 'src 指向站点根的绝对路径'],
]
for (const [pattern, label] of forbidden) {
  const hit = pattern instanceof RegExp ? pattern.test(bundle) : bundle.includes(pattern)
  if (hit) fail(`assets/index.js 里仍有${label}：${pattern}`)
}
for (const needle of ['/web/terraria/_framework/dotnet.js', '/web/terraria/backdrop.png', '/web/terraria/app.ico']) {
  if (!bundle.includes(needle)) fail(`assets/index.js 缺少 ${needle}`)
}

/*
  **必须真解析一遍**：补丁是字符串替换，删多了/删少了括号，上面的字符串检查照样全绿，
  而线上是整页白屏 + 控制台一句 `Unexpected token ')'`（这个错误真实发生过一次：
  移除 Steam 登录路由时把收尾的 `)` 留在原地）。esbuild 只解析不打包，几十毫秒。
*/
try {
  execFileSync(join(root, 'node_modules/.bin/esbuild'), [bundleFile, '--outfile=/dev/null', '--log-level=warning'], { stdio: 'pipe' })
} catch (e) {
  const detail = String(e.stderr || e.message).split('\n').slice(0, 6).join('\n')
  fail(`assets/index.js 语法错误（补丁打坏了？）：\n${detail}`)
}

for (const name of ['assets/index.css', 'app.ico', 'backdrop.png', 'logo.png', 'AndyBold.ttf']) {
  const file = join(runtimeDir, name)
  if (!existsSync(file) || statSync(file).size === 0) fail(`缺少 ${name}`)
}
// 上游的 sw.js 与 MILESTONE 是**故意不发**的；真出现在产物里说明有人整包拷了过来。
if (readdirSync(runtimeDir).includes('sw.js')) fail('产物里出现了 sw.js —— 本站不注册 service worker，别整包拷贝')

if (useDist) {
  const mismatched = []
  const walk = (relative = '') => {
    for (const entry of readdirSync(join(runtimeDir, relative), { withFileTypes: true })) {
      const next = relative ? posix.join(relative, entry.name) : entry.name
      if (entry.isDirectory()) { walk(next); continue }
      const source = join(publicDir, next)
      if (!existsSync(source) || !readFileSync(source).equals(readFileSync(join(runtimeDir, next)))) mismatched.push(next)
    }
  }
  walk()
  if (mismatched.length) fail(`${mismatched.length} 个文件与 public/web/terraria 不一致（重新 npm run build）：${mismatched.slice(0, 5).join('、')}`)
}

const frameworkNote = existsSync(join(runtimeDir, '_framework'))
  ? '_framework 就在本地（本机可直接跑）'
  : '_framework 走 R2 代理（本机要跑请把上游那份放进 public/web/terraria/_framework/）'
console.log(`✔ Terraria ${useDist ? '部署产物' : '公开目录'}完整（补丁在位、引用齐全；${frameworkNote}）`)
