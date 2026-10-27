/*
 * 主站与亚洲边缘的首次路由。
 *
 * 这段必须独立于 React/Vite：它在应用、水合和大资源下载前运行，才能避免用户先从
 * 较慢的域名把一半页面资源下载下来再跳走。它只保存一个短期的「哪个边缘较快」cookie，
 * 不收集 IP、地域、账号或请求内容；cookie 也不参与认证。
 *
 * ⚠️ 两个域名的 localStorage / sessionStorage 不共享。已有登录态、后台口令或 OAuth
 * 回调若跨域，会表现成突然退出登录，因此这些会话一律留在当前域名。SEO 爬虫和测速
 * 工具也完全跳过，canonical 仍固定在主站，见 src/services/seo.ts。
 */
;(function (global) {
  'use strict'

  var PRIMARY_HOST = '8bitgo.com'
  var ASIA_HOST = 'cn.8bitgo.com'
  var HOSTS = [PRIMARY_HOST, ASIA_HOST]
  var COOKIE_NAME = '8bitgo.edge'
  var COOKIE_TTL_MS = 2 * 60 * 60 * 1000
  // 首次探测只允许占用很短的首屏窗口；失败就留在当前已成功打开的站点。
  var PROBE_TIMEOUT_MS = 450
  var MIN_WIN_MS = 80
  var MIN_WIN_RATIO = 0.15

  function now() {
    return global.performance && typeof global.performance.now === 'function' ? global.performance.now() : Date.now()
  }

  function currentTarget() {
    return String(global.location.pathname || '/') + String(global.location.search || '') + String(global.location.hash || '')
  }

  // 只接受站内相对地址，避免未来调用方把外部地址意外变成跨站跳转。
  function normalizeTarget(value) {
    var target = typeof value === 'string' ? value : currentTarget()
    if (!target || target.charAt(0) !== '/' || target.slice(0, 2) === '//') return currentTarget()
    return target
  }

  function isKnownHost(host) {
    return HOSTS.indexOf(String(host || '').toLowerCase()) >= 0
  }

  function readStorage(storage, key) {
    try {
      return storage && storage.getItem(key)
    } catch (_error) {
      // 隐私模式可能拒绝 Storage；这时宁可不跨域，也不能让首屏报错。
      return null
    }
  }

  function hasLocalSession() {
    return Boolean(
      readStorage(global.localStorage, '8bitgo.token') ||
        readStorage(global.localStorage, '8bitgo.session') ||
        readStorage(global.localStorage, '8bitgo.session.user') ||
        readStorage(global.sessionStorage, '8bitgo.api.admintoken') ||
        readStorage(global.sessionStorage, '8bitgo.admin.unlocked'),
    )
  }

  function isCrawlerOrLab(ua) {
    return /bot|crawl|spider|slurp|google-|googleother|mediapartners|facebookexternalhit|embedly|preview|lighthouse|pagespeed|page speed|ptst|gtmetrix/i.test(
      String(ua || ''),
    )
  }

  function isSensitivePath(path) {
    // 登录和开放平台授权依赖当前域的临时状态；后台还可能有仅当前标签可见的口令。
    return /^\/(?:[a-z]{2}(?:-[A-Za-z]{4})?\/)?(?:admin|login|auth|open)(?:\/|$)/.test(path)
  }

  function readChoice() {
    try {
      var all = String(global.document.cookie || '').split(/;\s*/)
      for (var i = 0; i < all.length; i++) {
        var pair = all[i].split('=')
        if (pair.shift() !== COOKIE_NAME) continue
        var match = String(pair.join('=')).match(/^(8bitgo\.com|cn\.8bitgo\.com):(\d+)$/)
        if (!match) return null
        var timestamp = Number(match[2])
        if (!Number.isFinite(timestamp) || Date.now() - timestamp < 0 || Date.now() - timestamp > COOKIE_TTL_MS) return null
        return { host: match[1], timestamp: timestamp }
      }
    } catch (_error) {
      // Cookie 被禁用时只是每次重新测，不影响访问。
    }
    return null
  }

  function storeChoice(host) {
    if (!isKnownHost(host)) return
    try {
      // Domain 让两个同站子域共享结果；Secure/SameSite 限定为 HTTPS 的第一方导航。
      global.document.cookie =
        COOKIE_NAME +
        '=' +
        host +
        ':' +
        Date.now() +
        '; Domain=.8bitgo.com; Path=/; Max-Age=' +
        Math.floor(COOKIE_TTL_MS / 1000) +
        '; SameSite=Lax; Secure'
    } catch (_error) {
      // 无 cookie 仍然能本次选路。
    }
  }

  function navigate(host, target) {
    var location = global.location
    if (host === String(location.hostname || '').toLowerCase()) {
      if (target !== currentTarget()) location.replace(target)
      return
    }
    location.replace('https://' + host + target)
  }

  function probe(host) {
    if (typeof global.fetch !== 'function') return Promise.resolve(null)

    return new Promise(function (resolve) {
      var finished = false
      var started = now()
      // 弱网下 fetch 可能一直挂着；超时后主动断开，不能让两条测速连接占用后续 ROM 下载。
      var controller = typeof global.AbortController === 'function' ? new global.AbortController() : null
      var timer = global.setTimeout(function () {
        finish(null, true)
      }, PROBE_TIMEOUT_MS)
      // 固定 URL + no-store 只绕过浏览器缓存，不给每次请求制造新的 CDN 缓存键。
      // 随机查询串会让边缘反复回源，测到的是源站冷请求，还会增加源站负载。
      var url = 'https://' + host + '/favicon.svg'

      function finish(milliseconds, abort) {
        if (finished) return
        finished = true
        global.clearTimeout(timer)
        if (abort && controller) controller.abort()
        resolve(typeof milliseconds === 'number' && milliseconds >= 0 ? milliseconds : null)
      }

      // no-cors + omit 让测速既不读取跨域响应，也不携带登录凭据；只量请求是否能抵达边缘。
      // favicon 是极小、两边部署都必须存在的静态文件，避免把 SSR 或游戏资源波动当成网络差异。
      var options = { method: 'GET', mode: 'no-cors', credentials: 'omit', cache: 'no-store' }
      if (controller) options.signal = controller.signal
      global
        .fetch(url, options)
        .then(function () {
          finish(now() - started)
        })
        .catch(function () {
          finish(null)
        })
    })
  }

  function choose(primaryMs, asiaMs) {
    if (asiaMs == null) return PRIMARY_HOST
    if (primaryMs == null) return ASIA_HOST
    // 轻微抖动不切域：一次测速刚好快几十毫秒，不值得让用户承担跨域重载。
    var requiredGain = Math.max(MIN_WIN_MS, primaryMs * MIN_WIN_RATIO)
    return asiaMs + requiredGain < primaryMs ? ASIA_HOST : PRIMARY_HOST
  }

  /**
   * @param {string} requestedTarget 语言脚本已经算好的站内路径（含查询串和锚点）
   */
  global.__8bitgoEdgeRoute = function (requestedTarget) {
    var target = normalizeTarget(requestedTarget)
    var location = global.location
    var host = String(location.hostname || '').toLowerCase()
    var path = String(location.pathname || '/')
    var ua = global.navigator && global.navigator.userAgent

    // 非生产域、HTTP、机器访问和身份敏感页只完成原本的站内语言跳转，不测也不跨域。
    if (
      location.protocol !== 'https:' ||
      !isKnownHost(host) ||
      isCrawlerOrLab(ua) ||
      isSensitivePath(path) ||
      hasLocalSession()
    ) {
      navigate(host, target)
      return
    }

    var remembered = readChoice()
    if (remembered) {
      if (remembered.host === host) {
        navigate(host, target)
        return
      }

      // Cookie 只记上次较快的边缘，不代表它现在仍可用。当前 HTML 已经成功打开，
      // 跳去另一域前先轻量验证；目标失联时保留当前页面并更新选择，避免把整站送进坏节点。
      probe(remembered.host).then(function (milliseconds) {
        if (milliseconds != null) {
          navigate(remembered.host, target)
          return
        }
        storeChoice(host)
        navigate(host, target)
      })
      return
    }

    // 两个小请求同时发出；任一失败只当该边缘本次不可用，绝不阻断当前页面。
    Promise.all([probe(PRIMARY_HOST), probe(ASIA_HOST)]).then(function (times) {
      var selected = choose(times[0], times[1])
      storeChoice(selected)
      navigate(selected, target)
    })
  }
})(window)
