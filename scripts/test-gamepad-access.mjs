/**
 * getGamepads() 被权限策略挡住时会抛 SecurityError（src/emulator/gamepadAccess.ts）。
 * 2026-11-14 大陆 iPad iOS 17 应用内浏览器《拳皇 97 风云再起 Plus》：EmulatorJS 的 GamepadHandler 在构造里
 * 同步调它，一抛错引擎没下核心就死了，两分钟后才报「卡住」。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const g = await import('../src/emulator/gamepadAccess.ts')
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const blockedError = () => Object.assign(new Error('Third-party iframes are not allowed to call getGamepads()'), { name: 'SecurityError' })

// 安全读：被挡住 / 没有 API / 只有 webkit 前缀
assert.deepEqual(g.readGamepadsSafe({ getGamepads: () => { throw blockedError() } }), [])
assert.deepEqual(g.readGamepadsSafe({}), [])
assert.deepEqual(g.readGamepadsSafe(undefined), [])
assert.deepEqual(g.readGamepadsSafe({ webkitGetGamepads: () => ['pad'] }), ['pad'])
assert.deepEqual(g.readGamepadsSafe({ getGamepads: () => [null, 'pad'] }), [null, 'pad'])

// iframe 守卫：被挡住时报 true，之后引擎调 getGamepads 拿空数组而不是抛错
{
  const win = { navigator: { getGamepads() { throw blockedError() } } }
  assert.equal(g.guardFrameGamepads(win), true)
  assert.deepEqual(win.navigator.getGamepads(), [], '引擎的 GamepadHandler 不再在构造里抛错')
}
// 没被挡住：照常返回原生结果，报 false
{
  const pads = [null, { id: 'pad', connected: true }]
  const win = { navigator: { getGamepads() { return pads } } }
  assert.equal(g.guardFrameGamepads(win), false)
  assert.equal(win.navigator.getGamepads(), pads)
}
// 之后才被挡住（外层框架换了）也不抛
{
  let allow = true
  const win = { navigator: { getGamepads() { if (!allow) throw blockedError(); return [] } } }
  assert.equal(g.guardFrameGamepads(win), false)
  allow = false
  assert.deepEqual(win.navigator.getGamepads(), [])
}
assert.equal(g.guardFrameGamepads({ navigator: {} }), null, '没有 API 就不装')

// 接线：守卫装在 loader.js 之前；外层三处轮询都走安全读
const adapter = read('src/emulator/adapters/emulatorjs.ts')
const guardAt = adapter.indexOf('guardFrameGamepads(win)')
assert.ok(guardAt > 0 && guardAt < adapter.indexOf("injectScript(doc, ejsRuntimeAsset('loader.js'))"), 'loader.js 之前装守卫')
assert.match(read('src/emulator/gamepad.ts'), /readGamepadsSafe\(navigator\)/)
assert.match(read('src/emulator/gamepadInput.ts'), /readGamepadsSafe\(navigator\)/)
assert.match(read('src/emulator/frameFocus.ts'), /readGamepadsSafe\(iframe\?\.contentWindow\?\.navigator\)/)
// 引擎里那段同步调用还在：升级引擎后它若改成自带 try，这条红了可以重新评估
assert.match(read('public/emulatorjs/emulator.min.js'), /getGamepads\(\)\{return navigator\.getGamepads\?navigator\.getGamepads\(\)/)

console.log('test:gamepad-access 通过')
