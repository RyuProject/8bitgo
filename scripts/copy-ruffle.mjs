#!/usr/bin/env node
/**
 * 把 npm 包 @ruffle-rs/ruffle（Flash 运行时，MIT / Apache-2.0）复制到 public/ruffle/，
 * 供 src/runtimes/ruffle.ts 以 /ruffle/ruffle.js 加载。
 *
 *   npm run ruffle                     强制复制
 *   node scripts/copy-ruffle.mjs --if-missing   已有则跳过（dev / build 前自动执行）
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'node_modules', '@ruffle-rs', 'ruffle')
const out = join(root, 'public', 'ruffle')
const ifMissing = process.argv.includes('--if-missing')

if (ifMissing && existsSync(join(out, 'ruffle.js'))) process.exit(0)

if (!existsSync(join(src, 'ruffle.js'))) {
  const msg = '未找到 node_modules/@ruffle-rs/ruffle，请先 npm install'
  if (ifMissing) {
    console.warn(`⚠ ${msg}；Flash 游戏暂不可用`)
    process.exit(0)
  }
  console.error(`✖ ${msg}`)
  process.exit(1)
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
let n = 0
for (const name of readdirSync(src)) {
  if (name.endsWith('.map') || name === 'package.json' || name === 'README.md') continue
  copyFileSync(join(src, name), join(out, name))
  n++
}
console.log(`✔ Ruffle 已复制 ${n} 个文件到 public/ruffle/`)
