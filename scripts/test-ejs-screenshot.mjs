/**
 * EmulatorJS 截屏回归：npm run test:ejs-screenshot
 *
 * 2026-11-19《龙虎争霸1》玩家反馈「截图是白屏」。根因：适配器把 gameManager.screenshot() 当成「返回字节」，
 * 而当前引擎返回 Promise，`shot?.length` 恒为 undefined，于是一律落到 canvas.toBlob ——
 * WebGL2 画布没开 preserveDrawingBuffer，拿到的是一张全透明 PNG（Playwright 实测不透明像素 0），
 * 看图软件里显示成一整张白。所有 EmulatorJS 游戏都中招。
 *
 * 这里守两头：引擎那边的取证（接口形状变了要重新核），适配器这边的调用顺序。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

const engine = readFileSync(new URL('../public/emulatorjs/emulator.min.js', import.meta.url), 'utf8')
const adapter = readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
const code = adapter.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

check('引擎取证：gameManager.screenshot() 返回 Promise，且文件不出现就一直轮询（必须自己加时限）', () => {
  assert.match(engine, /screenshot\(\)\{try\{this\.FS\.unlink\("\/screenshot\.png"\)\}catch\(t\)\{\}return this\.functions\.screenshot\(\),new Promise\(async t=>\{for\(;;\)/)
})

check('引擎取证：takeScreenshot(source, format, upscale) 存在，canvas 那一路在 requestAnimationFrame 里拷画布', () => {
  assert.match(engine, /takeScreenshot\(t,e,i\)\{return new Promise/)
  const from = engine.indexOf('"canvas"===a){')
  assert.ok(from > 0, 'canvas 截图分支不见了')
  assert.match(engine.slice(from, from + 1200), /requestAnimationFrame\(\(\)=>\{i\.drawImage\(this\.canvas/)
})

check('适配器：先走引擎的 takeScreenshot(\'canvas\')，带时限', () => {
  assert.match(code, /withTimeout\(emu\.takeScreenshot\('canvas', 'png', 1\), SCREENSHOT_TIMEOUT_MS\)/)
})

check('适配器：RetroArch 原生截图只作兜底，而且等 Promise、带时限', () => {
  const method = code.slice(code.indexOf('async screenshot() {'), code.indexOf('captureSources():'))
  assert.ok(method.length > 0)
  assert.ok(method.indexOf('takeScreenshot') < method.indexOf('gm.screenshot()'), 'takeScreenshot 必须排在 RetroArch 截图前面')
  assert.match(method, /withTimeout\(Promise\.resolve\(gm\.screenshot\(\)\), SCREENSHOT_TIMEOUT_MS\)/)
})

check('适配器：截屏方法里不再直接 canvas.toBlob（那是全透明的空帧）', () => {
  const method = code.slice(code.indexOf('async screenshot() {'), code.indexOf('captureSources():'))
  assert.doesNotMatch(method, /canvas\.toBlob\(/)
})

check('适配器：自拷那一路在 iframe 的 rAF 里拷，并抽样排除空帧', () => {
  const from = code.indexOf('async function captureCanvasFrame')
  assert.ok(from > 0)
  const body = code.slice(from, code.indexOf('\n}\n', from))
  assert.match(body, /win\?\.requestAnimationFrame/)
  assert.match(body, /getImageData/)
  assert.match(body, /resolve\(lit > 0 \? out : null\)/)
})

console.log(`\nEmulatorJS 截屏回归：${passed} 项全过`)
