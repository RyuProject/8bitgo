/**
 * 浏览器没有 WebAssembly 时还能玩的平台（2026-11-15）。
 *
 * Edge「增强安全性」、iOS 锁定模式、关了 JIT 的模拟器 / 精简浏览器会把 WebAssembly 整个拿掉，
 * 而本站绝大多数核心都是 WebAssembly。这几种平台有纯 JS 退路：
 *   nes      → jsnes（随 Vite 打包），8BG 用纯 JS 的 fzstd 解压
 *   gb / gbc → binjgb 的纯 JavaScript 构建（public/binjgb/binjgb-js.js）
 * 网页游戏（html5）不算：站内的主力网页游戏几乎都是 WebAssembly 移植。
 *
 * 前端用它过滤游戏库、平台入口和卡片；后端 loadForRoute 收到 `nowasm=1` 时按它查。
 * 给某个平台加了纯 JS 退路，就在这里加上它，并同步 src/emulator/browserSupport.ts。
 */
export const WASM_FREE_PLATFORM_IDS = Object.freeze(['nes', 'gb', 'gbc'])

const SET = new Set(WASM_FREE_PLATFORM_IDS)

/** @param {string | undefined | null} id */
export function platformRunsWithoutWasm(id) {
  return SET.has(String(id || ''))
}
