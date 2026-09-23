#!/usr/bin/env node
/**
 * 校验 js-dos、DOSBox、DOSBox-X 与本站补丁属于同一批产物。
 *
 * 这套运行时由固定名字的 JS/WASM 组成；少一个文件或混进旧版本通常只表现为黑屏。
 * 构建前查 public，构建后再查 dist/client，发布之前把这类故障变成明确的构建失败。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const distMode = process.argv.includes('--dist')
const pkgFile = join(root, 'node_modules', 'js-dos', 'package.json')
const pathsFile = join(root, 'src', 'emulator', 'paths.ts')
const copyScript = join(root, 'scripts', 'copy-jsdos.mjs')

const fail = (message) => {
  console.error(`✖ js-dos 检查失败：${message}`)
  process.exit(1)
}
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

if (!existsSync(pkgFile)) fail('npm 包不存在，请先 npm install')
const { version } = JSON.parse(readFileSync(pkgFile, 'utf8'))
const declared = readFileSync(pathsFile, 'utf8').match(/export const JSDOS_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1]
if (declared !== version) fail(`src/emulator/paths.ts 声明 ${declared || '空'}，npm 安装的是 ${version}`)

const publicDir = join(root, 'public', 'jsdos', `v${version}`)
const runtimeDir = distMode ? join(root, 'dist', 'client', 'jsdos', `v${version}`) : publicDir
const publicManifest = join(publicDir, 'runtime.json')
const manifestFile = join(runtimeDir, 'runtime.json')
if (!existsSync(publicManifest)) fail('public/jsdos 的 runtime.json 不存在；先运行 npm run jsdos')
if (!existsSync(manifestFile)) fail(`${distMode ? 'dist/client' : 'public'}/jsdos/v${version}/runtime.json 不存在`)
if (distMode && !readFileSync(manifestFile).equals(readFileSync(publicManifest))) {
  fail('dist/client/jsdos 的清单落后于 public；请重新构建客户端')
}

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
} catch {
  fail('runtime.json 不是合法 JSON')
}
if (manifest.version !== version || manifest.withDosboxX !== true || manifest.ipxPatched !== true) {
  fail('runtime.json 的版本或 DOSBox-X / IPX 补丁标记不正确')
}
if (manifest.copyScriptSha256 !== sha256(copyScript)) fail('复制补丁脚本已经变化，public 仍是旧产物；请运行 npm run jsdos')
if (!Array.isArray(manifest.files) || !manifest.files.length) fail('runtime.json 没有文件清单')

const listed = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path)
    else if (name !== 'runtime.json') listed.push(relative(runtimeDir, path).replace(/\\/g, '/'))
  }
}
walk(runtimeDir)
listed.sort()
if (JSON.stringify(listed) !== JSON.stringify(manifest.files.map((file) => file.name))) {
  fail('目录里的实际文件与 runtime.json 清单不一致（有缺失或残留旧文件）')
}

for (const file of manifest.files) {
  if (!/^[\w./-]+$/.test(file.name) || file.name.includes('..')) fail(`清单含非法文件名：${String(file.name)}`)
  const target = join(runtimeDir, file.name)
  if (!existsSync(target)) fail(`缺文件 ${file.name}`)
  if (statSync(target).size !== file.size) fail(`${file.name} 长度不符`)
  if (sha256(target) !== file.sha256) fail(`${file.name} 摘要不符`)
}

const required = [
  'js-dos.js',
  'js-dos.css',
  'emulators/wdosbox.js',
  'emulators/wdosbox.wasm',
  'emulators/wdosbox-x.js',
  'emulators/wdosbox-x.wasm',
  'emulators/wdosbox-x-jspi.js',
  'emulators/wdosbox-x-jspi.wasm',
  'emulators/wlibzip.js',
  'emulators/wlibzip.wasm',
  'emulators/webrtcnet.mjs',
  'emulators/webrtcnet.wasm',
]
for (const name of required) if (!listed.includes(name)) fail(`运行时缺 ${name}`)

const js = readFileSync(join(runtimeDir, 'js-dos.js'), 'utf8')
const css = readFileSync(join(runtimeDir, 'js-dos.css'), 'utf8')
if (!js.startsWith(';(function () {\n') || !js.endsWith('\n}).call(this);\n')) fail('js-dos.js 没有 IIFE 隔离，可能覆盖 window.io')
if (js.includes('":1900/ipx/"') || !js.includes('"/ipx/"')) fail('IPX 仍在使用 Cloudflare 无法代理的 1900 端口')
for (const marker of ['__8bitgoListeners', '__8bitgoCleanup', 'navigator.keyboard.unlock']) {
  if (!js.includes(marker)) fail(`会话清理补丁缺关键特征 ${marker}`)
}
for (const type of ['fullscreenchange', 'pointerlockchange', 'visibilitychange']) {
  if (!js.includes(`__8bitgoListen("${type}",`)) fail(`${type} 监听没有纳入 stop() 清理`)
}
if (!css.startsWith('@layer jsdos{')) fail('js-dos.css 没放进 cascade layer，会覆盖整站样式')

for (const name of required.filter((name) => name.endsWith('.wasm'))) {
  const wasm = readFileSync(join(runtimeDir, name))
  if (!wasm.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))) fail(`${name} 不是有效 WASM`)
}

console.log(`✔ js-dos ${version} ${distMode ? '部署产物' : '公开目录'}完整（DOSBox / DOSBox-X 配套，三项补丁在位）`)
