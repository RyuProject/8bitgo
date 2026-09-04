#!/usr/bin/env node
/**
 * 直播那条 socket.io 加载路径的回归测试。
 *
 * 背景：2026-09-04 线上控制台一直刷
 *   [live] 自动开播失败 Error: socket.io 已加载但没有暴露 io()
 * 脚本明明 200 而且是真的 socket.io（v4.8.3），onload 也触发了，就是 window.io 是空的。
 *
 * 病根是 UMD 的分支顺序：
 *   typeof exports === 'object' && typeof module !== 'undefined' → CommonJS
 *   typeof define === 'function' && define.amd                   → AMD
 *   否则                                                          → global.io = factory()
 * 页面上只要有人占了 define / module / exports，第三支就永远轮不到。
 *
 * 所以改成不走全局：取源码，把 module / exports 当**形参**喂进去（lib/umd.ts 的
 * runAsCommonJs），逼它走第一支。这个测试把三种页面环境都摆一遍，
 * 证明新写法在哪种下都拿得到 io()，而老写法（走全局）确实会空手而归。
 *
 * 跑：npm run test:live-io
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { looksLikeSocketIo, runAsCommonJs } from '../src/lib/umd.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// 服务端 serveClient:true 发出去的就是这个文件，测真货不测替身
const SRC = readFileSync(join(root, 'server/node_modules/socket.io/client-dist/socket.io.js'), 'utf8')

let pass = 0
const fails = []
const ck = (name, ok, detail = '') => {
  if (ok) pass++
  else fails.push(name)
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${detail ? `  — ${detail}` : ''}`)
}

/** 老写法：脚本在全局作用域里跑，指望它给 globalThis.io 赋值 */
function loadViaGlobal() {
  delete globalThis.io
  new Function(SRC).call(globalThis)
  const io = globalThis.io
  delete globalThis.io
  return io
}

/** 把某些全局临时占上，跑完还原 */
function withGlobals(vals, fn) {
  const saved = Object.entries(vals).map(([k]) => [k, k in globalThis, globalThis[k]])
  for (const [k, v] of Object.entries(vals)) globalThis[k] = v
  try {
    return fn()
  } finally {
    for (const [k, had, prev] of saved) {
      if (had) globalThis[k] = prev
      else delete globalThis[k]
    }
  }
}

console.log('① 干净页面')
{
  const io = runAsCommonJs(SRC)
  ck('新写法拿得到 io()', looksLikeSocketIo(io), `Manager=${typeof io?.Manager} Socket=${typeof io?.Socket}`)
  ck('全局 io 没被碰过', !('io' in globalThis))
  ck('老写法在干净页面上也能用（所以以前没暴露出问题）', looksLikeSocketIo(loadViaGlobal()))
}

console.log('② 页面上有 AMD 的 define（第三方 loader）')
withGlobals({ define: Object.assign(() => {}, { amd: {} }) }, () => {
  ck('老写法空手而归 —— 线上那条报错就是这么来的', loadViaGlobal() === undefined)
  ck('新写法照样拿得到 io()', looksLikeSocketIo(runAsCommonJs(SRC)))
})

console.log('③ 页面上有全局 module / exports（没包 IIFE 的第三方脚本）')
withGlobals({ module: { exports: {} }, exports: {} }, () => {
  ck('老写法空手而归', loadViaGlobal() === undefined)
  ck('新写法照样拿得到 io()', looksLikeSocketIo(runAsCommonJs(SRC)))
})

console.log('④ looksLikeSocketIo 认得出冒牌货')
{
  // js-dos 泄漏到全局的那个 io 就是 immer 的 each：是函数，但没有 Manager/Socket/connect
  const fakeIo = function each() {}
  ck('immer 的 each 这类同名函数不会被当成 socket.io', !looksLikeSocketIo(fakeIo))
  ck('undefined 不会被当成 socket.io', !looksLikeSocketIo(undefined))
  ck('普通对象不会被当成 socket.io', !looksLikeSocketIo({ Manager: 1 }))
}

console.log(`\n${pass}/${pass + fails.length} 通过`)
if (fails.length) {
  console.error('失败：', fails.join(' / '))
  process.exit(1)
}
console.log('直播 socket.io 加载测试通过')
