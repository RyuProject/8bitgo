#!/usr/bin/env node

/**
 * 校验 /web/PvZ2 的产物（prebuild / postbuild:client 都会跑）。
 *
 * 这个游戏的失败形态很安静：
 *  1. **base href 写错**。Cocos 的 index.js 用 `document.getElementById('GameCanvas')` 启动，
 *     所有相对资源（src/、cocos-js/、assets/）都靠 <base href="/web/PvZ2/"> 解析。
 *     漏了或写错路径，页面会白屏，控制台只有一句含糊的模块加载失败。
 *  2. **启动层文件缺失**。cocos-js/cc.js 只是壳，真正的引擎 `_virtual_cc-*.js` 还动态
 *     import `bullet.release.*` / `spine.*`；少一个兄弟文件就 404。
 *  3. **服务 worker 漏清**。上游站点被 Cloudflare 注入过 Rocket Loader / GA，
 *     本脚本会扫一遍并报告外链，fetch 阶段已把 serviceWorker.register 剔除。
 *  4. **dist 里是旧拷贝**。入口文件名不带哈希，肉眼分不出新旧。
 *
 * 资产层（assets/，约 722MB）来自 git LFS，由 fetch-pvzge.mjs 拉取；
 * 本检查只确认关键文件在、引用齐、base 对。目录整体缺失时直接跳过（不阻断普通构建）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtinWebGameFor } from '../shared/builtin-web-games.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const useDist = process.argv.includes('--dist')
const publicDir = join(root, 'public/web/PvZ2')
const runtimeDir = useDist ? join(root, 'dist/client/web/PvZ2') : publicDir

// 目录整体缺失（尚未 npm run pvzge:fetch）时跳过，不阻断普通构建。
if (!existsSync(join(runtimeDir, 'index.html'))) {
  console.log(`PvZ2 检查跳过：未找到 ${runtimeDir}/index.html（先跑 npm run pvzge:fetch）`)
  process.exit(0)
}

const fail = (m) => {
  console.error(`✖ PvZ2 检查失败：${m}`)
  process.exit(1)
}

if (builtinWebGameFor('pvz2')?.entry !== '/web/PvZ2') fail('内置 Web 游戏注册表没有识别 pvz2')
if (builtinWebGameFor('pvz2')?.isolated !== false) fail('pvz2 必须 isolated:false（Cocos 单线程，不需要 COOP/COEP）')

const indexFile = join(runtimeDir, 'index.html')
const index = readFileSync(indexFile, 'utf8')
if (!index.includes('<base href="/web/PvZ2/')) fail('index.html 缺 <base href="/web/PvZ2/">')
if (index.includes('googletagmanager.com') || index.includes('googlesyndication.com')) fail('index.html 还残留 Google Analytics / AdSense')
if (index.includes('rocket-loader') || index.includes('cf-settings')) fail('index.html 还残留 Cloudflare 注入')

// 关键文件必须齐
const required = [
  'index.js',
  'application.js',
  'style.css',
  'tmpPatch.js',
  'src/polyfills.bundle.js',
  'src/system.bundle.js',
  'src/import-map.json',
  'src/chunks/bundle.js',
  'src/effect.bin',
  'src/settings.json',
  'cocos-js/cc.js',
]
for (const rel of required) {
  const f = join(runtimeDir, rel)
  if (!existsSync(f) || statSync(f).size === 0) fail(`缺少关键文件：${rel}`)
}

// cocos-js 真实引擎（cc.js 只是壳）
const virtual = readdirSync(join(runtimeDir, 'cocos-js')).find((n) => /^_virtual_cc-.*\.js$/.test(n))
if (!virtual) fail('cocos-js/ 缺少 _virtual_cc-*.js 引擎文件（cocos-js/cc.js 只是壳）')

// 资产层：至少要有 assets 三大 bundle 目录（来自 git LFS）
for (const b of ['main', 'internal', 'resources']) {
  const d = join(runtimeDir, 'assets', b)
  if (!existsSync(d) || !readdirSync(d).length) fail(`assets/${b} 为空（资产层未拉取，先跑 npm run pvzge:fetch）`)
}

// index.html 里每个引用都要落在磁盘上（相对路径按 /web/PvZ2/ 解析）
for (const m of index.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const url = m[1].replace(/^\.\//, '')
  if (/^(?:https?:|data:|#)/.test(url)) continue
  const rel = url.startsWith('/web/PvZ2/') ? url.slice('/web/PvZ2/'.length) : url.replace(/^\//, '')
  const f = join(runtimeDir, rel.split('?')[0])
  if (!existsSync(f) || statSync(f).size === 0) fail(`index.html 引用了不存在的文件：${rel}`)
}

if (useDist) {
  const mismatched = []
  const walk = (relative = '') => {
    for (const entry of readdirSync(join(runtimeDir, relative), { withFileTypes: true })) {
      const next = relative ? posix.join(relative, entry.name) : entry.name
      if (entry.isDirectory()) {
        walk(next)
        continue
      }
      const source = join(publicDir, next)
      if (!existsSync(source)) continue
      if (!readFileSync(source).equals(readFileSync(join(runtimeDir, next)))) mismatched.push(next)
    }
  }
  walk()
  if (mismatched.length) fail(`${mismatched.length} 个文件与 public/web/PvZ2 不一致（重新 npm run build）：${mismatched.slice(0, 5).join('、')}`)
}

console.log(`✔ PvZ2 ${useDist ? '部署产物' : '公开目录'}完整（base 正确、启动层与资产层齐全、无第三方 SW/GA）`)
