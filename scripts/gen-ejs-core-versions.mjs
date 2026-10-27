#!/usr/bin/env node
/**
 * 给每个 EmulatorJS 核心文件算内容版本号，写进 src/emulator/ejsCoreVersionsData.ts。
 *
 * 为什么：以前核心 URL 的 `?v=` 一律是全局的 EJS_RUNTIME_GENERATION。任何一次引擎或单个核心的
 * 改动（一周里换了 6 代：melonDS、PS1、MAME 胶水……）都会让**所有**核心的 URL 一起变 ——
 * FBNeo 玩家要为一次 MAME 修复重新下载 8MB、重新 7z 解压，mame-current 玩家要重走 37MB + 242MB；
 * Cloudflare 边缘缓存也一起作废。按文件内容取版本后，只有真正变了的核心才换 URL。
 *
 * 用法：node scripts/gen-ejs-core-versions.mjs          重新生成
 *       node scripts/gen-ejs-core-versions.mjs --check  只校验（check-emulatorjs 会调用）
 *
 * ⚠️ 换核心 / 重打核心包后必须重新生成；--check 发现表与文件不一致会让构建失败，
 *    否则旧 URL 会把新字节当成「一年不变」的旧缓存继续发给玩家。
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const coresDir = join(root, 'public', 'emulatorjs', 'cores')
const target = join(root, 'src', 'emulator', 'ejsCoreVersionsData.ts')
const checkOnly = process.argv.includes('--check')

function sha(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)
}

export function computeCoreVersions() {
  const out = {}
  if (!existsSync(coresDir)) return out
  for (const name of readdirSync(coresDir).sort()) {
    if (name.endsWith('.data')) out[`cores/${name}`] = sha(join(coresDir, name))
  }
  const meta = join(coresDir, 'metadata')
  if (existsSync(meta)) {
    for (const name of readdirSync(meta).sort()) {
      if (name.endsWith('.json')) out[`cores/metadata/${name}`] = sha(join(meta, name))
    }
  }
  return out
}

function render(map) {
  return `/* 自动生成，勿手改：node scripts/gen-ejs-core-versions.mjs（换核心后必须重跑，见脚本头注释） */
/** 核心文件（相对 /emulatorjs/）→ 内容 SHA-256 前 16 位。表里没有的文件退回全局 EJS_RUNTIME_GENERATION。 */
export const EJS_CORE_VERSIONS: Readonly<Record<string, string>> = Object.freeze(${JSON.stringify(map, null, 2)})
`
}

const map = computeCoreVersions()
if (checkOnly) {
  const current = existsSync(target) ? readFileSync(target, 'utf8') : ''
  if (current !== render(map)) {
    console.error('✖ src/emulator/ejsCoreVersionsData.ts 与 public/emulatorjs/cores 里的文件不一致。')
    console.error('  改过 / 换过核心后必须运行：node scripts/gen-ejs-core-versions.mjs')
    process.exit(1)
  }
  console.log(`✔ 核心内容版本表与 ${Object.keys(map).length} 个文件一致`)
} else {
  writeFileSync(target, render(map))
  console.log(`写入 ${target}：${Object.keys(map).length} 个文件`)
}
