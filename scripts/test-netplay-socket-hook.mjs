/**
 * EmulatorJS 联机信令挂钩的回归测试（src/emulator/netplaySocketHook.ts）。
 *
 * 盯的两个坑（2026-11-11，大陆玩家《拳皇97》《合金弹头2》开联机 5 次全部「联机没有连上」）：
 *   1. emulator.min.js 自带 socket.io，加载时 `(globalThis).io = e()` 把适配器的包装覆盖掉 ——
 *      game_slug 补丁失效（服务端拒绝开房）、握手轨迹一条都记不到；
 *   2. socket 没连上就断时 socket.io 照样发 disconnect，引擎据此 leaveRoom 把 socket 置空，
 *      自动重连跟着没了，适配器白等到超时。
 *
 * 跑：npm run test:netplay-socket-hook
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { guardPreConnectDisconnect, installIoHook, withSignalTimeout } from '../src/emulator/netplaySocketHook.ts'

let n = 0
let failed = 0
const ok = (cond, msg) => {
  if (cond) {
    n++
    console.log('✅ ' + msg)
  } else {
    failed++
    console.error('❌ ' + msg)
  }
}
process.on('exit', () => {
  console.log(`\n${n} 项通过，${failed} 项失败`)
  if (failed) process.exitCode = 1
})

const wrapper = () => {
  const calls = []
  const wrap = (fn) => {
    const p = (...a) => {
      calls.push(a)
      return fn(...a)
    }
    p.__8bit = true
    p.inner = fn
    return p
  }
  return { wrap, calls }
}

// ── 1. 后赋值的 io 也会被包 ──
{
  const win = { io: (u) => ({ from: 'injected', u }) }
  const { wrap, calls } = wrapper()
  ok(installIoHook(win, wrap), '能把 io 钉成访问器')
  ok(win.io.__8bit, '先注入的那份被包了')
  const engineIo = (u) => ({ from: 'engine', u })
  win.io = engineIo
  ok(win.io.__8bit && win.io.inner === engineIo, '引擎后来赋的 io 也被包上')
  win.io('https://x/netplay')
  ok(calls.length === 1, '调用经过包装')
  const again = win.io
  win.io = again
  ok(win.io === again, '已经包过的不会重复包')
}

// ── 2. 用 emulator.min.js 里那段真实的 UMD 赋值验一遍 ──
{
  const src = readFileSync(new URL('../public/emulatorjs/emulator.min.js', import.meta.url), 'utf8')
  const marker = '(t="undefined"!=typeof globalThis?globalThis:t||self).io=e()'
  ok(src.includes(marker), 'emulator.min.js 仍自带 socket.io 并赋给全局 io（引擎升级后这条红了就重新取证）')
  const ctx = vm.createContext({})
  ctx.window = ctx
  ctx.io = function injected() {}
  const { wrap } = wrapper()
  installIoHook(ctx, wrap)
  vm.runInContext(
    `(function(t,e){"object"==typeof exports&&"undefined"!=typeof module?module.exports=e():"function"==typeof define&&define.amd?define(e):${marker}})(window,function(){return function engineIo(){return {engine:true}}})`,
    ctx,
  )
  ok(ctx.io.__8bit && ctx.io.inner.name === 'engineIo', 'UMD 覆盖之后全局 io 仍是包装过的引擎版本')
  ok(vm.runInContext('typeof io', ctx) === 'function', '裸 io 读到的是函数（引擎 typeof io 检查能过）')
}

// ── 3. 握手超时 ──
{
  assert.deepEqual(withSignalTimeout(['https://h/netplay'], 8000), ['https://h/netplay', { timeout: 8000 }])
  ok(true, '只传地址时补上 timeout')
  assert.deepEqual(withSignalTimeout(['u', { path: '/s' }], 8000), ['u', { path: '/s', timeout: 8000 }])
  ok(true, '已有选项时合并 timeout')
  assert.deepEqual(withSignalTimeout(['u', { timeout: 3000 }], 8000), ['u', { timeout: 3000 }])
  ok(true, '调用方显式给的 timeout 不动')
  assert.deepEqual(withSignalTimeout([{ path: '/s' }], 8000), [{ path: '/s', timeout: 8000 }])
  ok(true, '只传选项对象时也补')
}

// ── 4. 没连上就断：引擎的 leaveRoom 不触发 ──
{
  const handlers = {}
  const sock = {
    on(ev, cb) {
      ;(handlers[ev] ||= []).push(cb)
      return this
    },
  }
  const fire = (ev, ...a) => (handlers[ev] || []).forEach((h) => h(...a))
  const ours = []
  sock.on('disconnect', (r) => ours.push(r))
  const swallowed = []
  ok(guardPreConnectDisconnect(sock, (r) => swallowed.push(r)), '挂上守卫')
  let left = 0
  const ret = sock.on('disconnect', () => left++)
  ok(ret === sock, 'on 仍可链式调用')
  fire('disconnect', 'transport close')
  ok(left === 0, '从未连上时引擎的 disconnect（leaveRoom）不触发')
  ok(swallowed[0] === 'transport close' && ours.length === 1, '拦下来的会回报，守卫之前注册的日志照记')
  fire('connect')
  fire('disconnect', 'ping timeout')
  ok(left === 1, '连上之后的断线照旧交给引擎退房')
  let other = 0
  sock.on('users-updated', () => other++)
  fire('users-updated')
  ok(other === 1, '其它事件不受影响')
  ok(guardPreConnectDisconnect(undefined) === false && guardPreConnectDisconnect({}) === false, '不是 socket 的对象原样放过')
}

// ── 5. 适配器确实在用这几样 ──
{
  const adapter = readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
  ok(/installIoHook\(win, wrapIo\)/.test(adapter), 'hookRoomToken 用访问器挂钩，而不是一次性赋值')
  ok(!/\n\s*win\.io = proxy/.test(adapter), '不再一次性 win.io = proxy')
  ok(/withSignalTimeout\(rawArgs, SIGNAL_CONNECT_TIMEOUT_MS\)/.test(adapter), 'io() 带上更短的握手超时')
  ok(/guardPreConnectDisconnect\(sock,/.test(adapter), 'socket 诞生时挂上未连先断守卫')
  ok(/netTrace\.errors >= SIGNAL_FAIL_ERRORS/.test(adapter), '一次 connect_error 不再直接判「连不上」')
}
