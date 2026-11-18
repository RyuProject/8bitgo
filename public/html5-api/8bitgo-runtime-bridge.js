/**
 * Pages 子域上的网页游戏无法再由主站读取 DOM，因此用一条只报告生命周期的窄桥。
 * 它不接收命令、不读取存档；消息只发往由 document.referrer 确认的 8BitGo 父页，
 * 宿主再核对消息来自当前游戏 iframe，因此第三方不能借这条桥控制播放器。
 */
(() => {
  'use strict'

  if (window.parent === window) return
  const source = '8bitgo-runtime-bridge'
  const installKey = '__8bitgoRuntimeBridgeV1'
  if (window[installKey]) return

  let parentOrigin = ''
  try {
    const parent = new URL(document.referrer)
    const siteHost = ['8bitgo.com', 'www.8bitgo.com', 'cn.8bitgo.com', 'tv.8bitgo.com'].includes(parent.hostname)
    const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(parent.hostname)
    // 生产只认本站实际入口；开发联调仅放行回环地址，不能让普通 HTTP 网站安装可通信的桥。
    if ((parent.protocol === 'https:' && siteHost) || (parent.protocol === 'http:' && localHost)) {
      parentOrigin = parent.origin
    }
  } catch {
    return
  }
  if (!parentOrigin) return

  const bridgeScript = document.currentScript || document.querySelector('script[src*="8bitgo-runtime-bridge.js"]')
  const selector = bridgeScript?.dataset?.readySelector ||
    (typeof bridgeScript?.getAttribute === 'function' ? bridgeScript.getAttribute('data-ready-selector') : '') || ''
  const state = {
    firstFrame: false,
    playable: false,
    firstInteraction: false,
    failed: false,
  }
  const READY_TIMEOUT_MS = 120_000
  let ready = false
  let observer = null
  let timeout = 0
  let timeoutStartedAt = 0
  let remainingTimeout = READY_TIMEOUT_MS
  let inspectOnLoad = null
  let inspectTimer = 0
  let visibilityListener = null
  let firstInteractionListener = null
  let inspectScheduled = false

  const send = (type, detail) => {
    try {
      window.parent.postMessage({ source, version: 1, type, detail }, parentOrigin)
      return true
    } catch {
      // iframe 正在销毁或父页已经导航时，不能让收尾消息抛错干扰游戏。
      return false
    }
  }

  const isDocumentHidden = () => typeof document.visibilityState === 'string'
    ? document.visibilityState !== 'visible'
    : document.hidden === true

  const now = () => window.performance && typeof window.performance.now === 'function'
    ? window.performance.now()
    : Date.now()

  const stopDomWatch = () => {
    observer?.disconnect()
    observer = null
    if (inspectTimer) window.clearTimeout(inspectTimer)
    inspectTimer = 0
    if (inspectOnLoad) window.removeEventListener('load', inspectOnLoad)
    inspectOnLoad = null
  }

  const pauseTimeout = () => {
    if (!timeout) return
    window.clearTimeout(timeout)
    timeout = 0
    remainingTimeout = Math.max(0, remainingTimeout - (now() - timeoutStartedAt))
  }

  const armTimeout = () => {
    if (timeout || state.playable || state.failed || isDocumentHidden()) return
    if (remainingTimeout <= 0) {
      reportFailure('网页游戏在 120 秒内没有报告可玩状态')
      return
    }
    timeoutStartedAt = now()
    timeout = window.setTimeout(() => {
      timeout = 0
      remainingTimeout = 0
      reportFailure('网页游戏在 120 秒内没有报告可玩状态')
    }, remainingTimeout)
  }

  const stopReadinessWatch = () => {
    stopDomWatch()
    pauseTimeout()
    if (visibilityListener) document.removeEventListener('visibilitychange', visibilityListener)
    visibilityListener = null
  }

  const stopInteractionWatch = () => {
    if (!firstInteractionListener) return
    window.removeEventListener('pointerdown', firstInteractionListener, true)
    window.removeEventListener('keydown', firstInteractionListener, true)
    firstInteractionListener = null
  }

  const reportFirstFrame = () => {
    if (state.firstFrame || state.failed) return
    state.firstFrame = true
    send('first-frame')
  }

  const reportPlayable = () => {
    if (state.playable || state.failed) return
    ready = true
    stopReadinessWatch()
    state.playable = true
    reportFirstFrame()
    send('game-playable')
  }

  const reportFirstInteraction = () => {
    if (!state.playable || state.firstInteraction || state.failed) return
    state.firstInteraction = true
    stopInteractionWatch()
    send('first-interaction')
  }

  const reportFailure = (detail) => {
    if (state.playable || state.failed) return
    ready = true
    stopReadinessWatch()
    stopInteractionWatch()
    state.failed = true
    const message = typeof detail === 'string' ? detail.trim().slice(0, 160) : ''
    send('failed', message || '网页游戏启动失败')
  }

  /**
   * 给游戏自身的加载器一个稳定入口，避免每个项目都手写 postMessage 协议。
   * 这只上报当前 iframe 的生命周期，不开放截图、直播、登录令牌或父页控制能力。
   */
  const api = Object.freeze({
    source,
    version: 1,
    getState: () => ({ ...state }),
    reportFirstFrame,
    reportPlayable,
    reportFirstInteraction,
    reportFailure,
  })
  window[installKey] = api
  window.EightBitGoBridge = api

  const reportReady = () => {
    if (ready) return
    ready = true
    // 两帧后复查选择器，避免短暂加载节点被误认成可玩；确认前保留观察器与超时预算。
    const requestFrame = window.requestAnimationFrame || ((callback) => window.setTimeout(callback, 16))
    requestFrame(() => requestFrame(() => {
      if (state.failed || state.playable) return
      try {
        if (!document.querySelector(selector)) {
          ready = false
          scheduleInspect()
          return
        }
      } catch {
        reportFailure('网页游戏就绪选择器无效')
        return
      }
      reportPlayable()
    }))
  }

  const inspect = () => {
    if (ready || !selector) return
    try {
      if (document.querySelector(selector)) reportReady()
    } catch {
      reportFailure('网页游戏就绪选择器无效')
    }
  }

  const scheduleInspect = () => {
    if (ready || !selector || inspectScheduled || isDocumentHidden()) return
    inspectScheduled = true
    inspectTimer = window.setTimeout(() => {
      inspectTimer = 0
      inspectScheduled = false
      inspect()
    }, 100)
  }

  observer = selector && typeof MutationObserver !== 'undefined'
    ? new MutationObserver(scheduleInspect)
    : null
  if (observer && document.documentElement) {
    try {
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true })
    } catch {
      observer.disconnect()
      observer = null
    }
  }
  visibilityListener = () => {
    if (isDocumentHidden()) {
      pauseTimeout()
      if (inspectTimer) window.clearTimeout(inspectTimer)
      inspectTimer = 0
      inspectScheduled = false
    }
    else {
      armTimeout()
      scheduleInspect()
    }
  }
  document.addEventListener('visibilitychange', visibilityListener)
  armTimeout()

  inspectOnLoad = inspect
  window.addEventListener('load', inspectOnLoad, { once: true })
  inspect()

  if (!state.failed) {
    firstInteractionListener = () => reportFirstInteraction()
    window.addEventListener('pointerdown', firstInteractionListener, true)
    window.addEventListener('keydown', firstInteractionListener, true)
  }
})()
