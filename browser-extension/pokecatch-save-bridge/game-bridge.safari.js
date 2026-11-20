(() => {
  const GAME_HOST = 'pokecatch-online.netlify.app'
  const MAIN_SOURCE = '8bitgo-pokecatch-safari-main'
  const BRIDGE_SOURCE = '8bitgo-pokecatch-safari-bridge'
  const extensionRuntime = globalThis.browser?.runtime ?? globalThis.chrome?.runtime

  if (location.hostname !== GAME_HOST || !extensionRuntime) return

  let nextId = 0
  const pending = new Map()

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return
    const message = event.data
    if (!message || message.source !== MAIN_SOURCE || message.type !== 'result') return
    const resolve = pending.get(message.requestId)
    if (!resolve) return
    pending.delete(message.requestId)
    resolve(message.result)
  })

  function requestMain(mode, raw) {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    const requestId = `${Date.now()}-${++nextId}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        resolve({ ok: false, code: 'timeout' })
      }, 5000)
      pending.set(requestId, (result) => {
        clearTimeout(timer)
        resolve(result)
      })
      window.postMessage({ source: BRIDGE_SOURCE, type: 'operate', requestId, mode, raw }, location.origin)
    })
  }

  extensionRuntime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'pokecatch-frame-operation') return false
    requestMain(message.mode, message.raw || '').then(sendResponse, () => sendResponse({ ok: false, code: 'storage' }))
    return true
  })
})()
