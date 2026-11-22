/**
 * id → 真正的挂载实现。每个运行时单独动态导入，避免启动一款游戏时把其它平台的适配器一起下载。
 *
 * 判断「该用哪个引擎」仍走 registry.ts + runtimeMeta.ts；只有真正选定运行时后才会取它的适配器代码。
 */
import type { RuntimeId, RuntimeMount } from './types'
import { isRuntimeModuleTimeout, MODULE_LOAD_IDLE_MS, MODULE_LOAD_MAX_MS, raceModuleLoad, watchModuleResources } from './moduleLoadDeadline'
import { markRuntimeEdgeBad } from './paths'
import { assetsFromCnEdge } from '@/services/moduleLinkRecovery'

const LOADERS: Record<RuntimeId, () => Promise<RuntimeMount>> = {
  emulatorjs: () => import('./adapters/emulatorjs').then((module) => module.mount),
  ruffle: () => import('./adapters/ruffle').then((module) => module.mount),
  awayfl: () => import('./adapters/awayfl').then((module) => module.mount),
  html5: () => import('./adapters/html5').then((module) => module.mount),
  jsnes: () => import('./adapters/jsnes').then((module) => module.mount),
  binjgb: () => import('./adapters/binjgb').then((module) => module.mount),
  iodinegba: () => import('./adapters/iodinegba').then((module) => module.mount),
  j2me: () => import('./adapters/j2me').then((module) => module.mount),
  jsdos: () => import('./adapters/jsdos').then((module) => module.mount),
  webretro: () => import('./adapters/webretro').then((module) => module.mount),
  play: () => import('./adapters/play').then((module) => module.mount),
  ppsspp: () => import('./adapters/ppsspp').then((module) => module.mount),
  eka2l1: () => import('./adapters/eka2l1').then((module) => module.mount),
  dolphin: () => import('./adapters/dolphin').then((module) => module.mount),
  cloudgame: () => import('./adapters/cloudgame').then((module) => module.mount),
  liveview: () => import('./adapters/liveview').then((module) => module.mount),
}

const pendingLoads = new Map<RuntimeId, Promise<RuntimeMount>>()
/** 代码分块请求偶尔会静默挂起；要早于播放器的 120 秒总看门狗给出可重试错误。 */
const RUNTIME_MODULE_TIMEOUT_MS = 60_000

/** 运行时 chunk 所在目录（生产构建里就是 /assets/ 或大陆加速入口的 /_cn/assets/） */
function assetsDir(): string {
  try {
    return new URL('./', import.meta.url).href
  } catch {
    return ''
  }
}

/**
 * 模块本身都从 EdgeOne 拿不下来时，这种运行时后面几 MB 的引擎文件更不可能走得通：持久化改走同源。
 * 目前只接 js-dos（#2756 / #2758）；其它运行时的同源线对大陆访客普遍更慢，先不扩大。
 */
const EDGE_KIND_ON_MODULE_TIMEOUT: Partial<Record<RuntimeId, 'jsdos'>> = { jsdos: 'jsdos' }

/**
 * 按选中的运行时加载并缓存挂载函数；失败时清掉 promise，允许用户重试下载代码块。
 * 时限按进展算（moduleLoadDeadline.ts）：同目录 chunk 还在陆续到齐就继续等，连续 60 秒没进展才判超时。
 */
export function loadMountOf(id: RuntimeId): Promise<RuntimeMount> {
  const existing = pendingLoads.get(id)
  if (existing) return existing

  const dir = assetsDir()
  const loading = raceModuleLoad(LOADERS[id](), {
    watchProgress: watchModuleResources(dir),
    message: (reason) => reason === 'idle'
      ? `${id} 运行时模块加载超时（${MODULE_LOAD_IDLE_MS / 1000} 秒没有进展），请检查网络后重试`
      : `${id} 运行时模块加载超时（${MODULE_LOAD_MAX_MS / 1000} 秒仍未完成），请检查网络后重试`,
  })
  pendingLoads.set(id, loading)
  void loading.catch((error) => {
    if (pendingLoads.get(id) === loading) pendingLoads.delete(id)
    if (!isRuntimeModuleTimeout(error) || typeof window === 'undefined') return
    const onEdge = assetsFromCnEdge(dir, window.location.origin)
    Object.defineProperty(error, 'assetsOnCnEdge', { value: onEdge, configurable: true })
    const kind = EDGE_KIND_ON_MODULE_TIMEOUT[id]
    if (onEdge && kind) markRuntimeEdgeBad(kind)
  })
  return loading
}
