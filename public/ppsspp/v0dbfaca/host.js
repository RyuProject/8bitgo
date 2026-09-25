/*
 * 8BitGo ↔ PPSSPP 桥。
 *
 * 远程游戏只把 URL 作为 argv 交给打过补丁的核心。这里故意没有“整盘请求后转内存”逻辑：
 * 一旦有人把整盘下载逻辑加回来，scripts/test-ppsspp-range.mjs 会直接失败。
 */
(() => {
  'use strict'

  const SOURCE = '8bitgo-ppsspp-bridge'
  const VERSION = 1
  // 版本目录本身会被永久缓存；查询串是这次兼容性补丁的内容代次，避免老访客继续命中
  // “核心还没读盘就报启动成功”的旧胶水。以后替换任一运行时文件都必须一起递增。
  const RUNTIME_REVISION = '12'
  const RUNTIME_SCRIPT = `PPSSPPSDL.js?r=${RUNTIME_REVISION}`
  const SAVE_ROOT = '/home/web_user/.config/ppsspp'
  const canvas = document.getElementById('canvas')
  const status = document.getElementById('status')
  let started = false
  let syncTimer = 0
  let syncRunning = false
  let syncQueued = false
  let saveSyncEnabled = false

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
    if (!saveSyncEnabled) return
    if (syncRunning) {
      syncQueued = true
      return
    }
    try {
      if (typeof FS === 'undefined') return
      syncRunning = true
      FS.syncfs(false, (error) => {
        syncRunning = false
        if (error) console.warn('[ppsspp] 存档写入 IndexedDB 失败', error)
        if (syncQueued) {
          syncQueued = false
          syncSaves()
        }
      })
    } catch (error) {
      syncRunning = false
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
    let runtimeInitialized = false
    let canvasStarted = false
    let rangeReadConfirmed = false
    let requestSettled = false
    let fatal = false
    let canvasPoll = 0
    let legacyReadyTimer = 0

    const isLocal = file instanceof File
    const gamePath = isLocal ? `/game/${safeName(file.name)}` : String(remote?.url || '')
    if (!isLocal && (!remote || !/^https?:\/\//i.test(gamePath) || !Number.isFinite(remote.size) || remote.size <= 0)) {
      started = false
      respond(requestId, false, undefined, '远程 PSP 镜像描述无效')
      return
    }

    const stopReadyChecks = () => {
      window.cancelAnimationFrame(canvasPoll)
      window.clearTimeout(legacyReadyTimer)
    }

    const finishStart = () => {
      if (requestSettled || fatal || !runtimeInitialized || !canvasStarted) return
      // 新核心必须既完成真实 Range 读取又开始绘制；当前已发布的旧核心还没有回调，给它一秒
      // 兼容窗口后以首帧为准。这样至少不会再在 callMain 之前误报“已启动”。
      if (!isLocal && !rangeReadConfirmed) {
        if (!legacyReadyTimer) {
          legacyReadyTimer = window.setTimeout(() => {
            legacyReadyTimer = 0
            if (!requestSettled && !fatal) {
              console.warn('[ppsspp] 核心没有 Range 遥测回调，使用首帧兼容判据')
              rangeReadConfirmed = true
              finishStart()
            }
          }, 1000)
        }
        return
      }
      requestSettled = true
      stopReadyChecks()
      setStatus('')
      syncTimer = window.setInterval(syncSaves, 30_000)
      respond(requestId, true, { mode: isLocal ? 'local' : 'range' })
      canvas.focus()
    }

    const fail = (message) => {
      if (fatal) return
      fatal = true
      stopReadyChecks()
      window.clearInterval(syncTimer)
      setStatus(message, 'error')
      if (!requestSettled) {
        requestSettled = true
        respond(requestId, false, undefined, message)
      } else {
        post('runtime-error', { error: message })
      }
    }

    const watchCanvas = () => {
      // 没有 width/height 属性时画布固有尺寸是 300×150；SDL 真正建好窗口后会改成 PSP
      // 的渲染尺寸。连续两帧看到新尺寸，排除初始化过程中一闪而过的中间状态。
      let stableFrames = 0
      const check = () => {
        if (fatal || requestSettled) return
        if (canvas.width !== 300 || canvas.height !== 150) stableFrames++
        else stableFrames = 0
        if (stableFrames >= 2) {
          canvasStarted = true
          finishStart()
          return
        }
        canvasPoll = window.requestAnimationFrame(check)
      }
      canvasPoll = window.requestAnimationFrame(check)
    }

    // C++ Range loader 每完成一块会调用它；数值表示本局实际从网络取回的累计字节，
    // 不是光盘顺序位置，所以随机寻道时允许超过镜像总大小。
    window.__ppssppRangeProgress = (loaded, total) => {
      const safeLoaded = Number(loaded) || 0
      const safeTotal = Number(total) || Number(remote?.size) || 0
      if (!isLocal && safeTotal !== Number(remote.size)) {
        fail(`远程 PSP 镜像在启动期间发生变化：探测为 ${remote.size} 字节，读取为 ${safeTotal} 字节`)
        return
      }
      if (safeLoaded > 1) rangeReadConfirmed = true
      post('stream-progress', { loaded: safeLoaded, total: safeTotal })
      finishStart()
    }
    window.__ppssppRangeError = (message) => {
      fail(`PPSSPP 流式读盘失败：${String(message || '未知错误')}`)
    }

    window.Module = {
      canvas,
      arguments: [gamePath],
      locateFile(path) {
        const url = new URL(path, location.href)
        url.searchParams.set('r', RUNTIME_REVISION)
        return url.href
      },
      print(text) {
        console.log('[ppsspp]', text)
      },
      printErr(text) {
        console.error('[ppsspp]', text)
        // 第一批已发布核心只能把 Range 致命错误写到 stderr，没有 JS 回调。先识别它，
        // 让玩家得到明确错误并让外层结束加载，而不是首帧后继续停在黑屏。
        if (/Range request failed|Remote disc changed size|Range block was shorter|HTTP Range read reached|Server did not provide a valid 206/i.test(String(text))) {
          fail(`PPSSPP 流式读盘失败：${String(text)}`)
        }
      },
      setStatus(text) {
        if (text) setStatus(String(text))
      },
      preRun: [() => {
        // PSP/SAVEDATA、即时存档与配置都放进 IDBFS。先把旧内容拉进来再放行 main，
        // 否则 PPSSPP 会在空目录上启动，稍后同步时反而把已有存档覆盖掉。
        // Emscripten 5 把可挂载后端收进 FS.filesystems，不再把 IDBFS / WORKERFS
        // 暴露成全局变量；直接引用全局名会在真正读盘前抛 ReferenceError。
        const idbfs = FS.filesystems?.IDBFS
        if (!idbfs) throw new Error('PPSSPP 核心缺少 IDBFS，无法安全加载和保存进度')
        FS.mkdirTree(SAVE_ROOT)
        FS.mount(idbfs, {}, SAVE_ROOT)
        addRunDependency('8bitgo-ppsspp-idbfs')
        FS.syncfs(true, (error) => {
          if (error) {
            // 读失败时仍允许游戏启动，但本局绝不能再往同一 IDBFS 回写空目录，否则会把
            // 原有存档覆盖掉。玩家本局的存档只保留在内存，下一次正常读取后再恢复同步。
            saveSyncEnabled = false
            console.warn('[ppsspp] 读取本地存档失败，本局已禁用持久化以保护旧存档', error)
          } else {
            saveSyncEnabled = true
          }
          removeRunDependency('8bitgo-ppsspp-idbfs')
        })

        if (isLocal) {
          const workerfs = FS.filesystems?.WORKERFS
          if (!workerfs) throw new Error('PPSSPP 核心缺少 WORKERFS，无法打开本地镜像')
          FS.mkdirTree('/game')
          FS.mount(workerfs, { files: [file] }, '/game')
        }
      }],
      onRuntimeInitialized() {
        // 这个回调发生在 callMain 之前，只代表 WASM 装载完成。旧实现此处直接报成功，
        // 后面的 ISO 读取即使失败，外层也已经丢掉请求。必须再等真实读盘和首帧。
        runtimeInitialized = true
        setStatus(isLocal ? '正在打开本地游戏…' : '正在流式读取游戏…')
        watchCanvas()
        finishStart()
      },
      onAbort(reason) {
        fail(`PPSSPP 已中止：${String(reason || '未知原因')}`)
      },
    }

    const script = document.createElement('script')
    script.src = RUNTIME_SCRIPT
    script.async = true
    script.onerror = () => {
      const message = 'PPSSPP 核心文件未部署或版本不完整。请运行 npm run ppsspp:build 后重新构建站点。'
      fail(message)
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

  window.addEventListener('error', (event) => {
    if (started && window.__ppssppRangeError) {
      window.__ppssppRangeError(event.error?.message || event.message || '运行时脚本异常')
    }
  })
  window.addEventListener('unhandledrejection', (event) => {
    if (started && window.__ppssppRangeError) {
      window.__ppssppRangeError(event.reason?.message || event.reason || '运行时 Promise 异常')
    }
  })

  post('host-ready')
})()
