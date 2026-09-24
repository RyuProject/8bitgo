/*
 * 8BitGo ↔ PPSSPP 桥。
 *
 * 远程游戏只把 URL 作为 argv 交给打过补丁的核心。这里故意没有 fetch(url).arrayBuffer()：
 * 一旦有人把整盘下载逻辑加回来，scripts/test-ppsspp-range.mjs 会直接失败。
 */
(() => {
  'use strict'

  const SOURCE = '8bitgo-ppsspp-bridge'
  const VERSION = 1
  const RUNTIME_SCRIPT = 'PPSSPPSDL.js'
  const SAVE_ROOT = '/home/web_user/.config/ppsspp'
  const canvas = document.getElementById('canvas')
  const status = document.getElementById('status')
  let started = false
  let syncTimer = 0

  const post = (type, payload = {}) => {
    if (window.parent === window) return
    window.parent.postMessage({ source: SOURCE, version: VERSION, type, ...payload }, location.origin)
  }

  const setStatus = (message, tone = 'info') => {
    status.hidden = !message
    status.textContent = message || ''
    status.dataset.tone = tone
  }

  const respond = (requestId, ok, payload = undefined, error = undefined) => {
    post('response', { requestId, ok, payload, error })
  }

  const syncSaves = () => {
    try {
      if (typeof FS === 'undefined') return
      FS.syncfs(false, (error) => {
        if (error) console.warn('[ppsspp] 存档写入 IndexedDB 失败', error)
      })
    } catch (error) {
      console.warn('[ppsspp] 无法同步存档', error)
    }
  }

  const safeName = (name) => {
    const tail = String(name || 'game.iso').split(/[\\/]/).pop() || 'game.iso'
    return tail.replace(/[\u0000-\u001f]/g, '_')
  }

  const start = ({ requestId, file, remote }) => {
    if (started) {
      respond(requestId, false, undefined, '同一个 PPSSPP 页面只能启动一款游戏')
      return
    }
    started = true
    setStatus('正在启动 PPSSPP…')

    const isLocal = file instanceof File
    const gamePath = isLocal ? `/game/${safeName(file.name)}` : String(remote?.url || '')
    if (!isLocal && (!remote || !/^https?:\/\//i.test(gamePath) || !Number.isFinite(remote.size) || remote.size <= 0)) {
      started = false
      respond(requestId, false, undefined, '远程 PSP 镜像描述无效')
      return
    }

    // C++ Range loader 每完成一块会调用它；数值表示本局实际从网络取回的累计字节，
    // 不是光盘顺序位置，所以随机寻道也能给外层一个诚实的流量进度。
    window.__ppssppRangeProgress = (loaded, total) => {
      post('stream-progress', { loaded: Number(loaded) || 0, total: Number(total) || Number(remote?.size) || 0 })
    }

    window.Module = {
      canvas,
      arguments: [gamePath],
      locateFile(path) {
        return new URL(path, location.href).href
      },
      print(text) {
        console.log('[ppsspp]', text)
      },
      printErr(text) {
        console.error('[ppsspp]', text)
      },
      setStatus(text) {
        if (text) setStatus(String(text))
      },
      preRun: [() => {
        // PSP/SAVEDATA、即时存档与配置都放进 IDBFS。先把旧内容拉进来再放行 main，
        // 否则 PPSSPP 会在空目录上启动，稍后同步时反而把已有存档覆盖掉。
        FS.mkdirTree(SAVE_ROOT)
        FS.mount(IDBFS, {}, SAVE_ROOT)
        addRunDependency('8bitgo-ppsspp-idbfs')
        FS.syncfs(true, (error) => {
          if (error) console.warn('[ppsspp] 读取本地存档失败，将使用空存档目录', error)
          removeRunDependency('8bitgo-ppsspp-idbfs')
        })

        if (isLocal) {
          FS.mkdirTree('/game')
          FS.mount(WORKERFS, { files: [file] }, '/game')
        }
      }],
      onRuntimeInitialized() {
        setStatus('')
        syncTimer = window.setInterval(syncSaves, 30_000)
        respond(requestId, true, { mode: isLocal ? 'local' : 'range' })
        canvas.focus()
      },
      onAbort(reason) {
        const message = `PPSSPP 已中止：${String(reason || '未知原因')}`
        setStatus(message, 'error')
        respond(requestId, false, undefined, message)
      },
    }

    const script = document.createElement('script')
    script.src = RUNTIME_SCRIPT
    script.async = true
    script.onerror = () => {
      const message = 'PPSSPP 核心文件未部署或版本不完整。请运行 npm run ppsspp:build 后重新构建站点。'
      setStatus(message, 'error')
      respond(requestId, false, undefined, message)
    }
    document.head.appendChild(script)
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== location.origin) return
    const message = event.data
    if (!message || message.source !== SOURCE || message.version !== VERSION) return
    if (message.type === 'mount-local') start({ requestId: message.requestId, file: message.file })
    if (message.type === 'mount-remote') start({ requestId: message.requestId, remote: message.remote })
  })

  window.addEventListener('pagehide', () => {
    window.clearInterval(syncTimer)
    syncSaves()
  })

  post('host-ready')
})()
