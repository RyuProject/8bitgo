#!/usr/bin/env node

/**
 * 验收 /web/Minecraft 的自托管客户端是否干净（不带第三方 SW、不带外链）。
 * 用法：npm run minecraft:check
 *
 * 前置：先 `npm run minecraft:fetch -- --src <构建目录>` 把客户端导进来。
 * 客户端未部署时返回非 0（仅在 operator 主动验收时报错，不进 prebuild，不会卡住主站构建）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const engineDir = join(root, 'public/web/Minecraft/eaglercraft')

const TEXT_EXT = new Set(['.html', '.htm', '.js', '.mjs', '.json', '.css', '.txt'])
const SW_REGISTER = /navigator\.serviceWorker\.register\(/i
const EXTERNAL = /https?:\/\//i

let ok = true
const fail = (msg) => { ok = false; console.error('  ✗ ' + msg) }
const warn = (msg) => console.warn('  ⚠ ' + msg)

if (!existsSync(join(engineDir, 'index.html'))) {
  console.error('[minecraft] 客户端未部署：public/web/Minecraft/eaglercraft/index.html 不存在。')
  console.error('[minecraft] 先执行：npm run minecraft:fetch -- --src <Eaglercraft 构建目录>')
  process.exit(1)
}

function textFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) { out.push(...textFiles(full)); continue }
    if (TEXT_EXT.has(full.slice(full.lastIndexOf('.')))) out.push(full)
  }
  return out
}

let swFound = 0
const externalFiles = []
for (const file of textFiles(engineDir)) {
  const txt = readFileSync(file, 'utf8')
  if (SW_REGISTER.test(txt)) { swFound++; fail(`${relative(root, file)} 仍含 serviceWorker.register`) }
  if (EXTERNAL.test(txt)) externalFiles.push(relative(root, file))
}

if (swFound === 0) console.log('  ✓ 未检测到第三方 service worker 注册')
else console.log(`  ✗ 发现 ${swFound} 处 service worker 注册`)

if (externalFiles.length) {
  warn(`以下文件含 http(s) 外链，请确认不是资源加载（玩家填的多人服务器地址是运行时输入，不在此列）：`)
  externalFiles.forEach((f) => warn('  - ' + f))
} else {
  console.log('  ✓ 未发现 http(s) 外链')
}

console.log('[minecraft] ' + (ok ? '验收通过' : '验收未通过'))
process.exit(ok ? 0 : 1)
