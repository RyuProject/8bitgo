#!/usr/bin/env node
/**
 * 构建后核对懒加载的导入图（postbuild:client；也可 `node scripts/check-lazy-imports.mjs --dist <目录>`）。
 *
 * 2026-11-19「页面懒加载模块导入失败」复盘（AGENTS.md §2.39）：详情页一次要拉 21 个 chunk，任何一个依赖请求失败一次，
 * 失败就被本页模块表记住、整页坏掉。这里把能在构建时看出来的问题挡在发布前：
 *   1. 每个懒加载目标（现代包 `import("./X.js")`、legacy 包 `.import("./X-legacy-….js")`）都在磁盘上，
 *      现代包的目标连同它的静态依赖闭包都在 SHA-256 清单里（少一个文件就是线上必坏的懒加载）；
 *   2. 抗失败的预加载助手（scripts/lib/vite-resilient-preload.mjs）确实进了现代包 —— Vite 升级把补丁冲掉时构建就红；
 *   3. 扇出预算：一个懒加载目标在首屏之外要多拉多少个 chunk。超过上限多半是有人引入了一大串新依赖，
 *      在弱网上每多一个请求就多一个失败点（Safari / Firefox 没有预加载重试）；
 *   4. 首屏预算：入口静态依赖闭包的总字节数。调整分包（codeSplitting.groups）时最容易把懒加载才用的代码拖进首屏
 *      —— 2026-11-19 试过把懒加载的小共享模块合并，首屏从 644KB 涨到 1016KB，就是这一条要拦的。
 * 预算不是性能目标，只是「明显变坏」的报警线；真要放宽，改这里的常量并在提交里写清为什么。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { RESILIENT_PRELOAD_MARKER, PRELOAD_FAILURE_PROP } from './lib/vite-resilient-preload.mjs'

/** 单个懒加载目标在首屏之外最多再拉多少个 chunk（2026-11-19：最多 29 个，emulatorjs 适配器） */
export const MAX_LAZY_FANOUT = 40
/** 首屏（入口静态依赖闭包）最多多少字节（2026-11-19：约 644KB，未压缩） */
export const MAX_ENTRY_CLOSURE_BYTES = 820 * 1024

const MODERN_DYNAMIC_IMPORT = /\bimport\(\s*[`'"]\.\/([\w.-]+\.js)[`'"]\s*\)/g
const LEGACY_DYNAMIC_IMPORT = /\.import\(\s*[`'"]\.\/([\w.-]+-legacy-[\w.-]+\.js)[`'"]\s*\)/g

export function analyzeLazyImports(dist) {
  const assets = path.join(dist, 'assets')
  const problems = []
  const html = readFileSync(path.join(dist, 'index.html'), 'utf8')
  const entry = /<script[^>]*type="module"[^>]*src="\/assets\/(index-[\w-]+\.js)"/.exec(html)?.[1]
  if (!entry) return { problems: ['index.html 里找不到现代版入口脚本'], targets: [], entryBytes: 0 }
  const manifestName = `integrity-${entry.slice('index-'.length, -'.js'.length)}.json`
  const manifestPath = path.join(assets, manifestName)
  if (!existsSync(manifestPath)) return { problems: [`缺 assets/${manifestName}`], targets: [], entryBytes: 0 }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const files = manifest.files ?? {}
  const imports = manifest.imports ?? {}
  const size = (name) => (existsSync(path.join(assets, name)) ? statSync(path.join(assets, name)).size : 0)
  const closure = (name, seen = new Set()) => {
    if (seen.has(name)) return seen
    seen.add(name)
    for (const dep of imports[name] ?? []) closure(dep, seen)
    return seen
  }
  const entryClosure = closure(entry)
  const entryBytes = [...entryClosure].reduce((sum, name) => sum + size(name), 0)
  if (entryBytes > MAX_ENTRY_CLOSURE_BYTES) {
    problems.push(`首屏静态依赖闭包 ${Math.round(entryBytes / 1024)}KB，超过预算 ${Math.round(MAX_ENTRY_CLOSURE_BYTES / 1024)}KB（懒加载才用的代码被拖进首屏了？）`)
  }

  const jsFiles = readdirSync(assets).filter((name) => name.endsWith('.js'))
  const modernTargets = new Map()
  const legacyTargets = new Map()
  let helperFound = false
  for (const name of jsFiles) {
    const source = readFileSync(path.join(assets, name), 'utf8')
    const legacy = name.includes('-legacy-')
    if (!legacy && source.includes(RESILIENT_PRELOAD_MARKER) && source.includes(PRELOAD_FAILURE_PROP)) helperFound = true
    for (const match of source.matchAll(legacy ? LEGACY_DYNAMIC_IMPORT : MODERN_DYNAMIC_IMPORT)) {
      const map = legacy ? legacyTargets : modernTargets
      if (!map.has(match[1])) map.set(match[1], new Set())
      map.get(match[1]).add(name)
    }
  }
  if (!helperFound) {
    problems.push('现代包里找不到抗失败的预加载助手（scripts/lib/vite-resilient-preload.mjs 没生效？Vite 升级改了助手写法？）')
  }

  const targets = []
  for (const [target, importers] of modernTargets) {
    const from = [...importers].slice(0, 2).join('、')
    if (!existsSync(path.join(assets, target))) {
      problems.push(`懒加载目标 ${target} 不在磁盘上（${from} 引用）`)
      continue
    }
    if (!files[target]) {
      problems.push(`懒加载目标 ${target} 不在 SHA-256 清单里（${from} 引用）`)
      continue
    }
    const deps = [...closure(target)]
    for (const dep of deps) {
      if (!files[dep] || !existsSync(path.join(assets, dep))) problems.push(`${target} 的静态依赖 ${dep} 缺失`)
    }
    const extra = deps.filter((dep) => !entryClosure.has(dep))
    const fanout = extra.length
    targets.push({ target, fanout, bytes: extra.reduce((sum, dep) => sum + size(dep), 0) })
    if (fanout > MAX_LAZY_FANOUT) problems.push(`${target} 在首屏之外要拉 ${fanout} 个 chunk，超过预算 ${MAX_LAZY_FANOUT}`)
  }
  for (const [target, importers] of legacyTargets) {
    if (!existsSync(path.join(assets, target))) problems.push(`legacy 懒加载目标 ${target} 不在磁盘上（${[...importers][0]} 引用）`)
  }
  if (!modernTargets.size) problems.push('现代包里一个懒加载目标都没找到：识别规则过期了？')
  targets.sort((a, b) => b.fanout - a.fanout)
  return { problems, targets, entryBytes, legacyTargets: legacyTargets.size }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const flag = process.argv.indexOf('--dist')
  const dist = flag > 0 && process.argv[flag + 1] ? path.resolve(process.argv[flag + 1]) : path.join(root, 'dist', 'client')
  const result = analyzeLazyImports(dist)
  if (result.problems.length) {
    for (const problem of result.problems) console.error(`✗ 懒加载导入图：${problem}`)
    process.exit(1)
  }
  const top = result.targets.slice(0, 3).map((t) => `${t.target.replace(/-[\w-]{8}\.js$/, '')} ${t.fanout} 个`).join('、')
  console.log(`✓ 懒加载导入图：${result.targets.length} 个现代 / ${result.legacyTargets} 个 legacy 懒加载目标都在；首屏 ${Math.round(result.entryBytes / 1024)}KB；扇出最多：${top}；预加载助手已换上`)
}
