#!/usr/bin/env node
/**
 * PPSSPP v128 invoke 跳板回归（AGENTS.md §2.32.2 v24）。
 *
 * 1. 迷你模块复现：v128 签名的 JS 导入一调用就抛 `type incompatibility`（QQ Browser 21 现场的原文）；
 *    换成跳板后同一调用正常返回。
 * 2. 当前实体运行时：胶水已装跳板、所有 v128 导入都被覆盖，跳板导出能通过真实 18MB Wasm 的链接类型检查，
 *    主表抄过去后 GamepadEmuView 用到的表项可用。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildSimdTrampolineModule, findV128InvokeImports, SIMD_TRAMPOLINE_MARKER } from './helpers/ppsspp-simd-trampoline.mjs'

const RUNTIME = new URL('../public/ppsspp/v0dbfaca/v24/', import.meta.url)

// ---- 1. 迷你模块 ----
const v128const = [0xfd, 0x0c, 7, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0]
const mini = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  // types: 0 = (v128)->i32, 1 = (i32,v128)->i32, 2 = ()->i32
  0x01, 0x10, 0x03, 0x60, 0x01, 0x7b, 0x01, 0x7f, 0x60, 0x02, 0x7f, 0x7b, 0x01, 0x7f, 0x60, 0x00, 0x01, 0x7f,
  // import a.Wd type 1
  0x02, 0x08, 0x01, 0x01, 0x61, 0x02, 0x57, 0x64, 0x00, 0x01,
  // funcs: callee type 0, run type 2
  0x03, 0x03, 0x02, 0x00, 0x02,
  // table funcref min 1
  0x04, 0x04, 0x01, 0x70, 0x00, 0x01,
  // exports: run (func 2), tbl (table 0)
  0x07, 0x0d, 0x02, 0x03, 0x72, 0x75, 0x6e, 0x00, 0x02, 0x03, 0x74, 0x62, 0x6c, 0x01, 0x00,
  // elem: table0 offset 0 -> func 1
  0x09, 0x07, 0x01, 0x00, 0x41, 0x00, 0x0b, 0x01, 0x01,
  ...codeSection(),
])
function codeSection() {
  const callee = [0x00, 0x20, 0x00, 0xfd, 0x1b, 0x00, 0x0b]
  const run = [0x00, 0x41, 0x00, ...v128const, 0x10, 0x00, 0x0b]
  const body = [0x02, callee.length, ...callee, run.length, ...run]
  return [0x0a, body.length, ...body]
}
assert.ok(WebAssembly.validate(mini), '迷你复现模块必须合法')
const jsInvoke = (index, a1) => 0
const broken = new WebAssembly.Instance(new WebAssembly.Module(mini), { a: { Wd: jsInvoke } })
assert.throws(() => broken.exports.run(), (e) => e instanceof TypeError && /type incompatibility/.test(e.message),
  'v128 跨 JS 边界必须复现 QQ Browser 现场的 TypeError')

const entries = [{ field: 'Wd', params: ['i32', 'v128'], results: ['i32'] }]
const table = new WebAssembly.Table({ element: 'anyfunc', initial: 0 })
const tramp = new WebAssembly.Instance(new WebAssembly.Module(buildSimdTrampolineModule(entries)), { e: { t: table } })
const fixed = new WebAssembly.Instance(new WebAssembly.Module(mini), { a: { Wd: tramp.exports.Wd } })
table.grow(fixed.exports.tbl.length)
table.set(0, fixed.exports.tbl.get(0))
assert.equal(fixed.exports.run(), 7, '跳板必须按表索引调用并原样传递 v128')

// ---- 2. 当前实体运行时 ----
const wasm = readFileSync(new URL('PPSSPPSDL.wasm', RUNTIME))
const glue = readFileSync(new URL('PPSSPPSDL.js', RUNTIME), 'utf8')
assert.ok(glue.includes(SIMD_TRAMPOLINE_MARKER), 'v24 胶水必须装上 v128 跳板')
assert.ok(glue.includes('function getWasmImports(){assignWasmImports();__8bitgoInstallSimdTrampolines(wasmImports);'), '每个线程取导入时都要替换 v128 导入')
assert.ok(glue.includes('assignWasmExports(wasmExports);__8bitgoFillSimdTrampolineTable();'), '实例化后必须把主表抄进跳板表')
const v128 = findV128InvokeImports(wasm, glue)
assert.deepEqual(v128.map((e) => e.glueName).sort(), ['invoke_iiViijjji', 'invoke_iiViijjjij'], '已取证的 v128 导入只有这两个；核心换了要重新取证')
const moduleSrc = glue.match(/new WebAssembly\.Module\(new Uint8Array\(\[([\d,]+)\]\)\)/)
assert.ok(moduleSrc, '胶水里要内嵌跳板模块字节')
const embedded = new Uint8Array(moduleSrc[1].split(',').map(Number))
assert.deepEqual(embedded, buildSimdTrampolineModule(v128), '内嵌的跳板模块必须与当前 Wasm 的导入签名一致')

const realTable = new WebAssembly.Table({ element: 'anyfunc', initial: 0 })
const realTramp = new WebAssembly.Instance(new WebAssembly.Module(embedded), { e: { t: realTable } }).exports
const mod = new WebAssembly.Module(wasm)
const imports = {}
for (const entry of WebAssembly.Module.imports(mod)) {
  imports[entry.module] ??= {}
  if (entry.kind === 'function') imports[entry.module][entry.name] = realTramp[entry.name] ?? (() => 0)
  else if (entry.kind === 'memory') imports[entry.module][entry.name] = new WebAssembly.Memory({ initial: 8192, maximum: 65536, shared: true })
  else throw new Error(`未预期的导入 ${entry.kind}`)
}
const instance = new WebAssembly.Instance(mod, imports) // 跳板签名不对会在这里 LinkError
const mainTable = Object.values(instance.exports).find((value) => value instanceof WebAssembly.Table)
realTable.grow(mainTable.length)
for (let i = 0; i < mainTable.length; i++) realTable.set(i, mainTable.get(i))
assert.equal(typeof realTable.get(2612), 'function', 'addBoolButton lambda 必须抄进跳板表')
assert.equal(typeof realTable.get(2613), 'function', 'addPSPButton lambda 必须抄进跳板表')

console.log('✔ PPSSPP v128 invoke 跳板：复现与修复、真实 Wasm 链接均通过')
