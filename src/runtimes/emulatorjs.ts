/**
 * EmulatorJS 运行时：主机 / 掌机 / 街机 / DOS。
 *
 * EmulatorJS 通过全局 window.EJS_* 读取配置，并在顶层声明 `class EmulatorJS`，
 * 不能在同一页面反复注入，因此放进独立的 srcdoc iframe 里运行：切换游戏直接销毁 iframe，
 * 画面、声音与 WebAssembly 内存随之释放；React StrictMode 二次挂载也不会重复实例化。
 *
 * 资源默认走官方 CDN；自托管时把发行包 data/ 放到 public/emulatorjs/ 并设置 VITE_EJS_PATH=/emulatorjs/
 */
import { platformMap } from '@/data/platforms'
import type { MountOptions, Runtime } from './types'
import { getT, fmt } from '@/services/i18n'

export const EJS_PATH: string = (() => {
  const p = import.meta.env.VITE_EJS_PATH || 'https://cdn.emulatorjs.org/stable/data/'
  return p.endsWith('/') ? p : `${p}/`
})()

const FRAME_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; height: 100%; background: #0b0b0f; overflow: hidden; }
  #game { width: 100%; height: 100%; }
</style>
</head>
<body><div id="game"></div></body>
</html>`

function mount(container: HTMLElement, options: MountOptions): () => void {
  const rt = getT().runtime
  const core = platformMap[options.platform]?.core
  if (!core) {
    options.onError?.(fmt(rt.ejsNoCore, { platform: options.platform }))
    return () => {}
  }

  const iframe = document.createElement('iframe')
  iframe.title = fmt(rt.emulatorTitle, { name: options.gameName })
  iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#0b0b0f'
  iframe.setAttribute('allow', 'fullscreen; gamepad; autoplay; camera; microphone; clipboard-write')
  iframe.srcdoc = FRAME_HTML

  let destroyed = false
  // 本地文件转成 blob: URL（同源 iframe 可直接访问）；gameName 用原始文件名以保留扩展名
  const isFile = typeof options.game !== 'string'
  const gameUrl = isFile ? URL.createObjectURL(options.game as File) : (options.game as string)
  const gameName = isFile ? (options.game as File).name : options.gameName

  iframe.addEventListener('load', () => {
    if (destroyed) return
    const win = iframe.contentWindow as (Window & Record<string, unknown>) | null
    const doc = iframe.contentDocument
    if (!win || !doc) {
      options.onError?.(rt.ejsInitFailed)
      return
    }
    Object.assign(win, {
      EJS_player: '#game',
      EJS_core: core,
      EJS_gameUrl: gameUrl,
      EJS_gameName: gameName,
      EJS_pathtodata: EJS_PATH,
      EJS_color: '#0078f2',
      EJS_backgroundColor: '#0b0b0f',
      EJS_language: 'zh-CN',
      EJS_startOnLoaded: true,
      EJS_volume: 0.6,
      EJS_ready: () => options.onReady?.(),
      EJS_onGameStart: () => options.onStart?.(),
    })
    const script = doc.createElement('script')
    script.src = `${EJS_PATH}loader.js`
    script.async = true
    script.onerror = () => options.onError?.(fmt(rt.ejsLoadFailed, { path: EJS_PATH }))
    doc.body.appendChild(script)
  })

  container.appendChild(iframe)

  return () => {
    destroyed = true
    try {
      iframe.srcdoc = ''
      iframe.src = 'about:blank'
    } catch {
      /* ignore */
    }
    iframe.remove()
    if (isFile) URL.revokeObjectURL(gameUrl)
  }
}

export const emulatorJsRuntime: Runtime = {
  id: 'emulatorjs',
  name: 'EmulatorJS',
  get description() {
    return getT().runtime.ejsDesc
  },
  supports: (platform) => Boolean(platformMap[platform]?.core),
  engineLabel: (platform) => platformMap[platform]?.core ?? '—',
  mount,
}
