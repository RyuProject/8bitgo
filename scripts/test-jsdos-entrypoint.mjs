#!/usr/bin/env node
/** js-dos 主入口脚本也必须有界；EdgeOne 慢速挂起时要释放标签并允许同源回退。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const { loadJsdosScript } = await import(pathToFileURL(`${process.cwd()}/src/emulator/jsdosScriptLoader.ts`))
const source = readFileSync(`${process.cwd()}/src/emulator/adapters/jsdos.ts`, 'utf8')
assert.match(source, /loadJsdosScript\(document, `\$\{root\}js-dos\.js`, \(\) => win\.Dos, \{ timeoutMs: JSDOS_ENTRY_TIMEOUT_MS \}\)/)
assert.match(source, /加载失败或超时，改走同源/)

function harness() {
  const scripts = []
  const timers = []
  const document = {
    createElement(name) {
      assert.equal(name, 'script')
      return { async: false, src: '', onload: null, onerror: null, removed: false, remove() { this.removed = true } }
    },
    head: { appendChild(script) { scripts.push(script); return script } },
  }
  const setTimer = (callback, delay) => {
    const timer = { callback, delay, cleared: false }
    timers.push(timer)
    return timer
  }
  const clearTimer = (timer) => { if (timer) timer.cleared = true }
  return { document, scripts, timers, setTimer, clearTimer }
}

{
  const h = harness()
  let runtime
  const loading = loadJsdosScript(h.document, 'https://cn-assets.example/js-dos.js', () => runtime, {
    timeoutMs: 20_000, setTimer: h.setTimer, clearTimer: h.clearTimer,
  })
  assert.equal(h.scripts[0].src, 'https://cn-assets.example/js-dos.js')
  assert.equal(h.timers[0].delay, 20_000)
  h.timers[0].callback()
  await assert.rejects(loading, /timed out after 20000ms/)
  assert.equal(h.scripts[0].removed, true, '超时必须清理标签，避免重试误以为脚本已加载')
  assert.equal(h.timers[0].cleared, true)

  const retry = loadJsdosScript(h.document, 'https://8bitgo.com/js-dos.js', () => runtime, {
    timeoutMs: 20_000, setTimer: h.setTimer, clearTimer: h.clearTimer,
  })
  assert.equal(h.scripts.length, 2, '释放超时 Promise 后能创建同源重试')
  runtime = { Dos: true }
  h.scripts[1].onload()
  assert.equal(await retry, runtime)
  assert.equal(h.timers[1].cleared, true)
}

{
  const h = harness()
  const loading = loadJsdosScript(h.document, '/js-dos.js', () => undefined, {
    timeoutMs: 5_000, setTimer: h.setTimer, clearTimer: h.clearTimer,
  })
  h.scripts[0].onload()
  await assert.rejects(loading, /loaded without its runtime export/)
  assert.equal(h.scripts[0].removed, true)
  assert.equal(h.timers[0].cleared, true)
}

{
  const h = harness()
  let runtime
  const loading = loadJsdosScript(h.document, '/js-dos.js', () => runtime, {
    timeoutMs: 5_000, setTimer: h.setTimer, clearTimer: h.clearTimer,
  })
  h.scripts[0].onerror()
  await assert.rejects(loading, /script request failed/)
  assert.equal(h.scripts[0].removed, true)
  assert.equal(h.timers[0].cleared, true)
}

console.log('✔ js-dos 主入口请求超时、错误与缺失全局对象都会释放并可重试')
