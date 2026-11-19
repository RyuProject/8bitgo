/** HTML5 游戏可选的父子页就绪协议。跨域页也能 postMessage，但父页只接受当前游戏 iframe。 */
export const HTML5_RUNTIME_BRIDGE_SOURCE = '8bitgo-runtime-bridge'
export const HTML5_RUNTIME_BRIDGE_VERSION = 1

/**
 * progress：游戏自己的加载器还在推进（下载 / 写盘）。2026-11-18 植物大战僵尸（日本 6.8Mbps）首次要下约 93MB，
 * 桥和播放器都按固定 120 秒判死，下载还在走就被重试、再判死；进度信号让两边都改成「连续 120 秒没有进展」。
 */
export type Html5RuntimeSignal = 'first-frame' | 'game-playable' | 'first-interaction' | 'failed' | 'progress'

export function html5RuntimeSignal(value: unknown): { type: Html5RuntimeSignal; detail?: string; ratio?: number } | null {
  if (!value || typeof value !== 'object') return null
  const message = value as { source?: unknown; version?: unknown; type?: unknown; detail?: unknown }
  if (message.source !== HTML5_RUNTIME_BRIDGE_SOURCE || message.version !== HTML5_RUNTIME_BRIDGE_VERSION) return null
  if (!['first-frame', 'game-playable', 'first-interaction', 'failed', 'progress'].includes(String(message.type))) return null
  if (message.type === 'progress') {
    const ratio = typeof message.detail === 'number' && Number.isFinite(message.detail)
      ? Math.min(1, Math.max(0, message.detail))
      : undefined
    return { type: 'progress', ...(ratio === undefined ? {} : { ratio }) }
  }
  return {
    type: message.type as Html5RuntimeSignal,
    ...(typeof message.detail === 'string' ? { detail: message.detail.slice(0, 160) } : {}),
  }
}

/**
 * 没接桥的同源游戏只能用画布作保守兜底。至少要求 backing store 已有真实尺寸；
 * iframe 的 load 不参与判断，避免 HTML 外壳到了、WASM 还在下载时就计成“可玩”。
 */
export function html5CanvasHasFrame(canvas: Pick<HTMLCanvasElement, 'width' | 'height'> | null | undefined): boolean {
  return Boolean(canvas && Number(canvas.width) > 1 && Number(canvas.height) > 1)
}
