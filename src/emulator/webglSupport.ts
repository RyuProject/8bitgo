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
