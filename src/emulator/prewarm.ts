/**
 * 玩家已经把指针移到“开始”上时，先让浏览器并行拉运行时的小入口和已知核心。
 * 这里绝不碰 ROM：成人内容门、语言选择和备用源都还没有作出最终决定，提前拉游戏文件
 * 既浪费流量也可能绕过访问时机。fetch 只填 HTTP 缓存，引擎稍后照常走自己的初始化。
 */
import type { RuntimeId } from './types'
import { EJS_PATH, J2ME_PATH, RUFFLE_PATH } from './paths'
import { CHEERPJ_ORIGIN, j2meWarmTargets } from './j2meUrl'
import { preconnectOrigin, warmHttpCache } from './httpWarm'

/**
 * 这台设备上「指针停在按钮上」和「点击」之间是否真的有提前量。
 *
 * 桌面端鼠标移过去到点下去通常有几百毫秒到几秒；触摸设备上没有 hover 这回事，
 * 按钮的 focus 是在**点击那一刻**才触发的，这个判断用来区分这两种情况。
 */
function hasHoverIntent(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches
}

/**
 * J2ME 的冷启动是串行的：libmidi.wasm（3.4 MB）和 freej2me-web.jar（952 KB）
 * 各自独占一段关键路径，中间 CheerpJ 起 JVM 的那几十秒连接还闲着。
 * 预热清单与逐条理由见 j2meUrl.ts 的 j2meWarmTargets。
 *
 * 顺带把 CheerpJ 的 CDN 连接建起来 —— run.html 里那条 loader.js 是跨源脚本，
 * DNS + TCP + TLS 都算在冷启动里，而从国内连那个 CDN 并不快。这一条**任何设备都做**：
 * 它只是建连接，不发请求，也不占带宽。
 *
 * ⚠️ 预拉那三个文件**只在有 hover 提前量的设备上做**。触摸设备上这个函数是被
 * onFocus 叫起来的，也就是点击的同一下，而 iframe 自己一两秒后就会去拉同一份文件 ——
 * 两个在途请求撞在一起，浏览器不一定会合并它们，最坏情况是同一份 3.4 MB 下两遍，
 * 比不预热更糟。等真开玩时的那份下载，交给 adapters/j2me.ts 里那处（那里提前量是几十秒）。
 */
function prewarmJ2me() {
  if (!J2ME_PATH) return
  preconnectOrigin(CHEERPJ_ORIGIN)
  if (!hasHoverIntent()) return
  for (const url of j2meWarmTargets(J2ME_PATH)) warmHttpCache(url)
}

export function prewarmRuntime(runtime: RuntimeId | undefined, core?: string | null) {
  if (runtime === 'j2me') {
    prewarmJ2me()
    return
  }
  if (runtime === 'ruffle') {
    warmHttpCache(`${RUFFLE_PATH}ruffle.js`)
    return
  }
  if (runtime !== 'emulatorjs') return
  warmHttpCache(`${EJS_PATH}loader.js`)
  if (core) warmHttpCache(`${EJS_PATH}cores/${encodeURIComponent(core)}-wasm.data`)
}
