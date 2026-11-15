/**
 * AwayFL 运行时：无 WebAssembly 浏览器中的 Flash 后备。
 *
 * AwayFL 是近期仍维护的 JavaScript / TypeScript Flash 播放器。这里把每局装进独立同源 iframe，
 * 避免运行时的全局状态和 SharedObject 存档串到站点或其它游戏；兼容性仍按 AwayFL 自己的逐款验证名单放行。
 */
import type { CaptureSources, Capability, MountOptions, PadButton, RuntimeHandle } from '../types'
import { flashKeysFor, keyDesc } from '../flashKeys'
import { loadGameBytes } from '../romLoader'
import { assertSwf, assertSwfBlob, MAX_SWF_BYTES } from '@/lib/romValidation'
import { captureCanvasScreenshot } from '../recorder'
import { installAudioTap, type AudioTap } from '../audioTap'
import { startGamepadInput, type GamepadInput } from '../gamepadInput'
import { swfStageSize } from '../swfHeader'
import { AWAYFL_HOST_PATH, AWAYFL_VERSION } from '../paths'
import { getT, fmt } from '@/services/i18n'
import { diagLog, registerDiagnosticSnapshot } from '@/services/startupDiagnostics'

const FRAME_READY_TIMEOUT_MS = 45_000
const START_TIMEOUT_MS = 90_000
const DEFAULT_STAGE = { width: 550, height: 400 }
const CHANNEL = '8bitgo-awayfl-v1'

interface AwayflMessage {
  channel: string
  type: 'ready' | 'started' | 'error'
  message?: string
}

function storageKeyFor(options: MountOptions): string {
  const raw = options.gameSlug || (typeof options.game === 'string' ? '' : `local:${options.game.name}`) || options.gameName || 'unknown'
  return raw.replace(/[^\w~:.-]+/g, '_').slice(0, 120)
}

function gameUrlFor(game: File | string, remoteUrl?: string): string {
  const value = remoteUrl || (typeof game === 'string' ? game : '')
  try {
    return value ? new URL(value, location.href).href : location.href
  } catch {
    return location.href
  }
}

function waitForeground(check: () => boolean, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let spent = 0
    let last = performance.now()
    const tick = () => {
      if (signal.aborted) return resolve(false)
      if (check()) return resolve(true)
      const now = performance.now()
      if (!document.hidden) spent += Math.min(now - last, 1000)
      last = now
      if (spent >= timeoutMs) return resolve(false)
      window.setTimeout(tick, 100)
    }
    tick()
  })
}

export function mount(container: HTMLElement, options: MountOptions): RuntimeHandle {
  const rt = getT().runtime
  const caps = new Set<Capability>()
  const aborter = new AbortController()
  const mountedAt = Date.now()
  let destroyed = false
  let ready = false
  let failed = false
  let hostReady = false
  let started = false
  let failureMessage = ''
  let stage = '挂载'
  let swfInfo = ''
  let stageSize: { width: number; height: number } | null = null
  let audioTap: AudioTap | null = null
  let volume = 1
  let gamepad: GamepadInput | null = null
  const downKeys = new Set<string>()
  const removeListeners: Array<() => void> = []

  const markStage = (name: string, detail = '') => {
    stage = name
    diagLog('stage', 'info', `AwayFL · ${name}${detail ? ` · ${detail}` : ''} (+${Date.now() - mountedAt}ms)`)
  }
  const stopSnapshot = registerDiagnosticSnapshot(() =>
    `AwayFL 现场：${ready ? '已启动' : `卡在「${stage}」`}，挂载后 ${Math.round((Date.now() - mountedAt) / 100) / 10}s，SWF ${swfInfo || '未到'}，页面${document.hidden ? '在后台' : '在前台'}`,
  )

  const fail = (message: string, scope: 'runtime' | 'content' = 'runtime') => {
    if (destroyed || failed) return
    failed = true
    failureMessage = message
    diagLog('adapter', 'error', `AwayFL 失败（${stage}）：${message}`)
    options.onError?.(message, scope)
  }

  const iframe = document.createElement('iframe')
  iframe.title = options.gameName || 'Flash'
  iframe.setAttribute('allow', 'autoplay; fullscreen; gamepad')
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-pointer-lock')
  iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#000'
  iframe.src = `${AWAYFL_HOST_PATH}host.html`
  container.appendChild(iframe)

  const childWindow = (): (Window & typeof globalThis) | null => iframe.contentWindow as (Window & typeof globalThis) | null
  const stageCanvas = (): HTMLCanvasElement | null => {
    try {
      const canvas = iframe.contentDocument?.querySelector('canvas') ?? null
      return canvas && canvas.width > 2 && canvas.height > 2 ? canvas : null
    } catch {
      return null
    }
  }
  const post = (type: string, detail: Record<string, unknown> = {}, transfer?: Transferable[]) => {
    try {
      childWindow()?.postMessage({ channel: CHANNEL, type, ...detail }, location.origin, transfer ?? [])
    } catch {
      /* 会话已销毁或 iframe 尚未导航完成 */
    }
  }

  let manuallyInteracted = false
  const resumeAudio = () => {
    const ctx = audioTap?.ctx
    if (ctx?.state === 'suspended') void ctx.resume().catch(() => {})
  }
  const applyVolume = () => {
    try {
      if (audioTap?.node) audioTap.node.gain.value = volume
    } catch {
      /* 音频探针不可用时不影响游戏 */
    }
  }
  const onInteraction = () => {
    if (manuallyInteracted) return
    manuallyInteracted = true
    resumeAudio()
    options.onFirstInteraction?.()
  }
  for (const type of ['pointerdown', 'keydown', 'touchend'] as const) {
    window.addEventListener(type, onInteraction, { capture: true, once: true })
    removeListeners.push(() => window.removeEventListener(type, onInteraction, { capture: true }))
  }

  const focusGame = () => {
    try {
      iframe.focus({ preventScroll: true })
      childWindow()?.focus()
    } catch {
      /* iframe 已拆除 */
    }
  }

  const keys = flashKeysFor(options.gameSlug, options.flashControls)
  const dispatchKey = (name: string, down: boolean) => {
    const desc = keyDesc(name)
    if (!desc) return
    post(down ? 'keydown' : 'keyup', { key: desc.key, code: desc.code, keyCode: desc.keyCode })
  }

  markStage('下载 SWF')
  const gameBytes = loadGameBytes(options.game, options.onProgress, aborter.signal, {
    maxBytes: MAX_SWF_BYTES + 16 * 1024 * 1024,
    maxUnpackedBytes: MAX_SWF_BYTES,
    validate: assertSwf,
    validateBlob: assertSwfBlob,
  })
  void gameBytes.catch(() => {})

  const onMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow || event.origin !== location.origin) return
    const data = event.data as AwayflMessage | null
    if (!data || data.channel !== CHANNEL) return
    if (data.type === 'ready') {
      hostReady = true
      // AwayFL 建 Player 时会创建音频上下文；在 start 消息之前先装探针。
      const win = childWindow()
      if (win) audioTap = installAudioTap(win as unknown as Window & Record<string, unknown>, 'shared-output')
      applyVolume()
    } else if (data.type === 'started') {
      started = true
    } else if (data.type === 'error') {
      failureMessage = data.message || 'AwayFL failed to load this SWF'
      if (started && ready) fail(fmt(rt.flashLoadFailed, { msg: failureMessage }), 'runtime')
    }
  }
  window.addEventListener('message', onMessage)
  removeListeners.push(() => window.removeEventListener('message', onMessage))

  const start = async () => {
    markStage('加载 AwayFL')
    const frameReady = await waitForeground(() => hostReady || Boolean(failureMessage), FRAME_READY_TIMEOUT_MS, aborter.signal)
    if (destroyed) return
    if (failureMessage) {
      fail(fmt(rt.flashLoadFailed, { msg: failureMessage }))
      return
    }
    if (!frameReady || !hostReady) {
      fail(fmt(rt.flashInitFailed, { msg: 'AwayFL player did not initialize' }))
      return
    }

    let loaded: Awaited<typeof gameBytes>
    try {
      markStage('等 SWF')
      loaded = await gameBytes
    } catch (error) {
      if (destroyed || aborter.signal.aborted) return
      fail(fmt(rt.flashLoadFailed, { msg: error instanceof Error ? error.message : String(error) }), 'content')
      return
    }
    if (destroyed) return

    swfInfo = `${Math.round(loaded.data.byteLength / 1024)}KB${loaded.fromCache ? '（本地缓存）' : ''}`
    const size = swfStageSize(loaded.data) ?? DEFAULT_STAGE
    stageSize = size
    const bytes = loaded.data.slice(0)
    options.onProgress?.({ phase: 'starting', ratio: 0.2 })
    markStage('启动虚拟机', `${size.width}×${size.height}`)
    post('start', {
      bytes,
      gameUrl: gameUrlFor(options.game, loaded.remoteUrl),
      storageKey: storageKeyFor(options),
      width: size.width,
      height: size.height,
    }, [bytes])

    markStage('等主循环')
    const didStart = await waitForeground(() => started || Boolean(failureMessage), START_TIMEOUT_MS, aborter.signal)
    if (destroyed) return
    if (failureMessage) {
      fail(fmt(rt.flashLoadFailed, { msg: failureMessage }), 'content')
      return
    }
    if (!didStart || !started) {
      fail(fmt(rt.flashLoadFailed, { msg: 'AwayFL did not start this SWF' }), 'content')
      return
    }

    ready = true
    markStage('可以玩了')
    options.onProgress?.({ phase: 'starting', ratio: 1 })
    options.onReady?.()
    options.onStart?.()
    caps.add('volume')
    caps.add('screenshot')
    caps.add('record')
    if (keys) {
      caps.add('touchpad')
      caps.add('gamepad')
      gamepad = startGamepadInput((button, down) => handle.sendButton?.(button, down, 0))
    }
    options.onCaps?.(caps)
    applyVolume()
    focusGame()
  }

  const handle: RuntimeHandle = {
    caps,
    volume,
    nativeVideoSize() {
      return swfStageSizeFromInfo()
    },
    saveMetadata: { core: 'awayfl', build: AWAYFL_VERSION, format: 'awayfl-shared-object' },
    focus: focusGame,
    setVolume(next: number) {
      volume = Math.max(0, Math.min(1, next))
      applyVolume()
    },
    padButtons: keys ? (Object.keys(keys.p1) as PadButton[]) : [],
    coopButtons: keys?.p2 ? (Object.keys(keys.p2) as PadButton[]) : [],
    gamepads: () => {
      try {
        return Array.from(navigator.getGamepads?.() ?? []).filter(Boolean).map((pad) => pad!.id)
      } catch {
        return []
      }
    },
    sendButton(button, down, seat = 0) {
      if (!keys) return
      const name = (seat === 1 ? keys.p2 : keys.p1)?.[button]
      if (!name) return
      const id = `${seat}:${name}`
      if (down === downKeys.has(id)) return
      if (down) {
        downKeys.add(id)
        focusGame()
        resumeAudio()
      } else downKeys.delete(id)
      dispatchKey(name, down)
    },
    captureSources(): CaptureSources | null {
      const canvas = stageCanvas()
      if (!canvas) return null
      return { canvas, audioNode: audioTap?.node ?? null, audioContext: audioTap?.ctx ?? null }
    },
    async screenshot() {
      const canvas = stageCanvas()
      return canvas ? captureCanvasScreenshot(canvas, { directFallback: false }) : null
    },
    destroy() {
      destroyed = true
      aborter.abort()
      stopSnapshot()
      gamepad?.stop()
      gamepad = null
      for (const remove of removeListeners.splice(0)) remove()
      for (const id of downKeys) dispatchKey(id.slice(id.indexOf(':') + 1), false)
      downKeys.clear()
      post('destroy')
      const ctx = audioTap?.ctx
      if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {})
      audioTap = null
      try { iframe.src = 'about:blank' } catch { /* ignore */ }
      iframe.remove()
    },
  }

  function swfStageSizeFromInfo() {
    return stageSize
  }
  void start().catch((error) => fail(fmt(rt.flashLoadFailed, { msg: error instanceof Error ? error.message : String(error) })))
  return handle
}
