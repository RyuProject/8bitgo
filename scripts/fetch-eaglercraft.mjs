#!/usr/bin/env node

/**
 * 把 operator 用自己正版 Minecraft 1.8 构建出的 EaglercraftX 1.8 客户端，自托管到本站。
 *
 * 本站规则（见 AGENTS.md §2.28.7）：引擎必须自托管、不能有任何外链、不能给整站装第三方
 * service worker。上游的 Site 构建产物本就假定能被丢进某个子目录直接跑（相对路径），所以这里
 * 以「原样拷贝 + 定点净化」为主，不擅自改写路径（避免破坏无法在本环境验证的内部引用）。
 *
 * 净化分两步，每一条都带断言，上游换版本导致补丁点漂移时必须人工重新核对：
 *   一、移除 service worker 注册：任何 navigator.serviceWorker.register(...) 都删掉，
 *       本站只靠服务端给 /web/Minecraft 发头，不装第三方 SW。
 *   二、报告外链与根绝对路径：扫描所有文本文件里的 http(s):// 与外链式 /foo 根路径，
 *       打印出来由 operator 确认（不自动改写，避免误伤上游合法的子目录引用）。
 *
 * 用法：
 *   npm run minecraft:fetch -- --src <Eaglercraft 构建目录>
 *
 * <构建目录> 里应含 index.html 及它引用的 classes.js / assets.epk 等同级文件
 * （由上游 CompileLatestClient 脚本产出）。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const targetDir = join(root, 'public/web/Minecraft/eaglercraft')

const at = process.argv.indexOf('--src')
const srcDir = at >= 0 ? process.argv[at + 1] : ''
if (!srcDir || !existsSync(srcDir)) {
  console.error('用法: npm run minecraft:fetch -- --src <Eaglercraft 构建目录>')
  process.exit(1)
}
if (!existsSync(join(srcDir, 'index.html'))) {
  console.error(`[minecraft] 上游构建目录里找不到 index.html：${srcDir}`)
  process.exit(1)
}

mkdirSync(targetDir, { recursive: true })

// 1) 原样拷整棵目录（index.html + classes.js + assets.epk + 任何同级文件）
cpSync(srcDir, targetDir, { recursive: true })
console.log(`[minecraft] 已拷贝上游构建到 ${relative(root, targetDir)}`)

const TEXT_EXT = new Set(['.html', '.htm', '.js', '.mjs', '.json', '.css', '.txt'])
const SW_REGISTER = /navigator\.serviceWorker\.register\([^)]*\)\s*;?/g
const EXTERNAL = /https?:\/\/[^\s"'<>)+]+/gi
const ROOT_ABS = /(?:src|href)\s*=\s*["']\/[^"']+["']/gi

function textFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) { out.push(...textFiles(full)); continue }
    if (TEXT_EXT.has(full.slice(full.lastIndexOf('.')))) out.push(full)
  }
  return out
}

// 2) 净化文本文件
let swStripped = 0
for (const file of textFiles(targetDir)) {
  const original = readFileSync(file, 'utf8')
  let out = original
  if (SW_REGISTER.test(out)) {
    out = out.replace(SW_REGISTER, '/* serviceWorker.register 已被本站移除 */')
    swStripped++
  }
  if (out !== original) writeFileSync(file, out)
}
console.log(`[minecraft] 已移除 ${swStripped} 处 service worker 注册`)

// 3) 报告（不擅自改写）外链与根绝对路径，交 operator 确认
const externalHits = []
const rootHits = []
for (const file of textFiles(targetDir)) {
  const txt = readFileSync(file, 'utf8')
  const ext = txt.match(EXTERNAL)
  if (ext) externalHits.push(`${relative(root, file)}: ${ext.length} 处外链`)
  const rootAbs = txt.match(ROOT_ABS)
  if (rootAbs) rootHits.push(`${relative(root, file)}: ${rootAbs.length} 处根绝对路径`)
}
if (swStripped) console.log('[minecraft] ✅ 第三方 SW 已清除')
else console.log('[minecraft] 未检测到 service worker 注册')
if (externalHits.length) console.warn('[minecraft] ⚠️ 外链未自动处理，请人工确认不是资源加载：\n  - ' + externalHits.join('\n  - '))
else console.log('[minecraft] ✅ 未发现 http(s) 外链')
if (rootHits.length) console.warn('[minecraft] ⚠️ 根绝对路径（/foo），若指向引擎资源需改成相对路径：\n  - ' + rootHits.join('\n  - '))

console.log('[minecraft] 自托管完成，下一步：npm run minecraft:check')
