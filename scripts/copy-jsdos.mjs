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

/**
 * DOSBox 的「不可跳过的 sleep」原版是忙等：worker 发 ws-sync-sleep，主线程原样回 wc-sync-sleep，
 * 没到 wakeUpAt 就再来一轮。DOSBox 每 1ms 节拍睡 1ms，于是一个空闲的 DOS 游戏每秒要在 worker 与
 * 主线程之间来回 5～7 万条消息（2026-11-05《大富翁3》实测 56k～70k/s），两边各吃掉一个核心，
 * 页面主线程还要为每条消息跑一次事件分发。
 *
 * 改成：第一轮仍经主线程（worker 必须让出事件循环，才能收到按键 / 鼠标），之后剩余时间用
 * worker 自己的 setTimeout 等到点。消息量降到约每秒 1000 条；DOSBox 按真实耗时补节拍，
 * 同一画面下声音包速率与原版一致（92.5/s 对 92.5/s），游戏速度不变。
 * 只在 worker 里换成定时器：js-dos 的「主线程直跑」模式下，隐藏标签页的 setTimeout 会被节流到 1 秒，
 * 那里保留原来的消息轮询。四个核心（dosbox / dosbox-x / jspi / dbg）都是同一段 Emscripten 胶水，必须全部命中。
 */
const SYNC_SLEEP_BUSY_WAIT = 'if(Module.wakeUpAt!==undefined&&Date.now()<Module.wakeUpAt){postWakeUpMessage();return}var wakeUp=Module.sync_wakeUp;delete Module.sync_wakeUp;delete Module.wakeUpAt;if(Module.alive){wakeUp()}}};'
const SYNC_SLEEP_TIMED_WAIT = '__8bitgoWakeWhenDue()}};function __8bitgoWakeWhenDue(){if(Module.wakeUpAt!==undefined){var rest=Module.wakeUpAt-Date.now();if(rest>0){if(typeof importScripts==="function"){setTimeout(__8bitgoWakeWhenDue,rest)}else{postWakeUpMessage()}return}}var wakeUp=Module.sync_wakeUp;delete Module.sync_wakeUp;delete Module.wakeUpAt;if(Module.alive&&wakeUp){wakeUp()}}'
function patchSyncSleep(file) {
  const code = readFileSync(file, 'utf8')
  const times = code.split(SYNC_SLEEP_BUSY_WAIT).length - 1
  if (times !== 1) fail(`${file.split(/[\\/]/).pop()} 的 sync sleep 结构变了（期望 1 处忙等，实际 ${times} 处）`)
  writeFileSync(file, code.replace(SYNC_SLEEP_BUSY_WAIT, SYNC_SLEEP_TIMED_WAIT))
}

/**
 * DOSBox 核心（wdosbox.wasm）的 INT 33h 事件回调把 SI/DI 改回「累计」mickey 计数。
 *
 * ── 为什么（2026-11-05《主题医院》实测）──────────────────────────────────────
 * 微软鼠标驱动、原版 DOSBox、DOSBox-X 在调用 INT 33h 0Ch 注册的事件回调时，SI/DI 给的都是
 * **累计**的原始 mickey 计数，游戏自己拿两次回调的差当位移。js-dos 自己的 jsdos-mouse.cpp
 * 把 INT74_Handler 改成了 `reg_si = getRelMickey(...).mickey_x`：每次只给「上次回调以来」的
 * 增量。于是只用 0Ch 回调的游戏（《主题医院》：INT 33h 只调用 00/0C/15，从不调 03/0B）算出的
 * 位移变成「本次增量 − 上次增量」：
 *   · 同方向连续移动 → 差为 0，光标不动（+10、+10、+10 只动第一下）；
 *   · 换方向 → 跳两倍，甚至反向（-16 后 -8，光标反而右移 8）；
 *   · 小幅连续移动几乎全被吃掉，绝对坐标桥送进来的小位移只剩约 5%。
 * 用 INT 33h 记录 TSR + 帧缓冲定位光标逐项核对过；修好后 ±5～±30 的相对位移、
 * 0.05 的绝对位移都 1:1 落到光标上，16ms 连发也不丢。
 *
 * ── 怎么改 ────────────────────────────────────────────────────────────────
 * 不重编 DOSBox：新增两个 i32 全局 gx / gy，把 INT74_Handler 里
 *   reg_si = rel.mickey_x; reg_di = rel.mickey_y
 * 换成
 *   gx += rel.mickey_x; reg_si = gx; gy += rel.mickey_y; reg_di = gy
 * （i32.store16 自动按 16 位回绕，和真驱动一样）。只读 SI/DI 的差值的游戏完全不受回绕影响；
 * 用 0Bh 轮询、用 CX/DX 位置的游戏走的不是这条路，不受影响。
 * 字节特征必须在代码段里恰好出现一次，否则直接让同步失败——上游换了构建就得重新核对，不能猜。
 */
const INT74_SI_DI_STORE = Uint8Array.from([
  0x41, 0xa0, 0x89, 0xa6, 0x0a, // i32.const <reg_si>
  0x20, 0x03, 0x28, 0x02, 0x00, // local.get 3; i32.load (rel.mickey_x)
  0x3b, 0x01, 0x00, // i32.store16
  0x41, 0xa4, 0x89, 0xa6, 0x0a, // i32.const <reg_di>
  0x20, 0x03, 0x28, 0x02, 0x04, // local.get 3; i32.load offset=4 (rel.mickey_y)
  0x3b, 0x01, 0x00, // i32.store16
])
const readLeb = (bytes, at) => {
  let value = 0
  let shift = 0
  let byte
  do {
    byte = bytes[at++]
    value |= (byte & 0x7f) << shift
    shift += 7
  } while (byte & 0x80)
  return [value >>> 0, at]
}
const leb = (value) => {
  const out = []
  do {
    let byte = value & 0x7f
    value >>>= 7
    if (value) byte |= 0x80
    out.push(byte)
  } while (value)
  return Uint8Array.from(out)
}
const joinBytes = (...parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}
const findBytes = (hay, needle, from, to) => {
  outer: for (let i = from; i <= to - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}
function patchInt74CumulativeMickeys(input) {
  const wasm = input instanceof Uint8Array ? input : new Uint8Array(input)
  const sections = []
  for (let at = 8; at < wasm.length;) {
    const [size, body] = readLeb(wasm, at + 1)
    sections.push({ id: wasm[at], start: at, body, end: body + size })
    at = body + size
  }
  const imports = sections.find((section) => section.id === 2)
  const globals = sections.find((section) => section.id === 6)
  const code = sections.find((section) => section.id === 10)
  if (!globals || !code) throw new Error('缺少 global / code 段')

  // 全局索引空间先排导入的全局
  let importedGlobals = 0
  if (imports) {
    let at = imports.body
    let count
    ;[count, at] = readLeb(wasm, at)
    for (let i = 0; i < count; i++) {
      let length
      ;[length, at] = readLeb(wasm, at)
      at += length
      ;[length, at] = readLeb(wasm, at)
      at += length
      const kind = wasm[at++]
      if (kind === 0) [, at] = readLeb(wasm, at)
      else if (kind === 1) {
        at++
        const flags = wasm[at++]
        ;[, at] = readLeb(wasm, at)
        if (flags & 1) [, at] = readLeb(wasm, at)
      } else if (kind === 2) {
        const flags = wasm[at++]
        ;[, at] = readLeb(wasm, at)
        if (flags & 1) [, at] = readLeb(wasm, at)
      } else if (kind === 3) {
        importedGlobals++
        at += 2
      } else throw new Error(`未知导入类型 ${kind}`)
    }
  }
  const [localGlobals, globalEntries] = readLeb(wasm, globals.body)
  const gx = leb(importedGlobals + localGlobals)
  const gy = leb(importedGlobals + localGlobals + 1)

  const hit = findBytes(wasm, INT74_SI_DI_STORE, code.body, code.end)
  if (hit < 0 || findBytes(wasm, INT74_SI_DI_STORE, hit + 1, code.end) !== -1) {
    throw new Error('INT74 的 SI/DI 写入特征不是恰好一处')
  }
  const replacement = joinBytes(
    Uint8Array.from([0x20, 0x03, 0x28, 0x02, 0x00, 0x23]), gx, Uint8Array.of(0x6a, 0x24), gx,
    Uint8Array.from([0x41, 0xa0, 0x89, 0xa6, 0x0a, 0x23]), gx, Uint8Array.of(0x3b, 0x01, 0x00),
    Uint8Array.from([0x20, 0x03, 0x28, 0x02, 0x04, 0x23]), gy, Uint8Array.of(0x6a, 0x24), gy,
    Uint8Array.from([0x41, 0xa4, 0x89, 0xa6, 0x0a, 0x23]), gy, Uint8Array.of(0x3b, 0x01, 0x00),
  )

  let at = code.body
  let functions
  ;[functions, at] = readLeb(wasm, at)
  let sizeAt = -1
  let bodyStart = -1
  let bodyEnd = -1
  for (let i = 0; i < functions; i++) {
    const thisSizeAt = at
    let size
    ;[size, at] = readLeb(wasm, at)
    if (hit >= at && hit < at + size) {
      sizeAt = thisSizeAt
      bodyStart = at
      bodyEnd = at + size
      break
    }
    at += size
  }
  if (sizeAt < 0) throw new Error('特征不在任何函数体内')
  const body = joinBytes(wasm.subarray(bodyStart, hit), replacement, wasm.subarray(hit + INT74_SI_DI_STORE.length, bodyEnd))
  const codeContent = joinBytes(wasm.subarray(code.body, sizeAt), leb(body.length), body, wasm.subarray(bodyEnd, code.end))
  const globalContent = joinBytes(
    leb(localGlobals + 2),
    wasm.subarray(globalEntries, globals.end),
    Uint8Array.from([0x7f, 0x01, 0x41, 0x00, 0x0b, 0x7f, 0x01, 0x41, 0x00, 0x0b]), // (mut i32) = 0 ×2
  )
  const parts = [wasm.subarray(0, 8)]
  for (const section of sections) {
    if (section === code) parts.push(Uint8Array.of(10), leb(codeContent.length), codeContent)
    else if (section === globals) parts.push(Uint8Array.of(6), leb(globalContent.length), globalContent)
    else parts.push(wasm.subarray(section.start, section.end))
  }
  return joinBytes(...parts)
}
function patchDosboxMouseWasm(file) {
  let patched
  try {
    patched = patchInt74CumulativeMickeys(readFileSync(file))
  } catch (error) {
    fail(`${file.split(/[\\/]/).pop()} 的 INT 33h 回调补丁失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!WebAssembly.validate(patched)) fail('INT 33h 回调补丁后的 wdosbox.wasm 校验不通过')
  writeFileSync(file, patched)
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
for (const core of readdirSync(join(out, 'emulators')).filter((name) => /^wdosbox(?:-x)?(?:-jspi|-dbg)?\.js$/.test(name))) {
  patchSyncSleep(join(out, 'emulators', core))
}
patchDosboxMouseWasm(join(out, 'emulators', 'wdosbox.wasm'))

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
    syncSleepTimedWait: true,
    int74CumulativeMickeys: true,
    sourceFingerprint,
    copyScriptSha256,
    files,
  }, null, 2)}\n`,
  'utf8',
)

const bytes = files.reduce((sum, file) => sum + file.size, 0)
console.log(`✔ js-dos ${version} 已同步 ${files.length} 个文件（${(bytes / 1024 / 1024).toFixed(1)} MB）到 public/jsdos/v${assetVersion}/`)
if (!withDosboxX) console.log('  （未包含 DOSBox-X；需要跑 Windows 客体时加 --with-dosbox-x）')
