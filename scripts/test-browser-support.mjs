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

// 哪些运行时要求新浏览器：经 Vite 转译的几个不要求
for (const id of ['jsnes', 'liveview', 'cloudgame', 'html5']) assert.equal(b.runtimeNeedsModernBrowser(id), false, id)
for (const id of ['emulatorjs', 'ruffle', 'binjgb', 'jsdos', 'j2me', 'webretro', 'play', 'ppsspp', 'dolphin']) assert.equal(b.runtimeNeedsModernBrowser(id), true, id)

// 接线
const player = read('src/emulator/EmulatorPlayer.tsx')
const beginAt = player.indexOf('const begin = (')
const guardAt = player.indexOf('if (runtimeNeedsModernBrowser(runtime.id) && !modernRuntimeSyntaxSupported())')
assert.ok(beginAt > 0 && guardAt > beginAt && guardAt - beginAt < 1500, 'begin() 一开头就拦，在下载任何东西之前')
assert.match(player, /setError\(t\.player\.browserTooOld\)/)
assert.match(player, /platform\.id === 'nes' && !modernRuntimeSyntaxSupported\(\)/, 'NES 详情页走 jsnes')
assert.match(player, /targetPlatform === 'nes' && !modernRuntimeSyntaxSupported\(\)/, '本地 ROM 的 NES 也走 jsnes')
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
