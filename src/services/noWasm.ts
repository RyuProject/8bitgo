/**
 * 浏览器没有 WebAssembly 时的「精简游戏库」模式（2026-11-15）。
 *
 * 探测就是一次 `typeof WebAssembly`，不发请求、不加载任何东西，正常访客零开销。
 *
 * ⚠️ 必须走 useSyncExternalStore，服务端快照固定是 false：
 *   - SSR 的 HTML 和边缘缓存对所有人都一样（Cloudflare 不会因此按浏览器拆两份页面）；
 *   - 水合那一遍和服务端一致（不然 React 报 #418、整棵树推倒重建）；
 *   - 水合之后这类浏览器再重新渲染一次，切到精简列表。
 * 水合之后的站内导航直接拿到客户端快照，第一次请求就带 `nowasm=1`。
 */
import { useSyncExternalStore } from 'react'
import { webAssemblyAvailable } from '@/emulator/browserSupport'
import { platformRunsWithoutWasm } from '../../shared/wasm-free-platforms.js'

const noop = () => () => {}
const clientSnapshot = () => !webAssemblyAvailable()
const serverSnapshot = () => false

/** 当前浏览器是否没有 WebAssembly（只列能跑的平台） */
export function useNoWasmMode(): boolean {
  return useSyncExternalStore(noop, clientSnapshot, serverSnapshot)
}

/** 精简模式下这个平台还要不要露出来 */
export function platformListed(noWasm: boolean, platform: string | undefined | null): boolean {
  return !noWasm || platformRunsWithoutWasm(platform)
}

/** 卡片 / 推荐位用：精简模式下这款游戏要不要画 */
export function useGameListed(platform: string | undefined | null): boolean {
  return platformListed(useNoWasmMode(), platform)
}
