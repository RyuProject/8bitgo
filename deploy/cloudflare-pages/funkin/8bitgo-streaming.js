(() => {
  'use strict'

  const VERSION = '__STREAM_VERSION__'
  const status = {
    version: VERSION,
    supported: 'serviceWorker' in navigator,
    registered: false,
    prefetchProfile: 'off',
  }
  window.__8bitgoFunkinStreaming = status

  const publish = () => {
    document.documentElement.dataset.funkinStreaming = status.error
      ? 'fallback'
      : status.controlled
        ? 'active'
        : status.registered
          ? 'registered'
          : status.supported
            ? 'starting'
            : 'unsupported'
    document.documentElement.dataset.funkinPrefetch = status.prefetchProfile
  }

  const loadGame = () => new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = './Funkin.js?v=__MAIN_JS_VERSION__'
    script.fetchPriority = 'high'
    script.onload = resolve
    script.onerror = () => reject(new Error('Funkin.js 下载失败'))
    document.head.append(script)
  })

  publish()

  if (!status.supported) {
    window.__8bitgoFunkinReady = loadGame()
    return
  }

  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection
  const saveData = Boolean(connection?.saveData)
  const effectiveType = String(connection?.effectiveType || '').toLowerCase()
  const slow = effectiveType === 'slow-2g' || effectiveType === '2g'
  const medium = effectiveType === '3g'

  const hasCurrentController = () => {
    const scriptUrl = navigator.serviceWorker.controller?.scriptURL
    if (!scriptUrl) return false
    try {
      return new URL(scriptUrl).searchParams.get('v') === VERSION
    } catch {
      return false
    }
  }

  // 旧控制器仍接管当前页面时，提前运行新主程序会把上一版资源清单与新代码混用。
  const upgradingController = Boolean(navigator.serviceWorker.controller) && !hasCurrentController()

  const waitForControl = () => {
    if (hasCurrentController()) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        window.clearTimeout(timer)
        navigator.serviceWorker.removeEventListener('controllerchange', changed)
        resolve()
      }
      const changed = () => {
        if (hasCurrentController()) done()
      }
      const timer = window.setTimeout(done, upgradingController ? 10_000 : 1_500)
      navigator.serviceWorker.addEventListener('controllerchange', changed)
    })
  }

  const startStreaming = navigator.serviceWorker.register(`./sw.js?v=${encodeURIComponent(VERSION)}`, {
    scope: './',
    updateViaCache: 'none',
  }).then(async (registration) => {
    status.registered = true
    status.scope = registration.scope
    publish()
    const ready = await navigator.serviceWorker.ready
    await waitForControl()
    status.controlled = hasCurrentController()
    publish()

    if (!status.controlled) return

    if (saveData || slow) return

    status.prefetchProfile = medium ? 'metadata' : 'tutorial'
    publish()
    const send = () => ready.active?.postMessage({
      type: 'PREFETCH',
      profile: status.prefetchProfile,
      version: VERSION,
    })

    /*
     * 首屏资源和游戏主动请求永远优先。教学曲预热只在首屏稳定后开始，并且由 Worker 单路低优先级
     * 执行；3G 只拿谱面元数据，2G/省流量完全不预热，避免“优化”反过来拖慢开局。
     */
    const schedule = () => {
      window.setTimeout(() => {
        if ('requestIdleCallback' in window) {
          window.requestIdleCallback(send, { timeout: 7_000 })
        } else {
          send()
        }
      }, 8_000)
    }
    if (document.readyState === 'complete') schedule()
    else window.addEventListener('load', schedule, { once: true })
  }).catch((error) => {
    status.error = String(error?.message || error)
    publish()
    console.warn('[8bitgo-streaming] 流式缓存不可用，已退回普通按需加载', error)
  })

  // 旧控制器升级需要额外等待；即使等待超时，版本化清单也能避开旧缓存并继续启动。
  const startupGate = new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      status.startupBypass = true
      publish()
      resolve()
    }, upgradingController ? 12_000 : 2_000)
    startStreaming.then(() => {
      window.clearTimeout(timer)
      resolve()
    })
  })
  window.__8bitgoFunkinReady = startupGate.then(loadGame)
})()
