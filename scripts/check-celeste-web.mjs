#!/usr/bin/env node

/**
 * 校验 /web/celeste 的产物（prebuild / postbuild:client 都会跑）。
 *
 * 与 check-terraria-web.mjs 同一套思路 —— 这个页面的失败形态都很安静，检查项全是
 * 「安静地坏掉」那一类：
 *
 *  1. **补丁掉了一处**。上游是构建产物，scripts/patch-celeste-web.mjs 做定点替换。
 *     漏掉 fetch/WebSocket 劫持的还原，站内请求会绕道第三方 wisp 中继；漏掉统计脚本，
 *     每个访客都会向 a.r58playz.dev 发数据。这些都不会报错，只会「不太对」。
 *  2. **子路径写错**。没有 `<base href>` 时 `/web/celeste`（无尾斜杠）下
 *     `./assets/...` 会解析到 `/web/assets/...` → 404 → 页面白屏且只有一句含糊报错。
 *  3. **dist 里是旧拷贝**。入口文件名不带内容哈希，肉眼分不出新旧（同 AGENTS.md §2.5）。
 *
 * `_framework/` 不在检查范围：生产中它在 R2，由 server/src/celeste.js 代理回源，
 * 本机想跑就把上游那份放进 public/web/celeste/_framework/（已 gitignore）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { builtinWebGameFor } from '../shared/builtin-web-games.js'
import { isolatedEmbedFor } from '../shared/isolated-embeds.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = join(root, 'public/web/celeste')
const useDist = process.argv.includes('--dist')
const runtimeDir = useDist ? join(root, 'dist/client/web/celeste') : publicDir
const fail = (message) => { console.error(`✖ Celeste 检查失败：${message}`); process.exit(1) }

if (builtinWebGameFor('celeste')?.entry !== '/web/celeste') fail('内置 Web 游戏注册表没有识别 celeste')
if (isolatedEmbedFor('celeste')?.embed !== '/web/celeste') fail('celeste 没注册到隔离薄壳（SharedArrayBuffer 会不可用）')

const indexFile = join(runtimeDir, 'index.html')
if (!existsSync(indexFile)) fail(`缺少 ${indexFile}（先跑 npm run celeste:patch）`)
const index = readFileSync(indexFile, 'utf8')

if (!index.includes('<base href="/web/celeste/">')) fail('index.html 缺 <base href="/web/celeste/">')
if (index.includes('colonthree') || index.includes('a.r58playz.dev')) fail('index.html 还带着第三方统计脚本')
if (index.includes('celeste.r58playz.dev')) fail('index.html 的 canonical 还指向上游站点')

// index.html 里的每个引用都要落在磁盘上。相对路径按 /web/celeste/ 解析（<base> 的作用）。
const referenced = []
for (const match of index.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const url = match[1].replace(/^\.\//, '')
  if (/^(?:https?:|data:|#)/.test(url)) continue
  const relative = url.startsWith('/web/celeste/') ? url.slice('/web/celeste/'.length) : url.replace(/^\//, '')
  referenced.push(relative)
}
for (const relative of referenced) {
  const file = join(runtimeDir, relative.split('?')[0])
  if (!existsSync(file) || statSync(file).size === 0) fail(`index.html 引用了不存在的文件：${relative}`)
}

const assetsDir = join(runtimeDir, 'assets')
const bundles = existsSync(assetsDir) ? readdirSync(assetsDir).filter((n) => /^index-.+\.js$/.test(n)) : []
if (bundles.length !== 1) fail(`assets/ 下应有且只有一个 index-<hash>.js，实际：${bundles.join(', ') || '(无)'}`)

const bundleFile = join(assetsDir, bundles[0])
const bundle = readFileSync(bundleFile, 'utf8')

// 补丁必须在位（与 patch-celeste-web.mjs 的收尾断言同源）
for (const forbidden of ['anura.pro', '__celestewasm_wisp_proxy_ws__', 'colonthree']) {
  if (bundle.includes(forbidden)) fail(`bundle 里仍有「${forbidden}」（补丁掉了，重跑 npm run celeste:patch）`)
}
if (bundle.includes('window.fetch=async')) fail('window.fetch 覆盖还在（native fetch 会被劫持到 wisp 中继）')
if (!bundle.includes('window.fetch=nativefetch')) fail('bundle 缺少 window.fetch=nativefetch 标记（补丁掉了）')
if (!bundle.includes('window.WebSocket=WebSocket')) fail('bundle 缺少 window.WebSocket=WebSocket 标记（wisp WebSocket 劫持还原掉了）')
if (!bundle.includes('wss://127.0.0.1:9')) fail('bundle 缺少 wisp 黑洞地址标记（补丁掉了）')

// 补丁之后的产物必须真解析一遍：字符串替换极易把压缩代码改出语法错误，
// 浏览器只报一句 Unexpected token 且上面所有字符串检查照样全绿。
execFileSync(join(root, 'node_modules/.bin/esbuild'), [bundleFile, '--outfile=/dev/null', '--log-level=warning'], { stdio: 'pipe' })

console.log(`✔ Celeste 检查通过（${useDist ? 'dist' : 'public'}，${bundles[0]} 已解析）`)
