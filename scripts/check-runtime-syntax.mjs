#!/usr/bin/env node
/**
 * 全站自托管运行时的语法门禁：public/ 里每一份我们发出去的 JS（含 HTML 内联脚本）都必须能被 V8 解析。
 *
 * ── 为什么（2026-11-17 全站事故）────────────────────────────────────────
 * scripts/patch-emulatorjs.mjs 往 emulator.min.js 写进一个没转义 `/` 的正则，整份引擎模块解析失败：
 * loader.js 的 import() 拒绝，NES / SFC / GBA / 街机 / PS1 …… 所有 EmulatorJS 平台同时打不开。
 * 当时补丁检查只看「字符串在不在」，构建、tsc、lint 全绿，坏文件一路发到生产。
 *
 * 这类「脚本往第三方产物里拼字符串」的写法不止 EmulatorJS：js-dos、PPSSPP、Dolphin、J2ME、PvZ、
 * CS1.6 …… 都有自己的补丁脚本，每一个都可能以同样方式把一整个平台打挂。所以这里不按平台写，
 * 而是对所有发出去的运行时 JS 一视同仁：解析不了就让构建失败。
 *
 * 判据：
 *   - 关键入口按真实加载方式严格检查（`STRICT_MODES`）：loader.js 是经典脚本，emulator.min.js 是 ES 模块。
 *   - 其它 .js 先按经典脚本解析，不行再按 ES 模块解析，任一通过即可（只编译不执行）。
 *   - HTML 里的内联 <script>：无 type / JS type 按经典脚本，type=module 按模块，JSON 类跳过。
 *
 *   node --experimental-vm-modules scripts/check-runtime-syntax.mjs           体检 public/ + index.html
 *   node --experimental-vm-modules scripts/check-runtime-syntax.mjs --dist    体检 dist/client（构建后）
 *
 * 没带 --experimental-vm-modules 也能跑，只是模块解析退回逐个起子进程（慢一些）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { moduleSyntaxError } from './lib/js-module-syntax.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const checkDist = process.argv.includes('--dist')
const base = checkDist ? join(root, 'dist', 'client') : join(root, 'public')

/** 关键入口：按浏览器真实的加载方式解析，不接受「换一种模式能过」 */
export const STRICT_MODES = Object.freeze({
  'emulatorjs/emulator.min.js': 'module', // loader.js 用 import() 加载
  'emulatorjs/loader.js': 'script', // 适配器用 <script> 注入，依赖 document.currentScript
  'edge-route-v2.js': 'script', // index.html 的 <script src>
})

/** 不是我们发的、也不经补丁的大目录（gitignored 的第三方整站 / 运营方自备客户端） */
const SKIP_PREFIXES = Object.freeze([
  'web/PvZ2/',
  'web/Minecraft/eaglercraft/',
  'web/terraria/_framework/',
  'web/celeste/_framework/',
  'web/cs15/packs/',
  'web/cs16/packs/',
  'assets/', // dist 模式下 Vite 产物由打包器生成，必然可解析；public/assets 里的修复脚本另行列入
  // Emscripten 的构建期库源码（含 {{{ }}} 预处理宏），随上游 vendor 目录发布，浏览器从不加载
  'web/gta-vc/vendor/un7z-opfs/src-glue/',
])
/** public/assets 下手写的修复脚本仍要查（它们不经打包器） */
const ALWAYS_INCLUDE = /^assets\/asset-repair-v\d+\.js$/

/** gitignored、由 prebuild / predev 生成的运行时目录（不在 git ls-files 里，但会发到线上） */
const GENERATED_DIRS = Object.freeze(['jsdos', 'j2me', 'j2me-web'])

const JS_EXT = new Set(['.js', '.mjs', '.cjs'])
const HTML_EXT = new Set(['.html', '.htm'])

const toPosix = (p) => p.split(sep).join('/')

function trackedPublicFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', 'public'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 })
    return out.split('\0').filter(Boolean).map((p) => p.slice('public/'.length))
  } catch {
    // 没有 git（极少数部署环境）：退回直接扫 public/
    return walk(join(root, 'public')).map((p) => toPosix(relative(join(root, 'public'), p)))
  }
}

function walk(dir) {
  const out = []
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

function listTargets() {
  const rels = new Set(trackedPublicFiles())
  for (const dir of GENERATED_DIRS) {
    for (const file of walk(join(root, 'public', dir))) rels.add(toPosix(relative(join(root, 'public'), file)))
  }
  const targets = []
  for (const rel of rels) {
    const ext = extname(rel).toLowerCase()
    if (!JS_EXT.has(ext) && !HTML_EXT.has(ext)) continue
    if (!ALWAYS_INCLUDE.test(rel) && SKIP_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue
    const file = join(base, rel)
    if (!existsSync(file)) continue
    targets.push({ rel, file })
  }
  // 站点入口：源码模式查仓库根的 index.html，dist 模式查构建产物（插件改写过的那份才是线上发的）
  const entryHtml = checkDist ? join(base, 'index.html') : join(root, 'index.html')
  if (existsSync(entryHtml)) targets.push({ rel: checkDist ? 'index.html' : '(root) index.html', file: entryHtml })
  return targets.sort((a, b) => a.rel.localeCompare(b.rel))
}

const hasVmModules = typeof vm.SourceTextModule === 'function'

function scriptError(code, filename) {
  try {
    new vm.Script(code, { filename })
    return ''
  } catch (error) {
    return `${error?.name || 'Error'}: ${error?.message || error}`
  }
}

function moduleError(code, identifier) {
  if (!hasVmModules) return moduleSyntaxError(code)
  try {
    new vm.SourceTextModule(code, { identifier })
    return ''
  } catch (error) {
    return `${error?.name || 'Error'}: ${error?.message || error}`
  }
}

/** @returns {string} 空串 = 通过 */
export function checkJs(code, { mode = 'auto', name = 'inline' } = {}) {
  if (mode === 'module') return moduleError(code, name)
  if (mode === 'script') return scriptError(code, name)
  const asScript = scriptError(code, name)
  if (!asScript) return ''
  const asModule = moduleError(code, name)
  if (!asModule) return ''
  // 两种都不行：带 import / export 的报模块的错，否则报经典脚本的错
  return /\b(?:import|export)\b/.test(code) ? asModule : asScript
}

const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module', 'text/ecmascript', 'application/ecmascript'])

/** HTML 里的内联脚本；返回 [{ index, error }] */
export function checkInlineScripts(html, name = 'inline.html') {
  const problems = []
  let index = 0
  for (const match of html.matchAll(SCRIPT_TAG)) {
    index++
    const attrs = match[1] || ''
    const body = match[2] || ''
    if (/\bsrc\s*=/i.test(attrs) || !body.trim()) continue
    const type = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1] || '').toLowerCase()
    if (!JS_TYPES.has(type)) continue
    const error = checkJs(body, { mode: type === 'module' ? 'module' : 'script', name: `${name}#script${index}` })
    if (error) problems.push({ index, error })
  }
  return problems
}

function main() {
  const started = Date.now()
  const targets = listTargets()
  const failures = []
  let jsCount = 0
  let htmlCount = 0
  for (const { rel, file } of targets) {
    if (statSync(file).size > 64 * 1024 * 1024) continue
    const code = readFileSync(file, 'utf8')
    const ext = extname(file).toLowerCase()
    if (HTML_EXT.has(ext)) {
      htmlCount++
      for (const { index, error } of checkInlineScripts(code, rel)) failures.push(`${rel} 第 ${index} 个内联 <script>：${error}`)
      continue
    }
    jsCount++
    const mode = STRICT_MODES[rel] || (ext === '.mjs' ? 'module' : 'auto')
    const error = checkJs(code, { mode, name: rel })
    if (error) failures.push(`${rel}（${mode === 'auto' ? '经典脚本 / ES 模块均' : mode === 'module' ? 'ES 模块' : '经典脚本'}）：${error}`)
  }
  for (const rel of Object.keys(STRICT_MODES)) {
    if (!targets.some((t) => t.rel === rel)) failures.push(`${rel}：关键运行时入口不存在`)
  }
  const where = checkDist ? 'dist/client' : 'public/ + index.html'
  if (failures.length) {
    console.error(`✖ ${where} 里有 ${failures.length} 份运行时脚本无法解析 —— 发出去就是整个平台打不开：`)
    for (const line of failures) console.error(`  - ${line}`)
    console.error('  怎么修：多半是某个补丁脚本拼进去的字符串写坏了（正则字面量里的 `/` 没转义、引号没闭合）。')
    console.error('  找出最近改过的 scripts/patch-*.mjs / copy-*.mjs / refresh-*.mjs，修好后重跑它再构建。')
    process.exit(1)
  }
  console.log(`✔ 运行时语法门禁：${where} ${jsCount} 份 JS、${htmlCount} 份 HTML 内联脚本全部可解析（${Date.now() - started}ms）`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
