/**
 * id → 真正的挂载实现。每个运行时单独动态导入，避免启动一款游戏时把其它平台的适配器一起下载。
 *
 * 判断「该用哪个引擎」仍走 registry.ts + runtimeMeta.ts；只有真正选定运行时后才会取它的适配器代码。
 */
import type { RuntimeId, RuntimeMount } from './types'

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

/** 按选中的运行时加载并缓存挂载函数；失败时清掉 promise，允许用户重试下载代码块。 */
export function loadMountOf(id: RuntimeId): Promise<RuntimeMount> {
  const existing = pendingLoads.get(id)
  if (existing) return existing

  const loading = LOADERS[id]()
  pendingLoads.set(id, loading)
  void loading.catch(() => {
    if (pendingLoads.get(id) === loading) pendingLoads.delete(id)
  })
  return loading
}
