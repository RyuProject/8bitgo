/*
  Digiverse（上游仓库名 gamblers-table）的发布完整性检查。

  这款游戏是纯 DOM/CSS 应用，普通的 Canvas 探针看不到它；因此除了
  固定上游提交与静态文件哈希，还要真正跑一遍就绪/存档桥。否则页面即使
  能单独打开，嵌入 8BitGo 时也会一直显示“正在启动”或生成伪 ZIP 存档。
*/
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { transformSync } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const useDist = process.argv.includes('--dist')
const sourceRoot = resolve(repo, 'public/web/gamblers-table')
const root = useDist ? resolve(repo, 'dist/client/web/gamblers-table') : sourceRoot
const manifestPath = resolve(sourceRoot, 'source.json')
const errors = []
const ok = (condition, message) => { if (!condition) errors.push(message) }
const text = (path) => readFileSync(path, 'utf8')
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

let manifest = null
try {
  manifest = JSON.parse(text(manifestPath))
} catch (error) {
  errors.push(`source.json 无效：${error.message}`)
}

if (manifest) {
  ok(manifest.format === '8bitgo.web-game-source.v1', 'source.json format 错误')
  ok(manifest.upstream === 'https://github.com/gaaiyeoi/gamblers-table', '上游仓库地址错误')
  ok(/^[0-9a-f]{40}$/.test(manifest.commit || ''), '上游提交没有锁定到完整 SHA')
  ok(manifest.base === '/web/gamblers-table/', '构建 base 不是站内固定目录')
  ok(manifest.target === 'es2017', '构建目标变了，需要重做浏览器兼容验收')
  ok(manifest.license === 'not-declared', '请如实保留上游未声明许可证的状态')
  ok(manifest.assets && typeof manifest.assets === 'object', 'source.json 缺少产物哈希')

  for (const [name, expected] of Object.entries(manifest.assets || {})) {
    const path = resolve(root, name)
    ok(existsSync(path), `${name} 缺失`)
    if (existsSync(path)) ok(sha256(path) === expected, `${name} 与固定提交的验收产物不一致`)
  }
}

const indexPath = resolve(root, 'index.html')
const bridgePath = resolve(root, '8bitgo-bridge.js')
const overridesPath = resolve(root, '8bitgo-overrides.css')
const sourceNotePath = resolve(root, 'SOURCE.md')
for (const path of [indexPath, bridgePath, overridesPath, sourceNotePath]) ok(existsSync(path), `${path.slice(root.length + 1)} 缺失`)

if (existsSync(indexPath)) {
  const html = text(indexPath)
  ok(html.includes('<html lang="zh-CN">'), '入口未声明中文语言')
  ok(html.includes('<base href="/web/gamblers-table/"'), '入口缺少固定 base')
  ok(html.includes('/web/gamblers-table/8bitgo-bridge.js'), '入口没有加载 8BitGo 运行桥')
  ok(html.includes('/web/gamblers-table/8bitgo-overrides.css'), '入口没有加载移动端覆盖样式')
  ok(!html.includes('/src/main.ts'), '入口仍是 Vite 开发版，生产环境会 404')
  ok(!/(?:src|href)=["']https?:\/\//i.test(html), '入口依赖外部运行资源，不是完整自托管')
}

if (existsSync(bridgePath)) {
  const bridge = text(bridgePath)
  try { new Function(bridge) } catch (error) { errors.push(`8bitgo-bridge.js 语法错误：${error.message}`) }
  for (const marker of [
    '8bitgo-runtime-bridge',
    '8bitgo-save-bridge',
    'coin-flip-game:save',
    "event.source !== window.parent",
    "event.origin !== window.location.origin",
    "runtime('game-playable')",
    'MAX_SAVE_BYTES',
  ]) ok(bridge.includes(marker), `8bitgo-bridge.js 缺少关键保护：${marker}`)

  // 用最小浏览器桩执行桥，不只靠字符串判断一段永远没跑过的代码。
  const listeners = new Map()
  const sent = []
  const parent = { postMessage: (message, origin, transfer) => sent.push({ message, origin, transfer }) }
  const storage = new Map([['coin-flip-game:save', JSON.stringify({ schemaVersion: 22, player: { level: 3 } })]])
  const windowObject = {
    parent,
    location: { origin: 'https://8bitgo.com' },
    addEventListener(type, listener) {
      const list = listeners.get(type) || []
      list.push(listener)
      listeners.set(type, list)
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) || []).filter((item) => item !== listener))
    },
  }
  windowObject.window = windowObject
  const localStorage = {
    getItem: (key) => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
  }
  const fire = (type, event = {}) => {
    for (const listener of listeners.get(type) || []) listener(event)
  }
  try {
    vm.runInNewContext(bridge, {
      window: windowObject,
      localStorage,
      requestAnimationFrame: (callback) => callback(),
      TextEncoder,
      TextDecoder,
      ArrayBuffer,
      JSON,
      Error,
    })
    fire('load')
    ok(sent.some(({ message }) => message.source === '8bitgo-runtime-bridge' && message.type === 'game-playable'), '运行桥没有报告游戏可玩')
    ok(sent.some(({ message }) => message.source === '8bitgo-save-bridge' && message.type === 'ready'), '存档桥没有报告就绪')

    const beforeWrongOrigin = sent.length
    fire('message', { source: parent, origin: 'https://attacker.invalid', data: { source: '8bitgo-save-bridge', version: 1, type: 'export', requestId: 1 } })
    ok(sent.length === beforeWrongOrigin, '存档桥接受了错误 origin 的请求')

    fire('message', { source: parent, origin: 'https://8bitgo.com', data: { source: '8bitgo-save-bridge', version: 1, type: 'export', requestId: 2 } })
    const exported = sent.find(({ message }) => message.type === 'response' && message.requestId === 2)?.message
    ok(exported?.ok && exported.data instanceof ArrayBuffer, '存档导出没有返回 ArrayBuffer')
    if (exported?.data instanceof ArrayBuffer) {
      ok(JSON.parse(new TextDecoder().decode(exported.data)).schemaVersion === 22, '存档导出内容不正确')
    }

    const oldSave = storage.get('coin-flip-game:save')
    const invalid = new TextEncoder().encode('{}').buffer
    fire('message', { source: parent, origin: 'https://8bitgo.com', data: { source: '8bitgo-save-bridge', version: 1, type: 'import', requestId: 3, data: invalid } })
    const rejected = sent.find(({ message }) => message.type === 'response' && message.requestId === 3)?.message
    ok(rejected?.ok === false && storage.get('coin-flip-game:save') === oldSave, '无效存档没有被安全拒绝')

    const replacement = JSON.stringify({ schemaVersion: 22, player: { level: 9 } })
    const valid = new TextEncoder().encode(replacement).buffer
    fire('message', { source: parent, origin: 'https://8bitgo.com', data: { source: '8bitgo-save-bridge', version: 1, type: 'import', requestId: 4, data: valid } })
    const imported = sent.find(({ message }) => message.type === 'response' && message.requestId === 4)?.message
    ok(imported?.ok === true && storage.get('coin-flip-game:save') === replacement, '合法存档没有导入 localStorage')
  } catch (error) {
    errors.push(`8bitgo-bridge.js 动态回归失败：${error.message}`)
  }
}

if (existsSync(overridesPath)) {
  const css = text(overridesPath)
  ok(css.includes('@media (max-width: 760px)'), '移动端样式没有小屏适配')
  ok(css.includes('prefers-reduced-motion: reduce'), '样式没有遵循减少动效偏好')
  ok(!/url\(\s*["']?https?:\/\//i.test(css), '样式依赖外部资源，不是完整自托管')
}

const bundlePath = manifest && Object.keys(manifest.assets || {}).find((name) => /^assets\/.*\.js$/.test(name))
if (bundlePath && existsSync(resolve(root, bundlePath))) {
  const bundle = text(resolve(root, bundlePath))
  try { transformSync(bundle, { loader: 'js', target: 'es2017', logLevel: 'silent' }) } catch (error) {
    errors.push(`游戏 JS 产物无法解析：${error.message}`)
  }
  const fetchCount = (bundle.match(/\bfetch\s*\(/g) || []).length
  const onlyViteModulePreload = fetchCount === 1 &&
    bundle.includes('relList') && bundle.includes('modulepreload') && bundle.includes('fetch(i.href')
  // Vite 为旧浏览器内置的 modulepreload polyfill 只会取入口声明的同源模块，
  // 它不是游戏联网。除这一处外，任何 fetch 或长连接都要重新做安全审查。
  ok(fetchCount === 0 || onlyViteModulePreload, '游戏产物新增了外部网络通道，需要人工审查')
  ok(!/\b(?:WebSocket|EventSource)\s*\(/.test(bundle), '游戏产物新增了长连接，需要人工审查')
  ok(!/serviceWorker\s*\.\s*register/.test(bundle), '嵌入游戏不应注册能控制主站路径的 Service Worker')
}

const registry = await import(pathToFileURL(resolve(repo, 'shared/builtin-web-games.js')).href)
const registered = registry.builtinWebGameFor('gamblers-table')
ok(registered?.entry === '/web/gamblers-table', '内置 Web 游戏表没有注册 gamblers-table')
ok(registered?.isolated === false, 'Digiverse 不应误走 COOP/COEP 隔离壳')

const adapterPath = resolve(repo, 'src/emulator/adapters/html5.ts')
if (existsSync(adapterPath)) {
  const adapter = text(adapterPath)
  ok(adapter.includes("options.gameSlug === 'gamblers-table'"), 'HTML5 适配器没有区分 Digiverse 存档格式')
  ok(adapter.includes("ext: 'gamblers.json'"), 'Digiverse 存档仍会被伪装成 PvZ ZIP')
  ok(adapter.includes("mime: 'application/json'"), 'Digiverse 存档 MIME 不是 JSON')
}

const findMaps = (dir) => existsSync(dir)
  ? readdirSync(dir).flatMap((name) => {
      const path = resolve(dir, name)
      return statSync(path).isDirectory() ? findMaps(path) : (name.endsWith('.map') ? [path] : [])
    })
  : []
ok(findMaps(root).length === 0, '生产目录不应发布可还原上游源码的 sourcemap')

if (errors.length) {
  console.error(`Digiverse 检查失败（${useDist ? 'dist' : 'public'}）：`)
  for (const error of errors) console.error('  - ' + error)
  process.exit(1)
}

console.log(`Digiverse 检查通过（${useDist ? 'dist' : 'public'}）：固定提交、资源哈希、移动端样式、就绪信号和 JSON 存档均正常`)
