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
import { findEmscriptenWasmFile } from './lib/jsdos-wasm-integrity.mjs'

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
const pathsSource = readFileSync(pathsFile, 'utf8')
const declared = pathsSource.match(/export const JSDOS_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1]
const assetVersion = pathsSource.match(/export const JSDOS_ASSET_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1]
if (declared !== version) fail(`src/emulator/paths.ts 声明 ${declared || '空'}，npm 安装的是 ${version}`)
if (!assetVersion || !assetVersion.startsWith(`${version}-`)) fail(`JSDOS_ASSET_VERSION 没有跟随当前上游版本 ${version}`)
const pinnedEntrySri = pathsSource.match(/export const JSDOS_SCRIPT_INTEGRITY\s*=\s*['"](sha256-[A-Za-z0-9+/]+=*)['"]/)?.[1]

const publicDir = join(root, 'public', 'jsdos', `v${assetVersion}`)
const runtimeDir = distMode ? join(root, 'dist', 'client', 'jsdos', `v${assetVersion}`) : publicDir
const publicManifest = join(publicDir, 'runtime.json')
const manifestFile = join(runtimeDir, 'runtime.json')
if (!existsSync(publicManifest)) fail('public/jsdos 的 runtime.json 不存在；先运行 npm run jsdos')
if (!existsSync(manifestFile)) fail(`${distMode ? 'dist/client' : 'public'}/jsdos/v${assetVersion}/runtime.json 不存在`)
if (distMode && !readFileSync(manifestFile).equals(readFileSync(publicManifest))) {
  fail('dist/client/jsdos 的清单落后于 public；请重新构建客户端')
}

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
} catch {
  fail('runtime.json 不是合法 JSON')
}
if (
  manifest.version !== version ||
  manifest.assetVersion !== assetVersion ||
  manifest.withDosboxX !== true ||
  manifest.ipxPatched !== true ||
  manifest.mouseCaptureChromePatched !== true ||
  manifest.emulatorsScriptRecovery !== true ||
  manifest.wasmRuntimeIntegrity !== true
) {
  fail('runtime.json 的版本或 DOSBox-X / IPX / 鼠标捕获 / 依赖恢复 / WASM 运行时完整性标记不正确')
}
if (manifest.copyScriptSha256 !== sha256(copyScript)) fail('复制补丁脚本已经变化，public 仍是旧产物；请运行 npm run jsdos')
if (!Array.isArray(manifest.files) || !manifest.files.length) fail('runtime.json 没有文件清单')
{
  // 产物字节变了却没换版本号 → 同一 URL 发新字节，长期缓存的访客拿不到（见 lib/jsdos-asset-lock.mjs）
  const { filesFingerprint, readLock, verifyLock } = await import('./lib/jsdos-asset-lock.mjs')
  const lock = readLock()
  if (!lock) fail('缺少 scripts/jsdos-asset-lock.json；运行 npm run jsdos 生成后一起提交')
  const verdict = verifyLock(lock, assetVersion, filesFingerprint(manifest.files))
  if (!verdict.ok) fail(verdict.reason)
  if (verdict.action === 'new-version') fail(`scripts/jsdos-asset-lock.json 记的是 ${lock.assetVersion}，当前是 ${assetVersion}；运行 npm run jsdos 更新后一起提交`)
}

const listed = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path)
    // `.br` / `.br.json` 是 scripts/precompress-runtimes.mjs 构建时生成的传输压缩版，由它自己的 --check 核对
    else if (name !== 'runtime.json' && !/\.br(?:\.json)?$/.test(name)) listed.push(relative(runtimeDir, path).replace(/\\/g, '/'))
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
const entryFile = manifest.files.find((file) => file.name === 'js-dos.js')
const expectedEntrySri = entryFile
  ? `sha256-${Buffer.from(entryFile.sha256, 'hex').toString('base64')}`
  : ''
if (!pinnedEntrySri || pinnedEntrySri !== expectedEntrySri) {
  fail('JSDOS_SCRIPT_INTEGRITY 与当前 js-dos.js 产物不符；更新路径常量后重跑 npm run test:jsdos-runtime')
}

const required = [
  'js-dos.js',
  'js-dos.css',
  'emulators/emulators.js',
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
if (listed.some((name) => /^emulators\/wdosbox-x-dbg\.(?:js|wasm)$/.test(name))) {
  fail('生产产物不应包含没有运行时入口的 DOSBox-X 调试启动器 / WASM')
}

const js = readFileSync(join(runtimeDir, 'js-dos.js'), 'utf8')
const emulators = readFileSync(join(runtimeDir, 'emulators', 'emulators.js'), 'utf8')
const css = readFileSync(join(runtimeDir, 'js-dos.css'), 'utf8')
for (const marker of ['__8bitgoPrefetchAfter', '__8bitgoPrefetchLimit', '__8bitgoPrefetchBytes']) {
  if (!emulators.includes(marker)) fail(`Sockdrive 顺序预读补丁缺关键特征 ${marker}`)
}
if (emulators.includes('readRangeAsync:async e=>{d.add(e),p.has(e)||(p.add(e),P(e))}')) {
  fail('Sockdrive 仍在使用完全按需的旧读盘逻辑')
}
if (!js.startsWith(';(function () {\n') || !js.endsWith('\n}).call(this);\n')) fail('js-dos.js 没有 IIFE 隔离，可能覆盖 window.io')
if (js.includes('":1900/ipx/"') || !js.includes('"/ipx/"')) fail('IPX 仍在使用 Cloudflare 无法代理的 1900 端口')
for (const marker of ['__8bitgoListeners', '__8bitgoCleanup', 'navigator.keyboard.unlock']) {
  if (!js.includes(marker)) fail(`会话清理补丁缺关键特征 ${marker}`)
}
if (js.includes('unadjustedMovement')) fail('Pointer Lock 仍在绕过系统鼠标加速')
if (!js.includes('requestPointerLock()')) fail('找不到使用系统加速的 Pointer Lock 补丁')
if (!js.includes('n.lock(["KeyW","Escape"])?.catch(()=>{})')) {
  fail('Keyboard Lock 拒绝仍可能变成全局未处理异常')
}
// 压缩函数名并不是稳定接口：8.4.1 的 Xa/Dl 在 8.5.3 已变成 Ga/Tl。
// 直接确认会生成界面的唯一 DOM 特征已消失，避免以后只因符号重命名误报。
if (js.includes('class:"sidebar-slider "+')) fail('js-dos 仍可能显示重复的鼠标灵敏度侧栏')
if (js.includes('class:"absolute top-0 left-0 w-full h-full flex flex-col items-center justify-center pointer-events-none bg-black/70')) {
  fail('js-dos 仍可能显示鼠标捕获黑色蒙版')
}
if (js.includes('i&&l&&zi("div",{class:"w-2 flex-shrink-0"})')) fail('kiosk 仍为鼠标侧栏保留空白边')
if (!/requestPointerLock\(\)\}\}const \w+=\{capture:!0\};for\(const \w+ of \w+\.starters\)e\.addEventListener\(/.test(js)) {
  fail('找不到画布点击直接请求 Pointer Lock 的监听器')
}
for (const marker of [
  'var Ci=!1,__8bitgoEmulatorsLoading=null;function Si(e,t,n){',
  'const stale=document.querySelector("#emulators-js");stale&&stale.remove()',
  'if(__8bitgoEmulatorsLoading)return __8bitgoEmulatorsLoading.then(()=>{window.emulators.pathPrefix=e,window.emulators.pathSuffix=t})',
  'return __8bitgoEmulatorsLoading=new Promise(',
  'timeout=setTimeout(()=>{clearTimeout(timeout),r.remove(),o(new Error("emulators.js load timed out"))},7000)',
  '.finally(()=>{__8bitgoEmulatorsLoading=null})',
  'r.onload=()=>{clearTimeout(timeout);const a=window.emulators;if(!a){r.remove();return o(new Error(',
  'emulators.js loaded without window.emulators',
  'r.onerror=e=>{clearTimeout(timeout),r.remove(),o(new Error(',
]) {
  if (!js.includes(marker)) fail(`emulators.js 失败后重试补丁缺关键特征 ${marker}`)
}
for (const type of ['fullscreenchange', 'pointerlockchange', 'visibilitychange']) {
  if (!js.includes(`__8bitgoListen("${type}",`)) fail(`${type} 监听没有纳入 stop() 清理`)
}
if (!css.startsWith('@layer jsdos{')) fail('js-dos.css 没放进 cascade layer，会覆盖整站样式')

// 每个 DOSBox 核心的胶水都必须换掉 sync sleep 的主线程忙等（见 copy-jsdos.mjs patchSyncSleep）
for (const name of listed.filter((name) => /^emulators\/wdosbox(?:-x)?(?:-jspi|-dbg)?\.js$/.test(name))) {
  const core = readFileSync(join(runtimeDir, name), 'utf8')
  if (!core.includes('function __8bitgoWakeWhenDue(){') || core.includes('Date.now()<Module.wakeUpAt){postWakeUpMessage();return}')) {
    fail(`${name} 仍在用主线程忙等实现 sleep（每秒数万条消息）`)
  }
}
if (manifest.syncSleepTimedWait !== true) fail('runtime.json 没有记录 sync sleep 补丁，请重新运行 npm run jsdos')

// DOSBox 核心的 INT 33h 事件回调必须给累计 mickey（见 copy-jsdos.mjs patchInt74CumulativeMickeys）
{
  const core = readFileSync(join(runtimeDir, 'emulators', 'wdosbox.wasm'))
  const original = Buffer.from('41a089a60a2003280200 3b0100 41a489a60a2003280204 3b0100'.replace(/ /g, ''), 'hex')
  // 十六进制串里反向引用后面紧跟数字会被当成八进制转义，用 (?:) 隔开
  const cumulativeSi = /200328020023(?<g>..)6a24\k<g>(?:)41a089a60a23\k<g>(?:)3b0100/
  if (core.includes(original)) fail('wdosbox.wasm 的 INT 33h 回调仍在传增量 mickey（《主题医院》光标不动 / 反向）')
  if (!cumulativeSi.test(core.toString('hex'))) fail('wdosbox.wasm 找不到累计 mickey 补丁特征')
  if (!WebAssembly.validate(core)) fail('wdosbox.wasm 校验不通过')
  if (manifest.int74CumulativeMickeys !== true) fail('runtime.json 没有记录 INT 33h 累计 mickey 补丁，请重新运行 npm run jsdos')
}

for (const name of required.filter((name) => name.endsWith('.wasm'))) {
  const wasm = readFileSync(join(runtimeDir, name))
  if (!wasm.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))) fail(`${name} 不是有效 WASM`)
}

// 运行时清单里的每个 WASM 都必须由对应 Emscripten 加载器核验最终产物摘要。
const wasmFiles = manifest.files.filter((file) => file.name.startsWith('emulators/') && file.name.endsWith('.wasm'))
const verifiedWasm = new Set()
for (const name of listed.filter((file) => /^emulators\/.*\.(?:js|mjs)$/.test(file))) {
  const code = readFileSync(join(runtimeDir, name), 'utf8')
  if (!code.includes('function findWasmBinary(){')) continue
  const metadata = code.match(/var __8bitgoWasmIntegrity=Object\.freeze\((\{[^;]+\})\);/)
  if (!metadata) fail(`${name} 仍有未校验的 Emscripten WASM 加载入口`)
  let expected
  try { expected = JSON.parse(metadata[1]) } catch { fail(`${name} 内嵌的 WASM 清单不是合法 JSON`) }
  let located
  try { located = findEmscriptenWasmFile(code) } catch (error) {
    fail(`${name} 的 WASM 定位结构损坏：${error instanceof Error ? error.message : String(error)}`)
  }
  const entry = wasmFiles.find((file) => file.name === `emulators/${expected.file}`)
  if (!entry || located !== expected.file || entry.size !== expected.bytes || entry.sha256 !== expected.sha256) {
    fail(`${name} 内嵌摘要与最终 ${expected.file || 'WASM'} 产物不一致`)
  }
  if (code.includes('WebAssembly.instantiateStreaming')) fail(`${name} 保留了绕过 SHA-256 校验的流式编译入口`)
  verifiedWasm.add(expected.file)
}
for (const file of wasmFiles) {
  if (!verifiedWasm.has(file.name.slice('emulators/'.length))) fail(`${file.name} 没有对应的运行时 SHA-256 校验器`)
}

console.log(`✔ js-dos ${version} ${distMode ? '部署产物' : '公开目录'}完整（DOSBox / DOSBox-X 配套，鼠标补丁与所有 WASM 运行时 SHA-256 校验在位）`)
