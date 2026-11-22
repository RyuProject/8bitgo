#!/usr/bin/env node
/** 给 EmulatorJS 构建目录里的 FCEUmm 显式导出 Libretro RAM 查询函数。 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const coreDir = process.argv[2]
if (!coreDir) throw new Error('用法：node scripts/patch-fceumm-ram-exports.mjs <FCEUmm 源码目录>')

const sourcePath = join(coreDir, 'src/drivers/libretro/libretro.c')
const original = readFileSync(sourcePath, 'utf8')
let source = original

const include = '#include <libretro.h>\n'
const includePatch = `${include}#ifdef __EMSCRIPTEN__\n#include <emscripten/emscripten.h>\n#define EJS_KEEPALIVE EMSCRIPTEN_KEEPALIVE\n#else\n#define EJS_KEEPALIVE\n#endif\n`
if (!source.includes('#define EJS_KEEPALIVE EMSCRIPTEN_KEEPALIVE')) {
  if (source.indexOf(include) < 0 || source.indexOf(include, source.indexOf(include) + include.length) >= 0) {
    throw new Error('FCEUmm 的 libretro.h include 位置变化，停止打 RAM 导出补丁')
  }
  source = source.replace(include, includePatch)
}

for (const signature of [
  'void *retro_get_memory_data(unsigned type)',
  'size_t retro_get_memory_size(unsigned type)',
]) {
  const exported = `EJS_KEEPALIVE ${signature}`
  if (source.includes(exported)) continue
  if (source.indexOf(signature) < 0 || source.indexOf(signature, source.indexOf(signature) + signature.length) >= 0) {
    throw new Error(`FCEUmm 未找到唯一的 ${signature}，停止打 RAM 导出补丁`)
  }
  source = source.replace(signature, exported)
}

if (source !== original) writeFileSync(sourcePath, source)
console.log('[ok] FCEUmm 已将 retro_get_memory_data / retro_get_memory_size 标为 WASM 导出')
