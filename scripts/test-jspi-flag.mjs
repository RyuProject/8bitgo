#!/usr/bin/env node
/**
 * JSPI 开关的回归测试。跑：npm run test:jspi
 *
 * 这块的失败方式全是安静的：
 *   · key 写错 / 写晚了 → 永远跑 Asyncify 版，慢一截，没有任何迹象
 *   · 浏览器不支持却写了 true → js-dos 的 dosJspi 会弹一个英文 alert
 *   · 忘了在不支持时写 false → 以前开过的玩家一直卡在那个弹窗上
 * 所以每条都钉。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { armJspi, jspiOverride, jspiSupported } from '../src/emulator/jspiFlag.ts'

let pass = 0, fail = 0
const ok = (c, m) => { c ? (pass++, console.log('✅ ' + m)) : (fail++, console.log('❌ ' + m)) }

/* ---- 替身 ---- */
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
}
const realWasm = globalThis.WebAssembly
const setSupport = (yes) => {
  globalThis.WebAssembly = yes ? { ...realWasm, promising: () => {} } : { ...realWasm, promising: undefined }
}

console.log('── 特性检测 ──')
setSupport(true)
ok(jspiSupported() === true, 'WebAssembly.promising 存在 → 支持')
setSupport(false)
ok(jspiSupported() === false, '不存在 → 不支持')

console.log('\n── 查询串开关（同一台机器 A/B 用）──')
ok(jspiOverride('?jspi=1') === true, '?jspi=1 强制开')
ok(jspiOverride('?jspi=on') === true, '?jspi=on 强制开')
ok(jspiOverride('?jspi=0') === false, '?jspi=0 强制关')
ok(jspiOverride('?jspi=off') === false, '?jspi=off 强制关')
ok(jspiOverride('?x=1') === null, '没写就不表态（交给特性检测）')
ok(jspiOverride('') === null, '空查询串不表态')
ok(jspiOverride('?jspi=maybe') === null, '认不出来的值不表态，而不是当成开')

console.log('\n── armJspi 写进 localStorage 的值 ──')
setSupport(true)
store.clear()
ok(armJspi('') === true, '支持 → 自动开')
ok(store.get('jspi') === 'true', "写进去的是字符串 'true'（js-dos 是按字符串比的）")

setSupport(false)
store.clear()
ok(armJspi('') === false, '不支持 → 关')
ok(store.get('jspi') === 'false', "⭐ 不支持时要**明确写 'false'**，不能只是不写")

setSupport(false)
store.set('jspi', 'true')
ok(armJspi('') === false, '⭐ 以前开过、现在换了不支持的浏览器 → 必须覆盖掉')
ok(store.get('jspi') === 'false', '旧的 true 没被清掉的话 js-dos 会弹一个英文 alert')

setSupport(true)
store.clear()
ok(armJspi('?jspi=0') === false, '查询串能强制关（用来 A/B 对照组）')
ok(store.get('jspi') === 'false', '强制关也要落盘')

setSupport(false)
store.clear()
ok(armJspi('?jspi=1') === false, '⭐ 强制开也拦不住「浏览器根本不支持」')
ok(store.get('jspi') === 'false', '不支持时哪怕人工要求开，也只能写 false')

console.log('\n── localStorage 不可用时不能炸 ──')
setSupport(true)
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => { throw new DOMException('denied', 'SecurityError') },
}
let threw = false
try { armJspi('') } catch { threw = true }
ok(!threw, '⭐ 无痕 / 禁用站点数据时静默吞掉 —— 这只是提速，不能让人玩不了游戏')
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) }

console.log('\n── 接线 ──')
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const src = strip(readFileSync(new URL('../src/emulator/adapters/jsdos.ts', import.meta.url), 'utf8'))
ok(/armJspi\(\)/.test(src), 'jsdos 适配器真的调了 armJspi')
{
  /*
    ⚠️ 顺序是这条的全部意义：js-dos 的 store 在**模块求值时**读 localStorage，
    晚一步写就完全无效，而且不会有任何报错 —— 只是永远跑 Asyncify 版。
  */
  const armed = src.indexOf('armJspi()')
  const injected = src.indexOf("script.src = `${JSDOS_PATH}js-dos.js`")
  ok(armed > 0 && injected > 0 && armed < injected, '⭐ armJspi 必须在插入 js-dos.js 的 <script> 之前')
}

console.log(`\n${fail ? '❌' : '✅'} JSPI 开关：${pass} 项通过，${fail} 项失败`)
process.exit(fail ? 1 : 0)
