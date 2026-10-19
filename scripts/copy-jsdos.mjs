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

/**
 * js-dos 启动时会主动锁住 Escape 等按键，但 iframe / WebView 常常禁止 Keyboard Lock。
 * 上游没有处理返回 Promise 的拒绝，控制台会出现全局 InvalidStateError，和 Pointer Lock 失败
 * 长得几乎一样，既污染监控也会把鼠标问题带偏。键盘锁只是增强能力，拒绝时静默降级即可。
 */
function patchKeyboardLockRejection(file) {
  const code = readFileSync(file, 'utf8')
  const needle = 'null==(n=navigator.keyboard)||n.lock(["KeyW","Escape"]);'
  if (code.split(needle).length - 1 !== 1) {
    fail('上游 Keyboard Lock 结构变化，无法确认失败 Promise 已被处理')
  }
  writeFileSync(file, code.replace(
    needle,
    'null==(n=navigator.keyboard)||n.lock(["KeyW","Escape"])?.catch(()=>{});',
  ))
}

/**
 * 本站已经把逐游戏鼠标速度 / Y 轴反转收进播放器的 🎮 面板，不能再让 js-dos 在画面左侧
 * 重复画一根全站设置滑条。上游那层「点击捕获」蒙版也会长期压暗游戏，并让玩家误以为还要
 * 点一个确认按钮；真正的 Pointer Lock 本来就直接绑在 canvas 的 pointerdown 上，裁掉提示层
 * 不会改变捕获行为。最后一处把 kiosk 为滑条预留的 8px 空栏一起拿掉，避免留下彩色细边。
 *
 * 这里故意按当前锁定版本的函数边界严格匹配：上游升级后若压缩符号变化，应先重新取证，
 * 不能静默发布一个又出现重复滑条 / 黑色蒙版的运行时。
 */
function patchMinimalMouseCaptureUi(file) {
  let code = readFileSync(file, 'utf8')
  const replaceMarkedFunction = (marker, label) => {
    if (code.split(marker).length - 1 !== 1) {
      fail(`上游 ${label} 特征变化，无法移除重复的鼠标捕获界面`)
    }
    const markerAt = code.indexOf(marker)
    const from = code.lastIndexOf('function ', markerAt)
    const to = code.indexOf('function ', markerAt + marker.length)
    const signature = code.slice(from, markerAt).match(/^function ([\w$]+)\([^)]*\)\{/)
    if (from < 0 || to <= from || !signature) {
      fail(`上游 ${label} 函数边界变化，无法确认补丁目标`)
    }
    code = `${code.slice(0, from)}function ${signature[1]}(){return null}${code.slice(to)}`
  }

  // 压缩符号会随上游构建漂移（8.4.1 的 Xa/Dl 在 8.5.3 变成 Ga/Tl），
  // 用唯一的 DOM 特征锁定完整函数，既容忍符号改名，又不会在界面结构变化时模糊替换。
  replaceMarkedFunction('class:"sidebar-slider "+e.class', '鼠标灵敏度侧栏')
  replaceMarkedFunction(
    'class:"absolute top-0 left-0 w-full h-full flex flex-col items-center justify-center pointer-events-none bg-black/70',
    '鼠标捕获提示层',
  )

  const kioskSpacer = 'i&&l&&zi("div",{class:"w-2 flex-shrink-0"}),'
  if (code.split(kioskSpacer).length - 1 !== 1) {
    fail('上游 kiosk 鼠标侧栏留白结构变化，无法确认补丁目标')
  }
  code = code.replace(kioskSpacer, '')
  writeFileSync(file, code)
}

/**
 * Sockdrive 原版每次碰到未缓存的 256KB 块都等一次网络；剧情切换时连续读文件就会一块一卡。
 * 只在已完整预热的会话里，观察到连续两次读盘后试读下一块。投机结果暂存至多一个块，真正
 * 请求到该块时直接交给客体；失败仍走原来的重试路径。3G 最多 4MB，其他网络最多 8MB，
 * 省流量 / 2G / 不完整启动清单不预读，避免投机请求抢走真正读盘与系统镜像的带宽。
 */
function patchSockdriveSequentialReadAhead(file) {
  let code = readFileSync(file, 'utf8')
  const anchor = 'return c.preloadSizeInBytes=b.length*c.ahead_read,'
  const read = 'readRangeAsync:async e=>{d.add(e),p.has(e)||(p.add(e),P(e))}'
  if (code.split(anchor).length - 1 !== 1 || code.split(read).length - 1 !== 1) {
    fail('上游 Sockdrive 读盘结构变化，无法确认顺序预读补丁安全')
  }
  const helper = `let __8bitgoLastDemand=-2,__8bitgoPrefetchCount=0,__8bitgoPrefetchRange=-1,__8bitgoPrefetchTask=null,__8bitgoPrefetchBytes=null;
const __8bitgoConnection="undefined"!==typeof navigator?navigator.connection:null;
const __8bitgoSlow=!!(__8bitgoConnection&&(__8bitgoConnection.saveData||/(?:^|-)2g$/i.test(__8bitgoConnection.effectiveType||"")));
const __8bitgoPrefetchLimit="none"===n||__8bitgoSlow?0:Math.floor((__8bitgoConnection?.effectiveType==="3g"?4:8)*1048576/c.ahead_read);
function __8bitgoPrefetchAfter(range){
 const next=range+1;
 if(!__8bitgoPrefetchLimit||__8bitgoPrefetchCount>=__8bitgoPrefetchLimit||__8bitgoPrefetchTask||next>=c.range_count||y.has(next)||f.has(next)||p.has(next)||g.has(next))return;
 __8bitgoPrefetchCount++;
 __8bitgoPrefetchRange=next;
 __8bitgoPrefetchBytes=null;
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),15000);
 __8bitgoPrefetchTask=fetch(e+"/"+next+".raw",{signal:controller.signal,priority:"low"})
  .then(async response=>{if(!response.ok)throw Error("HTTP "+response.status);const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length!==Math.min(c.ahead_read,c.size*1024-next*c.ahead_read))throw Error("Sockdrive read-ahead length mismatch");__8bitgoPrefetchBytes=bytes})
  .catch(()=>{__8bitgoPrefetchBytes=null})
  .finally(()=>{clearTimeout(timer);__8bitgoPrefetchTask=null});
}
`
  code = code.replace(anchor, helper + anchor)
  code = code.replace(read, `readRangeAsync:async e=>{
 d.add(e);
 const sequential=e===__8bitgoLastDemand+1;
 __8bitgoLastDemand=e;
 if(p.has(e))return;
 if(__8bitgoPrefetchRange===e&&__8bitgoPrefetchTask)await __8bitgoPrefetchTask;
 if(p.has(e))return;
 p.add(e);
 if(__8bitgoPrefetchRange===e&&__8bitgoPrefetchBytes){
  const bytes=__8bitgoPrefetchBytes;
  __8bitgoPrefetchBytes=null;
  __8bitgoPrefetchRange=-1;
  u.put(e,bytes).catch(console.error);
  x(e,bytes);
  c.readInBytes+=c.ahead_read;
  if(sequential)__8bitgoPrefetchAfter(e);
  return;
 }
 const current=P(e);
 if(sequential)current.then(()=>__8bitgoPrefetchAfter(e)).catch(console.error);
}`)
  writeFileSync(file, code)
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
patchKeyboardLockRejection(mainJs)
patchMinimalMouseCaptureUi(mainJs)
patchLifecycle(mainJs)
wrapCssInLayer(join(out, 'js-dos.css'))
wrapInIife(mainJs)
patchSockdriveSequentialReadAhead(join(out, 'emulators', 'emulators.js'))

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
    mouseCaptureChromePatched: true,
    sourceFingerprint,
    copyScriptSha256,
    files,
  }, null, 2)}\n`,
  'utf8',
)

const bytes = files.reduce((sum, file) => sum + file.size, 0)
console.log(`✔ js-dos ${version} 已同步 ${files.length} 个文件（${(bytes / 1024 / 1024).toFixed(1)} MB）到 public/jsdos/v${assetVersion}/`)
if (!withDosboxX) console.log('  （未包含 DOSBox-X；需要跑 Windows 客体时加 --with-dosbox-x）')
