/*
 * 坏 chunk 自修复（出错时才加载，正常访问从不下载这个文件）。
 * 放在 /assets/ 下是为了大陆访客能经 EdgeOne 取到；首页按入口脚本的实际域名加载它。
 *
 * 2026-11-15 PK / TH 两位访客：`The requested module './live-Cqhc9j-k.js' does not provide an export named 'x'`。
 * 源站那份有这个导出、构建是确定性的 —— 浏览器手里那份字节被某一跳缓存换掉了。/assets/ 文件一年 immutable，
 * 普通刷新拿回的还是同一份坏字节，玩家只能看着兜底页。
 *
 * 做法：
 *   1. 读本版构建的 SHA-256 清单（assets/integrity-<入口哈希>.json，scripts/lib/vite-asset-integrity.mjs 生成）；
 *   2. 只核对本页真正用过的 chunk（Resource Timing）、点名 chunk 的静态依赖和错误里点名的那个，先从浏览器缓存读（不走网络）；
 *   3. 对不上的绕过浏览器缓存重取（cache: 'reload'，顺带覆盖缓存里的坏副本）；
 *   4. 重取仍不符或连续取不下来时，换一个带查询串的地址回源核对，好的话记下来，
 *      下次开页由首页的内联钩子用 import map 把这个文件改指到新地址，并通知服务端清掉那条边缘缓存；
 *   5. 修好了就自动刷新一次（同一页一分钟内最多一次）。
 *
 * 为什么用 SHA-256 不用 MD5：浏览器内置的 crypto.subtle 只有 SHA 系列，原生实现比任何 JS 版 MD5 都快，
 * 也是浏览器 SRI 用的同一类摘要。只用 ES2017：页面兼容下限是 Chrome 64。
 * 文件名带版本号：改逻辑要新建 asset-repair-v7.js，不能原地覆盖（长期缓存，见 server/src/cache.js）。
 *
 * v3（2026-11-16，诊断包 #761：微信 iOS 在 cn.8bitgo.com/_cn/assets/ 上懒加载 GameDetailPage 报
 * `Importing a module script failed`，自动刷新后再次失败）：
 *   - v2 对「取不下来」（网络错误 / HTTP 错误）的文件直接记失败，分不清是偶发、EdgeOne 的问题还是访客断网。
 *     现在先绕过缓存重试一次（好了记 recovered，算修好）；还不行、且文件来自大陆加速入口，
 *     就取主站同名文件对照：主站正常记 edgeOnly，由 React 兜底页改用主站资源重新载入整页。
 *   - trace 记每个异常文件的三次结果（HTTP 状态 / 网络错误 / 超时），写进诊断包。
 *
 * v4（2026-11-16，诊断包 #850 / #851：Chrome 懒加载播放器时，内部 live chunk 连续 HTTP 500）：
 *   - v3 对连续 HTTP / 网络错误只在大陆 EdgeOne 路径对照主站；主站资源路径遇到 500 时，
 *     `cache: 'reload'` 仍可能取回相同错误响应，现场无法单凭状态码判断是哪一层产生。
 *   - 两次普通请求仍失败后，再用 `?asset-repair=1` 核对一次。回源正常就记 remap、请求清 Cloudflare，
 *     让下一次整页加载通过 import map 使用这份资源；仍不可达时，才继续做 EdgeOne / 主站对照。
 *
 * v5（2026-11-17，诊断包 #917：Chrome 150 / Linux / 3G，播放器 chunk 导入失败）：
 *   - 现场点名的播放器 chunk 在 SHA-256 清单里正确，但诊断没有检查它的静态依赖，可能漏掉真正失败的子模块；
 *     v2 清单带静态依赖图，出错时只递归核对点名 chunk 的依赖，不扫全站文件。
 *   - 第三次带 `chunk-retry` 导入会被 Resource Timing 和错误点名各收录一次；按同一文件、剥掉该重试参数去重，
 *     避免弱网下把 200KB 播放器重复下载两遍。
 *
 * v6（2026-11-17，诊断包 #1108：Chrome 150 / Linux / US / 3G，EmulatorPlayer 动态导入失败）：
 *   - 目标 chunk 的普通 URL 被 SHA-256 验证正确，强制重取也正确，但动态导入仍失败。只刷新文档会继续使用原 CDN URL；
 *     同源入口下再用短时限检查一次 `?asset-repair=1` 地址，校验正确才写 import map 并请求清 Cloudflare，下一页改走该 URL。
 *     这能绕开原 URL 的边缘缓存 / 请求路径；查询串副本未验证通过时保留原来的刷新恢复路径。
 *
 * v7（2026-11-19，诊断包 #1285 / #1368 / #1393，与 #917 / #1108 同一画像：Chrome 150 / Linux / US / 3G、90 核、页面在后台）：
 *   - v6 的前提不成立。Chromium 153 与 WebKit 26.6 实测：懒加载入口的**静态依赖**一次取不下来（404 / 错误 MIME /
 *     请求被中止 / window.stop()），报错写的仍是入口地址；失败的依赖被这一份文档的模块表记住，换查询串重导入口也必然失败，
 *     而同一时刻 fetch() 入口、依赖、查询串副本全都正常。所以「原 URL 内容正常但导入失败」说明不了 CDN 上那份有问题，
 *     v6 据此写 import map、请求清 Cloudflare，是在给健康文件清缓存。
 *   - 现在点名文件的普通地址字节和类型都正常时只记 inDocument（导入失败在本页模块表里，整页刷新即可），不改地址、不清边缘。
 *   - 核对时多看一眼 Content-Type：.js 回的不是 JavaScript（边缘把错误页 / 别的类型挂在这个地址上）才算地址本身异常，
 *     和字节不符一样走「绕过缓存重取 → 查询串回源」，回源正常再改走回源地址、请求清缓存 —— 这才是 v6 想覆盖的那种故障。
 */
;(function () {
  'use strict'
  var w = window
  if (w.__8bitgoAssetRepairRun) return

  var CONCURRENCY = 6
  var MAX_FILES = 160
  var FETCH_TIMEOUT_MS = 15000
  var REMAP_KEY = '8bitgo.asset-remap'
  var REMAP_TTL_MS = 7 * 24 * 3600 * 1000
  var REMAP_MAX = 24
  var RELOAD_KEY = '8bitgo.asset-repair-reload:'
  var RELOAD_COOLDOWN_MS = 60000
  var BYPASS_PARAM = 'asset-repair'

  function entrySrc() {
    var el = document.querySelector('script[type="module"][src*="/assets/index-"]')
    return el ? el.src : ''
  }

  function parseEntry(src) {
    var m = /^(.*\/assets\/)index-([A-Za-z0-9_-]+)\.js(?:[?#].*)?$/.exec(src || '')
    if (!m || m[2].indexOf('legacy-') === 0) return null
    return { base: m[1], id: m[2] }
  }

  function fileOf(url) {
    var m = /\/assets\/([^/?#]+)(?:[?#]|$)/.exec(String(url || ''))
    return m ? m[1] : null
  }

  function strip(url) {
    return String(url).split('#')[0].split('?')[0]
  }

  function bypassUrl(url) {
    return strip(url) + '?' + BYPASS_PARAM + '=1'
  }

  function toBase64(buffer) {
    var bytes = new Uint8Array(buffer)
    var bin = ''
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    }
    return btoa(bin)
  }

  /** fetch + 超时；返回 { ok, status, buffer } 或抛错 */
  function grab(url, cacheMode, timeoutMs) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null
    var timer = ctrl ? setTimeout(function () { ctrl.abort() }, timeoutMs || FETCH_TIMEOUT_MS) : 0
    var init = { cache: cacheMode, credentials: 'same-origin' }
    if (ctrl) init.signal = ctrl.signal
    return fetch(url, init).then(function (res) {
      if (!res.ok) return { ok: false, status: res.status, buffer: null }
      var type = ''
      try { type = res.headers && typeof res.headers.get === 'function' ? String(res.headers.get('content-type') || '') : '' } catch (e) { type = '' }
      return res.arrayBuffer().then(function (buffer) { return { ok: true, status: res.status, buffer: buffer, type: type } })
    }).then(function (out) {
      if (timer) clearTimeout(timer)
      return out
    }, function (err) {
      if (timer) clearTimeout(timer)
      throw err
    })
  }

  /**
   * 'ok' | 'mismatch' | 'mime' | 'http' | 'error'（error 带 why：超时 / 网络错误）。
   * mime：.js 回的 Content-Type 不是 JavaScript —— 模块脚本会被浏览器拒绝，fetch() 却照样拿到字节，
   * 只比 SHA-256 发现不了。没有 Content-Type（测试桩、极少数代理）不算异常。
   */
  function check(url, expected, cacheMode, timeoutMs) {
    return grab(url, cacheMode, timeoutMs).then(function (res) {
      if (!res.ok) return { state: 'http', status: res.status, bytes: 0 }
      if (res.type && /\.js(?:[?#]|$)/.test(strip(url)) && !/javascript|ecmascript/i.test(res.type)) {
        return { state: 'mime', bytes: res.buffer.byteLength, type: res.type.split(';')[0].slice(0, 40) }
      }
      if (!expected) return { state: 'ok', bytes: res.buffer.byteLength }
      return crypto.subtle.digest('SHA-256', res.buffer).then(function (digest) {
        return { state: toBase64(digest) === expected ? 'ok' : 'mismatch', bytes: res.buffer.byteLength }
      })
    }, function (err) {
      return { state: 'error', why: err && err.name === 'AbortError' ? '超时' : '网络错误', bytes: 0 }
    })
  }

  /** 诊断包里的一个词：HTTP 502 / 网络错误 / 超时 / 内容不符 / 正常 */
  function describe(out) {
    if (!out) return '?'
    if (out.state === 'http') return 'HTTP ' + out.status
    if (out.state === 'error') return out.why || '网络错误'
    if (out.state === 'mime') return '类型错误 ' + (out.type || '')
    return out.state === 'mismatch' ? '内容不符' : '正常'
  }

  /**
   * 大陆加速入口（cn.<裸域>/_cn/assets/x.js）上的文件对应的主站地址；本来就同源时返回 ''。
   * 只用来对照「是不是 EdgeOne 的问题」，不改变页面加载哪一份。
   */
  function originTwin(url) {
    var name = fileOf(url)
    if (!name) return ''
    try {
      if (new URL(url, location.href).origin === location.origin) return ''
      return location.origin + '/assets/' + name
    } catch (e) {
      return ''
    }
  }

  function validManifest(data) {
    return data && (data.v === 1 || data.v === 2) && data.alg === 'sha256' && data.files && typeof data.files === 'object'
  }

  /** 重试参数只区分同一 chunk 的 ESM 模块实例，诊断时应把它们视为同一个构建文件。 */
  function targetKey(url) {
    try {
      var parsed = new URL(url, location.href)
      parsed.searchParams.delete('chunk-retry')
      parsed.hash = ''
      return parsed.href
    } catch (e) {
      return strip(url).replace(/([?&])chunk-retry=[^&]*&?/, function (_, prefix) { return prefix === '?' ? '?' : '' }).replace(/[?&]$/, '')
    }
  }

  /** 只沿懒加载入口的静态 JS 依赖查：失败的子模块可能不会留下 Resource Timing 条目。 */
  function staticDependencyUrls(manifest, urls, base) {
    if (!manifest || manifest.v !== 2 || !manifest.imports) return []
    var found = {}
    var result = []
    function visit(name) {
      if (!name || found[name]) return
      found[name] = true
      var dependencies = manifest.imports[name]
      if (!Array.isArray(dependencies)) return
      dependencies.forEach(function (dependency) {
        if (!/^[\w.-]+\.js$/.test(dependency) || !manifest.files[dependency]) return
        result.push(base + dependency)
        visit(dependency)
      })
    }
    urls.forEach(function (url) { visit(fileOf(url)) })
    return result
  }

  /** 清单本身也可能被缓存坏：先读缓存，解析不了再绕过缓存取一次 */
  function loadManifest(entry) {
    var url = entry.base + 'integrity-' + entry.id + '.json'
    function attempt(mode) {
      return grab(url, mode).then(function (res) {
        if (!res.ok) return { missing: res.status === 404 }
        try {
          var data = JSON.parse(new TextDecoder().decode(res.buffer))
          return validManifest(data) ? { data: data } : { broken: true }
        } catch (e) {
          return { broken: true }
        }
      }, function () { return { broken: true } })
    }
    return attempt('force-cache').then(function (first) {
      if (first.data || first.missing) return first.data || null
      return attempt('reload').then(function (second) { return second.data || null })
    })
  }

  function loadedAssetUrls() {
    var out = []
    try {
      var entries = performance.getEntriesByType('resource')
      for (var i = 0; i < entries.length; i++) {
        var name = entries[i].name
        if (fileOf(name)) out.push(name)
      }
    } catch (e) { /* Resource Timing 不可用：只查错误里点名的文件 */ }
    return out
  }

  function pool(items, worker) {
    var index = 0
    function next() {
      if (index >= items.length) return Promise.resolve()
      var item = items[index++]
      return worker(item).then(next, next)
    }
    var runners = []
    for (var i = 0; i < Math.min(CONCURRENCY, items.length); i++) runners.push(next())
    return Promise.all(runners)
  }

  function readRemap() {
    try {
      var data = JSON.parse(localStorage.getItem(REMAP_KEY) || '{}')
      return data && typeof data === 'object' ? data : {}
    } catch (e) {
      return {}
    }
  }

  function saveRemap(urls) {
    if (!urls.length) return
    try {
      var now = Date.now()
      var data = readRemap()
      var kept = {}
      Object.keys(data).forEach(function (key) {
        if (data[key] && data[key].until > now) kept[key] = data[key]
      })
      urls.forEach(function (url) { kept[strip(url)] = { to: bypassUrl(url), until: now + REMAP_TTL_MS } })
      var keys = Object.keys(kept).sort(function (a, b) { return kept[b].until - kept[a].until }).slice(0, REMAP_MAX)
      var out = {}
      keys.forEach(function (key) { out[key] = kept[key] })
      localStorage.setItem(REMAP_KEY, JSON.stringify(out))
    } catch (e) { /* 无痕 / 配额满：本次不记，下次再修一遍 */ }
  }

  function reportEdge(entry, files) {
    if (!files.length) return
    try {
      fetch('/api/asset-repair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ build: entry.id, files: files.slice(0, 8) }),
        keepalive: true,
        credentials: 'omit',
      }).catch(function () {})
    } catch (e) { /* 只是通知，失败无所谓 */ }
  }

  function reloadOnce() {
    try {
      var key = RELOAD_KEY + location.pathname
      var last = Number(sessionStorage.getItem(key)) || 0
      var now = Date.now()
      if (now - last >= 0 && now - last < RELOAD_COOLDOWN_MS) return false
      sessionStorage.setItem(key, String(now))
    } catch (e) {
      return false
    }
    location.reload()
    return true
  }

  function run(opts) {
    opts = opts || {}
    var started = Date.now()
    var result = {
      manifest: false,
      checked: 0,
      ok: 0,
      repaired: [],
      refreshed: [],
      // v7：点名文件的普通地址字节、类型都正常 —— 导入失败在本页模块表里，整页刷新即可
      inDocument: [],
      remapped: [],
      bad: [],
      failed: [],
      // v3：取不下来、重试一次就好了
      recovered: [],
      // v3：大陆加速入口取不下来，主站同名文件正常
      edgeOnly: [],
      // v3：异常文件的取数经过，例如「GameDetailPage-x.js 网络错误→网络错误，主站 正常」
      trace: [],
      // v3：资源从哪个域名取的（入口脚本所在的主机）
      from: '',
      reloaded: false,
      ms: 0,
    }
    var entry = parseEntry(entrySrc())
    try { if (entry) result.from = new URL(entry.base, location.href).host } catch (e) { /* 留空 */ }
    if (!entry || !w.fetch || !w.crypto || !crypto.subtle) {
      result.ms = Date.now() - started
      return Promise.resolve(result)
    }
    var priority = {}
    ;(opts.urls || []).forEach(function (url) { if (url && fileOf(url)) priority[strip(url)] = true })

    return loadManifest(entry).then(function (manifest) {
      result.manifest = Boolean(manifest)
      var files = manifest ? manifest.files : {}
      var seen = {}
      var targets = []
      var namedUrls = Object.keys(priority)
      var dependencies = staticDependencyUrls(manifest, namedUrls, entry.base)
      namedUrls.concat(dependencies, loadedAssetUrls()).forEach(function (url) {
        var name = fileOf(url)
        var key = targetKey(url)
        if (!name || seen[key]) return
        // 没有清单时只能处理错误里点名的文件；有清单时只查清单里有的（别的构建、别的目录不归它管）
        if (manifest ? !files[name] : !priority[strip(url)]) return
        seen[key] = true
        targets.push(url)
      })
      targets = targets.slice(0, MAX_FILES)
      var edgeBad = []

      function note(text) {
        if (result.trace.length < 6) result.trace.push(text)
      }

      // 普通地址重取仍不符或不可达时，带查询串回源核对一次
      function verifyBypass(url, name, expected, failedIfUnreachable) {
        return check(bypassUrl(url), expected, 'no-store').then(function (third) {
          if (third.state === 'ok') {
            result.remapped.push(name)
            edgeBad.push({ url: url, name: name })
            note(name + ' 带查询串回源正常')
          } else {
            if (third.state === 'mismatch' || third.state === 'mime') result.bad.push(name)
            else if (failedIfUnreachable && third.state !== 'ok') result.failed.push(name)
          }
          return third
        })
      }

      /*
        取不下来（网络错误 / HTTP 错误）：先绕过浏览器缓存重试，偶发的这一下就能恢复；
        仍失败就用带查询串的地址核对回源，成功时改用这份地址并请服务端清边缘缓存；
        还不行且文件来自大陆加速入口时，才取主站同名文件对照 —— 主站正常说明是 EdgeOne 这一路的问题，
        React 兜底页据此改用主站资源重新载入整页（只换一个文件会让同一模块出现两份，见 AGENTS.md §2.39）。
      */
      function retryUnreachable(url, name, expected, first) {
        return check(url, expected, 'reload').then(function (second) {
          if (second.state === 'ok') {
            result.recovered.push(name)
            note(name + ' ' + describe(first) + '→重试正常')
            return
          }
          if (second.state === 'mismatch' || second.state === 'mime') {
            return verifyBypass(url, name, expected, true).then(function (third) {
              if (third.state !== 'ok') note(name + ' ' + describe(first) + '→' + describe(second) + '，回源 ' + describe(third))
            })
          }
          return verifyBypass(url, name, expected).then(function (bypass) {
            if (bypass.state === 'ok' || bypass.state === 'mismatch' || bypass.state === 'mime') return
            var twin = originTwin(url)
            if (!twin) {
              result.failed.push(name)
              note(name + ' ' + describe(first) + '→' + describe(second) + '，回源 ' + describe(bypass))
              return
            }
            return check(twin, expected, 'reload').then(function (fourth) {
              if (fourth.state === 'ok') result.edgeOnly.push(name)
              else result.failed.push(name)
              note(name + ' ' + describe(first) + '→' + describe(second) + '，回源 ' + describe(bypass) + '，主站 ' + describe(fourth))
            })
          })
        })
      }

      return pool(targets, function (url) {
        var name = fileOf(url)
        var expected = manifest ? files[name] : ''
        var named = Boolean(priority[strip(url)])
        result.checked++
        return check(url, expected, 'force-cache').then(function (first) {
          if (first.state === 'ok' && !named) { result.ok++; return }
          if (first.state === 'http' || first.state === 'error') return retryUnreachable(url, name, expected, first)
          // 缓存里那份坏了，或错误点名了它（没清单 / 缓存键不一致时也覆盖一遍）：绕过浏览器缓存重取
          return check(url, expected, 'reload').then(function (second) {
            if (second.state === 'ok') {
              if (first.state === 'ok') {
                result.refreshed.push(name)
                // 点名文件字节、类型都对：导入失败发生在这一份文档的模块表里（多半是某个静态依赖当时没取到、被记住了），
                // 整页刷新就会重新取；不改地址、不请求清边缘缓存（v6 在这里清的是健康文件）。
                if (named && expected) {
                  result.inDocument.push(name)
                  note(name + ' 字节与类型正常，导入失败在本页模块表里')
                }
              } else result.repaired.push(name)
              return
            }
            if (second.state !== 'mismatch' && second.state !== 'mime') {
              result.failed.push(name)
              note(name + ' ' + describe(first) + '→' + describe(second))
              return
            }
            return verifyBypass(url, name, expected)
          })
        })
      }).then(function () {
        // 依赖真有问题（取不下来 / 内容不符 / 改了地址）时，点名的入口只是被连累，不能说「失败在本页模块表里」；
        // 它仍记在 refreshed（强制重取过），该刷新还是刷新
        if (result.failed.length || result.bad.length || result.remapped.length || result.edgeOnly.length) {
          result.inDocument = []
          result.trace = result.trace.filter(function (line) { return line.indexOf('导入失败在本页模块表里') < 0 })
        }
        saveRemap(edgeBad.map(function (item) { return item.url }))
        reportEdge(entry, edgeBad.map(function (item) { return item.name }))
        result.ms = Date.now() - started
        var fixed = result.repaired.length + result.refreshed.length + result.remapped.length + result.recovered.length + result.inDocument.length
        if (fixed && opts.reload !== false) result.reloaded = reloadOnce()
        try {
          console.warn('[8bitgo/asset-repair]', JSON.stringify(result), opts.reason || '')
        } catch (e) { /* 控制台不可用也不影响修复 */ }
        return result
      })
    }, function () {
      result.ms = Date.now() - started
      return result
    })
  }

  w.__8bitgoAssetRepairRun = run
})()
