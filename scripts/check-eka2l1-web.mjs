#!/usr/bin/env node
/**
 * 检查自托管的 EKA2L1-WEB（塞班）运行时是否完整、是否是打过本站补丁的那一版。
 *
 *   node scripts/check-eka2l1-web.mjs          # 核对 public/
 *   node scripts/check-eka2l1-web.mjs --dist   # 核对 dist/client/（构建后真正上线的那份）
 *
 * 失败场景都对应真实风险：入口常量指向不存在的目录 → /symbian 的开始按钮 404；
 * 文件和 runtime.json 对不上 → 新旧构建混用；补丁缺失 → 玩家流量又走第三方中继、
 * 或者 SW 把旧 wasm 钉在 Cache Storage 里。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'
import {
  EKA2L1_ALL_PATCHES, EKA2L1_EXTERNAL_PATCHES, EKA2L1_GLUE_PATCHES, EKA2L1_PATCHES,
  EKA2L1_UPSTREAM_COMMIT, eka2l1PublishedPagePath,
} from './lib/eka2l1-patches.mjs'
import { EKA2L1_SITE_SCRIPTS } from './lib/eka2l1-site-scripts.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const useDist = process.argv.includes('--dist')
const ifPresent = process.argv.includes('--if-present')
const fail = (message) => {
  console.error(`✖ EKA2L1 检查失败：${message}`)
  process.exit(1)
}

const constants = readFileSync(join(root, 'src', 'emulator', 'eka2l1Runtime.ts'), 'utf8')
const buildId = /EKA2L1_BUILD_ID = '([0-9a-f]{12})'/.exec(constants)?.[1] ?? ''
if (!buildId && ifPresent) {
  console.log('· EKA2L1 尚未构建，跳过运行时文件检查')
  process.exit(0)
}
if (!buildId) fail('eka2l1Runtime.ts 里的构建哈希为空')
if (!constants.includes(`EKA2L1_RUNTIME_DIR = '/eka2l1/v${buildId}/'`)) fail('EKA2L1_RUNTIME_DIR 与 EKA2L1_BUILD_ID 不一致')

const dir = join(root, useDist ? 'dist/client' : 'public', 'eka2l1', `v${buildId}`)
if (!existsSync(join(dir, 'runtime.json'))) fail(`缺少 ${dir}/runtime.json`)
const manifest = JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8'))
if (manifest.buildId !== buildId) fail(`runtime.json 的 buildId=${manifest.buildId}，期望 ${buildId}`)
if (!/^[0-9a-f]{12}$/.test(manifest.upstreamBuildId || '')) fail('runtime.json 缺少上游页面版本号')
if (manifest.commit !== EKA2L1_UPSTREAM_COMMIT) fail('runtime.json 的上游提交与补丁表不一致，需重新构建')
const expectPatches = EKA2L1_ALL_PATCHES.map((p) => p.id).join(',')
if ((manifest.patches || []).join(',') !== expectPatches) fail(`运行时打的补丁是 [${manifest.patches}]，补丁表是 [${expectPatches}]，需重新构建`)

for (const name of [
  'index.html', 'run.html', 'eka2l1.js', 'eka2l1.wasm', 'eka2l1.data', 'js/boot.js', 'js/build_id.js', 'LICENSE', 'SOURCE.md',
  'source/scripts/build-eka2l1-web.mjs', 'source/scripts/lib/eka2l1-patches.mjs',
  'source/scripts/lib/eka2l1-site-scripts.mjs',
  ...EKA2L1_SITE_SCRIPTS.flatMap((script) => [script.published, script.sourceCopy]),
  'source/patches/external/README.md',
  ...EKA2L1_EXTERNAL_PATCHES.map((patch) => `source/${patch.file}`),
]) {
  if (!manifest.files?.[name]) fail(`runtime.json 未登记 ${name}`)
}
const contentHash = createHash('sha256')
for (const [rel, file] of Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b))) {
  contentHash.update(rel).update('\0').update(file.sha256).update('\n')
}
if (contentHash.digest('hex').slice(0, 12) !== buildId) fail('运行时目录名不是发布文件内容哈希，immutable 缓存可能串版本')
for (const [rel, { bytes, sha256 }] of Object.entries(manifest.files)) {
  const file = join(dir, rel)
  if (!existsSync(file)) fail(`缺少 ${rel}`)
  const data = readFileSync(file)
  if (data.length !== bytes) fail(`${rel} 大小 ${data.length}，清单 ${bytes}`)
  if (createHash('sha256').update(data).digest('hex') !== sha256) fail(`${rel} 内容与清单不符`)
}
const sourceDoc = readFileSync(join(dir, 'SOURCE.md'), 'utf8')
if (!sourceDoc.includes(EKA2L1_UPSTREAM_COMMIT)) fail('SOURCE.md 没有标出对应上游提交')
if (!sourceDoc.includes('source/scripts/lib/eka2l1-patches.mjs') || !sourceDoc.includes('source/scripts/build-eka2l1-web.mjs')) {
  fail('SOURCE.md 没有链接随包提供的本站补丁与构建脚本')
}
for (const script of EKA2L1_SITE_SCRIPTS) {
  if (!sourceDoc.includes(script.sourceCopy)) fail(`SOURCE.md 没有说明本站脚本 ${script.sourceCopy}`)
}
for (const patch of EKA2L1_ALL_PATCHES) {
  if (!sourceDoc.includes(patch.id)) fail(`SOURCE.md 缺少修改说明 ${patch.id}`)
}
if (!/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(readFileSync(join(dir, 'LICENSE'), 'utf8'))) fail('运行目录缺少 AGPL-3.0 许可证文本')
for (const banned of ['sw.js', 'smoke.html', 'edgeone.json']) {
  if (existsSync(join(dir, banned))) fail(`不应发布 ${banned}`)
}

// 补丁在产物里的指纹
const glue = readFileSync(join(dir, 'eka2l1.js'), 'utf8')
if (glue.includes('qq.zixing.fun')) fail('eka2l1.js 仍默认连接第三方 TCP 中继')
const publishedPatches = readFileSync(join(dir, 'source/scripts/lib/eka2l1-patches.mjs'), 'utf8')
if (!publishedPatches.includes("id: 'network-relay-off'") || !publishedPatches.includes("|| '';")) {
  fail('发布的对应源码没有关闭默认 TCP 中继')
}
// 改页面 / 改胶水的补丁：替换后的文本必须原样出现在发布文件里
for (const patch of [...EKA2L1_PATCHES.filter((p) => eka2l1PublishedPagePath(p.file)), ...EKA2L1_GLUE_PATCHES]) {
  const rel = eka2l1PublishedPagePath(patch.file) || patch.file
  const text = readFileSync(join(dir, rel), 'utf8')
  for (const [, to] of patch.replace) {
    if (!text.includes(to)) fail(`${rel} 缺少补丁「${patch.id}」，需重新打包（npm run eka2l1:repackage）`)
  }
}
// 2026-11-19：上游这行在 emcc 7 的胶水上必崩（FS.filesystems 不存在），玩家装固件第一步就失败
if (readFileSync(join(dir, 'js/boot.js'), 'utf8').includes('mod.FS.mount(mod.FS.filesystems.IDBFS')) {
  fail('js/boot.js 仍从 FS.filesystems 取 IDBFS，核心启动会报 reading \'IDBFS\'')
}
if (!glue.includes('Module["IDBFS"]=IDBFS')) fail('eka2l1.js 没有导出 Module.IDBFS，boot.js 挂载不了存储')

for (const page of ['index.html', 'run.html']) {
  const html = readFileSync(join(dir, page), 'utf8')
  if (!html.includes("if (false && 'serviceWorker' in navigator)")) fail(`${page} 仍会注册 Service Worker`)
  if (!html.includes(`?v=${manifest.upstreamBuildId}`)) fail(`${page} 的资源引用没有带上游页面版本号`)
}
// 本站脚本：index.html 要加载它，发布版和随包源码都要和仓库里的一字不差（改了脚本就得重新打包换目录）
const libraryHtml = readFileSync(join(dir, 'index.html'), 'utf8')
for (const script of EKA2L1_SITE_SCRIPTS) {
  if (!libraryHtml.includes(`<script src="${script.published}"></script>`)) fail(`index.html 未加载本站脚本 ${script.published}`)
  const expected = readFileSync(join(root, script.source), 'utf8')
  for (const rel of [script.published, script.sourceCopy]) {
    if (readFileSync(join(dir, rel), 'utf8') !== expected) {
      fail(`${rel} 与仓库里的 ${script.source} 不一致，需运行 npm run eka2l1:repackage`)
    }
  }
}
if (readFileSync(join(dir, 'source/scripts/lib/eka2l1-site-scripts.mjs'), 'utf8') !== readFileSync(join(root, 'scripts/lib/eka2l1-site-scripts.mjs'), 'utf8')) {
  fail('随包的 eka2l1-site-scripts.mjs 与仓库不一致，需运行 npm run eka2l1:repackage')
}

// 预压缩：存在就必须与原文件一致（precompress-runtimes 生成；--dist 时由它的 --check 兜底）
for (const name of ['eka2l1.wasm', 'eka2l1.data']) {
  const br = join(dir, `${name}.br`)
  if (!existsSync(br)) continue
  const plain = brotliDecompressSync(readFileSync(br))
  if (createHash('sha256').update(plain).digest('hex') !== manifest.files[name].sha256) fail(`${name}.br 解压后与原文件不一致`)
}

console.log(`✓ EKA2L1 运行时 v${buildId} 完整（${Object.keys(manifest.files).length} 个文件，补丁 ${expectPatches}）`)
