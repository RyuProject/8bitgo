/**
 * 8BitGo HTML5 / Unity 媒体桥 v1。
 *
 * 放在游戏引擎脚本之前：
 *   <script src="/html5-api/8bitgo-media-bridge.js"></script>
 *
 * 普通 Canvas 不接它也能截图和录画面；提前接入的价值是能在 Unity / Emscripten 创建
 * AudioContext 之前装好旁路，让录像和直播从第一声开始就带游戏音频。它不会改音量、
 * 不会把声音再接回扬声器，也不会把任何媒体上传到服务器。
 */
(function install8BitGoMediaBridge(global) {
  'use strict'

  var BRIDGE_KEY = '__8bitgoMediaBridge'
  var TAP_KEY = '__8bitgoAudioTap'
  if (global[BRIDGE_KEY] && global[BRIDGE_KEY].version === 1) return

  function installAudioTap() {
    if (global[TAP_KEY]) return global[TAP_KEY]
    var tap = { ctx: null, node: null }
    var Native = global.AudioContext || global.webkitAudioContext
    var NodeProto = global.AudioNode && global.AudioNode.prototype
    if (typeof Native !== 'function' || !NodeProto) return tap

    global[TAP_KEY] = tap
    class TappedAudioContext extends Native {
      constructor() {
        super(...arguments)
        if (!tap.ctx) {
          tap.ctx = this
          try {
            tap.node = this.createGain()
          } catch {
            tap.node = null
          }
        }
      }
    }

    try { global.AudioContext = TappedAudioContext } catch {}
    try { if (global.webkitAudioContext) global.webkitAudioContext = TappedAudioContext } catch {}

    var originalConnect = NodeProto.connect
    NodeProto.connect = function (destination) {
      var args = Array.prototype.slice.call(arguments, 1)
      var result = originalConnect.call(this, destination, ...args)
      try {
        // 只复制最终接到扬声器的一级，避免同一条链路被重复录两三遍。
        if (tap.ctx && tap.node && destination === tap.ctx.destination) {
          originalConnect.call(this, tap.node)
        }
      } catch {
        // 旁路失败只允许影响录音，绝不能影响游戏原来的发声路径。
      }
      return result
    }
    return tap
  }

  function largestCanvas(doc, depth) {
    if (!doc) return null
    var best = null
    var area = 0
    var canvases = doc.querySelectorAll('canvas')
    for (var i = 0; i < canvases.length; i++) {
      var candidate = canvases[i]
      var nextArea = (Number(candidate.width) || 0) * (Number(candidate.height) || 0)
      if (nextArea > area) {
        best = candidate
        area = nextArea
      }
    }
    if (depth >= 2) return best
    var frames = doc.querySelectorAll('iframe')
    for (var j = 0; j < frames.length; j++) {
      var nested = null
      try { nested = largestCanvas(frames[j].contentDocument, depth + 1) } catch {}
      var nestedArea = nested ? nested.width * nested.height : 0
      if (nestedArea > area) {
        best = nested
        area = nestedArea
      }
    }
    return best
  }

  var tap = installAudioTap()
  var screenshotProvider = null
  global[BRIDGE_KEY] = {
    source: '8bitgo-media-bridge',
    version: 1,
    captureSources: function () {
      return {
        canvas: largestCanvas(global.document, 0),
        audioNode: tap.node,
        audioContext: tap.ctx,
      }
    },
    /**
     * 可选扩展：游戏有原生截图 API 时在启动代码里登记，例如返回 PNG Blob。
     * 不登记就返回 null，外层会用 Canvas captureStream 截浏览器真正合成的那一帧。
     */
    setScreenshotProvider: function (provider) {
      screenshotProvider = typeof provider === 'function' ? provider : null
    },
    screenshot: function () {
      return screenshotProvider ? Promise.resolve(screenshotProvider()) : Promise.resolve(null)
    },
  }
})(window)
