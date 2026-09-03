/**
 * 让 node 直接 import 前端的 .ts 源码，用于写不依赖构建的单元测试。
 *
 * 做两件事：把 `@/` 别名指回 src/，把测试用不到的重依赖（react 等）换成极小的桩。
 * 为什么不像 test-age-gate.mjs 那样先用 esbuild 打包：esbuild 装的是平台相关的
 * 原生二进制，换个机器就跑不了（这个仓库的 node_modules 在 macOS 上装的，
 * 挂到 Linux 侧一律报 Cannot find module '@esbuild/...'）。
 *
 * 用法见 scripts/test-rom-probe.mjs：node --experimental-strip-types --import ./scripts/helpers/ts-register.mjs
 */
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../../src/', import.meta.url))

/** 只桩掉与被测逻辑无关的模块，其余一律加载真实源码 */
const STUBS = {
  react: 'export const useState=()=>[];export const useEffect=()=>{};export const useCallback=(f)=>f;',
  '@/emulator': 'export const isPlayable=()=>true;',
  '@/services/lang': 'export const useLang=()=>"zh-Hans";',
  '@/data/platforms': 'export const platformMap={};',
}

export async function resolve(specifier, context, next) {
  if (STUBS[specifier]) return { url: 'stub:' + specifier, shortCircuit: true }
  if (specifier.startsWith('@/')) return next(pathToFileURL(SRC + specifier.slice(2)).href + '.ts', context)
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (url.startsWith('stub:')) return { format: 'module', shortCircuit: true, source: STUBS[url.slice(5)] }
  return next(url, context)
}
