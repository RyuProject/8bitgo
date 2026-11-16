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
 *   2. 只核对本页真正用过的 chunk（Resource Timing）和错误里点名的那个，先从浏览器缓存读（不走网络）；
 *   3. 对不上的绕过浏览器缓存重取（cache: 'reload'，顺带覆盖缓存里的坏副本）；
 *   4. 重取的还是坏的，说明 CDN 边缘给的就是坏字节：换一个带查询串的地址直接回源核对，好的话记下来，
 *      下次开页由首页的内联钩子用 import map 把这个文件改指到新地址，并通知服务端清掉那条边缘缓存；
 *   5. 修好了就自动刷新一次（同一页一分钟内最多一次）。
 *
 * 为什么用 SHA-256 不用 MD5：浏览器内置的 crypto.subtle 只有 SHA 系列，原生实现比任何 JS 版 MD5 都快，
 * 也是浏览器 SRI 用的同一类摘要。只用 ES2017：页面兼容下限是 Chrome 64。
 * 文件名带版本号：改逻辑要新建 asset-repair-v3.js，不能原地覆盖（长期缓存，见 server/src/cache.js）。
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
  function grab(url, cacheMode) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null
    var timer = ctrl ? setTimeout(function () { ctrl.abort() }, FETCH_TIMEOUT_MS) : 0
    var init = { cache: cacheMode, credentials: 'same-origin' }
    if (ctrl) init.signal = ctrl.signal
    return fetch(url, init).then(function (res) {
      if (!res.ok) return { ok: false, status: res.status, buffer: null }
      return res.arrayBuffer().then(function (buffer) { return { ok: true, status: res.status, buffer: buffer } })
    }).then(function (out) {
      if (timer) clearTimeout(timer)
      return out
    }, function (err) {
      if (timer) clearTimeout(timer)
      throw err
    })
  }

  /** 'ok' | 'mismatch' | 'http' | 'error' */
  function check(url, expected, cacheMode) {
    return grab(url, cacheMode).then(function (res) {
      if (!res.ok) return { state: 'http', status: res.status, bytes: 0 }
      if (!expected) return { state: 'ok', bytes: res.buffer.byteLength }
      return crypto.subtle.digest('SHA-256', res.buffer).then(function (digest) {
        return { state: toBase64(digest) === expected ? 'ok' : 'mismatch', bytes: res.buffer.byteLength }
      })
    }, function () {
      return { state: 'error', bytes: 0 }
    })
  }

  function validManifest(data) {
    return data && data.v === 1 && data.alg === 'sha256' && data.files && typeof data.files === 'object'
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
      remapped: [],
      bad: [],
      failed: [],
      reloaded: false,
      ms: 0,
    }
    var entry = parseEntry(entrySrc())
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
      Object.keys(priority).concat(loadedAssetUrls()).forEach(function (url) {
        var name = fileOf(url)
        if (!name || seen[url]) return
        // 没有清单时只能处理错误里点名的文件；有清单时只查清单里有的（别的构建、别的目录不归它管）
        if (manifest ? !files[name] : !priority[strip(url)]) return
        seen[url] = true
        targets.push(url)
      })
      targets = targets.slice(0, MAX_FILES)
      var edgeBad = []

      return pool(targets, function (url) {
        var name = fileOf(url)
        var expected = manifest ? files[name] : ''
        var named = Boolean(priority[strip(url)])
        result.checked++
        return check(url, expected, 'force-cache').then(function (first) {
          if (first.state === 'ok' && !named) { result.ok++; return }
          if (first.state === 'http' || (first.state === 'error' && !named)) { result.failed.push(name); return }
          // 缓存里那份坏了，或错误点名了它（没清单 / 缓存键不一致时也覆盖一遍）：绕过浏览器缓存重取
          return check(url, expected, 'reload').then(function (second) {
            if (second.state === 'ok') {
              if (first.state === 'ok') result.refreshed.push(name)
              else result.repaired.push(name)
              return
            }
            if (second.state !== 'mismatch') { result.failed.push(name); return }
            // 重取的还是坏的：多半是 CDN 边缘缓存坏了。带查询串直接回源核对一次
            return check(bypassUrl(url), expected, 'no-store').then(function (third) {
              if (third.state === 'ok') {
                result.remapped.push(name)
                edgeBad.push({ url: url, name: name })
              } else {
                result.bad.push(name)
              }
            })
          })
        })
      }).then(function () {
        saveRemap(edgeBad.map(function (item) { return item.url }))
        reportEdge(entry, edgeBad.map(function (item) { return item.name }))
        result.ms = Date.now() - started
        var fixed = result.repaired.length + result.refreshed.length + result.remapped.length
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
