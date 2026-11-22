(() => {
  const GAME_HOST = 'pokecatch-online.netlify.app'
  const GAME_KEY = 'gachamon-save-v1'
  const BACKUP_KEY = '8bitgo.pokecatch.backup.v1'
  const MAIN_SOURCE = '8bitgo-pokecatch-safari-main'
  const BRIDGE_SOURCE = '8bitgo-pokecatch-safari-bridge'
  const MAX_SAVE_BYTES = 4 * 1024 * 1024

  if (location.hostname !== GAME_HOST) return

  function parseSave(raw) {
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > MAX_SAVE_BYTES) return null
    try {
      const save = JSON.parse(raw)
      return save && Number.isInteger(save.v) && save.v > 0 && Array.isArray(save.mons) && save.mons.length <= 151
        ? save
        : null
    } catch {
      return null
    }
  }

  function operate(message) {
    if (message.mode === 'read') {
      let raw
      try {
        raw = localStorage.getItem(GAME_KEY)
      } catch {
        return { ok: false, code: 'storage' }
      }
      if (!raw) return { ok: false, code: 'missing' }
      if (new TextEncoder().encode(raw).byteLength > MAX_SAVE_BYTES) return { ok: false, code: 'too-large' }
      return parseSave(raw) ? { ok: true, raw } : { ok: false, code: 'invalid' }
    }

    const save = parseSave(message.raw)
    if (!save) return { ok: false, code: 'invalid' }
    try {
      const current = localStorage.getItem(GAME_KEY)
      if (current) localStorage.setItem(BACKUP_KEY, current)
      localStorage.setItem(GAME_KEY, message.raw)
      // Safari 扩展消息需要先返回写入结果，再刷新游戏框。
      setTimeout(() => location.reload(), 800)
      return { ok: true, mons: save.mons.length }
    } catch {
      return { ok: false, code: 'storage' }
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return
    const message = event.data
    if (!message || message.source !== BRIDGE_SOURCE || message.type !== 'operate' || typeof message.requestId !== 'string') return
    const result = operate(message)
    window.postMessage({ source: MAIN_SOURCE, type: 'result', requestId: message.requestId, result }, location.origin)
  })
})()
