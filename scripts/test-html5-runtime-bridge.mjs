#!/usr/bin/env node
/**
 * Pages 网页游戏的生命周期桥（public/html5-api/8bitgo-runtime-bridge.js）的就绪预算。
 *
 *   npm run test:html5-runtime-bridge
 *
 * 2026-11-18 植物大战僵尸（日本 6.8Mbps，诊断包 #1220）：首次要下约 93MB，桥从安装起固定 120 秒，
 * 下载途中就报失败，播放器重试后又死一次。现在预算是「连续 120 秒没有进展」：游戏报进度就重新给满。
 * 这里用假时钟真跑一遍桥的源码。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { html5RuntimeSignal } from '../src/emulator/html5Lifecycle.ts'

const source = readFileSync(new URL('../public/html5-api/8bitgo-runtime-bridge.js', import.meta.url), 'utf8')

function boot() {
  let clock = 0
  let nextId = 1
  const timers = new Map()
  const messages = []
  const parent = { postMessage: (data, origin) => messages.push({ ...data, origin }) }
  const doc = {
    referrer: 'https://8bitgo.com/games/plants-vs-zombies-web',
    visibilityState: 'visible',
    currentScript: { dataset: {}, getAttribute: () => '' },
    documentElement: {},
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  }
  const win = {
    parent,
    document: doc,
    performance: { now: () => clock },
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { at: clock + ms, fn }); return id },
    clearTimeout: (id) => timers.delete(id),
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (fn) => win.setTimeout(fn, 16),
  }
  const ctx = vm.createContext({ window: win, document: doc, URL, Math, Number, Object, Date, Infinity })
  vm.runInContext(source, ctx, { filename: '8bitgo-runtime-bridge.js' })
  const advance = (ms) => {
    const end = clock + ms
    for (;;) {
      let due = null
      for (const [id, t] of timers) if (t.at <= end && (!due || t.at < due[1].at)) due = [id, t]
      if (!due) break
      timers.delete(due[0])
      clock = due[1].at
      due[1].fn()
    }
    clock = end
  }
  const failures = () => messages.filter((m) => m.type === 'failed')
  return { api: win.EightBitGoBridge, advance, messages, failures }
}

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✖ ${name}`)
    throw err
  }
}

console.log('网页游戏生命周期桥：就绪预算')

test('不报进度的游戏照旧：120 秒没有可玩信号就报失败', () => {
  const b = boot()
  b.advance(119_000)
  assert.equal(b.failures().length, 0)
  b.advance(2_000)
  assert.equal(b.failures().length, 1)
  assert.match(b.failures()[0].detail, /120 秒/)
})

test('慢网一直在下载：每次报进度都重新给满，230 秒也不判死', () => {
  const b = boot()
  for (let t = 0; t < 230; t += 10) {
    b.api.reportProgress(t / 230)
    b.advance(10_000)
  }
  assert.equal(b.failures().length, 0)
  b.api.reportPlayable()
  assert.ok(b.messages.some((m) => m.type === 'game-playable'))
  b.advance(300_000)
  assert.equal(b.failures().length, 0, '可玩之后不能再报超时')
})

test('进度停了：从最后一次进展算 120 秒才报失败', () => {
  const b = boot()
  b.advance(100_000)
  b.api.reportProgress(0.4)
  b.advance(119_000)
  assert.equal(b.failures().length, 0)
  b.advance(2_000)
  assert.equal(b.failures().length, 1)
})

test('进度转告父页按秒节流，并钳到 0~1；只发给已确认的本站父页', () => {
  const b = boot()
  b.api.reportProgress(0.1)
  b.api.reportProgress(0.2)
  b.api.reportProgress(0.3)
  b.advance(1_000)
  b.api.reportProgress(7)
  const progress = b.messages.filter((m) => m.type === 'progress')
  assert.deepEqual(progress.map((m) => m.detail), [0.1, 1])
  assert.ok(progress.every((m) => m.origin === 'https://8bitgo.com'))
})

test('父页协议：progress 带比例，非数字的比例丢掉，其它类型不受影响', () => {
  const base = { source: '8bitgo-runtime-bridge', version: 1 }
  assert.deepEqual(html5RuntimeSignal({ ...base, type: 'progress', detail: 0.42 }), { type: 'progress', ratio: 0.42 })
  assert.deepEqual(html5RuntimeSignal({ ...base, type: 'progress', detail: 'x' }), { type: 'progress' })
  assert.deepEqual(html5RuntimeSignal({ ...base, type: 'progress', detail: 3 }), { type: 'progress', ratio: 1 })
  assert.deepEqual(html5RuntimeSignal({ ...base, type: 'failed', detail: 'boom' }), { type: 'failed', detail: 'boom' })
  assert.equal(html5RuntimeSignal({ ...base, type: 'eval' }), null)
})

test('PvZ 自动加载器在更新进度条时报给桥', () => {
  for (const file of ['scripts/pvz-web/autoplay-snippet.html', 'public/web/PvZ/cn/index.html', 'public/web/PvZ/en/index.html']) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.ok(text.includes('bridge.reportProgress(p)'), `${file} 没有把下载进度报给生命周期桥`)
  }
})

console.log(`✓ 网页游戏生命周期桥 ${passed} 项通过`)
