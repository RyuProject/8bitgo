/**
 * 8BitGo 网页游戏 SDK v1。
 *
 * 这是游戏页主动接入的轻量桥：不加载第三方脚本、不改 WebGL 上下文，也不接触账号令牌。
 * 同源游戏仍由播放器直接采集；跨源游戏可通过精确来源的消息请求截图、本地录制和直播画帧。
 */
(() => {
  'use strict'

  if (window.EightBitGoGameSDK?.source === '8bitgo-game-sdk' && window.EightBitGoGameSDK.version === 1) return

  const SOURCE = '8bitgo-game-sdk'
  const VERSION = 1
  const MAX_RECORD_MS = 60_000
  const config = window.GAME_CONFIG?.eightBitGo || {}
  const state = {
    ready: false,
    recording: false,
    streaming: false,
    canvas: null,
    error: '',
  }
  const listeners = new Map()
  let parentOrigin = ''
  let hostToken = ''
  let recording = null
  let lastRecordingBlob = null
  let registeredCanvas = null
  let captureStreamProvider = null
  let liveCapture = null
  let announcedCanvas = null
  let announcedWidth = 0
  let announcedHeight = 0
  let announcedToken = ''
  let observer = null
  let script = document.currentScript

  const report = (name, detail) => {
    const callbacks = listeners.get(name)
    if (!callbacks) return
    // 先复制监听器快照，回调里退订或新增监听不能改变本次派发范围。
    for (const callback of Array.from(callbacks)) {
      try { callback(detail) } catch (error) { console.error('[8BitGo SDK] 事件处理失败', error) }
    }
  }

  const sendParent = (message, transfer) => {
    if (!parentOrigin || window.parent === window) return false
    try {
      const payload = { source: SOURCE, version: VERSION, ...message }
      if (transfer?.length) window.parent.postMessage(payload, parentOrigin, transfer)
      else window.parent.postMessage(payload, parentOrigin)
      return true
    } catch (error) {
      console.warn('[8BitGo SDK] 无法向播放器发送消息', error)
      return false
    }
  }

  const allowedParentOrigin = () => {
    try {
      const referrer = new URL(document.referrer)
      const host = referrer.hostname.toLowerCase()
      const site = ['8bitgo.com', 'www.8bitgo.com', 'cn.8bitgo.com', 'tv.8bitgo.com'].includes(host)
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(host)
      if ((referrer.protocol === 'https:' && site) || (referrer.protocol === 'http:' && local)) return referrer.origin
    } catch {
      // 顶层打开或 referrer 被浏览器策略隐藏时，只提供本页 API，不建立父页通信。
    }
    return ''
  }

  const bridgeScript = () => script || document.querySelector('script[src*="8bitgo-game-sdk.js"]')

  const canvasArea = (canvas) => (Number(canvas?.width) || 0) * (Number(canvas?.height) || 0)

  const findCanvas = () => {
    if (registeredCanvas && registeredCanvas.width > 1 && registeredCanvas.height > 1) return registeredCanvas
    const selector = config.canvasSelector || bridgeScript()?.dataset?.canvasSelector
    if (selector) {
      try {
        const selected = document.querySelector(selector)
        // 调用方给了选择器就严格遵守：PvZ 的隐藏启动画布尺寸虽完整，但开始实际游玩前不能开播黑屏。
        return selected instanceof HTMLCanvasElement && selected.width > 1 && selected.height > 1 ? selected : null
      } catch {
        console.warn('[8BitGo SDK] canvasSelector 无效，改用画布自动发现')
      }
    }
    const canvases = document.querySelectorAll('canvas')
    let best = null
    let area = 0
    for (const canvas of canvases) {
      if (canvas.width > 1 && canvas.height > 1 && canvasArea(canvas) > area) {
        best = canvas
        area = canvasArea(canvas)
      }
    }
    return best
  }

  const mediaBridge = () => window.__8bitgoMediaBridge || null

  const canvasCapabilities = (canvas) => {
    const screenshot = Boolean(canvas && typeof canvas.toBlob === 'function')
    const record = Boolean(canvas && (captureStreamProvider || typeof canvas.captureStream === 'function') && typeof MediaRecorder !== 'undefined')
    const live = Boolean(canvas && typeof createImageBitmap === 'function' && typeof requestAnimationFrame === 'function')
    return { screenshot, record, live }
  }

  const reportReady = () => {
    const canvas = findCanvas()
    if (!canvas) {
      if (state.ready) {
        state.canvas = null
        state.ready = false
        announcedCanvas = null
        announcedWidth = 0
        announcedHeight = 0
        announcedToken = ''
        if (hostToken) sendParent({ type: 'unready', token: hostToken })
        report('unready', getState())
      }
      return false
    }
    const width = Math.min(8192, Math.max(2, canvas.width))
    const height = Math.min(8192, Math.max(2, canvas.height))
    const changed = !state.ready || announcedCanvas !== canvas || announcedWidth !== width || announcedHeight !== height
    state.canvas = canvas
    state.ready = true
    announcedCanvas = canvas
    announcedWidth = width
    announcedHeight = height
    if (changed) {
      announcedToken = ''
      report('ready', getState())
    }
    if (hostToken && announcedToken !== hostToken) {
      const capabilities = canvasCapabilities(canvas)
      sendParent({ type: 'ready', token: hostToken, detail: { capabilities, width, height } })
      announcedToken = hostToken
    }
    return true
  }

  const reportPlayable = () => {
    reportReady()
    const lifecycle = window.EightBitGoBridge
    if (lifecycle && typeof lifecycle.reportPlayable === 'function') lifecycle.reportPlayable()
    else sendParent({ source: '8bitgo-runtime-bridge', version: 1, type: 'game-playable' })
    return true
  }

  const getCanvas = () => {
    const current = findCanvas()
    if (current) state.canvas = current
    return current || state.canvas
  }

  const screenshot = (options = {}) => new Promise((resolve, reject) => {
    const canvas = getCanvas()
    if (!canvas || typeof canvas.toBlob !== 'function') {
      reject(new Error('当前游戏没有可截图的画布'))
      return
    }
    const mimeType = typeof options.type === 'string' && options.type.startsWith('image/') ? options.type : 'image/png'
    const quality = Number.isFinite(options.quality) ? Math.max(0, Math.min(1, options.quality)) : undefined
    try {
      canvas.toBlob((blob) => {
        if (!blob || blob.size === 0) reject(new Error('浏览器无法读取游戏画面'))
        else if (blob.size > 24 * 1024 * 1024) reject(new Error('截图超过 24 MiB，已取消回传'))
        else resolve(blob)
      }, mimeType, quality)
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })

  const supportedMimeTypes = () => {
    if (typeof MediaRecorder === 'undefined') return []
    return [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4',
      'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm',
    ].filter((type) => MediaRecorder.isTypeSupported?.(type))
  }

  const startRecording = (options = {}) => {
    if (recording) return Promise.resolve(false)
    lastRecordingBlob = null
    const canvas = getCanvas()
    if (!canvas || (!captureStreamProvider && typeof canvas.captureStream !== 'function') || typeof MediaRecorder === 'undefined') {
      return Promise.reject(new Error('当前浏览器不支持网页游戏录制'))
    }
    let videoStream
    let media = null
    let audioDestination = null
    let mixedStream = null
    const ownsVideoStream = typeof captureStreamProvider !== 'function'
    const ownedTracks = []
    try {
      const fps = Math.max(10, Math.min(60, Number(options.fps) || Number(config.captureFps) || 30))
      videoStream = typeof captureStreamProvider === 'function'
        ? captureStreamProvider(canvas, fps)
        : canvas.captureStream(fps)
      if (!videoStream || typeof videoStream.getVideoTracks !== 'function' || !videoStream.getVideoTracks().length) {
        throw new Error('游戏画布没有可录制的视频轨')
      }

      media = mediaBridge()?.captureSources?.()
      let tracks = videoStream.getTracks()
      if (!ownsVideoStream) {
        tracks = tracks.map((track) => {
          if (typeof track.clone !== 'function') return track
          const clone = track.clone()
          ownedTracks.push(clone)
          return clone
        })
      } else {
        ownedTracks.push(...tracks)
      }
      if (!tracks.some((track) => track.kind === 'audio') && media?.audioNode && media?.audioContext?.createMediaStreamDestination) {
        try {
          audioDestination = media.audioContext.createMediaStreamDestination()
          media.audioNode.connect(audioDestination)
          const audioTracks = audioDestination.stream.getAudioTracks()
          tracks = [...tracks, ...audioTracks]
          ownedTracks.push(...audioTracks)
        } catch {
          audioDestination = null
        }
      }
      mixedStream = new MediaStream(tracks)

      let recorderInstance = null
      const candidates = [...supportedMimeTypes(), undefined]
      for (const mimeType of candidates) {
        try {
          recorderInstance = new MediaRecorder(mixedStream, mimeType ? { mimeType, videoBitsPerSecond: 2_500_000 } : undefined)
          break
        } catch {
          // 部分浏览器的 MIME 探测结果和实际构造结果不一致，继续试下一种格式。
        }
      }
      if (!recorderInstance) throw new Error('浏览器无法创建录制器')

      const chunks = []
      const startedAt = performance.now()
      let hardStop = 0
      let recordedBytes = 0
      let exceededLimit = false
      let cleaned = false
      let resolveStop
      let rejectStop
      const stopped = new Promise((resolve, reject) => { resolveStop = resolve; rejectStop = reject })
      const cleanup = () => {
        if (cleaned) return
        cleaned = true
        window.clearTimeout(hardStop)
        if (audioDestination && media?.audioNode) {
          try { media.audioNode.disconnect(audioDestination) } catch { /* 游戏引擎已先行断开 */ }
        }
        for (const track of ownedTracks) {
          try { track.stop() } catch { /* 浏览器已结束该轨 */ }
        }
        state.recording = false
        recording = null
      }
      recorderInstance.ondataavailable = (event) => {
        const size = Number(event.data?.size) || 0
        if (!size || exceededLimit) return
        if (recordedBytes + size > 96 * 1024 * 1024) {
          exceededLimit = true
          chunks.length = 0
          report('error', new Error('录像超过 96 MiB，已取消回传'))
          if (recorderInstance.state !== 'inactive') stopActiveRecording()
          return
        }
        recordedBytes += size
        chunks.push(event.data)
      }
      recorderInstance.onerror = (event) => {
        cleanup()
        rejectStop(event.error || new Error('游戏录制失败'))
      }
      recorderInstance.onstop = () => {
        let blob = null
        try {
          if (!exceededLimit) blob = new Blob(chunks, { type: recorderInstance.mimeType || 'video/webm' })
        } catch (error) {
          cleanup()
          rejectStop(error instanceof Error ? error : new Error(String(error)))
          report('error', error)
          return
        }
        lastRecordingBlob = blob?.size > 0 ? blob : null
        cleanup()
        resolveStop(lastRecordingBlob)
        report('recording-stopped', { durationMs: Math.max(0, performance.now() - startedAt), blob })
      }
      recorderInstance.start(1000)
      const maxMs = Math.max(1_000, Math.min(MAX_RECORD_MS, Number(options.maxMs) || MAX_RECORD_MS))
      hardStop = window.setTimeout(() => stopActiveRecording(), maxMs)
      recording = { recorder: recorderInstance, stopped, reject: rejectStop, cleanup, getBlob: () => null }
      state.recording = true
      report('recording-started', { startedAt })
      return Promise.resolve(true)
    } catch (error) {
      if (audioDestination && media?.audioNode) {
        try { media.audioNode.disconnect(audioDestination) } catch { /* ignore */ }
      }
      try { audioDestination?.disconnect?.() } catch { /* ignore */ }
      for (const track of ownedTracks.length ? ownedTracks : ownsVideoStream ? videoStream?.getTracks?.() || [] : []) {
        try { track.stop() } catch { /* ignore */ }
      }
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  const stopRecording = () => {
    const active = recording
    if (!active) {
      const blob = lastRecordingBlob
      lastRecordingBlob = null
      return Promise.resolve(blob)
    }
    return stopActiveRecording().then((blob) => {
      if (lastRecordingBlob === blob) lastRecordingBlob = null
      return blob
    })
  }

  const stopActiveRecording = () => {
    const active = recording
    if (!active) return Promise.resolve(null)
    if (active.recorder.state !== 'inactive') {
      try {
        active.recorder.stop()
      } catch (error) {
        active.cleanup()
        active.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    return active.stopped
  }

  const releaseLiveAudio = (active) => {
    if (active.audioNode && active.audioDestination) {
      try { active.audioNode.disconnect(active.audioDestination) } catch { /* 游戏音频图已先行释放 */ }
    }
    if (!active.audioTransferred) {
      try { active.audioTrack?.stop() } catch { /* 浏览器已结束这条轨 */ }
    }
    try { active.audioDestination?.disconnect?.() } catch { /* destination 已释放 */ }
    active.audioNode = null
    active.audioDestination = null
    active.audioTrack = null
  }

  const attachLiveAudio = (active) => {
    try {
      const media = mediaBridge()?.captureSources?.()
      if (!media?.audioNode || !media?.audioContext || media.audioContext.state === 'closed' || typeof media.audioContext.createMediaStreamDestination !== 'function') return
      const destination = media.audioContext.createMediaStreamDestination()
      media.audioNode.connect(destination)
      const track = destination.stream?.getAudioTracks?.().find((item) => item.readyState !== 'ended')
      if (!track) {
        media.audioNode.disconnect(destination)
        destination.disconnect?.()
        return
      }
      active.audioNode = media.audioNode
      active.audioDestination = destination
      active.audioTrack = track
    } catch {
      // 某些游戏没有 WebAudio 或浏览器禁止旁路；直播画面仍可单独工作。
    }
  }

  const stopLiveCapture = (sessionId) => {
    const active = liveCapture
    if (!active || (sessionId && active.sessionId !== sessionId)) return false
    liveCapture = null
    active.cancelled = true
    if (active.raf) cancelAnimationFrame(active.raf)
    if (active.ackTimer) window.clearTimeout(active.ackTimer)
    active.ackTimer = 0
    active.awaitingFrame = 0
    releaseLiveAudio(active)
    state.streaming = false
    if (!active.settled) {
      active.settled = true
      active.resolve(false)
    }
    report('live-stopped', { sessionId: active.sessionId })
    return true
  }

  /**
   * 跨域 iframe 的 Canvas 不能交给父页 captureStream；按需把 ImageBitmap 转移给播放器，
   * 由播放器自己的小画布接入既有直播管线。播放器确认已消费上一帧后才取下一帧，避免主线程繁忙时
   * postMessage 队列囤积 ImageBitmap、把浏览器内存随直播时长持续吃满。
   */
  const startLiveCapture = (options = {}) => {
    const canvas = getCanvas()
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : ''
    if (!sessionId || !canvas || typeof createImageBitmap !== 'function' || typeof requestAnimationFrame !== 'function') return Promise.resolve(false)
    if (liveCapture) return Promise.resolve(liveCapture.sessionId === sessionId && state.streaming)
    const width = Number(canvas.width) || 0
    const height = Number(canvas.height) || 0
    if (width < 16 || height < 16 || width > 8192 || height > 8192 || width * height > 16_777_216) return Promise.resolve(false)

    const fps = Math.max(10, Math.min(30, Number(options.fps) || 30))
    const active = {
      sessionId, fps, raf: 0, lastFrameAt: 0, frameId: 0, busy: false, cancelled: false, settled: false, resolve: null,
      audioNode: null, audioDestination: null, audioTrack: null, audioTransferred: false,
      awaitingFrame: 0, ackTimer: 0, tick: null,
    }
    attachLiveAudio(active)
    liveCapture = active
    return new Promise((resolve) => {
      active.resolve = resolve
      const tick = async (now) => {
        active.raf = 0
        if (liveCapture !== active || active.cancelled) return
        if (!active.busy && now - active.lastFrameAt >= 1000 / active.fps) {
          active.busy = true
          active.lastFrameAt = now
          let bitmap = null
          try {
            const current = getCanvas()
            const frameWidth = Number(current?.width) || 0
            const frameHeight = Number(current?.height) || 0
            if (!current || frameWidth < 16 || frameHeight < 16 || frameWidth > 8192 || frameHeight > 8192 || frameWidth * frameHeight > 16_777_216) {
              throw new Error('游戏画布尺寸不可直播')
            }
            bitmap = await createImageBitmap(current)
            if (liveCapture !== active || active.cancelled) {
              bitmap.close?.()
              return
            }
            const frameId = ++active.frameId
            const frame = { type: 'live-frame', token: hostToken, sessionId, frameId, bitmap }
            let sent = false
            if (active.audioTrack && !active.audioTransferred) {
              sent = sendParent({ ...frame, audioTrack: active.audioTrack }, [bitmap, active.audioTrack])
              if (sent) active.audioTransferred = true
              else {
                // MediaStreamTrack 的跨页转移不是所有浏览器都支持；转移失败后退回纯画面帧。
                releaseLiveAudio(active)
                sent = sendParent(frame, [bitmap])
              }
            } else {
              sent = sendParent(frame, [bitmap])
            }
            if (!sent) throw new Error('游戏画面无法发送给播放器')
            bitmap = null
            active.awaitingFrame = frameId
            active.ackTimer = window.setTimeout(() => {
              if (liveCapture !== active || active.awaitingFrame !== frameId) return
              stopLiveCapture(sessionId)
              report('error', new Error('播放器没有及时确认直播画面，已停止跨域采集'))
            }, 2_000)
            state.streaming = true
            if (!active.settled) {
              active.settled = true
              active.resolve(true)
              report('live-started', { sessionId, fps })
            }
          } catch (error) {
            bitmap?.close?.()
            stopLiveCapture(sessionId)
            report('error', error)
          } finally {
            // 成功发送后保持 busy，直到父页明确确认画布已消费该帧；异常路径可立即释放重试状态。
            if (!active.awaitingFrame) {
              active.busy = false
              if (liveCapture === active && !active.cancelled && !active.raf) active.raf = requestAnimationFrame(tick)
            }
          }
        }
      }
      active.tick = tick
      active.raf = requestAnimationFrame(tick)
    })
  }

  const getState = () => ({ ...state })
  const api = {
    source: SOURCE,
    version: VERSION,
    init: () => Promise.resolve(api),
    getState,
    on(name, callback) {
      if (typeof callback !== 'function') return () => {}
      const set = listeners.get(name) || new Set()
      set.add(callback)
      listeners.set(name, set)
      if (name === 'ready' && state.ready) {
        try { callback(getState()) } catch (error) { console.error('[8BitGo SDK] 事件处理失败', error) }
      }
      return () => set.delete(callback)
    },
    off(name, callback) { listeners.get(name)?.delete(callback) },
    registerCanvas(canvas) {
      if (!canvas || String(canvas.tagName).toLowerCase() !== 'canvas' || (typeof canvas.toBlob !== 'function' && typeof canvas.captureStream !== 'function')) return false
      registeredCanvas = canvas
      state.canvas = canvas
      reportReady()
      return true
    },
    registerCaptureStream(provider) {
      if (typeof provider !== 'function') return false
      captureStreamProvider = provider
      return true
    },
    setReady(detail) {
      if (detail && typeof detail === 'string') state.error = detail.slice(0, 160)
      return reportPlayable()
    },
    setInputHandler(handler) {
      if (typeof handler !== 'function') return false
      api.inputHandler = handler
      return true
    },
    reportFirstFrame() {
      const bridge = window.EightBitGoBridge
      if (bridge?.reportFirstFrame) bridge.reportFirstFrame()
      else sendParent({ source: '8bitgo-runtime-bridge', version: 1, type: 'first-frame' })
    },
    reportPlayable,
    reportFailure(message) {
      const bridge = window.EightBitGoBridge
      if (bridge?.reportFailure) bridge.reportFailure(message)
      else sendParent({ source: '8bitgo-runtime-bridge', version: 1, type: 'failed', detail: String(message || '').slice(0, 160) })
    },
    captureScreenshot: screenshot,
    startRecording,
    stopRecording,
    startLiveCapture,
    stopLiveCapture: () => stopLiveCapture(),
  }

  const respond = (id, operation, ok, result) => sendParent({ type: 'response', token: hostToken, requestId: id, operation, ok, result })
  const onHostMessage = (event) => {
    if (event.source !== window.parent || event.origin !== parentOrigin) return
    const message = event.data
    if (!message || message.source !== '8bitgo-host' || message.version !== VERSION) return
    if (message.type === 'init' && typeof message.token === 'string' && message.token.length > 0 && message.token.length <= 128) {
      hostToken = message.token
      if (state.ready) reportReady()
      return
    }
    if (!hostToken || message.token !== hostToken) return
    if (message.type === 'live-frame-ack') {
      const active = liveCapture
      if (!active || message.sessionId !== active.sessionId || !Number.isInteger(message.frameId) || message.frameId !== active.awaitingFrame) return
      if (active.ackTimer) window.clearTimeout(active.ackTimer)
      active.ackTimer = 0
      active.awaitingFrame = 0
      active.busy = false
      if (!active.cancelled && !active.raf) active.raf = requestAnimationFrame(active.tick)
      return
    }
    if (!Number.isInteger(message.requestId)) return
    const id = message.requestId
    if (message.type === 'request-screenshot') {
      screenshot(message.options).then((blob) => respond(id, 'screenshot', true, blob), (error) => respond(id, 'screenshot', false, String(error?.message || error)))
    } else if (message.type === 'record-start') {
      startRecording(message.options).then((ok) => respond(id, 'record-start', true, ok), (error) => respond(id, 'record-start', false, String(error?.message || error)))
    } else if (message.type === 'record-stop') {
      stopRecording().then((blob) => respond(id, 'record-stop', true, blob), (error) => respond(id, 'record-stop', false, String(error?.message || error)))
    } else if (message.type === 'live-start') {
      startLiveCapture(message.options).then((ok) => respond(id, 'live-start', true, ok), (error) => respond(id, 'live-start', false, String(error?.message || error)))
    } else if (message.type === 'live-stop') {
      const stopped = stopLiveCapture(typeof message.options?.sessionId === 'string' ? message.options.sessionId : '')
      respond(id, 'live-stop', true, stopped)
    }
  }

  parentOrigin = allowedParentOrigin()
  window.addEventListener('message', onHostMessage)
  sendParent({ type: 'hello' })
  window.EightBitGoGameSDK = api
  window.__8bitgoGameSdkDestroy = () => {
    void stopRecording()
    stopLiveCapture()
    observer?.disconnect()
    observer = null
    window.removeEventListener('message', onHostMessage)
  }

  const scan = () => {
    if (state.ready && announcedCanvas && document.documentElement?.contains?.(announcedCanvas) &&
      announcedWidth === Math.min(8192, Math.max(2, announcedCanvas.width)) &&
      announcedHeight === Math.min(8192, Math.max(2, announcedCanvas.height))) return
    reportReady()
  }
  if (typeof MutationObserver === 'function' && document.documentElement) {
    observer = new MutationObserver(scan)
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['width', 'height', 'class'] })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan, { once: true })
  else scan()
})()
