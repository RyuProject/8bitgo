/**
 * HTML5 / Unity WebGL 的媒体能力发现。
 *
 * 这部分单独放出来，是因为网页游戏不像模拟器那样有固定 DOM：Canvas 可能等 WASM 下载完
 * 才创建，也可能藏在一两层同源 iframe 里。能力必须按真实画面动态开放，不能平台一选成
 * html5 就把截图按钮画出来，否则第三方跨源页面和纯 DOM 游戏只会得到一个必失败的按钮。
 */
import type { CaptureSources } from './types'
import { usableVideoSize } from './videoTuning'

export const HTML5_MEDIA_BRIDGE_KEY = '__8bitgoMediaBridge'
export const HTML5_MEDIA_BRIDGE_VERSION = 1

export interface Html5MediaBridge {
  source?: '8bitgo-media-bridge'
  version: number
  /** 页面在引擎初始化前装探针后，可以把 Canvas 与 WebAudio 旁路点一起交出来。 */
  captureSources?: () => CaptureSources | null
  /** Unity 等引擎有自己的截图 API 时可以覆盖；没有就由外层走 Canvas 合成帧。 */
  screenshot?: () => Promise<Blob | null> | Blob | null
  setScreenshotProvider?: (provider: (() => Promise<Blob | null> | Blob | null) | null) => void
}

type MediaBridgeWindow = Window & Record<string, unknown>

/** 只接受本站公开的 v1 形状；同源页面塞了同名普通对象时不能让播放器跟着抛。 */
export function html5MediaBridge(win: Window | null | undefined): Html5MediaBridge | null {
  if (!win) return null
  try {
    const value = (win as MediaBridgeWindow)[HTML5_MEDIA_BRIDGE_KEY] as Partial<Html5MediaBridge> | undefined
    if (!value || value.source !== '8bitgo-media-bridge' || value.version !== HTML5_MEDIA_BRIDGE_VERSION) return null
    return value as Html5MediaBridge
  } catch {
    return null
  }
}

/**
 * 找当前文档树里面积最大的 Canvas。
 *
 * 必须把当前页和同源子 iframe 放在一起比较。旧实现只要外层有一张 1×1 的字体度量 Canvas
 * 就立刻返回，真正藏在子 iframe 里的 1280×720 游戏画面永远轮不到，直播于是推一格黑点。
 */
export function findHtml5Canvas(doc: Document | null, depth = 0): HTMLCanvasElement | null {
  if (!doc) return null
  let best: HTMLCanvasElement | null = null
  let bestArea = 0
  for (const canvas of Array.from(doc.querySelectorAll<HTMLCanvasElement>('canvas'))) {
    const area = Math.max(0, Number(canvas.width) || 0) * Math.max(0, Number(canvas.height) || 0)
    if (area > bestArea) {
      best = canvas
      bestArea = area
    }
  }
  if (depth >= 2) return best

  for (const frame of Array.from(doc.querySelectorAll<HTMLIFrameElement>('iframe'))) {
    let inner: Document | null = null
    try {
      inner = frame.contentDocument
    } catch {
      continue // 跨源子框架不能读，也不能录；跳过而不是让整款游戏报错
    }
    const canvas = findHtml5Canvas(inner, depth + 1)
    const area = canvas ? canvas.width * canvas.height : 0
    if (area > bestArea) {
      best = canvas
      bestArea = area
    }
  }
  return best
}

/** 根据这一刻的真实画布决定该露出哪些按钮。 */
export function html5CanvasCapabilities(
  canvas: HTMLCanvasElement | null,
  mediaRecorderAvailable = typeof MediaRecorder !== 'undefined',
): { screenshot: boolean; record: boolean } {
  const usable = Boolean(canvas && usableVideoSize(canvas.width, canvas.height))
  return {
    screenshot: usable && typeof canvas?.toBlob === 'function',
    record: usable && mediaRecorderAvailable && typeof canvas?.captureStream === 'function',
  }
}
