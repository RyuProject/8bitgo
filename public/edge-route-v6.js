/*
 * 主站与亚洲边缘的首次路由（v6）。
 *
 * 这段必须独立于 React/Vite：它在应用、水合和大资源下载前运行，才能避免用户先从
 * 较慢的域名把一半页面资源下载下来再跳走。它只保存短期的「选哪个边缘」cookie，
 * 不收集 IP、地域、账号或请求内容；cookie 也不参与认证。
 *
 * ⚠️ 两个域名的 localStorage / sessionStorage / IndexedDB 不共享。已有登录态、后台口令、
 * OAuth 回调或本地存档的访客若跨域，会表现成突然退出登录、存档消失，因此这些访客一律留在
 * 当前域名。SEO 爬虫和测速工具也完全跳过，canonical 仍固定在主站，见 src/services/seo.ts。
 *
 * v2 → v3（2026-11-20）：v2 只靠两个 180ms 的测速探针决定去留。从大陆直连实测，
 * 探已连上的 8bitgo.com 要 1.0 秒、第一次连 cn.8bitgo.com（含握手）要 1.4～3.2 秒，
 * 两个探针永远超时，按规则留在当前页 —— 上线以来没把一个大陆访客送到更快的 EdgeOne。
 * 同一时刻经 Cloudflare 美国节点取入口 JS 7.9 秒、经 EdgeOne 1.5 秒。
 * v3 改用 Cloudflare 已经给出的地域结论：SSR 在 <html data-8bitgo-cdn> 写 cn / main
 * （来自边缘改写规则追加的 __cdn=cn，见 shared/cover-cdn-hint.js）。主站上判为 cn 的访客
 * 只验证 cn.8bitgo.com 能连上就过去；判为 main 的访客不再测速，省掉一条到香港的冷连接。
 * 没有结论（规则没配、本地开发）的主站访客仍走 v2 的测速逻辑。
 * v3 → v4（2026-11-20）：v3 在 cn.8bitgo.com 上还按 180ms 测速决定去留。大陆直连实测
 * （出口 CN，Cloudflare LAX）：打开 cn.8bitgo.com 后探针约 0.45 秒就判主站赢、整页送回
 * 8bitgo.com —— 小请求只量握手延迟（Cloudflare TLS 约 0.5 秒、EdgeOne 0.6～2.6 秒），
 * 量不出丢包：同一时刻主站首页 HTML 要 4～25 秒（边缘已 HIT）、经 EdgeOne 2.5～3.5 秒。
 * 被送回的大陆访客随后又被主站按地域送回 cn，白加载两次页面。现在亚洲边缘上一律留下。
 * 代价：从分享链接直接打开 cn.8bitgo.com 的海外访客也留在 EdgeOne（照样能用，只是不如主站快）。
 * v4 → v5（2026-11-22）：为 NS 迁出 Cloudflare 做准备（deploy/saas/README.md）。迁移后大陆访客经 DNS 分线路
 * 直接由 EdgeOne 打开 8bitgo.com 本身，SSR 在 <html data-8bitgo-site="cn"> 标出「这页经 EdgeOne 回源」。
 * 这种页面已经在亚洲边缘上，和 cn.8bitgo.com 一样留下；否则 Cloudflare 判为 cn 的规则会把它送去 cn 子域，
 * 本地存档就分到两个域名下了。迁移前 Cloudflare 那边的 HTML 永远不带这个属性，行为与 v4 相同。
 * v5 → v6（2026-11-28）：SSR 曾按字符串首次查找 HTML head 结束标记；内联注释中的同名文本会让边缘文本提取把脚本源码显示在首页。现在 SSR 用模板专用槽位，并移除此字面量。
 * v2 / v3 / v4 / v5 文件保留：边缘缓存和浏览器里的旧 HTML 还引用它们。
 */
;(function (global) {
  'use strict'

  var PRIMARY_HOST = '8bitgo.com'
  var ASIA_HOST = 'cn.8bitgo.com'
  var HOSTS = [PRIMARY_HOST, ASIA_HOST]
  var COOKIE_NAME = '8bitgo.edge'
  /** 「EdgeOne 取不下资源、整页改从主站加载」后钉在主站，不再按地域送去 EdgeOne */
  var PIN_COOKIE_NAME = '8bitgo.edge.pin'
  var COOKIE_TTL_MS = 2 * 60 * 60 * 1000
  // 首次探测只占用有限窗口；失败就留在当前已经成功打开的站点。
  // 首次访问的测速发生在应用启动前；450ms 的超时会变成用户看得到的空白等待。
  // 180ms 足以识别明显的区域差异，测不准就留在当前已经打开的站点，不让测速拖慢开局。
  var PROBE_TIMEOUT_MS = 180
  var MIN_WIN_MS = 80
  var MIN_WIN_RATIO = 0.15
  /**
   * 按地域结论跳转前，只验证亚洲边缘能连上，不比快慢：跨太平洋的冷连接本来就要一两秒。
   * 等待期间当前页面照常渲染、不被阻塞；3 秒还没回来就留在主站。
   */
  var REACH_TIMEOUT_MS = 3000
  /** indexedDB.databases() 在 IndexedDB 坏掉的浏览器上可能永不返回（AGENTS.md §2.8.0.1） */
  var DATABASE_CHECK_TIMEOUT_MS = 1500
  /** SSR 把地域结论写在 <html> 上；后续的封面 meta 还没解析到 */
  var HINT_ATTR = 'data-8bitgo-cdn'
  /** SSR 写在 <html> 上：这页经 EdgeOne 回源（源站 nginx 校验过回源密钥），值只会是 cn */
  var SITE_ATTR = 'data-8bitgo-site'

  /*
    「这个浏览器在当前域名上玩过 / 存过东西」的痕迹。有任何一项就留下，不能让本地存档
    在另一个域名上「消失」。只列存档、游玩记录和玩家自己改过的设置；语言、侧栏这类偏好不算。
  */
  var LOCAL_PLAY_KEYS = ['8bitgo.recents', '8bitgo.save.target']
  var LOCAL_PLAY_PREFIXES = [
    'ejs-', // EmulatorJS 每款游戏的改键 / 金手指 / 核心选项
    '8bitgo.battery-sync.',
    '8bitgo.binjgb.battery.',
    '8bitgo.iodinegba.battery.',
    '8bitgo.eka2l1.save.',
    '8bitgo.emulatorjs.keymaps',
    '8bitgo.nes.keys',
    '8bitgo.hotkeys',
    '8bitgo.dos.',
  ]
  /** Ruffle SharedObject 的键是 `<hostname>/flash-frames/<slug>/…`（src/emulator/ruffleStorageScope.ts） */
  var RUFFLE_SAVE_MARK = '/flash-frames/'
  /** 只是缓存、丢了会自己重下的库；其余任何 IndexedDB 都按「可能有存档」处理 */
  var CACHE_ONLY_DATABASES = ['EmulatorJS-Cache', '8bitgo-roms', '8bitgo-rom-downloads']

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
        readStorage(global.sessionStorage, '8bitgo.admin.unlocked')
    )
  }

  function hasLocalPlayKeys() {
    var storage
    try {
      storage = global.localStorage
      if (!storage) return false
      for (var k = 0; k < LOCAL_PLAY_KEYS.length; k++) {
        var value = storage.getItem(LOCAL_PLAY_KEYS[k])
        if (value && value !== '[]') return true
      }
      var count = Number(storage.length) || 0
      for (var i = 0; i < count; i++) {
        var key = String(storage.key(i) || '')
        if (key.indexOf(RUFFLE_SAVE_MARK) >= 0) return true
        for (var j = 0; j < LOCAL_PLAY_PREFIXES.length; j++) {
          if (key.indexOf(LOCAL_PLAY_PREFIXES[j]) === 0) return true
        }
      }
    } catch (_error) {
      // 读不了 localStorage 的浏览器（隐私模式等）本来也写不进去，不会有要保护的数据。
      return false
    }
    return false
  }

  /**
   * @returns {Promise<boolean|null>} true = 有可能装着存档的库；false = 没有；null = 查不出来（按有处理）
   */
  function hasLocalPlayDatabases() {
    var idb = null
    try {
      idb = global.indexedDB
    } catch (_error) {
      idb = null
    }
    // 老 Firefox / Safari 没有 databases()：查不了库，只靠 localStorage 里的游玩记录（玩过就会写 recents）。
    if (!idb || typeof idb.databases !== 'function') return Promise.resolve(false)
    return new Promise(function (resolve) {
      var done = false
      var timer = global.setTimeout(function () {
        finish(null)
      }, DATABASE_CHECK_TIMEOUT_MS)
      function finish(value) {
        if (done) return
        done = true
        global.clearTimeout(timer)
        resolve(value)
      }
      var pending
      try {
        pending = idb.databases()
      } catch (_error) {
        finish(null)
        return
      }
      Promise.resolve(pending).then(
        function (list) {
          var items = list || []
          for (var i = 0; i < items.length; i++) {
            var name = String((items[i] && items[i].name) || '')
            if (name && CACHE_ONLY_DATABASES.indexOf(name) < 0) {
              finish(true)
              return
            }
          }
          finish(false)
        },
        function () {
          finish(null)
        }
      )
    })
  }

  function isCrawlerOrLab(ua) {
    return /bot|crawl|spider|slurp|google-|googleother|mediapartners|facebookexternalhit|embedly|preview|lighthouse|pagespeed|page speed|ptst|gtmetrix/i.test(
      String(ua || '')
    )
  }

  function isSensitivePath(path) {
    // 登录和开放平台授权依赖当前域的临时状态；后台还可能有仅当前标签可见的口令。
    return /^\/(?:[a-z]{2}(?:-[A-Za-z]{4})?\/)?(?:admin|login|auth|open)(?:\/|$)/.test(path)
  }

  function edgeHint() {
    try {
      var root = global.document && global.document.documentElement
      var value = root && typeof root.getAttribute === 'function' ? String(root.getAttribute(HINT_ATTR) || '') : ''
      return value === 'cn' || value === 'main' ? value : ''
    } catch (_error) {
      return ''
    }
  }

  /** 当前这页是不是由亚洲边缘（EdgeOne）送来的：cn 子域本身，或经 EdgeOne 打开的主域 */
  function servedByAsiaEdge(host) {
    if (host === ASIA_HOST) return true
    try {
      var root = global.document && global.document.documentElement
      return Boolean(root && typeof root.getAttribute === 'function' && String(root.getAttribute(SITE_ATTR) || '') === 'cn')
    } catch (_error) {
      return false
    }
  }

  function readCookie(name) {
    try {
      var all = String(global.document.cookie || '').split(/;\s*/)
      for (var i = 0; i < all.length; i++) {
        var pair = all[i].split('=')
        if (pair.shift() !== name) continue
        var match = String(pair.join('=')).match(/^(8bitgo\.com|cn\.8bitgo\.com):(\d+)$/)
        if (!match) return null
        var timestamp = Number(match[2])
        if (!Number.isFinite(timestamp) || Date.now() - timestamp < 0 || Date.now() - timestamp > COOKIE_TTL_MS) return null
        return { host: match[1], timestamp: timestamp }
      }
    } catch (_error) {
      // Cookie 被禁用时只是每次重新判断，不影响访问。
    }
    return null
  }

  function writeCookie(name, host) {
    if (!isKnownHost(host)) return
    try {
      // Domain 让两个同站子域共享结果；Secure/SameSite 限定为 HTTPS 的第一方导航。
      global.document.cookie =
        name +
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

  function readChoice() {
    return readCookie(COOKIE_NAME)
  }

  function storeChoice(host) {
    writeCookie(COOKIE_NAME, host)
  }

  function navigate(host, target) {
    var location = global.location
    if (host === String(location.hostname || '').toLowerCase()) {
      if (target !== currentTarget()) location.replace(target)
      return
    }
    location.replace('https://' + host + target)
  }

  /**
   * 测一次请求能否抵达某个边缘。
   * @param {number} timeoutMs 超时就当这次不可用
   * @param {boolean} warmConnection true 时带凭据：浏览器把带 / 不带凭据的请求放在不同连接池，
   *   只有带凭据的探针连接才能被随后的整页跳转复用，省掉一次握手（大陆到 EdgeOne 实测 0.7～0.9 秒）。
   *   登录令牌在 localStorage 里，不在 cookie 里，带凭据也不会把账号带过去。
   */
  function probe(host, timeoutMs, warmConnection) {
    if (typeof global.fetch !== 'function') return Promise.resolve(null)

    return new Promise(function (resolve) {
      var finished = false
      var started = now()
      // 弱网下 fetch 可能一直挂着；超时后主动断开，不能让测速连接占用后续 ROM 下载。
      var controller = typeof global.AbortController === 'function' ? new global.AbortController() : null
      var timer = global.setTimeout(function () {
        finish(null, true)
      }, timeoutMs)
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

      // no-cors 不读取跨域响应；favicon 是极小、两边部署都必须存在的静态文件，
      // 避免把 SSR 或游戏资源波动当成网络差异。
      var options = { method: 'GET', mode: 'no-cors', credentials: warmConnection ? 'include' : 'omit', cache: 'no-store' }
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

  /** 页面加载期间用户已经点过 / 按过键，就不再整页跳走打断他 */
  function watchInteraction() {
    var state = { touched: false, stop: function () {} }
    var events = ['pointerdown', 'keydown', 'touchstart']
    function mark() {
      state.touched = true
    }
    if (typeof global.addEventListener !== 'function') return state
    try {
      for (var i = 0; i < events.length; i++) global.addEventListener(events[i], mark, true)
      state.stop = function () {
        for (var j = 0; j < events.length; j++) global.removeEventListener(events[j], mark, true)
      }
    } catch (_error) {
      // 监听不上只是少一道保护
    }
    return state
  }

  function choose(primaryMs, asiaMs, currentHost) {
    // 两边都没测出结果时不做跨域迁移：当前页面至少已成功打开，保留它比猜一个节点安全。
    if (primaryMs == null && asiaMs == null) return isKnownHost(currentHost) ? currentHost : PRIMARY_HOST
    if (asiaMs == null) return PRIMARY_HOST
    if (primaryMs == null) return ASIA_HOST
    // 轻微抖动不切域：一次测速刚好快几十毫秒，不值得让用户承担跨域重载。
    var requiredGain = Math.max(MIN_WIN_MS, primaryMs * MIN_WIN_RATIO)
    return asiaMs + requiredGain < primaryMs ? ASIA_HOST : PRIMARY_HOST
  }

  /** 主站上 Cloudflare 判为大陆的访客：没有本地痕迹、亚洲边缘连得上、用户还没开始操作，才过去 */
  function routeMainlandVisitor(host, target) {
    if (readCookie(PIN_COOKIE_NAME)) {
      navigate(host, target)
      return
    }
    if (hasLocalPlayKeys()) {
      navigate(host, target)
      return
    }
    var interaction = watchInteraction()
    Promise.all([hasLocalPlayDatabases(), probe(ASIA_HOST, REACH_TIMEOUT_MS, true)]).then(function (results) {
      interaction.stop()
      // results[0] 为 null（查不出来）也留下：宁可慢一点，不能让存档看起来丢了
      if (results[0] !== false || results[1] == null || interaction.touched) {
        navigate(host, target)
        return
      }
      storeChoice(ASIA_HOST)
      navigate(ASIA_HOST, target)
    })
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

    // 兜底页在 EdgeOne 取不下 chunk 后带 __assets=origin 整页改从主站载入（src/services/moduleLinkRecovery.ts）。
    // 这一页和之后两小时都留在主站，否则下一次整页加载又被按地域送回同一条坏线路。
    if (host === PRIMARY_HOST && /[?&]__assets=origin(?:&|$)/.test(String(location.search || ''))) {
      writeCookie(PIN_COOKIE_NAME, PRIMARY_HOST)
      navigate(host, target)
      return
    }

    // 亚洲边缘上不测速、不跨域：能打开 cn.8bitgo.com、或经 EdgeOne 打开主域的访客留下，旧 cookie 也不理。
    // 180ms 的小探针只量握手延迟，大陆直连时常把丢包严重的 Cloudflare 美国节点判成更快（见文件头 v3 → v4）。
    if (servedByAsiaEdge(host)) {
      navigate(host, target)
      return
    }

    // 地域结论只在主站上有意义：大陆入口的 SSR 一律写 cn，那不代表访客在大陆。
    if (host === PRIMARY_HOST) {
      var hint = edgeHint()
      if (hint === 'cn') {
        routeMainlandVisitor(host, target)
        return
      }
      if (hint === 'main') {
        navigate(host, target)
        return
      }
    }

    var remembered = readChoice()
    if (remembered) {
      if (remembered.host === host) {
        navigate(host, target)
        return
      }

      // Cookie 只记上次较快的边缘，不代表它现在仍可用。当前 HTML 已经成功打开，
      // 跳去另一域前先轻量验证；目标失联时保留当前页面并更新选择，避免把整站送进坏节点。
      probe(remembered.host, PROBE_TIMEOUT_MS, false).then(function (milliseconds) {
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
    Promise.all([probe(PRIMARY_HOST, PROBE_TIMEOUT_MS, false), probe(ASIA_HOST, PROBE_TIMEOUT_MS, false)]).then(function (times) {
      var selected = choose(times[0], times[1], host)
      storeChoice(selected)
      navigate(selected, target)
    })
  }
})(window)
