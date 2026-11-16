#!/usr/bin/env node
/**
 * 为现有 EKA2L1-WEB 二进制增加本站前端资源，不重新编译 11MB 的 WASM 核心。
 *
 * 仅适用于只改 HTML / JS 和许可源码文件的版本；C++、WASM 或 .data 有变化时必须用
 * build-eka2l1-web.mjs 完整重建。新目录仍按最终发布文件内容哈希命名，旧目录保留。
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const outIdPlaceholder = '000000000000'
const outDir = join(root, 'public', 'eka2l1', `v${outIdPlaceholder}`)
const htmlFile = join(baseDir, 'index.html')
let html = readFileSync(htmlFile, 'utf8')
if (!html.includes('js/8bitgo-default-firmware.js')) {
  if (!html.includes('</body>')) throw new Error('index.html 缺少 </body>')
  html = html.replace('</body>', '<script src="js/8bitgo-default-firmware.js"></script>\n</body>')
}

const sourceFile = join(root, 'scripts', 'eka2l1-default-firmware.js')
const sourceBytes = readFileSync(sourceFile)
let sourceDoc = readFileSync(join(baseDir, 'SOURCE.md'), 'utf8')
const oldAddonDescription = '8BitGo 还附带 `source/scripts/eka2l1-default-firmware.js`：从本站说明页进入时，若当前浏览器尚无已安装设备，则自动取回后台配置的 N-Gage QD ROM 并调用原有固件安装流程。已有设备不会被覆盖；ROM 只保存在玩家自己的浏览器存储中。'
const newAddonDescription = '8BitGo 还附带 `source/scripts/eka2l1-default-firmware.js`：从本站游戏页进入时，若当前浏览器尚无设备则先安装后台配置的 N-Gage QD ROM，再把选中的游戏包导入本机；`.n-gage` 包放入 E:\\n-gage，需在 Games 应用中完成安装。已有设备不会被默认固件覆盖；导入内容只保存在玩家自己的浏览器存储中。'
if (sourceDoc.includes(oldAddonDescription)) sourceDoc = sourceDoc.replace(oldAddonDescription, newAddonDescription)
if (!sourceDoc.includes('source/scripts/eka2l1-default-firmware.js')) {
  sourceDoc = sourceDoc.replace(
    'Emscripten 子模块补丁原文和应用说明随包提供于 `source/patches/external/`。',
    'Emscripten 子模块补丁原文和应用说明随包提供于 `source/patches/external/`。\n\n'
      + newAddonDescription,
  )
}
sourceDoc = sourceDoc.replace(
  '固件（ROM / RPKG）与游戏安装包由玩家自行提供，保存在玩家本机浏览器中；8BitGo 不提供这些文件。',
  '后台管理员配置的 N-Gage QD 默认 ROM 和站内游戏包会供玩家导入；其它固件（ROM / RPKG）由玩家自行提供。导入内容保存在玩家本机浏览器中，运行时发布包本身不包含任何固件或游戏文件。',
)
sourceDoc = sourceDoc.replace(
  '仅后台管理员配置的 N-Gage QD 默认 ROM 会由站点供首次自动安装；其它固件（ROM / RPKG）和游戏安装包由玩家自行提供，内容保存在玩家本机浏览器中。运行时发布包不包含任何固件或游戏文件。',
  '后台管理员配置的 N-Gage QD 默认 ROM 和站内游戏包会供玩家导入；其它固件（ROM / RPKG）由玩家自行提供。导入内容保存在玩家本机浏览器中，运行时发布包本身不包含任何固件或游戏文件。',
)

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
cpSync(baseDir, outDir, { recursive: true })
writeFileSync(join(outDir, 'index.html'), html)
writeFileSync(join(outDir, 'js', '8bitgo-default-firmware.js'), sourceBytes)
writeFileSync(join(outDir, 'SOURCE.md'), sourceDoc)
writeFileSync(join(outDir, 'source', 'scripts', 'build-eka2l1-web.mjs'), readFileSync(join(root, 'scripts', 'build-eka2l1-web.mjs')))
writeFileSync(join(outDir, 'source', 'scripts', 'eka2l1-default-firmware.js'), sourceBytes)

const files = {}
for (const rel of Object.keys(manifest.files)) {
  const bytes = readFileSync(join(outDir, rel))
  files[rel] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}
for (const rel of [
  'index.html', 'SOURCE.md', 'source/scripts/build-eka2l1-web.mjs',
  'js/8bitgo-default-firmware.js', 'source/scripts/eka2l1-default-firmware.js',
]) {
  const bytes = readFileSync(join(outDir, rel))
  files[rel] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

const hash = createHash('sha256')
for (const [rel, file] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
  hash.update(rel).update('\0').update(file.sha256).update('\n')
}
const buildId = hash.digest('hex').slice(0, 12)
const finalDir = join(root, 'public', 'eka2l1', `v${buildId}`)
if (finalDir !== outDir) {
  rmSync(finalDir, { recursive: true, force: true })
  cpSync(outDir, finalDir, { recursive: true })
  rmSync(outDir, { recursive: true, force: true })
}
writeFileSync(join(finalDir, 'runtime.json'), `${JSON.stringify({ ...manifest, buildId, files }, null, 2)}\n`)
writeFileSync(constantsFile, [
  '// 由 scripts/build-eka2l1-web.mjs 或 scripts/repackage-eka2l1-web.mjs 生成。换构建 = 换目录，旧目录保留给已打开的页面。',
  `export const EKA2L1_BUILD_ID = '${buildId}'`,
  `export const EKA2L1_RUNTIME_DIR = '/eka2l1/v${buildId}/'`,
  '',
].join('\n'))

console.log(`✓ 已发布静态资源更新 /eka2l1/v${buildId}/；WASM 与 data 沿用 ${baseId}`)
