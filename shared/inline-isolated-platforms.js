/**
 * 详情页本身就是播放页、需要跨源隔离（COOP: same-origin + COEP: require-corp）的平台。
 *
 * PSP（PPSSPP）和塞班（EKA2L1）都是 pthread 构建，要 SharedArrayBuffer；它们的播放器直接内嵌在
 * /games/<slug> 里，而不是像 PS2 / Dolphin 那样先显示入口卡、再跳到 /play/<平台>/<slug>。
 *
 *   - server/src/ssr.js：这些平台的详情页 SSR 时发隔离头（也因此不进 Cloudflare 长缓存）；
 *   - src/pages/GameDetailPage.tsx：经 SPA 跳转进来时文档没有隔离头，整页刷新一次再挂播放器。
 *
 * 隔离页里跨源的封面 / 视频要带 CORP，或走同源代理（见 AGENTS.md「PSP 必须留在普通详情页内启动」）。
 */
export const INLINE_ISOLATED_PLATFORMS = Object.freeze(['psp', 'symbian'])

export function isInlineIsolatedPlatform(id) {
  return typeof id === 'string' && INLINE_ISOLATED_PLATFORMS.includes(id)
}
