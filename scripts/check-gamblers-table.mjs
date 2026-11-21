/*
  Gamblers Table（Godot 4 Web 导出）的发布完整性检查。

  这是一款自托管的 Godot WASM 游戏，入口在站内 /web/gamblers-table/。
  它用窄接口同步 Godot IDBFS 的 /userfs，并通过 8BitGo 存档桥交换 JSON 快照；
  这里只校验「入口是 Godot 加载器 + 资源齐全 + 完全自托管 + 存档桥接口存在 + 没有泄露源码的 sourcemap
  + 内置游戏表与适配器把入口指向站内自托管」。不验证游戏内部逻辑（那是 Godot 引擎的事）。
*/
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const useDist = process.argv.includes('--dist')
const sourceRoot = resolve(repo, 'public/web/gamblers-table')
const root = useDist ? resolve(repo, 'dist/client/web/gamblers-table') : sourceRoot
const errors = []
const ok = (condition, message) => { if (!condition) errors.push(message) }
const text = (path) => readFileSync(path, 'utf8')

const indexPath = resolve(root, 'index.html')
const wasmPath = resolve(root, 'index.wasm')
const pckPath = resolve(root, 'index.pck')
ok(existsSync(indexPath), 'index.html 缺失')
ok(existsSync(wasmPath), 'index.wasm 缺失')
ok(existsSync(pckPath), 'index.pck 缺失')

if (existsSync(wasmPath)) {
  const size = statSync(wasmPath).size
  ok(size > 1024 * 1024, `index.wasm 过小（${size} 字节），不像合法 Godot 运行时`)
}
if (existsSync(pckPath)) {
  const size = statSync(pckPath).size
  ok(size > 1024 * 1024, `index.pck 过小（${size} 字节），游戏数据可能不完整`)
}

if (existsSync(indexPath)) {
  const html = text(indexPath)
  ok(html.includes('GODOT_CONFIG') || html.includes('new Engine('), '入口不是 Godot 加载器')
  ok(html.includes('index.js'), '入口没有加载 Godot 引擎脚本 index.js')
  ok(!/(?:src|href)=["']https?:\/\//i.test(html), '入口依赖外部运行资源，不是完整自托管')
  const bridgePath = resolve(root, '8bitgo-save-bridge.js')
  const bridgeVersion = existsSync(bridgePath)
    ? createHash('sha256').update(readFileSync(bridgePath)).digest('hex').slice(0, 16)
    : ''
  ok(Boolean(bridgeVersion) && html.includes(`8bitgo-save-bridge.js?v=${bridgeVersion}`), '入口没有加载当前版本的 Gamblers Table 8BitGo 存档桥')
  const sdkPath = resolve(repo, 'public/html5-api/8bitgo-game-sdk.min.js')
  const sdkVersion = existsSync(sdkPath)
    ? createHash('sha256').update(readFileSync(sdkPath)).digest('hex').slice(0, 16)
    : ''
  ok(Boolean(sdkVersion) && html.includes(`/html5-api/8bitgo-game-sdk.min.js?v=${sdkVersion}`), '入口没有加载当前版本的 8BitGo 游戏 SDK')
  ok(html.indexOf('/html5-api/8bitgo-game-sdk.min.js') < html.indexOf('src="index.js"'), '游戏 SDK 必须在 Godot 运行时之前加载，自动开播才能及时握手')
  ok(html.includes('initializeBeforeStart') && html.includes('markStarted'), 'Godot 启动没有等待云存档恢复或启用自动同步')
}

const bridgeSourcePath = resolve(root, '8bitgo-save-bridge.js')
if (existsSync(bridgeSourcePath)) {
  const bridge = text(bridgeSourcePath)
  // 开局云存档比较：和 PvZ、电池存档同一套规则，绝不无条件拿云端盖掉本地进度。
  const decideSource = bridge.match(/function decideSync\([^)]*\) \{[\s\S]*?\n\t\}/)?.[0]
  ok(Boolean(decideSource), '存档桥缺少开局云存档比较 decideSync')
  if (decideSource) {
    const decide = new Function(`${decideSource}; return decideSync`)()
    const cases = [
      [['', '', '', false], 'none'],
      [['L', '', '', false], 'keep-local'],
      [['', 'C', '', false], 'use-cloud'],
      [['X', 'X', '', false], 'in-sync'],
      [['L0', 'C1', 'L0', false], 'use-cloud'],
      [['L1', 'C0', 'C0', false], 'keep-local'],
      [['L1', 'C1', 'B0', false], 'conflict'],
      [['L1', 'C1', '', false], 'conflict'],
      [['L1', 'P0', '', true], 'keep-local'],
    ]
    for (const [args, expected] of cases) ok(decide(...args) === expected, `decideSync(${args.join(', ')}) 应为 ${expected}`)
  }
  for (const marker of ['auto-final-snapshot', 'auto-final-done', 'auto-conflict', 'SYNCED_KEY_PREFIX', "if (status === 'saved') writeSyncedFingerprint"]) {
    ok(bridge.includes(marker), `存档桥缺少云存档比较 / 收尾保护：${marker}`)
  }
}

const runtimePath = resolve(root, 'index.js')
if (existsSync(runtimePath)) {
  ok(text(runtimePath).includes('Module["8bitgoSyncPersistentFS"]=GodotFS.sync;'), 'Godot 运行时没有导出持久化 FS 同步接口')
}

// 生产目录不应发布可还原上游源码的 sourcemap（Godot 导出通常不生成，这里兜底拦一道）
const findMaps = (dir) => (existsSync(dir)
  ? readdirSync(dir).flatMap((name) => {
      const path = resolve(dir, name)
      return statSync(path).isDirectory() ? findMaps(path) : (name.endsWith('.map') ? [path] : [])
    })
  : [])
ok(findMaps(root).length === 0, '生产目录不应发布可还原上游源码的 sourcemap')

const registry = await import(pathToFileURL(resolve(repo, 'shared/builtin-web-games.js')).href)
const registered = registry.builtinWebGameFor('gamblers-table')
ok(registered?.entry === '/web/gamblers-table/', '内置 Web 游戏表没有指向站内自托管 /web/gamblers-table/')
ok(registered?.isolated === false, 'Gamblers Table 不应误走 COOP/COEP 隔离壳')

const adapterPath = resolve(repo, 'src/emulator/adapters/html5.ts')
if (existsSync(adapterPath)) {
  const adapter = text(adapterPath)
  ok(adapter.includes("options.gameSlug === 'gamblers-table'"), 'HTML5 适配器没有区分 Gamblers Table 存档格式')
  ok(adapter.includes('isManagedGamblersTableEntry'), 'HTML5 适配器没有把 Gamblers Table 加入自动云存档 / SDK 精确白名单')
}

if (errors.length) {
  console.error(`Gamblers Table 检查失败（${useDist ? 'dist' : 'public'}）：`)
  for (const error of errors) console.error('  - ' + error)
  process.exit(1)
}
console.log(`Gamblers Table 检查通过（${useDist ? 'dist' : 'public'}）：Godot 加载器、wasm/pck、自托管与入口注册均正常`)
