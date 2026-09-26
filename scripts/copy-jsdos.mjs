#!/usr/bin/env node
/**
 * 把 npm 包 js-dos（DOSBox / DOSBox-X 的浏览器移植，GPL-2.0）同步到带版本号的
 * `public/jsdos/v<asset-version>/`，并打上本站必须的兼容补丁。
 *
 *   npm run jsdos                                  强制同步并包含 DOSBox-X
 *   node scripts/copy-jsdos.mjs --if-missing       完整一致时才跳过
 *   node scripts/copy-jsdos.mjs --with-dosbox-x    包含 DOSBox-X（Windows 客体必需）
 *   node scripts/copy-jsdos.mjs --no-ipx-patch     保留上游写死的 1900 端口
 *
 * 不能再用「js-dos.js 存在就跳过」：npm 升级、补丁变化或复制中断都会留下新旧 JS/WASM
 * 混用的目录。runtime.json 同时锁 npm 源文件、复制脚本和最终产物；其中任何一项变化都会
 * 自动重建。版本进入 URL 后，浏览器和 CDN 的旧缓存也不会混进新会话。
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptFile = fileURLToPath(import.meta.url)
const root = join(dirname(scriptFile), '..')
const src = join(root, 'node_modules', 'js-dos', 'dist')
const packageFile = join(root, 'node_modules', 'js-dos', 'package.json')
const pathsFile = join(root, 'src', 'emulator', 'paths.ts')
const publicRoot = join(root, 'public', 'jsdos')
const ifMissing = process.argv.includes('--if-missing')
const withDosboxX = process.argv.includes('--with-dosbox-x')
const patchIpx = !process.argv.includes('--no-ipx-patch')
const dosboxXFiles = ['wdosbox-x.js', 'wdosbox-x.wasm', 'wdosbox-x-jspi.js', 'wdosbox-x-jspi.wasm']

const fail = (message) => {
  console.error(`✖ js-dos 同步失败：${message}`)
  process.exit(1)
}
const sha256Bytes = (value) => createHash('sha256').update(value).digest('hex')
const sha256 = (file) => sha256Bytes(readFileSync(file))

if (!existsSync(join(src, 'js-dos.js')) || !existsSync(packageFile)) {
  const msg = '未找到 node_modules/js-dos，请先 npm install'
  if (ifMissing) {
    console.warn(`⚠ ${msg}；DOS 游戏暂不可用`)
    process.exit(0)
  }
  fail(msg)
}

const { version } = JSON.parse(readFileSync(packageFile, 'utf8'))
if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) fail(`npm 包版本格式异常：${String(version)}`)
const pathsSource = readFileSync(pathsFile, 'utf8')
const declaredVersion = pathsSource.match(/export const JSDOS_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1]
const assetVersion = pathsSource.match(/export const JSDOS_ASSET_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1]
if (declaredVersion !== version) fail(`paths.ts 声明 ${declaredVersion || '空'}，npm 安装的是 ${version}`)
if (!assetVersion || !assetVersion.startsWith(`${version}-`)) {
  fail(`JSDOS_ASSET_VERSION 必须以 ${version}- 开头，当前是 ${assetVersion || '空'}`)
}
const out = join(publicRoot, `v${assetVersion}`)
const manifestFile = join(out, 'runtime.json')

/** 类型声明和源码映射不会被浏览器读取，别把它们复制进每次部署的静态目录。 */
function skip(relativeName) {
  const name = relativeName.replace(/\\/g, '/')
  if (name.endsWith('.map') || name.endsWith('.symbols') || name.endsWith('.d.ts')) return true
  if (name.startsWith('emulators/types/')) return true
  if (!withDosboxX && name.split('/').pop()?.startsWith('wdosbox-x')) return true
  return false
}

function listFiles(dir, base = dir) {
  const listed = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) listed.push(...listFiles(path, base))
    else {
      const relativeName = relative(base, path).replace(/\\/g, '/')
      if (!skip(relativeName)) listed.push(relativeName)
    }
  }
  return listed.sort()
}

const sourceFiles = listFiles(src).map((name) => ({
  name,
  size: statSync(join(src, name)).size,
  sha256: sha256(join(src, name)),
}))
const sourceFingerprint = sha256Bytes(JSON.stringify(sourceFiles))
const copyScriptSha256 = sha256(scriptFile)

function outputIsCurrent() {
  if (!existsSync(manifestFile)) return false
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    if (
      manifest.version !== version ||
      manifest.assetVersion !== assetVersion ||
      manifest.withDosboxX !== withDosboxX ||
      manifest.ipxPatched !== patchIpx ||
      manifest.sourceFingerprint !== sourceFingerprint ||
      manifest.copyScriptSha256 !== copyScriptSha256 ||
      !Array.isArray(manifest.files)
    ) return false

    const actualNames = listFiles(out).filter((name) => name !== 'runtime.json')
    if (JSON.stringify(actualNames) !== JSON.stringify(manifest.files.map((file) => file.name))) return false
    return manifest.files.every((file) => {
      const target = join(out, file.name)
      return existsSync(target) && statSync(target).size === file.size && sha256(target) === file.sha256
    })
  } catch {
    return false
  }
}

if (ifMissing && outputIsCurrent()) process.exit(0)

rmSync(publicRoot, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
for (const file of sourceFiles) {
  const target = join(out, file.name)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(join(src, file.name), target)
}

if (withDosboxX) {
  const missing = dosboxXFiles.filter((name) => !existsSync(join(out, 'emulators', name)))
  if (missing.length) fail(`DOSBox-X 资源不完整：${missing.join('、')}。请重新安装 js-dos 依赖`)
}

/** Tailwind 全部在 cascade layer 里，上游未分层的全局 reset 必须放进最低优先级层。 */
function wrapCssInLayer(file) {
  const css = readFileSync(file, 'utf8')
  if (css.startsWith('@layer jsdos{')) return
  writeFileSync(file, `@layer jsdos{${css}}`)
}

/**
 * 上游经典脚本有数百个顶层 var/function，其中 `io` 会覆盖 socket.io；IIFE 只隔离隐式全局，
 * `window.Dos` 等显式导出不受影响。
 */
const IIFE_HEAD = ';(function () {\n'
const IIFE_TAIL = '\n}).call(this);\n'
function wrapInIife(file) {
  const code = readFileSync(file, 'utf8')
  if (code.startsWith(IIFE_HEAD)) return
  writeFileSync(file, `${IIFE_HEAD}${code}${IIFE_TAIL}`)
}

/**
 * 上游每次 Dos() 都往 document 注册 fullscreen / pointerlock / visibilitychange，stop() 却不移除。
 * 多开几局后，一次切后台会同时唤醒所有历史 Redux store，既泄漏完整模拟器对象，也会把
 * visibilitychange 变成长任务。把监听器按实例记账，并在 stop() 时一起拆掉。
 */
function patchLifecycle(file) {
  let code = readFileSync(file, 'utf8')
  const head = 'window.Dos=(e,t={})=>{'
  const stop = 'stop:async()=>{'
  const listeners = ['fullscreenchange', 'pointerlockchange', 'visibilitychange']
  if (code.split(head).length - 1 !== 1 || code.split(stop).length - 1 !== 1) {
    fail('上游 Dos()/stop() 结构变化，无法确认会话监听器能被清理')
  }
  code = code.replace(
    head,
    head +
      'const __8bitgoListeners=[],' +
      '__8bitgoListen=(e,t)=>{document.addEventListener(e,t),__8bitgoListeners.push([e,t])},' +
      '__8bitgoCleanup=()=>{for(const[e,t]of __8bitgoListeners)document.removeEventListener(e,t);' +
      '__8bitgoListeners.length=0,null==navigator.keyboard||navigator.keyboard.unlock?.()};',
  )
  for (const type of listeners) {
    const needle = `document.addEventListener("${type}",`
    if (code.split(needle).length - 1 !== 1) fail(`上游 ${type} 监听结构变化，不能静默留下内存泄漏`)
    code = code.replace(needle, `__8bitgoListen("${type}",`)
  }
  code = code.replace(stop, `${stop}__8bitgoCleanup();`)
  writeFileSync(file, code)
}

/**
 * Pointer Lock 的 unadjustedMovement 会绕过操作系统鼠标加速。网页外的鼠标是加速后的，
 * 进 DOS 画面却突然变成原始计数，用户感受到的就是速度完全不同。本站默认 0.5 正好是 1×，
 * 因此保留系统加速才最接近桌面手感；每款游戏的额外差异再由工具栏灵敏度补偿。
 */
function patchAdjustedPointerLock(file) {
  const code = readFileSync(file, 'utf8')
  const needle = 'requestPointerLock({unadjustedMovement:!0})'
  const count = code.split(needle).length - 1
  if (count !== 2) fail(`上游原始鼠标锁定结构变化，期望 2 处、实际 ${count} 处`)
  writeFileSync(file, code.replaceAll(needle, 'requestPointerLock()'))
}

/** 写死的 1900 端口过不了 Cloudflare；本站中继和主站共用 443 的 /ipx/。 */
function patchIpxPort(file) {
  if (!patchIpx) return
  const code = readFileSync(file, 'utf8')
  const needle = '":1900/ipx/"'
  const times = code.split(needle).length - 1
  if (times !== 1) fail(`IPX 补丁期望 1 处 ${needle}，实际 ${times} 处；上游写法可能变了`)
  writeFileSync(file, code.replace(needle, '"/ipx/"'))
}

const mainJs = join(out, 'js-dos.js')
patchIpxPort(mainJs)
patchAdjustedPointerLock(mainJs)
patchLifecycle(mainJs)
wrapCssInLayer(join(out, 'js-dos.css'))
wrapInIife(mainJs)

const files = listFiles(out)
  .filter((name) => name !== 'runtime.json')
  .map((name) => ({ name, size: statSync(join(out, name)).size, sha256: sha256(join(out, name)) }))
writeFileSync(
  manifestFile,
  `${JSON.stringify({
    version,
    assetVersion,
    withDosboxX,
    ipxPatched: patchIpx,
    sourceFingerprint,
    copyScriptSha256,
    files,
  }, null, 2)}\n`,
  'utf8',
)

const bytes = files.reduce((sum, file) => sum + file.size, 0)
console.log(`✔ js-dos ${version} 已同步 ${files.length} 个文件（${(bytes / 1024 / 1024).toFixed(1)} MB）到 public/jsdos/v${assetVersion}/`)
if (!withDosboxX) console.log('  （未包含 DOSBox-X；需要跑 Windows 客体时加 --with-dosbox-x）')
