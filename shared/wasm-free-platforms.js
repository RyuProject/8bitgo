/**
 * 浏览器没有 WebAssembly 时还能玩的平台（2026-11-15）。
 *
 * Edge「增强安全性」、iOS 锁定模式、关了 JIT 的模拟器 / 精简浏览器会把 WebAssembly 整个拿掉，
 * 而本站绝大多数核心都是 WebAssembly。这几种平台有纯 JS 退路：
 *   nes      → jsnes（随 Vite 打包），8BG 用纯 JS 的 fzstd 解压
 *   gb / gbc → binjgb 的纯 JavaScript 构建（public/binjgb/binjgb-js.js）
 *   gba      → IodineGBA（纯 JavaScript；后台没绑官方 BIOS 时用随站的 MIT 开源替代 BIOS）
 * 网页游戏（html5）不算：站内的主力网页游戏几乎都是 WebAssembly 移植。
 *
 * 前端用它过滤游戏库、平台入口和卡片；后端 loadForRoute 收到 `nowasm=1` 时按平台和逐款名单查。
 * 给某个平台加纯 JS 退路就在平台列表里加；个别游戏的兼容后备则单独加进游戏 slug 名单。
 */
import { AWAYFL_VERIFIED_GAMES, awayflVerifiedGame } from './awayfl-games.js'

export const WASM_FREE_PLATFORM_IDS = Object.freeze(['nes', 'gb', 'gbc', 'gba'])
// Flash 不能整个平台放行：AwayFL 只通过逐款实玩验收的游戏 slug 自动回退。
export const WASM_FREE_GAME_SLUGS = AWAYFL_VERIFIED_GAMES

const SET = new Set(WASM_FREE_PLATFORM_IDS)

/** @param {string | undefined | null} id */
export function platformRunsWithoutWasm(id) {
  return SET.has(String(id || ''))
}

/** @param {string | undefined | null} platform @param {string | undefined | null} slug */
export function gameRunsWithoutWasm(platform, slug) {
  if (platformRunsWithoutWasm(platform)) return true
  if (String(platform || '') !== 'flash') return false
  return awayflVerifiedGame(slug)
}

/** @param {string | undefined | null} platform */
export function platformHasWasmFreeGames(platform) {
  return String(platform || '') === 'flash' && WASM_FREE_GAME_SLUGS.length > 0
}
