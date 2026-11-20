const EXTENSION_SOURCE = '8bitgo-pokecatch-extension'
const PAGE_SOURCE = '8bitgo-pokecatch-page'
const extensionRuntime = globalThis.browser?.runtime ?? globalThis.chrome?.runtime

function post(type, detail = {}) {
  window.postMessage({ source: EXTENSION_SOURCE, type, ...detail }, location.origin)
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== location.origin) return
  const message = event.data
  if (!message || message.source !== PAGE_SOURCE) return

  if (message.type === 'ready') {
    post('bridge-ready')
    extensionRuntime?.sendMessage({ type: 'pokecatch-get-pending' })
      .then((reply) => { if (reply?.raw) post('embedded-save', { raw: reply.raw }) })
      .catch(() => {})
    return
  }

  if (message.type === 'pending-save-received') {
    extensionRuntime?.sendMessage({ type: 'pokecatch-clear-pending' }).catch(() => {})
    return
  }

  if (message.type === 'restore-embedded') {
    extensionRuntime?.sendMessage({ type: 'pokecatch-restore-embedded', raw: message.raw })
      .then((reply) => post('restore-result', reply || { ok: false, error: '扩展没有返回结果。' }))
      .catch(() => post('restore-result', { ok: false, error: '扩展没有返回结果。' }))
  }
})
