/**
 * 现在还建不建得出 WebGL。
 *
 * EmulatorJS 的 RetroArch 胶水只会 WebGL，建不出就是 `reading 'GLctx'`。有两种用法：
 *   · 核心报了 GLctx 后再建一次：建得出说明刚才只是一时（上下文数超限 / GPU 进程重启），值得重试；
 *   · 开局前先问一次：建不出时 NES 改用画 2D canvas 的 jsnes（2026-11-13 大陆 Android 12 Chrome 123
 *     与 Linux Chrome 108 两批访客，《超级玛丽》一个人连开 5 局都是「无法建立 WebGL」）；其它
 *     EmulatorJS 平台没有可用的 2D 核心，适配器会在下载 ROM / 核心前直接提示环境不支持。
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
