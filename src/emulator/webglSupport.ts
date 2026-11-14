/**
 * 现在还建不建得出 WebGL。
 *
 * EmulatorJS 的 RetroArch 胶水默认只会 WebGL，建不出就是 `reading 'GLctx'`。有两种用法：
 *   · 核心报了 GLctx 后再建一次：建得出说明刚才只是一时（上下文数超限 / GPU 进程重启），值得重试；
 *   · 开局前先问一次：建不出时 NES 改用 jsnes，GB/GBC 改用 binjgb；两者都只画 2D canvas。
 *     街机 FBNeo legacy 会在 EmulatorJS iframe 内尝试 Canvas 2D 兼容层；其它 EmulatorJS 平台
 *     仍在下载 ROM / 核心前直接提示环境不支持。
 */
export function canCreateWebgl(doc: Document = document): boolean {
  try {
    const canvas = doc.createElement('canvas')
    const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGLRenderingContext | null
    if (!gl) return false
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    return false
  }
}

/**
 * 现在还建不建得出 **WebGL2**。
 *
 * 只有 WebGL1 的浏览器（GPU 被 Chrome 拉黑 WebGL2、老显卡驱动）里，引擎会改下 `<核心>-legacy-wasm.data`；
 * 没有 legacy 构建的核心（melondsds，见 paths.ts 的 EJS_WEBGL2_ONLY_CORES）就 404，
 * 引擎报「Outdated graphics driver / 显卡驱动已过时」。2026-11-14 大陆 Chrome 149《使命召唤：战争世界》
 * 下完 ROM 才失败，又被当成 ROM 坏换语言版本，前后白下三遍。
 *
 * 判定照抄引擎（emulator.min.js 的 supportsWebgl2）：`getContext('webgl2')` 有没有返回。
 */
export function canCreateWebgl2(doc: Document = document): boolean {
  try {
    const canvas = doc.createElement('canvas')
    const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null
    if (!gl) return false
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    return false
  }
}
