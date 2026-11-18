#!/usr/bin/env node
/**
 * 为现有 EKA2L1-WEB 二进制增加本站前端资源，不重新编译 11MB 的 WASM 核心。
 *
 * 仅适用于只改 HTML / JS 和许可源码文件的版本；C++、WASM 或 .data 有变化时必须用
 * build-eka2l1-web.mjs 完整重建。新目录仍按最终发布文件内容哈希命名，旧目录保留。
 * 随附的本站脚本见 scripts/lib/eka2l1-site-scripts.mjs。
 *
 * 补丁表里改页面（src/emu/web/pages/）和改胶水（EKA2L1_GLUE_PATCHES）的条目在这里直接打到已发布文件上；
 * 已在位的跳过，所以每次打包都顺带复核一遍。改 C++ 的新补丁这里打不了，会当场要求完整重建。
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EKA2L1_ALL_PATCHES, EKA2L1_GLUE_PATCHES, EKA2L1_PATCHES,
  applyReplacePatch, eka2l1PublishedPagePath,
} from './lib/eka2l1-patches.mjs'
import { EKA2L1_SITE_SCRIPTS, injectSiteScripts } from './lib/eka2l1-site-scripts.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const constantsFile = join(root, 'src', 'emulator', 'eka2l1Runtime.ts')
const constants = readFileSync(constantsFile, 'utf8')
const baseId = /EKA2L1_BUILD_ID = '([0-9a-f]{12})'/.exec(constants)?.[1]
if (!baseId) throw new Error('无法从 eka2l1Runtime.ts 读取当前运行时版本')
const baseDir = join(root, 'public', 'eka2l1', `v${baseId}`)
const manifestFile = join(baseDir, 'runtime.json')
if (!existsSync(manifestFile)) throw new Error(`找不到基准运行时：${baseDir}`)

const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
if (!manifest.files?.['eka2l1.wasm'] || !manifest.files?.['eka2l1.data']) {
  throw new Error('基准运行时缺少 WASM / data 清单；请先完整构建 EKA2L1')
}

const basePatches = new Set(manifest.patches || [])
for (const patch of EKA2L1_ALL_PATCHES) {
  if (basePatches.has(patch.id)) continue
  if (!eka2l1PublishedPagePath(patch.file) && !EKA2L1_GLUE_PATCHES.includes(patch)) {
    throw new Error(`补丁「${patch.id}」改的是 ${patch.file}，基准运行时里没有，重新打包打不了；请用 npm run eka2l1:build 完整重建`)
  }
}

const outIdPlaceholder = '000000000000'
const outDir = join(root, 'public', 'eka2l1', `v${outIdPlaceholder}`)
const html = injectSiteScripts(readFileSync(join(baseDir, 'index.html'), 'utf8'))

let sourceDoc = readFileSync(join(baseDir, 'SOURCE.md'), 'utf8')
// 早期版本的说明文字，换成现在的
const firmwareScript = EKA2L1_SITE_SCRIPTS[0]
const oldAddonDescription = '8BitGo 还附带 `source/scripts/eka2l1-default-firmware.js`：从本站说明页进入时，若当前浏览器尚无已安装设备，则自动取回后台配置的 N-Gage QD ROM 并调用原有固件安装流程。已有设备不会被覆盖；ROM 只保存在玩家自己的浏览器存储中。'
if (sourceDoc.includes(oldAddonDescription)) sourceDoc = sourceDoc.replace(oldAddonDescription, firmwareScript.doc)
sourceDoc = sourceDoc.replace(
  '固件（ROM / RPKG）与游戏安装包由玩家自行提供，保存在玩家本机浏览器中；8BitGo 不提供这些文件。',
  '后台管理员配置的 N-Gage QD 默认 ROM 和站内游戏包会供玩家导入；其它固件（ROM / RPKG）由玩家自行提供。导入内容保存在玩家本机浏览器中，运行时发布包本身不包含任何固件或游戏文件。',
)
sourceDoc = sourceDoc.replace(
  '仅后台管理员配置的 N-Gage QD 默认 ROM 会由站点供首次自动安装；其它固件（ROM / RPKG）和游戏安装包由玩家自行提供，内容保存在玩家本机浏览器中。运行时发布包不包含任何固件或游戏文件。',
  '后台管理员配置的 N-Gage QD 默认 ROM 和站内游戏包会供玩家导入；其它固件（ROM / RPKG）由玩家自行提供。导入内容保存在玩家本机浏览器中，运行时发布包本身不包含任何固件或游戏文件。',
)
// 每个本站脚本一段说明，接在前一段后面（第一段接在外部补丁说明之后）
let anchor = 'Emscripten 子模块补丁原文和应用说明随包提供于 `source/patches/external/`。'
for (const script of EKA2L1_SITE_SCRIPTS) {
  if (!sourceDoc.includes(script.sourceCopy)) {
    if (!sourceDoc.includes(anchor)) throw new Error(`SOURCE.md 里找不到插入位置：${anchor.slice(0, 40)}…`)
    sourceDoc = sourceDoc.replace(anchor, `${anchor}\n\n${script.doc}`)
  }
  anchor = script.doc
}
// 补丁说明列表按补丁表整段重写，顺序与完整构建一致
{
  const lines = sourceDoc.split('\n')
  const first = lines.findIndex((line) => line.startsWith('- **'))
  if (first < 0) throw new Error('SOURCE.md 里找不到补丁说明列表')
  let last = first
  while (last + 1 < lines.length && lines[last + 1].startsWith('- **')) last++
  lines.splice(first, last - first + 1, ...EKA2L1_ALL_PATCHES.map((p) => `- **${p.id}**（${p.file}）：${p.why}`))
  sourceDoc = lines.join('\n')
}

// 运行目录里要换掉 / 新增的文件：本站脚本（发布版 + 对应源码）和随包的构建脚本
const overrides = new Map([
  ['index.html', Buffer.from(html)],
  ['SOURCE.md', Buffer.from(sourceDoc)],
  ['source/scripts/build-eka2l1-web.mjs', readFileSync(join(root, 'scripts', 'build-eka2l1-web.mjs'))],
  ['source/scripts/lib/eka2l1-patches.mjs', readFileSync(join(root, 'scripts', 'lib', 'eka2l1-patches.mjs'))],
  ['source/scripts/lib/eka2l1-site-scripts.mjs', readFileSync(join(root, 'scripts', 'lib', 'eka2l1-site-scripts.mjs'))],
])
for (const script of EKA2L1_SITE_SCRIPTS) {
  const bytes = readFileSync(join(root, script.source))
  overrides.set(script.published, bytes)
  overrides.set(script.sourceCopy, bytes)
}
const patchTargets = [
  ...EKA2L1_PATCHES.filter((p) => eka2l1PublishedPagePath(p.file)).map((p) => [eka2l1PublishedPagePath(p.file), p]),
  ...EKA2L1_GLUE_PATCHES.map((p) => [p.file, p]),
]
for (const [rel, patch] of patchTargets) {
  const current = (overrides.get(rel) ?? readFileSync(join(baseDir, rel))).toString('utf8')
  const next = applyReplacePatch(current, patch)
  if (next !== current) {
    overrides.set(rel, Buffer.from(next))
    console.log(`✓ 补丁 ${patch.id} → ${rel}`)
  }
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
// wasm / data 原样沿用，旧目录里的 .br 预压缩件也一并带过来（precompress-runtimes 按 sha256 核对）
cpSync(baseDir, outDir, { recursive: true })
for (const [rel, bytes] of overrides) {
  mkdirSync(dirname(join(outDir, rel)), { recursive: true })
  writeFileSync(join(outDir, rel), bytes)
}

const files = {}
for (const rel of new Set([...Object.keys(manifest.files), ...overrides.keys()])) {
  const bytes = readFileSync(join(outDir, rel))
  files[rel] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}
const sortedFiles = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))

const hash = createHash('sha256')
for (const [rel, file] of Object.entries(sortedFiles)) {
  hash.update(rel).update('\0').update(file.sha256).update('\n')
}
const buildId = hash.digest('hex').slice(0, 12)
const finalDir = join(root, 'public', 'eka2l1', `v${buildId}`)
if (finalDir !== outDir) {
  rmSync(finalDir, { recursive: true, force: true })
  cpSync(outDir, finalDir, { recursive: true })
  rmSync(outDir, { recursive: true, force: true })
}
const patches = EKA2L1_ALL_PATCHES.map((p) => p.id)
writeFileSync(join(finalDir, 'runtime.json'), `${JSON.stringify({ ...manifest, buildId, patches, files: sortedFiles }, null, 2)}\n`)
writeFileSync(constantsFile, [
  '// 由 scripts/build-eka2l1-web.mjs 或 scripts/repackage-eka2l1-web.mjs 生成。换构建 = 换目录，旧目录保留给已打开的页面。',
  `export const EKA2L1_BUILD_ID = '${buildId}'`,
  `export const EKA2L1_RUNTIME_DIR = '/eka2l1/v${buildId}/'`,
  '',
].join('\n'))

console.log(`✓ 已发布静态资源更新 /eka2l1/v${buildId}/；WASM 与 data 沿用 ${baseId}`)
console.log('  下一步：node scripts/precompress-runtimes.mjs && node scripts/check-eka2l1-web.mjs')
