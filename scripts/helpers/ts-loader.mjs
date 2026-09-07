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
import { existsSync } from 'node:fs'

const SRC = fileURLToPath(new URL('../../src/', import.meta.url))

/** 只桩掉与被测逻辑无关的模块，其余一律加载真实源码 */
const STUBS = {
  // useRef 要给个真的对象：roms.ts 的自动重试用它记次数，返回 undefined 会当场 TypeError
  react:
    'export const useState=()=>[];export const useEffect=()=>{};export const useCallback=(f)=>f;export const useRef=(v)=>({current:v});export const useSyncExternalStore=(s,get)=>get();export const useMemo=(f)=>f();',
  '@/emulator': 'export const isPlayable=()=>true;export const EJS_PATH="/ejs/";export const RUFFLE_PATH="/ruffle/";',
  '@/services/lang': 'export const useLang=()=>"zh-Hans";',
  '@/data/platforms': 'export const platformMap={};',
  /*
    直播那条服务：测试里不连真信令。socket 由测试自己塞进 globalThis.__fakeLiveSocket，
    这样 broadcast.ts 的整条握手/观众流程都能在 node 里跑（见 test-broadcast-idle.mjs）。
    只有**别的模块按 `@/services/live` 引它**时才会被换掉；直接按文件路径 import
    真实源码的测试（test-live-io.mjs）不受影响。
  */
  '@/services/live':
    'export const connectLive=async()=>globalThis.__fakeLiveSocket;' +
    'export const liveIceServers=async()=>[];' +
    'export const liveIceConfig=async()=>({iceServers:[],hasTurn:false,expiry:0});' +
    'export const liveEnabled=()=>true;' +
    'export const refreshLiveRooms=()=>{};',
}

export async function resolve(specifier, context, next) {
  if (STUBS[specifier]) return { url: 'stub:' + specifier, shortCircuit: true }
  if (specifier.startsWith('@/')) {
    const base = pathToFileURL(SRC + specifier.slice(2)).href
    for (const suffix of ['.ts', '.tsx', '/index.ts']) {
      if (existsSync(fileURLToPath(base + suffix))) return next(base + suffix, context)
    }
    return next(base + '.ts', context)
  }
  /*
    源码里的相对 import 是不带扩展名的（`./windowsLaunch`）——打包器会自己补 .ts，
    node 不会，于是直接 ERR_MODULE_NOT_FOUND。这里替它补：文件真的存在才改写，
    不存在就原样交回默认解析器，免得把 './data.json' 这类也误伤。
  */
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z]+$/i.test(specifier) && context.parentURL) {
    for (const suffix of ['.ts', '.tsx', '/index.ts']) {
      const candidate = new URL(specifier + suffix, context.parentURL)
      if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context)
    }
  }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (url.startsWith('stub:')) return { format: 'module', shortCircuit: true, source: STUBS[url.slice(5)] }
  const loaded = await next(url, context)
  /*
    `import.meta.env` 是 Vite 在构建时替换掉的东西，node 里根本没有这个属性 ——
    源码里一句 `import.meta.env.VITE_X` 在测试里就是 `Cannot read properties of undefined`。
    这里按文本换成一个全局对象，测试想指定就先设 globalThis.__viteEnv。
    只动 src/ 下的 .ts / .tsx，node_modules 一个字节都不碰。
  */
  if (loaded.source && url.startsWith(pathToFileURL(SRC).href) && /\.tsx?$/.test(url)) {
    const text = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8')
    if (text.includes('import.meta.env')) {
      return { ...loaded, source: text.replaceAll('import.meta.env', '(globalThis.__viteEnv ?? {})') }
    }
  }
  return loaded
}
