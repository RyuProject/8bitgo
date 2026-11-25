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
 *
 * 2026-11-15 起**引擎入口也按内容取版本**（emulator.min.js / css、loader.js、compression/extract7z.js、
 * localization/*.json）。以前这几份跟着手写的 EJS_RUNTIME_GENERATION 走：改了引擎忘了换代，边缘就把
 * 新 URL 之外的旧字节继续发一年（§2.5 那次「补丁打了、线上还是旧引擎」）；换了代又让没变的 css /
 * 语言包一起重下。现在 `npm run ejspatch` 打完补丁会自动重跑本脚本，构建时 --check 拦住忘了重跑的情况，
 * 手动换代这一步没有了。EJS_RUNTIME_GENERATION 只剩「存档元数据 / NDS 偏好」这类语义代号。
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ejsDir = join(root, 'public', 'emulatorjs')
const coresDir = join(ejsDir, 'cores')
/** 引擎自己的几份入口文件（相对 /emulatorjs/）；都经 paths.ts 的 ejsRuntimeAsset 拼地址 */
export const ENGINE_FILES = ['emulator.min.js', 'emulator.min.css', 'loader.js', 'compression/extract7z.js']
const target = join(root, 'src', 'emulator', 'ejsCoreVersionsData.ts')
const checkOnly = process.argv.includes('--check')

function sha(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)
}

export function computeCoreVersions() {
  const out = {}
  if (existsSync(coresDir)) {
    for (const name of readdirSync(coresDir).sort()) {
      if (name.endsWith('.data')) out[`cores/${name}`] = sha(join(coresDir, name))
    }
  }
  const meta = join(coresDir, 'metadata')
  if (existsSync(meta)) {
    for (const name of readdirSync(meta).sort()) {
      if (name.endsWith('.json')) out[`cores/metadata/${name}`] = sha(join(meta, name))
    }
  }
  for (const name of ENGINE_FILES) {
    const file = join(ejsDir, name)
    if (existsSync(file)) out[name] = sha(file)
  }
  const locales = join(ejsDir, 'localization')
  if (existsSync(locales)) {
    for (const name of readdirSync(locales).sort()) {
      if (name.endsWith('.json')) out[`localization/${name}`] = sha(join(locales, name))
    }
  }
  return out
}

/**
 * 版本化核心的大小随内容哈希一起生成，供下载器在 Fetch 拒绝时验证浏览器计时是否证明整份文件已到。
 * 只列实际 wasm 数据包；报告 JSON 和其它资源不参与这个恢复判断。
 */
export function computeCoreContentManifest() {
  const out = {}
  if (!existsSync(coresDir)) return out
  for (const name of readdirSync(coresDir).sort()) {
    if (!name.endsWith('-wasm.data')) continue
    const file = join(coresDir, name)
    out[`cores/${name}`] = { version: sha(file), bytes: statSync(file).size }
  }
  return out
}

function render(map) {
  return `/* 自动生成，勿手改：node scripts/gen-ejs-core-versions.mjs（换核心后必须重跑，见脚本头注释） */
/** 核心与引擎入口文件（相对 /emulatorjs/）→ 内容 SHA-256 前 16 位。表里没有的文件退回全局 EJS_RUNTIME_GENERATION。 */
export const EJS_CORE_VERSIONS: Readonly<Record<string, string>> = Object.freeze(${JSON.stringify(map, null, 2)})
`
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
const map = isMain ? computeCoreVersions() : null
if (!isMain) {
  /* 被测试 import 时只导出函数 */
} else if (checkOnly) {
  const current = existsSync(target) ? readFileSync(target, 'utf8') : ''
  if (current !== render(map)) {
    console.error('✖ src/emulator/ejsCoreVersionsData.ts 与 public/emulatorjs 里的核心 / 引擎文件不一致。')
    console.error('  改过 / 换过核心或引擎后必须运行：node scripts/gen-ejs-core-versions.mjs（npm run ejspatch 会自动跑）')
    process.exit(1)
  }
  console.log(`✔ 核心内容版本表与 ${Object.keys(map).length} 个文件一致`)
} else {
  writeFileSync(target, render(map))
  console.log(`写入 ${target}：${Object.keys(map).length} 个文件`)
}
