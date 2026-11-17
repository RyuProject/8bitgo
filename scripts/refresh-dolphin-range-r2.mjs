#!/usr/bin/env node
/** 为 Dolphin 的远程读盘修复发布独立静态目录，避免浏览器 / CDN 混用旧 Worker。 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceDir = resolve(root, 'public/dolphin/v7e38409')
const targetDir = resolve(sourceDir, 'r2')

const copyDir = (from, to) => {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = resolve(from, entry.name)
    const target = resolve(to, entry.name)
    if (entry.isDirectory()) copyDir(source, target)
    else if (entry.isFile()) writeFileSync(target, readFileSync(source))
  }
}

if (!existsSync(resolve(sourceDir, 'src/range-backed-file.js'))) throw new Error('缺少 Dolphin Range 运行时源码')
if (existsSync(targetDir)) throw new Error('Dolphin r2 目录已存在；不可覆盖不可变运行时')
const temporary = mkdtempSync(resolve(dirname(sourceDir), '.dolphin-r2-build-'))
const working = resolve(temporary, 'r2')
try {
  copyDir(sourceDir, working)
  renameSync(working, targetDir)
  console.log('✔ Dolphin r2：同步 Range 有限超时、重试和备用线路')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
