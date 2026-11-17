#!/usr/bin/env node
/**
 * 在 Node 里真正 import 一次 EmulatorJS 引擎（emulator.min.js），确认它能求值并导出 EmulatorJS 类。
 *
 * 语法检查（js-module-syntax.mjs）只保证能解析；模块顶层若在求值时抛错（补丁引用了不存在的变量、
 * 顶层代码访问了改名的类……），loader.js 的 import() 照样整份失败，所有 EmulatorJS 平台照样全挂。
 * 这里给一个「什么都能点出来」的宽容 DOM 桩，只求值模块顶层，不 new 引擎、不碰任何真实 DOM 行为。
 *
 * 单独起子进程跑（check-emulatorjs.mjs 调它）：桩会改 globalThis，不能污染调用方。
 *
 *   node scripts/lib/ejs-engine-import-smoke.mjs public/emulatorjs/emulator.min.js
 * 退出码 0 = 通过；1 = 失败（stderr 一行说明，不打印整行压缩源码）。
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** EmulatorJS 类必须有的方法：loader.js / 适配器 / 补丁都依赖它们 */
export const REQUIRED_ENGINE_METHODS = Object.freeze(['getCores', 'getCore', 'createElement', 'addEventListener', 'startGame', 'downloadFile'])

function tolerantStub(name = 'stub') {
  const fn = function () {}
  return new Proxy(fn, {
    get(_target, prop) {
      if (prop === Symbol.toPrimitive) return () => ''
      if (prop === 'then') return undefined // 别被当成 thenable
      if (prop === Symbol.iterator) return function* () {}
      if (prop === 'length') return 0
      if (prop === 'prototype') return {}
      return tolerantStub(`${name}.${String(prop)}`)
    },
    apply() { return tolerantStub(`${name}()`) },
    construct() { return tolerantStub(`new ${name}`) },
    set() { return true },
    has() { return true },
  })
}

export async function smokeImportEngine(file) {
  for (const key of ['document', 'navigator', 'location', 'localStorage', 'sessionStorage', 'indexedDB', 'screen', 'matchMedia', 'requestAnimationFrame', 'HTMLElement', 'HTMLCanvasElement', 'Image', 'Audio', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver']) {
    if (!(key in globalThis)) {
      try { globalThis[key] = tolerantStub(key) } catch { /* 只读的全局（如 navigator）保持原样 */ }
    }
  }
  if (!('window' in globalThis)) globalThis.window = globalThis
  let mod
  try {
    mod = await import(`${pathToFileURL(resolve(file)).href}?smoke=${Date.now()}`)
  } catch (error) {
    return `import 失败：${error?.name || 'Error'}: ${error?.message || error}`
  }
  const Engine = mod?.default
  if (typeof Engine !== 'function') return `默认导出不是 EmulatorJS 类（实际：${typeof Engine}）`
  const proto = Engine.prototype || {}
  const missing = REQUIRED_ENGINE_METHODS.filter((name) => typeof proto[name] !== 'function')
  if (missing.length) return `EmulatorJS 类缺少方法：${missing.join(', ')}`
  return ''
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const file = process.argv[2]
  if (!file) {
    console.error('用法：node scripts/lib/ejs-engine-import-smoke.mjs <emulator.min.js>')
    process.exit(1)
  }
  const problem = await smokeImportEngine(file)
  if (problem) {
    console.error(problem)
    process.exit(1)
  }
  console.log('ok')
  // 引擎顶层可能挂了定时器 / 监听；求值成功就够了，不等它们
  process.exit(0)
}
