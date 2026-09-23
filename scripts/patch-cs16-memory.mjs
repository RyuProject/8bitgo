#!/usr/bin/env node

/**
 * Xash3D 1.2.2 把主 WASM 的 memory 写成 min=256MB、max=256MB。
 * CS 资源放入 MEMFS 后，地图启动时还要给渲染器、模型和动态库分配内存；最大值不允许增长就会
 * 在 xash.main() 处稳定 `Aborted(OOM)`。这里只把 maximum 改成 512MB，initial 保持 256MB，
 * 浏览器仍按需增长，不会一进页面就多占 256MB。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const wasmPath = join(root, 'public/web/cs16/engine/dist/xash.wasm')
const gluePath = join(root, 'public/web/cs16/engine/dist/generated/xash.js')
const bytes = readFileSync(wasmPath)

function readLeb(at) {
  let value = 0
  let shift = 0
  let cursor = at
  for (;;) {
    const byte = bytes[cursor++]
    if (byte == null || shift > 35) throw new Error('WASM LEB128 损坏')
    value |= (byte & 0x7f) << shift
    if (!(byte & 0x80)) return { value: value >>> 0, start: at, end: cursor }
    shift += 7
  }
}

function encodeLeb(value) {
  const out = []
  do {
    let byte = value & 0x7f
    value >>>= 7
    if (value) byte |= 0x80
    out.push(byte)
  } while (value)
  return Buffer.from(out)
}

if (!bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) {
  throw new Error('xash.wasm 魔数或版本不正确')
}

let cursor = 8
let patched = false
let found = false
while (cursor < bytes.length) {
  const sectionId = bytes[cursor++]
  const size = readLeb(cursor)
  cursor = size.end
  const sectionEnd = cursor + size.value
  if (sectionId === 5) {
    found = true
    const count = readLeb(cursor)
    cursor = count.end
    if (count.value !== 1) throw new Error(`预期一个 memory，实际 ${count.value}`)
    const flags = readLeb(cursor); cursor = flags.end
    const initial = readLeb(cursor); cursor = initial.end
    if (!(flags.value & 1)) throw new Error('主 memory 没有 maximum，补丁前提已变化')
    const maximum = readLeb(cursor)
    if (initial.value !== 4096) throw new Error(`预期 initial=4096 页，实际 ${initial.value}`)
    if (![4096, 8192].includes(maximum.value)) throw new Error(`预期 maximum=4096/8192 页，实际 ${maximum.value}`)
    const encoded = encodeLeb(8192)
    if (encoded.length !== maximum.end - maximum.start) throw new Error('新旧 maximum 编码长度不同，不能原位补丁')
    if (maximum.value === 4096) encoded.copy(bytes, maximum.start)
    patched = maximum.value === 4096
    cursor = sectionEnd
    break
  }
  cursor = sectionEnd
}

if (!found) throw new Error('没有找到 WASM memory section')

if (patched) writeFileSync(wasmPath, bytes)

const noGrowth = 'var _emscripten_resize_heap = requestedSize => { var oldSize = HEAPU8.length; requestedSize >>>= 0; abortOnCannotGrowMemory(requestedSize); };'
const withGrowth = 'var _emscripten_resize_heap = requestedSize => { var oldSize = HEAPU8.length; requestedSize >>>= 0; if (requestedSize <= oldSize) return 1; if (requestedSize > 536870912) return 0; var target = Math.min(536870912, Math.max(requestedSize, Math.ceil(oldSize * 1.2 / 65536) * 65536)); return growMemory(target); };'
let glue = readFileSync(gluePath, 'utf8')
let gluePatched = false
if (glue.includes(noGrowth)) {
  glue = glue.replace(noGrowth, withGrowth)
  writeFileSync(gluePath, glue)
  gluePatched = true
} else if (!glue.includes(withGrowth)) {
  throw new Error('generated/xash.js 的内存扩容函数形状已变化，不能安全补丁')
}

console.log(`${patched || gluePatched ? '✔ 已把' : '✔'} CS16 Xash 内存改为 256MB 初始、512MB 按需上限`)
