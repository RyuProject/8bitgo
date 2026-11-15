/* AwayFL 游戏只在这个同源子页中运行，避免其舞台、输入监听和 SharedObject 污染站点页面。 */
(function () {
  'use strict'

  var CHANNEL = '8bitgo-awayfl-v1'
  var parentOrigin = location.origin
  var player = null
  var started = false
  var storagePrefix = ''

  function send(type, detail) {
    try {
      parent.postMessage(Object.assign({ channel: CHANNEL, type: type }, detail || {}), parentOrigin)
    } catch (_) {
      /* 父页已拆掉播放器时不再回传 */
    }
  }

  function errorText(error) {
    if (error && typeof error === 'object' && 'message' in error) return String(error.message)
    return String(error || 'AwayFL failed to load this SWF')
  }

  /* SharedObject 使用 localStorage；前缀让同源的游戏之间不会读写同名存档。 */
  function scopeStorage(key) {
    storagePrefix = '8bitgo.awayfl.' + String(key || 'unknown').replace(/[^\w~:.-]+/g, '_').slice(0, 120) + ':'
    var proto = Storage.prototype
    var native = {
      getItem: proto.getItem,
      setItem: proto.setItem,
      removeItem: proto.removeItem,
      clear: proto.clear,
      key: proto.key,
      length: Object.getOwnPropertyDescriptor(proto, 'length').get,
    }
    var ownKey = function (name) { return storagePrefix + String(name) }
    proto.getItem = function (name) { return native.getItem.call(this, ownKey(name)) }
    proto.setItem = function (name, value) { return native.setItem.call(this, ownKey(name), value) }
    proto.removeItem = function (name) { return native.removeItem.call(this, ownKey(name)) }
    proto.clear = function () {
      for (var i = native.length.call(this) - 1; i >= 0; i--) {
        var name = native.key.call(this, i)
        if (name && name.indexOf(storagePrefix) === 0) native.removeItem.call(this, name)
      }
    }
    Object.defineProperty(proto, 'key', {
      configurable: true,
      value: function (index) {
        var matches = []
        for (var i = 0; i < native.length.call(this); i++) {
          var name = native.key.call(this, i)
          if (name && name.indexOf(storagePrefix) === 0) matches.push(name.slice(storagePrefix.length))
        }
        return matches[index] === undefined ? null : matches[index]
      },
    })
    Object.defineProperty(proto, 'length', {
      configurable: true,
      get: function () {
        var count = 0
        for (var i = 0; i < native.length.call(this); i++) {
          var name = native.key.call(this, i)
          if (name && name.indexOf(storagePrefix) === 0) count++
        }
        return count
      },
    })
  }

  function dispatchKey(data) {
    var event = new KeyboardEvent(data.type, {
      key: data.key,
      code: data.code,
      keyCode: data.keyCode,
      which: data.keyCode,
      bubbles: true,
      cancelable: true,
      view: window,
    })
    // 从 document 派发会继续冒泡到 window，两个常见监听位置都能收到一次。
    document.dispatchEvent(event)
  }

  function start(data) {
    if (started || !window.AWAYFL || !window.AWAYFL.Player) {
      send('error', { message: 'AwayFL runtime is unavailable' })
      return
    }
    started = true
    scopeStorage(data.storageKey)

    try {
      var config = {
        x: '0%', y: '0%', w: '100%', h: '100%',
        width: data.width,
        height: data.height,
        stageScaleMode: 'showAll',
        maxStageScale: 1,
        backgroundColor: '#000000',
        baseUrl: '/awayfl/v0.1.4',
        runtimeFlags: { defaultSmoothBitmap: false, enableBlends: false, enableFilters: false },
        files: [{ data: data.bytes, path: data.gameUrl, resourceType: 'GAME' }],
      }
      player = new window.AWAYFL.Player(document, config)
      Promise.resolve(player.loadAndPlay()).then(function () {
        send('started')
      }, function (error) {
        send('error', { message: errorText(error) })
      })
    } catch (error) {
      send('error', { message: errorText(error) })
    }
  }

  window.addEventListener('message', function (event) {
    if (event.source !== parent || event.origin !== parentOrigin) return
    var data = event.data
    if (!data || data.channel !== CHANNEL) return
    if (data.type === 'start') start(data)
    else if (data.type === 'keydown' || data.type === 'keyup') dispatchKey(data)
    else if (data.type === 'destroy') {
      try { player && player.stop && player.stop() } catch (_) { /* iframe 即将销毁 */ }
      player = null
      started = false
    }
  })

  window.addEventListener('error', function (event) {
    if (started) send('error', { message: errorText(event.error || event.message) })
  })
  window.addEventListener('unhandledrejection', function (event) {
    if (started) send('error', { message: errorText(event.reason) })
  })

  send('ready')
})()
