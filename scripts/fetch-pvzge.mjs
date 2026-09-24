#!/usr/bin/env node

/**
 * 自托管 PvZ2 Gardendless（Apache-2.0，上游 https://github.com/Gzh0821/pvzge_web）
 * 到本站的 /web/PvZ2。
 *
 * 上游仓库 `docs/` 只提交了「数据层」：`application.js` + `assets/`（含 LFS 大资源）。
 * 真正的「启动 / 引擎层」——`index.html`、`cocos-js/`、`src/`、`style.css`、`tmpPatch.js` 等，
 * 由 Cocos Creator 工程构建产出、并不在仓库里（线上 play.pvzge.com 那份才是完整分发）。
 * 所以本脚本分两路拼出完整、版本自洽的分发：
 *
 *   一、资产层：clone 上游仓库（带 LFS）拿 `docs/assets/` + `docs/application.js`，
 *      这是权威且可版本化的来源（引擎运行时按 `assets/<bundle>/index.js` 约定动态加载，
 *      静态爬虫抓不到这些文件，必须整目录取）。
 *   二、启动 / 引擎层：从线上 play.pvzge.com 递归抓取 `cocos-js/`、`src/` 与根文件
 *      （GC 那条 9.6KB 的 cc.js 只是壳，真正 3.3MB 的引擎 `_virtual_cc-*.js` 还动态
 *      import `bullet.release.*` / `spine.*` 等兄弟文件，必须用 BFS 把它们都找出来）。
 *
 * 最后写一份干净的 index.html（注入 <base href="/web/PvZ2/">，剔除 Cloudflare Rocket
 * Loader 注入的 `type="...-text/javascript"`、Google Analytics / AdSense / CF challenge，
 * 并审计 service worker 注册）。
 *
 * 用法：
 *   npm run pvzge:fetch                 # 完整拉取（资产 + 启动层）
 *   npm run pvzge:fetch -- --boot-only  # 只拉启动层（本地快速验证接线，不下载 722MB 资产）
 *   npm run pvzge:fetch -- --if-missing # 已存在则跳过（部署幂等）
 *   npm run pvzge:fetch -- --force      # 清掉重拉
 *
 * 环境变量：
 *   PVZGE_BASE   启动层来源，默认 https://play.pvzge.com
 *   PVZGE_UPSTREAM 资产层 git 仓库，默认 https://github.com/Gzh0821/pvzge_web.git
 *   PVZGE_REF   资产层分支/标签，默认 master
 *   PVZGE_REPO_CACHE 仓库克隆缓存目录，默认 .pvzge-repo（已在 .gitignore）
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, posix, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public/web/PvZ2')
const BASE = process.env.PVZGE_BASE || 'https://play.pvzge.com'
const UPSTREAM = process.env.PVZGE_UPSTREAM || 'https://github.com/Gzh0821/pvzge_web.git'
const REF = process.env.PVZGE_REF || 'master'
const REPO_CACHE = resolve(ROOT, process.env.PVZGE_REPO_CACHE || '.pvzge-repo')

const BOOT_ONLY = process.argv.includes('--boot-only')
const IF_MISSING = process.argv.includes('--if-missing')
const FORCE = process.argv.includes('--force')
const args = process.argv.slice(2).filter((a) => !a.startsWith('--')).reduce((m, a) => ((m[a] = true), m), {})

const log = (...a) => console.log('[pvzge]', ...a)
const warn = (...a) => console.warn('[pvzge] ⚠️', ...a)

if (IF_MISSING && !FORCE && existsSync(join(OUT, 'index.html'))) {
  log(`已存在 ${OUT}/index.html，跳过（--if-missing）。强制重拉用 --force。`)
  process.exit(0)
}
if (FORCE && existsSync(OUT)) {
  rmSync(OUT, { recursive: true, force: true })
  log('已清除旧目录（--force）')
}
mkdirSync(OUT, { recursive: true })

// ───────────── 一、资产层：git LFS 克隆 ─────────────
if (!BOOT_ONLY) {
  try {
    if (!existsSync(join(REPO_CACHE, '.git'))) {
      log(`克隆上游仓库（含 LFS 资产）到 ${REPO_CACHE} …`)
      execFileSync('git', ['clone', '--depth', '1', '-b', REF, UPSTREAM, REPO_CACHE], { stdio: 'inherit' })
    } else {
      log(`复用缓存仓库 ${REPO_CACHE}，拉取最新 + LFS …`)
      execFileSync('git', ['-C', REPO_CACHE, 'fetch', '--depth', '1', 'origin', REF], { stdio: 'inherit' })
      execFileSync('git', ['-C', REPO_CACHE, 'reset', '--hard', `origin/${REF}`], { stdio: 'inherit' })
    }
    // LFS 资产（docs/assets 约 722MB）
    execFileSync('git', ['-C', REPO_CACHE, 'lfs', 'pull'], { stdio: 'inherit' })
    const docsAssets = join(REPO_CACHE, 'docs/assets')
    const docsApp = join(REPO_CACHE, 'docs/application.js')
    if (!existsSync(docsAssets)) throw new Error(`上游仓库 docs/assets 不存在：${docsAssets}`)
    copyDir(docsAssets, join(OUT, 'assets'))
    if (existsSync(docsApp)) copyFile(docsApp, join(OUT, 'application.js'))
    log('资产层就绪：docs/assets + application.js')
  } catch (e) {
    warn(`资产层拉取失败（不影响启动层）：${e.message}`)
    warn('PvZ2 将无法加载游戏资源；请检查 git / git-lfs 是否可用，或手动把上游 docs/ 放到 public/web/PvZ2/')
  }
} else {
  log('boot-only 模式：跳过 722MB 资产层（游戏资源会 404，仅用于验证接线）')
}

// ───────────── 二、启动 / 引擎层：线上递归抓取 ─────────────
const visited = new Set()
const queue = []
const enqueue = (raw) => {
  let p = String(raw).split('?')[0].split('#')[0]
  if (!p.startsWith('/')) p = '/' + p
  if (visited.has(p)) return
  visited.add(p)
  queue.push(p)
}

// 种子：入口 + 已知启动文件（即使爬虫漏掉也能拉到）
for (const seed of [
  '/',
  '/index.js',
  '/style.css',
  '/tmpPatch.js',
  '/src/polyfills.bundle.js',
  '/src/system.bundle.js',
  '/src/import-map.json',
  '/src/chunks/bundle.js',
  '/src/effect.bin',
  '/src/settings.json',
  '/cocos-js/cc.js',
]) enqueue(seed)

const TEXT_EXT = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.json', '.css', '.txt', '.map', '.ts'])

function extractRefs(p, text, ext) {
  const dir = posix.dirname(p)
  const add = (spec) => {
    if (!spec || /^(https?:|data:|#|mailto:)/i.test(spec)) return
    let resolved
    if (spec.startsWith('/')) resolved = spec
    else if (spec.startsWith('./') || spec.startsWith('../')) resolved = posix.normalize(posix.join(dir, spec))
    else if (/^[a-z0-9._-]+$/i.test(spec)) return // 裸模块名（cc 等）由 import-map 处理
    else return
    enqueue(resolved)
  }

  if (ext === '.html') {
    for (const m of text.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) add(m[1])
    for (const m of text.matchAll(/System\.import\(\s*["']([^"']+)["']\s*\)/g)) add(m[1])
  } else if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    // System.register(["a", "b"]) 的依赖列表
    for (const block of text.matchAll(/System\.register\(\s*\[\s*([\s\S]*?)\]\s*,/g)) {
      for (const s of block[1].matchAll(/"([^"]+)"/g)) add(s[1])
    }
    for (const m of text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) add(m[1])
    for (const m of text.matchAll(/(?:import|export)\b[^'"]*?from\s*["']([^"']+)["']/g)) add(m[1])
    for (const m of text.matchAll(/import\s*["']([^"']+)["']/g)) add(m[1])
    // Emscripten 胶水里直接写死的 .wasm 文件名
    for (const m of text.matchAll(/"([A-Za-z0-9_.\-]+\.wasm)"/g)) add(posix.join(dir, m[1]))
  } else if (ext === '.json') {
    try {
      const j = JSON.parse(text)
      if (j && j.imports) for (const v of Object.values(j.imports)) add(v)
    } catch {}
  }
}

let fetched = 0
let bytes = 0
const externalHits = new Set()

async function run() {
  const CONCURRENCY = 6
  let active = 0
  await new Promise((resolveAll) => {
    const pump = () => {
      if (queue.length === 0 && active === 0) return resolveAll()
      while (queue.length && active < CONCURRENCY) {
        const p = queue.shift()
        active++
        fetchOne(p).finally(() => {
          active--
          pump()
        })
      }
    }
    pump()
  })
}

async function fetchOne(p) {
  const url = BASE + p
  try {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) {
      warn(`启动层跳过 ${p}: HTTP ${res.status}`)
      return
    }
    const buf = Buffer.from(await res.arrayBuffer())
    // `/` 落地成 index.html；其它路径去掉前导斜杠
    const rel = p === '/' ? 'index.html' : p.replace(/^\//, '')
    const outPath = join(OUT, rel)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, buf)
    fetched++
    bytes += buf.length
    const ext = extname(p).toLowerCase()
    if (TEXT_EXT.has(ext)) {
      const text = buf.toString('utf8')
      // 记录外链，便于审计（不自动改写）
      for (const m of text.matchAll(/https?:\/\/[^\s"'<>)+]+/gi)) externalHits.add(m[0])
      extractRefs(p, text, ext)
    }
  } catch (e) {
    warn(`启动层抓取失败 ${p}: ${e.message}`)
  }
}

await run()
if (fetched) log(`启动层抓取完成：${fetched} 个文件，约 ${(bytes / 1048576).toFixed(1)} MB`)

// ───────────── 三、写干净的 index.html（注入 base href，剔除污染）─────────────
writeFileSync(
  join(OUT, 'index.html'),
  `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>PvZ2 Gardendless</title>
  <meta name="viewport" content="width=device-width,user-scalable=no,initial-scale=1,minimum-scale=1,maximum-scale=1,minimal-ui=true" />
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="format-detection" content="telephone=no">
  <base href="/web/PvZ2/">
  <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
  <div id="GameDiv" cc_exact_fit_screen="true">
    <div id="Cocos3dGameContainer">
      <canvas id="GameCanvas" tabindex="99"></canvas>
    </div>
  </div>

  <script src="src/polyfills.bundle.js" charset="utf-8"></script>
  <script src="src/system.bundle.js" charset="utf-8"></script>
  <script src="src/import-map.json" type="systemjs-importmap" charset="utf-8"></script>
  <script>System.import('./index.js').catch(function (err) { console.error(err); })</script>
  <script src="tmpPatch.js" charset="utf-8"></script>
</body>
</html>
`,
)
log('已写入干净的 index.html（<base href="/web/PvZ2/">，已剔除 Cloudflare/GA 污染）')

// ───────────── 四、审计：service worker / 外链 ─────────────
auditServiceWorker()
if (externalHits.size) {
  warn(`发现 ${externalHits.size} 处 http(s) 外链，请确认不是资源加载（Cloudflare/GA 应已被剔除）：`)
  for (const u of [...externalHits].slice(0, 20)) warn('  - ' + u)
}

writeFileSync(join(OUT, '.pvzge-source'), `${BASE} | assets:${UPSTREAM}@${REF} | ${new Date().toISOString()}\n`)
log('完成。下一步：npm run pvzge:check')

// ───────────── 工具函数 ─────────────
function copyDir(src, dest) {
  execFileSync('cp', ['-R', src, dest + (dest.endsWith('/') ? '' : '/')], { stdio: 'inherit' })
}
function copyFile(src, dest) {
  mkdirSync(dirname(dest), { recursive: true })
  execFileSync('cp', [src, dest], { stdio: 'inherit' })
}

function auditServiceWorker() {
  const targets = []
  walk(OUT, targets)
  let stripped = 0
  for (const file of targets) {
    if (!TEXT_EXT.has(extname(file).toLowerCase())) continue
    const original = readFileSync(file, 'utf8')
    if (/navigator\.serviceWorker\.register\(/i.test(original)) {
      const out = original.replace(/navigator\.serviceWorker\.register\([^)]*\)\s*;?/gi, '/* serviceWorker.register 已被本站移除 */')
      if (out !== original) {
        writeFileSync(file, out)
        stripped++
      }
    }
  }
  if (stripped) log(`已移除 ${stripped} 处 service worker 注册（第三方 SW 会给整站装全局缓存，违反本站规则）`)
}

function walk(dir, out) {
  for (const entry of readdirSafe(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else out.push(full)
  }
}
function readdirSafe(dir) {
  try {
    return require('node:fs').readdirSync(dir)
  } catch {
    return []
  }
}
