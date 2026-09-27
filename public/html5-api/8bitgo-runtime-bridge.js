/**
 * Pages 子域上的网页游戏无法再由主站读取 DOM，因此用一条只报告生命周期的窄桥。
 * 它不接收命令、不读取存档；父窗口还要同时满足 source 与精确来源校验，第三方站点
 * 即使嵌入游戏也拿不到任何 8BitGo 能力。
 */
(() => {
  'use strict'

  if (window.parent === window) return
  let parentOrigin = ''
  try {
    const parent = new URL(document.referrer)
    if (parent.protocol === 'https:' && (parent.hostname === '8bitgo.com' || parent.hostname === 'www.8bitgo.com')) {
      parentOrigin = parent.origin
    }
  } catch {
    return
  }
  if (!parentOrigin) return

  const source = '8bitgo-runtime-bridge'
  const selector = document.currentScript?.dataset.readySelector || ''
  let ready = false
  const send = (type, detail) => window.parent.postMessage({ source, version: 1, type, detail }, parentOrigin)

  const reportReady = () => {
    if (ready) return
    ready = true
    requestAnimationFrame(() => requestAnimationFrame(() => {
      send('first-frame')
      send('game-playable')
    }))
  }

  const inspect = () => {
    if (ready) return
    if (!selector || document.querySelector(selector)) reportReady()
  }

  const observer = selector && typeof MutationObserver !== 'undefined'
    ? new MutationObserver(inspect)
    : null
  if (observer && document.documentElement) observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true })
  window.addEventListener('load', inspect, { once: true })
  inspect()

  const firstInteraction = () => {
    send('first-interaction')
    window.removeEventListener('pointerdown', firstInteraction, true)
    window.removeEventListener('keydown', firstInteraction, true)
  }
  window.addEventListener('pointerdown', firstInteraction, true)
  window.addEventListener('keydown', firstInteraction, true)

  window.setTimeout(() => {
    if (!ready) send('failed', '网页游戏在 120 秒内没有生成可玩界面')
    observer?.disconnect()
  }, 120_000)
})()
