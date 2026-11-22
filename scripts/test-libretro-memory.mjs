#!/usr/bin/env node
/** Libretro system RAM 读取层的边界与快照测试。 */
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { createSystemRamReader, RETRO_MEMORY_SYSTEM_RAM } from '../src/emulator/libretroMemory.ts'

const pointer = 0x100
const size = 0x800
const heap = new Uint8Array(0x1000)
for (let i = 0; i < size; i++) heap[pointer + i] = i & 0xff

const calls = []
const module = {
  HEAPU8: heap,
  cwrap(name, returnType, argumentTypes) {
    calls.push({ name, returnType, argumentTypes })
    if (name === 'retro_get_memory_data') return (region) => region === RETRO_MEMORY_SYSTEM_RAM ? pointer : 0
    if (name === 'retro_get_memory_size') return (region) => region === RETRO_MEMORY_SYSTEM_RAM ? size : 0
    throw new Error(`unexpected export: ${name}`)
  },
}

const read = createSystemRamReader(module)
const first = read()
assert.ok(first instanceof Uint8Array)
assert.equal(first.length, size)
assert.deepEqual(first.slice(0, 8), new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))
assert.equal(calls.length, 2, '导出包装只解析一次')

// 返回值必须是快照，调用方改它不能写进模拟器的 WASM 堆。
first[0] = 0xff
assert.equal(heap[pointer], 0)
heap[pointer] = 0x5a
assert.equal(read(0, 1)?.[0], 0x5a, '每次读取都要看当前 RAM 内容')

// HEAPU8 在 WASM memory.grow 后会换成新视图，读取器必须动态读取新视图。
const grownHeap = new Uint8Array(0x2000)
grownHeap.set(heap)
grownHeap[pointer + 0x7ff] = 0xa5
module.HEAPU8 = grownHeap
assert.deepEqual(read(0x7ff, 1), new Uint8Array([0xa5]))

assert.equal(read(size)?.length, 0, 'RAM 尾后一格只允许空快照')
assert.equal(read(size, 0)?.length, 0)
for (const [offset, length] of [
  [-1, undefined], [0.5, 1], [Number.NaN, 1], [size + 1, undefined], [size - 1, 2], [0, -1], [0, 1.5],
]) {
  assert.equal(read(offset, length), null, `越界或非整数范围必须返回 null：${offset}, ${length}`)
}

assert.equal(createSystemRamReader({ HEAPU8: heap })(0), null, '没有 cwrap 时安全不可用')
assert.equal(createSystemRamReader({ HEAPU8: heap, cwrap: () => { throw new Error('not exported') } })(0), null)
assert.equal(createSystemRamReader({
  HEAPU8: heap,
  cwrap(name) {
    return name.endsWith('_data') ? () => heap.length - 1 : () => size
  },
})(0), null, '指针 + 长度 超出当前堆时必须拒绝')

// EmulatorJS 实际把 RetroArch 的 get_memory_data 包成了命名区域 API，
// 而不是把 FCEUmm 符号放到外层 Module.cwrap；这一条是生产核心走的路径。
const bridgeHeap = new Uint8Array([0xff, 0x01, 0x02, 0x03, 0x04])
const bridgedModule = {
  EmulatorJSGetMemoryData(region) {
    assert.equal(region, 'RETRO_MEMORY_SYSTEM_RAM')
    return bridgeHeap.subarray(1)
  },
}
const bridgedRead = createSystemRamReader(bridgedModule)
const bridgedSnapshot = bridgedRead()
assert.deepEqual(bridgedSnapshot, new Uint8Array([1, 2, 3, 4]))
bridgedSnapshot[0] = 0xff
assert.equal(bridgeHeap[1], 0x01, 'EmulatorJS heap view 也必须复制后再返回')
assert.deepEqual(bridgedRead(1, 2), new Uint8Array([2, 3]))
assert.equal(bridgedRead(4, 1), null, '桥接 API 的越界范围必须拒绝')
assert.equal(createSystemRamReader({ EmulatorJSGetMemoryData: () => undefined })(0), null)
assert.equal(createSystemRamReader({ EmulatorJSGetMemoryData: () => new Uint8Array() })(0), null, '空内存区表示当前核心没有可读 RAM')
const iframeHeapView = runInNewContext('new Uint8Array([7, 8, 9])')
assert.deepEqual(createSystemRamReader({ EmulatorJSGetMemoryData: () => iframeHeapView })(), new Uint8Array([7, 8, 9]), '跨 iframe 的 WASM heap view 也必须能读取')

console.log('[ok] Libretro system RAM 快照、WASM 堆增长、边界和缺失导出均符合预期')
