/**
 * 玩家已经把指针移到“开始”上时，先让浏览器并行拉运行时的小入口和已知核心。
 * 这里绝不碰 ROM：成人内容门、语言选择和备用源都还没有作出最终决定，提前拉游戏文件
 * 既浪费流量也可能绕过访问时机。fetch 只填 HTTP 缓存，引擎稍后照常走自己的初始化。
 */
import type { RuntimeId } from './types'
import { EJS_PATH, RUFFLE_PATH } from './paths'

const warmed = new Set<string>()

function warm(url: string) {
  if (!url || warmed.has(url)) return
  warmed.add(url)
  void fetch(url, { cache: 'force-cache', credentials: 'same-origin' }).catch(() => {
    // 预热失败不能占用正式加载的错误提示；允许下一次进页面再试。
    warmed.delete(url)
  })
}

export function prewarmRuntime(runtime: RuntimeId | undefined, core?: string | null) {
  if (runtime === 'ruffle') {
    warm(`${RUFFLE_PATH}ruffle.js`)
    return
  }
  if (runtime !== 'emulatorjs') return
  warm(`${EJS_PATH}loader.js`)
  if (core) warm(`${EJS_PATH}cores/${encodeURIComponent(core)}-wasm.data`)
}
