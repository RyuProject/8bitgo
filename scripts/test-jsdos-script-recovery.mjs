#!/usr/bin/env node
/**
 * js-dos 的依赖脚本请求失败后，浏览器会保留失败的 <script>。这项回归从实际发布产物里
 * 抽出依赖加载器，在最小 DOM 桩中先模拟 EdgeOne 失败，再模拟同源重试，确认第二次真的发请求。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const paths = readFileSync(path.join(root, 'src/emulator/paths.ts'), 'utf8')
const assetVersion = paths.match(/export const JSDOS_ASSET_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1]
assert.ok(assetVersion, '找不到 JSDOS_ASSET_VERSION')
const runtime = readFileSync(path.join(root, `public/jsdos/v${assetVersion}/js-dos.js`), 'utf8')
const startMarker = 'await function(e,t){'
const endMarker = '}(t,n),Ci=!0'
const startAt = runtime.indexOf(startMarker)
const endAt = runtime.indexOf(endMarker, startAt + startMarker.length)
assert.ok(startAt >= 0 && endAt > startAt, 'js-dos 依赖加载器结构变化，需更新此行为测试')
const loaderBody = runtime.slice(startAt + startMarker.length, endAt)

const scripts = []
const elements = []
const timers = []
const fakeSetTimeout = (callback, delay) => {
  const timer = { callback, delay, cleared: false }
  timers.push(timer)
  return timer
}
const fakeClearTimeout = (timer) => {
  if (timer) timer.cleared = true
}
const remove = (element) => {
  element.removed = true
  const index = elements.indexOf(element)
  if (index >= 0) elements.splice(index, 1)
}
const document = {
  querySelector(selector) {
    assert.equal(selector, '#emulators-js')
    return elements.find((element) => element.id === 'emulators-js') ?? null
  },
  createElement(name) {
    assert.equal(name, 'script')
    return {
      id: '',
      remove() { remove(this) },
    }
  },
  head: {
    appendChild(script) {
      scripts.push(script)
      elements.push(script)
      return script
    },
  },
}
const window = { emulators: undefined }
const loadEmulators = new Function(
  'window', 'document', 'setTimeout', 'clearTimeout',
  `let __8bitgoEmulatorsLoading=null;return (e,t)=>{${loaderBody}}`,
)(window, document, fakeSetTimeout, fakeClearTimeout)

// 上局失败留下的标签即使还在 DOM，也不能被当成依赖已加载。
const stale = { id: 'emulators-js', remove() { remove(this) } }
elements.push(stale)
const firstAttempt = loadEmulators('https://cn-assets.8bitgo.com/jsdos/', '?v=1')
assert.equal(stale.removed, true, '重试前应移除上次失败遗留的 script')
assert.equal(scripts.length, 1, '清掉残留标签后应创建新的请求')
const concurrentAttempt = loadEmulators('https://8bitgo.com/jsdos/', '?v=1')
assert.equal(scripts.length, 1, '同一时刻只能有一个 emulators.js 请求')
scripts[0].onerror(new Error('EdgeOne timeout'))
await Promise.all([
  assert.rejects(firstAttempt, /Unable to add emulators\.js/),
  assert.rejects(concurrentAttempt, /Unable to add emulators\.js/),
])
assert.equal(scripts[0].removed, true, '请求失败后应清掉标签，允许下次重试')
assert.equal(timers[0].cleared, true, '请求失败时应清理超时定时器')

// 玩家重开后换同源：必须发出第二个请求，不能因失败标签存在而假装加载成功。
const retry = loadEmulators('https://8bitgo.com/jsdos/', '?v=1')
assert.equal(scripts.length, 2, '第一次请求失败后重试必须创建新 script')
window.emulators = { version: '8.5.3' }
scripts[1].onload()
await retry
assert.equal(timers[1].cleared, true, '请求成功时应清理超时定时器')
assert.equal(window.emulators.pathPrefix, 'https://8bitgo.com/jsdos/')
assert.equal(window.emulators.pathSuffix, '?v=1')

// 并发调用共享请求，但每个调用仍需把全局运行时目录改成自己选择的线路。
window.emulators = undefined
const edgeAttempt = loadEmulators('https://cn-assets.8bitgo.com/jsdos/', '?v=3')
const sameOriginAttempt = loadEmulators('https://8bitgo.com/jsdos/', '?v=4')
assert.equal(scripts.length, 3, '不同线路并发时仍只应创建一个 script')
window.emulators = { version: '8.5.3' }
scripts[2].onload()
await Promise.all([edgeAttempt, sameOriginAttempt])
assert.equal(window.emulators.pathPrefix, 'https://8bitgo.com/jsdos/', '后开始的同源调用应在共享加载完成后更新运行时目录')
assert.equal(window.emulators.pathSuffix, '?v=4')
assert.equal(timers[2].cleared, true, '并发请求成功时也应清理超时定时器')

// 后续实例可复用已初始化的全局对象，并更新到本局选择的运行时目录。
await loadEmulators('https://8bitgo.com/jsdos-next/', '?v=2')
assert.equal(scripts.length, 3, '依赖已加载后不应重复注入 script')
assert.equal(window.emulators.pathPrefix, 'https://8bitgo.com/jsdos-next/')
assert.equal(window.emulators.pathSuffix, '?v=2')

// HTTP onload 不代表脚本执行成功：没有暴露全局对象时仍要失败并清理。
window.emulators = undefined
const noGlobal = loadEmulators('https://8bitgo.com/jsdos/', '?v=1')
scripts[3].onload()
await assert.rejects(noGlobal, /emulators\.js loaded without window\.emulators/)
assert.equal(scripts[3].removed, true, '脚本执行成功事件却没初始化全局对象时也要清理')
assert.equal(timers[3].cleared, true, 'onload 没有全局对象时应清理超时定时器')

// 没有 load / error 的慢请求必须自我结束，不能让下一次同源重试继续等待旧 Promise。
const hanging = loadEmulators('https://cn-assets.8bitgo.com/jsdos/', '?v=5')
assert.equal(scripts.length, 5)
assert.equal(timers[4].delay, 7000, '依赖请求超时必须早于适配器 8 秒兜底')
timers[4].callback()
await assert.rejects(hanging, /emulators\.js load timed out/)
assert.equal(scripts[4].removed, true, '请求超时后应移除仍 pending 的 script')
const afterTimeout = loadEmulators('https://8bitgo.com/jsdos/', '?v=5')
assert.equal(scripts.length, 6, '超时释放 Promise 后应能创建同源请求')
window.emulators = { version: '8.5.3' }
scripts[5].onload()
await afterTimeout
assert.equal(window.emulators.pathPrefix, 'https://8bitgo.com/jsdos/')

console.log('✔ js-dos 依赖脚本失败后清理标签，并可由同源入口重试')
