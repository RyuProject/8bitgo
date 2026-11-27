/**
 * 旧浏览器兼容（src/emulator/browserSupport.ts）：
 *   - 探测：只有 SyntaxError 才判「太旧」，CSP 禁 eval 的 EvalError 不误伤；
 *   - 接线：开局前拦住需要新语法的运行时，NES 改走 jsnes；
 *   - 取证：发布的运行时产物的最低语法没有超过 browserSupport.ts 写的下限（ES2022）。
 *     哪天引擎 / 核心升级用上 ES2023+，这里会红，提醒同步改下限和提示文案。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const acorn = require('acorn')
const root = new URL('..', import.meta.url).pathname
const read = (p) => readFileSync(path.join(root, p), 'utf8')
const b = await import('../src/emulator/browserSupport.ts')

// 探测
b.resetBrowserSupportProbe()
assert.equal(b.modernRuntimeSyntaxSupported(() => {}), true)
b.resetBrowserSupportProbe()
assert.equal(b.modernRuntimeSyntaxSupported(() => { throw new SyntaxError('Unexpected token .') }), false, '解析不了类字段 / ?. 就是太旧')
b.resetBrowserSupportProbe()
assert.equal(b.modernRuntimeSyntaxSupported(() => { throw new EvalError('Refused to evaluate a string as JavaScript') }), true, 'CSP 禁 eval 不能误判成太旧')
b.resetBrowserSupportProbe()
assert.equal(b.modernRuntimeSyntaxSupported(), true, 'Node 自己当然支持')
b.resetBrowserSupportProbe()

// 没有 WebAssembly（Edge 增强安全性 / iOS 锁定模式 / 关了 JIT 的安卓模拟器）
assert.equal(b.webAssemblyAvailable(), true, 'Node 有 WebAssembly')
assert.equal(b.runtimeRunsWithoutWasm('jsnes', 'https://assets.8bitgo.com/roms/nes/smb.nes'), true, '未打包的 NES 用 jsnes 照样能玩')
assert.equal(b.runtimeRunsWithoutWasm('jsnes', 'https://assets.8bitgo.com/roms/nes/smb.nes.8bg?romv=1'), true, '8BG 没有 WebAssembly 时改用纯 JS 的 fzstd 解压')
assert.equal(b.runtimeRunsWithoutWasm('jsnes', { name: 'smb.nes' }), true, '本地文件')
assert.equal(b.runtimeRunsWithoutWasm('emulatorjs', 'x.nes'), false)
assert.equal(b.runtimeRunsWithoutWasm('binjgb', 'x.gb'), true, 'binjgb 没有 WebAssembly 时用纯 JS 构建')
for (const id of ['liveview', 'cloudgame', 'html5']) assert.equal(b.runtimeRunsWithoutWasm(id, 'x'), true, id)
{
  // romPack 不能在模块顶层 import zstd-wasm：它的胶水求值时就碰 WebAssembly，没有就抛 ReferenceError，
  // 游戏详情页整个崩到兜底页（2026-11-15 Android 模拟器 Chrome 110 线上复现）
  const romPack = read('src/services/romPack.ts')
  assert.ok(!/^import [^\n]*'@bokuweb\/zstd-wasm'/m.test(romPack), 'romPack 不许静态 import zstd-wasm')
  assert.match(romPack, /if \(!webAssemblyAvailable\(\)\) \{\s*zstd = await loadJsZstd\(\)/, '没有 WebAssembly 改用纯 JS 解码（与播放器同一个判断）')
  assert.match(romPack, /await import\('fzstd'\)/, 'fzstd 也按需加载，不进主包')
  assert.match(romPack, /await import\('@bokuweb\/zstd-wasm'\)/)
  // 推广到整个 src（2026-11-15 #2512 / #2513 / #2523 都是 `ReferenceError: WebAssembly is not defined` 崩在兜底页）：
  // 主线程代码一律不许静态 import 会在求值时碰 WebAssembly 的胶水，也不许在模块顶层直接读 WebAssembly.*。
  // Worker 自成一个打包入口、页面在开 Worker 前已判断过 WebAssembly，不在此列。
  {
    const WASM_GLUE = /^import\s[^\n]*['"](@bokuweb\/zstd-wasm|[^'"]*\.wasm(\?[^'"]*)?)['"]/m
    const offenders = []
    const walk = (dir) => {
      for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (rel !== path.join('src', 'workers')) walk(rel)
          continue
        }
        if (!/\.(ts|tsx|js|mjs)$/.test(entry.name) || /(^|\.)worker\.[tj]s$/i.test(entry.name)) continue
        const text = read(rel)
        if (WASM_GLUE.test(text)) offenders.push(`${rel}：静态 import WebAssembly 胶水`)
        // 顶层语句（不缩进、不是注释）里读 WebAssembly.*：模块一求值就抛
        for (const line of text.split('\n')) {
          if (/^[^\s/*].*\bWebAssembly\.\w/.test(line) && !/typeof WebAssembly/.test(line)) offenders.push(`${rel}：顶层读 WebAssembly（${line.trim().slice(0, 80)}）`)
        }
      }
    }
    walk('src')
    assert.deepEqual(offenders, [], '主线程模块不能在求值时依赖 WebAssembly')
  }
  const p = read('src/emulator/EmulatorPlayer.tsx')
  assert.match(p, /if \(!webAssemblyAvailable\(\) && !runtimeRunsWithoutWasm\(runtime\.id, game\)\)/)
  assert.match(p, /setError\(t\.player\.browserNoWasm\)/)
  for (const lang of ['zh-Hans', 'zh-Hant', 'en', 'es', 'de', 'it', 'fr', 'ja']) {
    assert.match(read(`src/locales/${lang}.ts`), /browserNoWasm: ['"][^\n]*WebAssembly/, `${lang} 有 WebAssembly 提示`)
  }
}

// 哪些运行时要求新浏览器：经 Vite 转译的几个不要求
for (const id of ['jsnes', 'liveview', 'cloudgame', 'html5']) assert.equal(b.runtimeNeedsModernBrowser(id), false, id)
for (const id of ['emulatorjs', 'ruffle', 'binjgb', 'jsdos', 'j2me', 'webretro', 'play', 'ppsspp', 'dolphin']) assert.equal(b.runtimeNeedsModernBrowser(id), true, id)

// 接线
const player = read('src/emulator/EmulatorPlayer.tsx')
const beginAt = player.indexOf('const begin = (')
const guardAt = player.indexOf('if (runtimeNeedsModernBrowser(runtime.id) && !modernRuntimeSyntaxSupported())')
assert.ok(beginAt > 0 && guardAt > beginAt && guardAt - beginAt < 1500, 'begin() 一开头就拦，在下载任何东西之前')
assert.match(player, /setError\(t\.player\.browserTooOld\)/)
assert.match(player, /const noModernRuntime = platform\.id === 'nes'\s*\? !modernRuntimeSyntaxSupported\(\) \|\| !webAssemblyAvailable\(\)\s*: !webAssemblyAvailable\(\)/, 'NES 详情页走 jsnes，GB/GBC 走 binjgb（太旧 / 没有 WebAssembly）')
assert.match(player, /wasmUnavailable: \(targetPlatform === 'gb' \|\| targetPlatform === 'gbc'\) && !webAssemblyAvailable\(\)/, '本地 GB/GBC 也走 binjgb')
assert.match(read('src/emulator/registry.ts'), /\(platform === 'gb' \|\| platform === 'gbc'\) && \(ctx\.webglUnavailable \|\| ctx\.wasmUnavailable\)/)
// binjgb 没有 WebAssembly 或 SHA-256 时换同一提交、由 SRI 保护的纯 JS 构建（scripts/build-binjgb-js.mjs）
{
  const adapter = read('src/emulator/adapters/binjgb.ts')
  assert.match(adapter, /webAssemblyAvailable\(\) && Boolean\(globalThis\.crypto\?\.subtle\)\s*\?\s*\{ file: 'binjgb\.js', global: 'Binjgb' \}\s*:\s*\{ file: 'binjgb-js\.js', global: 'BinjgbJs' \}/)
  const meta = JSON.parse(read('public/binjgb/binjgb-js.json'))
  assert.equal(meta.wasm, false)
  assert.equal(meta.exportName, 'BinjgbJs')
  assert.ok(adapter.includes(`const BINJGB_BUILD = '${meta.commit}'`), '纯 JS 构建必须和 WebAssembly 版同一个 binjgb 提交')
  const js = read('public/binjgb/binjgb-js.js')
  assert.equal(require('node:crypto').createHash('sha256').update(js).digest('hex'), meta.sha256, 'binjgb-js.js 与清单一致')
  assert.match(js, /var BinjgbJs=/)
  assert.ok(!/\bfetch\([^)]*\.wasm/.test(js) && !js.includes('binjgb.wasm'), '纯 JS 构建不该再去取 .wasm')
}
assert.match(player, /targetPlatform === 'nes' && \(!modernRuntimeSyntaxSupported\(\) \|\| !webAssemblyAvailable\(\)\)/, '本地 ROM 的 NES 也走 jsnes')
for (const lang of ['zh-Hans', 'zh-Hant', 'en', 'es', 'de', 'it', 'fr', 'ja']) {
  assert.match(read(`src/locales/${lang}.ts`), /browserTooOld: ['"][^\n]*Chrome 80[^\n]*Safari 14/, `${lang} 有升级提示`)
}
// 页面本身的下限：legacy 包按这些目标转译（改了这里要同步 browserSupport.ts 头注释）
const vite = read('vite.config.ts')
for (const t of ["'Chrome >= 64'", "'Safari >= 12'", "'Firefox >= 67'"]) assert.ok(vite.includes(t), `legacy 目标仍含 ${t}`)

// 取证：运行时产物的最低语法
function minEs(src) {
  for (const sourceType of ['script', 'module']) {
    for (const v of [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024]) {
      try { acorn.parse(src, { ecmaVersion: v, sourceType }); return v } catch { /* 再高一版 */ }
    }
  }
  return Infinity
}
const FLOOR = 2022
const files = ['public/emulatorjs/emulator.min.js', 'public/emulatorjs/loader.js', 'public/binjgb/binjgb.js']
const ruffleDir = readdirSync(path.join(root, 'public/ruffle')).filter((d) => d.startsWith('v')).sort().pop()
if (ruffleDir) files.push(`public/ruffle/${ruffleDir}/ruffle.js`)
for (const f of files) {
  if (!existsSync(path.join(root, f))) continue
  const v = minEs(read(f))
  assert.ok(v <= FLOOR, `${f} 需要 ES${v}，超过了 browserSupport.ts 的下限 ES${FLOOR}`)
}
// 核心胶水封在 7z 里：有 bsdtar（macOS 自带）就抽一个核心核对，没有就跳过
let checkedCore = false
try {
  const dir = mkdtempSync(path.join(tmpdir(), 'ejs-core-'))
  execFileSync('bsdtar', ['-xf', path.join(root, 'public/emulatorjs/cores/fceumm-legacy-wasm.data'), '-C', dir], { stdio: 'ignore' })
  const glue = readdirSync(dir).find((n) => n.endsWith('.js'))
  const v = minEs(readFileSync(path.join(dir, glue), 'utf8'))
  assert.ok(v <= FLOOR, `核心胶水 ${glue} 需要 ES${v}，超过了下限 ES${FLOOR}`)
  checkedCore = true
} catch (error) {
  if (error instanceof assert.AssertionError) throw error
}

console.log(`test:browser-support 通过${checkedCore ? '' : '（没有 bsdtar，跳过核心胶水取证）'}`)
