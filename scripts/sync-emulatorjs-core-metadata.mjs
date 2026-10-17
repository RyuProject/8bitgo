#!/usr/bin/env node
/**
 * 给 EmulatorJS 核心报告生成一个不含 `/reports/` 的公开别名。
 *
 * 报告不是给人看的统计接口，而是引擎判断「这份核心能不能复用 IndexedDB 缓存」的
 * buildStart 元数据。部分浏览器扩展会只凭路径里的 reports 就拦截请求，导致核心缓存
 * 被静默关闭。源文件仍留在上游约定的 reports/；metadata/ 是逐字节副本，运行时只请求后者。
 *
 * 构建前每次同步，原因是 mame-current / melonDS DS 等自构建脚本会单独更新报告，
 * 不能靠开发者记得手工复制第二份。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const reports = join(root, 'public', 'emulatorjs', 'cores', 'reports')
const metadata = join(root, 'public', 'emulatorjs', 'cores', 'metadata')

if (!existsSync(reports)) {
  console.error('✖ public/emulatorjs/cores/reports/ 不存在，无法生成核心元数据别名')
  process.exit(1)
}

mkdirSync(metadata, { recursive: true })
const files = readdirSync(reports).filter((name) => name.endsWith('.json')).sort()
if (!files.length) {
  console.error('✖ cores/reports/ 里没有任何核心报告；缺报告会让引擎禁用核心缓存')
  process.exit(1)
}

for (const name of files) copyFileSync(join(reports, name), join(metadata, name))
console.log(`✔ 已同步 ${files.length} 份 EmulatorJS 核心报告到 cores/metadata/`)
