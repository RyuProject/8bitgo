/**
 * 8BitGo 的 HTML5 运行状态与云存档桥。
 *
 * 上游游戏完全由 DOM/CSS 绘制，没有 canvas；若不主动报告就绪，外层播放器会一直停在
 * “正在启动”。存档仍由游戏自己的 localStorage 负责，这里只在玩家主动保存/读取时，
 * 把同一份 JSON 安全地交给 8BitGo 的三档存档面板。
 */
(() => {
  'use strict'

  const RUNTIME_SOURCE = '8bitgo-runtime-bridge'
  const SAVE_SOURCE = '8bitgo-save-bridge'
  const VERSION = 1
  const STORAGE_KEY = 'coin-flip-game:save'
  const MAX_SAVE_BYTES = 2 * 1024 * 1024

  const send = (message, transfer) => {
    if (window.parent === window) return
    window.parent.postMessage(message, window.location.origin, transfer || [])
  }

  const runtime = (type, detail) => send({ source: RUNTIME_SOURCE, version: VERSION, type, detail })
  const response = (requestId, ok, data, error) => {
    const message = { source: SAVE_SOURCE, version: VERSION, type: 'response', requestId, ok, data, error }
    send(message, data instanceof ArrayBuffer ? [data] : [])
  }

  const validateSave = (raw) => {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_SAVE_BYTES) {
      throw new Error('存档为空或超过 2 MB')
    }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('存档格式无效')
    if (!Number.isInteger(parsed.schemaVersion) || parsed.schemaVersion < 1 || parsed.schemaVersion > 1000) {
      throw new Error('存档版本无效')
    }
    return raw
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== window.location.origin) return
    const message = event.data
    if (!message || message.source !== SAVE_SOURCE || message.version !== VERSION || !Number.isInteger(message.requestId)) return
    try {
      if (message.type === 'export') {
        const raw = validateSave(localStorage.getItem(STORAGE_KEY))
        const encoded = new TextEncoder().encode(raw)
        response(message.requestId, true, encoded.buffer, '')
        return
      }
      if (message.type === 'import') {
        if (!(message.data instanceof ArrayBuffer) || message.data.byteLength === 0 || message.data.byteLength > MAX_SAVE_BYTES) {
          throw new Error('存档为空或超过 2 MB')
        }
        const raw = validateSave(new TextDecoder().decode(message.data))
        localStorage.setItem(STORAGE_KEY, raw)
        response(message.requestId, true, null, '')
      }
    } catch (error) {
      response(message.requestId, false, null, error instanceof Error ? error.message : '存档操作失败')
    }
  })

  const firstInteraction = () => {
    runtime('first-interaction')
    window.removeEventListener('pointerdown', firstInteraction, true)
    window.removeEventListener('keydown', firstInteraction, true)
  }
  window.addEventListener('pointerdown', firstInteraction, true)
  window.addEventListener('keydown', firstInteraction, true)

  window.addEventListener('load', () => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      runtime('first-frame')
      runtime('game-playable')
      send({ source: SAVE_SOURCE, version: VERSION, type: 'ready' })
    }))
  }, { once: true })
})()
