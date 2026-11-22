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

export interface Html5RuntimeSignalHandlers {
  progress: (ratio?: number) => void
  firstFrame: () => void
  playable: () => void
  firstInteraction: () => void
  failed: (detail: string) => void
}

/**
 * 把一条桥消息分派到对应的处理函数。只有明确的 `failed` 才算启动失败。
 *
 * 2026-11-21 线上回归（诊断包 #1590，PvZ 开局约 10 秒报「HTML5 游戏报告启动失败」）：
 * 4b46d14 给 progress 加了分支，45d661f 合并时丢掉了，适配器又用「其余一律当失败」的 else 收尾 ——
 * PvZ 加载器下载时每秒发一次 progress，于是每一局都在第一次进度上报时被拆掉。
 * 分派放在这里、逐类型显式匹配，以后再加信号类型也不会默认落进失败分支。
 */
export function dispatchHtml5RuntimeSignal(
  signal: { type: Html5RuntimeSignal; detail?: string; ratio?: number },
  handlers: Html5RuntimeSignalHandlers,
): void {
  switch (signal.type) {
    case 'progress': handlers.progress(signal.ratio); return
    case 'first-frame': handlers.firstFrame(); return
    case 'game-playable': handlers.playable(); return
    case 'first-interaction': handlers.firstInteraction(); return
    case 'failed': handlers.failed(signal.detail || 'HTML5 游戏报告启动失败'); return
    default: return
  }
}
