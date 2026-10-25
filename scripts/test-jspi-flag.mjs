#!/usr/bin/env node
/**
 * JSPI 开关的回归测试。跑：npm run test:jspi
 *
 * 这块的失败方式全是安静的：
 *   · key 写错 / 写晚了 → js-dos 根本读不到，预热与实际核心分叉，每次冷启动白下一份 7.9MB wasm
 *   · 浏览器不支持却写了 true → js-dos 的 dosJspi 会弹一个英文 alert
 *   · 忘了在不支持时写 false → 以前开过的玩家一直卡在那个弹窗上
 * 所以每条都钉。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { armJspi, JSDOS_JSPI_STORAGE_KEY, JSDOS_STORAGE_PREFIX, jspiEnabled, jspiOverride, jspiSupported } from '../src/emulator/jspiFlag.ts'

let pass = 0, fail = 0
const ok = (c, m) => { c ? (pass++, console.log('✅ ' + m)) : (fail++, console.log('❌ ' + m)) }

/* ---- 替身 ---- */
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
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

console.log('\n── 预热与正式开局共用的最终选择 ──')
setSupport(true)
ok(jspiEnabled('') === false, '⭐ 默认跑已验收的 Asyncify 核心（预热也拉 wdosbox-x.wasm）')
ok(jspiEnabled('?jspi=1') === true, '支持时 ?jspi=1 可以做同机对照')
ok(jspiEnabled('?jspi=0') === false, '人工关闭 → Asyncify')
setSupport(false)
ok(jspiEnabled('?jspi=1') === false, '浏览器不支持时人工强开也不能预热 JSPI 核心')

console.log('\n── armJspi 写进 localStorage 的值 ──')
ok(JSDOS_JSPI_STORAGE_KEY === 'jsdos.8.jspi', '⭐ js-dos 读的是带前缀的 jsdos.8.jspi，不是裸键 jspi')
setSupport(true)
store.clear()
store.set('jspi', 'true')
ok(armJspi('') === false, '默认关')
ok(store.get('jsdos.8.jspi') === 'false', "⭐ 关也要明确写 'false'，盖掉 js-dos 设置面板留下的 true")
ok(!store.has('jspi'), '旧代码误写的裸键会被清掉')

store.clear()
ok(armJspi('?jspi=1') === true, '支持 + ?jspi=1 → 开')
ok(store.get('jsdos.8.jspi') === 'true', "写进去的是字符串 'true'（js-dos 是按字符串比的）")

setSupport(false)
store.clear()
store.set('jsdos.8.jspi', 'true')
ok(armJspi('?jspi=1') === false, '⭐ 强制开也拦不住「浏览器根本不支持」')
ok(store.get('jsdos.8.jspi') === 'false', '不支持时哪怕人工要求开，也只能写 false（否则 js-dos 会弹英文 alert）')

console.log('\n── 键名必须和打包进站点的 js-dos 运行时一致 ──')
{
  const paths = readFileSync(new URL('../src/emulator/paths.ts', import.meta.url), 'utf8')
  const version = paths.match(/export const JSDOS_ASSET_VERSION = '([^']+)'/)?.[1]
  ok(Boolean(version), '读到了 JSDOS_ASSET_VERSION')
  let runtime = ''
  try {
    runtime = readFileSync(new URL(`../public/jsdos/v${version}/js-dos.js`, import.meta.url), 'utf8')
  } catch {
    console.log('ℹ️ 本地没有 public/jsdos 运行时（未跑 npm run jsdos），跳过键名对照')
  }
  if (runtime) {
    ok(runtime.includes(`(void 0,"${JSDOS_STORAGE_PREFIX}")`), `⭐ js-dos 的存储前缀仍是 ${JSDOS_STORAGE_PREFIX}`)
    ok(/jspi:"true"===\$r\.getItem\("jspi"\)/.test(runtime), '⭐ js-dos 仍在模块求值时经前缀存储读 jspi')
  }
}

console.log('\n── localStorage 不可用时不能炸 ──')
setSupport(true)
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => { throw new DOMException('denied', 'SecurityError') },
}
let threw = false
try { armJspi('') } catch { threw = true }
ok(!threw, '⭐ 无痕 / 禁用站点数据时静默吞掉 —— 这只是提速，不能让人玩不了游戏')
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }

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
