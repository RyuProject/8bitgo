/**
 * 必须在顶层跨源隔离页启动的模拟器平台 / 特殊游戏入口。
 *
 * PPSSPP 和 wasm-dolphin 按平台使用 SharedArrayBuffer / pthread；Play! 街机仅按单游戏 runtime
 * 进入隔离页。把名单集中在 shared/，
 * 是为了让 React 路由、SSR 响应头和首屏取数永远使用同一套判断；三处各抄一份时，
 * 最危险的失败不是报错，而是某个平台拿不到 COOP/COEP 后只显示白屏。
 */
export const ISOLATED_RUNTIME_PLATFORM_IDS = Object.freeze(['psp', 'ps2', 'gamecube', 'wii'])
const ISOLATED_RUNTIME_ROUTE_PLATFORM_IDS = new Set([...ISOLATED_RUNTIME_PLATFORM_IDS, 'arcade'])

export function isIsolatedRuntimePlatform(id) {
  return ISOLATED_RUNTIME_PLATFORM_IDS.includes(id)
}

/** `/play/<platform>/<slug>` 是否是一条受支持的隔离播放器路由。 */
export function isolatedRuntimeRoute(pathname) {
  const seg = String(pathname || '').split('/').filter(Boolean)
  if (seg[0] !== 'play' || !ISOLATED_RUNTIME_ROUTE_PLATFORM_IDS.has(seg[1]) || !seg[2]) return undefined
  return Object.freeze({ platform: seg[1], slug: seg[2] })
}
