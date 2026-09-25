"use strict";

/*
 * PvZ Portable WebAssembly 的可恢复下载器。
 *
 * 浏览器原生的 instantiateStreaming 会把 wasm 当成一次完整请求：弱网断在 99% 时，刷新后是否
 * 能续上完全取决于 HTTP 缓存，实际经常从 0 开始。这里改为固定 Range 分块，并在每块完成后立刻
 * 写进 IndexedDB；自动刷新后只补缺块，最后仍用已验收的 SHA-256 校验整文件，不能把错块交给引擎。
 */
(function () {
  if (window.__PVZ_BLOCKED__) return;

  var REAL_SIZE = 7246681;
  var REAL_SHA256 = "851072d991cc7f5770244b9be7204ed03ff5ee769101446987bbd3e1329ec3a6";
  var local = location.hostname === "localhost" || location.hostname === "127.0.0.1" || location.hostname === "[::1]";
  // 只给本地回归缩小文件和分块；线上元数据必须固定，避免被查询串绕过完整性校验。
  var test = local && window.__PVZ_WASM_TEST_CONFIG__ ? window.__PVZ_WASM_TEST_CONFIG__ : {};
  var WASM_SIZE = Number(test.size) || REAL_SIZE;
  var WASM_SHA256 = String(test.sha256 || REAL_SHA256).toLowerCase();
  var CHUNK_SIZE = Number(test.chunkSize) || 1024 * 1024;
  var MAX_ATTEMPTS = Number(test.maxAttempts) || 3;
  var STALL_TIMEOUT_MS = Number(test.stallTimeoutMs) || 30000;
  var CONCURRENCY = 3;
  var WASM_URL = new URL("pvz-portable.wasm", document.baseURI).href;
  var DB_NAME = "pvz-portable";
  var DB_STORE = "resources";
  var CACHE_PREFIX = "wasm:" + WASM_SHA256 + ":" + WASM_SIZE + ":" + CHUNK_SIZE + ":";
  var loadPromise = null;
  var dbPromise = null;
  var cacheDisabled = false;

  function report(phase, loaded, detail) {
    var state = {
      phase: phase,
      loaded: Math.max(0, Math.min(WASM_SIZE, Number(loaded) || 0)),
      total: WASM_SIZE,
      detail: detail || "",
    };
    window.__pvzWasmProgress = state;
    window.dispatchEvent(new CustomEvent("pvz-wasm-progress", { detail: state }));
  }

  function openDB() {
    if (cacheDisabled) return Promise.reject(new Error("IndexedDB 不可用"));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var request;
      try { request = indexedDB.open(DB_NAME, 1); }
      catch (error) { reject(error); return; }
      request.onupgradeneeded = function () {
        if (!request.result.objectStoreNames.contains(DB_STORE)) request.result.createObjectStore(DB_STORE);
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error("IndexedDB 打开失败")); };
    }).catch(function (error) {
      cacheDisabled = true;
      throw error;
    });
    return dbPromise;
  }

  function idbGet(key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, "readonly");
        var request = tx.objectStore(DB_STORE).get(key);
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error); };
        tx.onabort = function () { reject(tx.error || new Error("IndexedDB 读取中止")); };
      });
    });
  }

  function idbPutMany(pairs) {
    if (!pairs.length) return Promise.resolve();
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, "readwrite");
        var store = tx.objectStore(DB_STORE);
        for (var i = 0; i < pairs.length; i++) store.put(pairs[i][1], pairs[i][0]);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error("IndexedDB 写入中止")); };
      });
    });
  }

  function idbDeletePrefix(prefix) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, "readwrite");
        var request = tx.objectStore(DB_STORE).openKeyCursor(IDBKeyRange.bound(prefix, prefix + "\uffff"));
        request.onsuccess = function () {
          var cursor = request.result;
          if (!cursor) return;
          tx.objectStore(DB_STORE).delete(cursor.key);
          cursor.continue();
        };
        request.onerror = function () { reject(request.error); };
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error("IndexedDB 清理中止")); };
      });
    });
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function isRetryable(error) {
    var status = Number(error && error.httpStatus) || 0;
    return !status || status === 408 || status === 425 || status === 429 || status >= 500;
  }

  function readBody(response, expectedLength, controller, onBytes) {
    if (!response.body || !response.body.getReader) {
      return response.arrayBuffer().then(function (buffer) {
        var bytes = new Uint8Array(buffer);
        if (onBytes) onBytes(bytes.byteLength);
        return bytes;
      });
    }
    var reader = response.body.getReader();
    var output = new Uint8Array(expectedLength);
    var offset = 0;
    var timer = 0;
    function arm() {
      clearTimeout(timer);
      timer = setTimeout(function () { controller.abort(); }, STALL_TIMEOUT_MS);
    }
    arm();
    function pump() {
      return reader.read().then(function (result) {
        if (result.done) {
          clearTimeout(timer);
          if (offset !== expectedLength) throw new Error("WASM 分块长度不符（应为 " + expectedLength + "，实际 " + offset + "）");
          return output;
        }
        arm();
        if (offset + result.value.byteLength > output.byteLength) throw new Error("WASM 响应超过声明长度");
        output.set(result.value, offset);
        offset += result.value.byteLength;
        if (onBytes) onBytes(offset);
        return pump();
      }).finally(function () { clearTimeout(timer); });
    }
    return pump();
  }

  function parseContentRange(value) {
    var match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(value || ""));
    return match ? { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) } : null;
  }

  function fetchChunk(index, committedBytes) {
    var start = index * CHUNK_SIZE;
    var end = Math.min(WASM_SIZE, start + CHUNK_SIZE) - 1;
    var expectedLength = end - start + 1;
    var attempt = 0;

    function run() {
      attempt++;
      var controller = new AbortController();
      var headerTimer = setTimeout(function () { controller.abort(); }, STALL_TIMEOUT_MS);
      return fetch(WASM_URL, {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        headers: { Range: "bytes=" + start + "-" + end },
      }).then(function (response) {
        clearTimeout(headerTimer);
        if (response.status !== 206 && response.status !== 200) {
          var error = new Error("WASM HTTP " + response.status);
          error.httpStatus = response.status;
          throw error;
        }
        if (response.status === 200) {
          return readBody(response, WASM_SIZE, controller, function (received) {
            report("downloading", Math.min(WASM_SIZE, committedBytes + received), "服务器未返回 Range，正在读取完整文件");
          }).then(function (bytes) { return { full: true, bytes: bytes }; });
        }
        var contentRange = parseContentRange(response.headers.get("content-range"));
        if (!contentRange || contentRange.start !== start || contentRange.end !== end || contentRange.total !== WASM_SIZE) {
          throw new Error("WASM Content-Range 不匹配");
        }
        return readBody(response, expectedLength, controller, function (received) {
          report("downloading", committedBytes + received, "正在下载第 " + (index + 1) + " 块");
        }).then(function (bytes) { return { full: false, bytes: bytes }; });
      }).catch(function (error) {
        clearTimeout(headerTimer);
        if (attempt < MAX_ATTEMPTS && isRetryable(error)) {
          report("retrying", committedBytes, "网络中断，正在重试第 " + attempt + " 块");
          return delay(attempt * 500).then(run);
        }
        error.retryable = isRetryable(error);
        throw error;
      }).finally(function () { clearTimeout(headerTimer); });
    }
    return run();
  }

  function normalizeCachedPart(value, index) {
    var bytes = value && value.bytes instanceof Uint8Array ? value.bytes : null;
    var expected = Math.min(CHUNK_SIZE, WASM_SIZE - index * CHUNK_SIZE);
    if (!bytes || bytes.byteLength !== expected || value.sha256 !== WASM_SHA256 || value.index !== index) return null;
    return bytes;
  }

  function cacheWholeFile(bytes) {
    var pairs = [];
    var count = Math.ceil(WASM_SIZE / CHUNK_SIZE);
    for (var i = 0; i < count; i++) {
      pairs.push([CACHE_PREFIX + i, {
        index: i,
        sha256: WASM_SHA256,
        bytes: bytes.slice(i * CHUNK_SIZE, Math.min(bytes.byteLength, (i + 1) * CHUNK_SIZE)),
      }]);
    }
    return idbPutMany(pairs).catch(function (error) {
      console.warn("[PvZ] WASM 分块缓存写入失败，本局仍继续：", error);
    });
  }

  function verify(bytes) {
    if (bytes.byteLength !== WASM_SIZE) return Promise.reject(new Error("WASM 长度不符"));
    if (!window.crypto || !window.crypto.subtle) return Promise.reject(new Error("浏览器不支持 SHA-256，无法安全加载 WASM"));
    report("verifying", WASM_SIZE, "正在校验引擎");
    return window.crypto.subtle.digest("SHA-256", bytes).then(function (digest) {
      var hex = Array.prototype.map.call(new Uint8Array(digest), function (value) {
        return value.toString(16).padStart(2, "0");
      }).join("");
      if (hex !== WASM_SHA256) throw new Error("WASM SHA-256 不匹配，已丢弃损坏分块");
      return bytes;
    });
  }

  function downloadRound(ignoreCache) {
    var count = Math.ceil(WASM_SIZE / CHUNK_SIZE);
    var parts = new Array(count);
    var committedBytes = 0;
    var indexes = Array.from({ length: count }, function (_, index) { return index; });
    var prepare = ignoreCache
      ? idbDeletePrefix(CACHE_PREFIX).catch(function () {})
      : Promise.all(indexes.map(function (index) {
          return idbGet(CACHE_PREFIX + index).then(function (value) {
            var bytes = normalizeCachedPart(value, index);
            if (bytes) { parts[index] = bytes; committedBytes += bytes.byteLength; }
          }).catch(function () {});
        }));

    return prepare.then(function () {
      report("downloading", committedBytes, committedBytes ? "从已保存的断点继续" : "开始下载引擎");
      var fullBytes = null;
      var next = 0;
      function savePart(index, result) {
        if (result.full) {
          fullBytes = result.bytes;
          committedBytes = WASM_SIZE;
          return cacheWholeFile(fullBytes);
        }
        parts[index] = result.bytes;
        committedBytes += result.bytes.byteLength;
        report("downloading", committedBytes, "分块已保存，可断点续传");
        return idbPutMany([[CACHE_PREFIX + index, {
          index: index,
          sha256: WASM_SHA256,
          bytes: result.bytes,
        }]]).catch(function (error) {
          console.warn("[PvZ] WASM 断点写入失败：", error);
        });
      }
      function worker() {
        function step() {
          if (fullBytes) return Promise.resolve();
          while (next < count && parts[next]) next++;
          if (next >= count) return Promise.resolve();
          var index = next++;
          var before = committedBytes;
          return fetchChunk(index, before).then(function (result) {
            return savePart(index, result).then(step);
          });
        }
        return step();
      }
      // 先探测一个缺块再开并发；若服务器忽略 Range 返回 200，可避免同时下载三份完整 wasm。
      while (next < count && parts[next]) next++;
      var probe = next < count
        ? (function () {
            var index = next++;
            return fetchChunk(index, committedBytes).then(function (result) { return savePart(index, result); });
          })()
        : Promise.resolve();
      return probe.then(function () {
        if (fullBytes) return;
        var pool = [];
        for (var i = 0; i < Math.min(CONCURRENCY, count); i++) pool.push(worker());
        return Promise.all(pool);
      }).then(function () {
        if (fullBytes) return fullBytes;
        var output = new Uint8Array(WASM_SIZE);
        var offset = 0;
        for (var index = 0; index < parts.length; index++) {
          if (!parts[index]) throw new Error("WASM 分块缺失：" + index);
          output.set(parts[index], offset);
          offset += parts[index].byteLength;
        }
        return output;
      });
    });
  }

  function loadVerifiedWasm() {
    return downloadRound(false).then(verify).catch(function (firstError) {
      if (/SHA-256|分块缺失|长度不符/.test(String(firstError && firstError.message))) {
        console.warn("[PvZ] WASM 缓存损坏，清空分块后重下：", firstError);
        return downloadRound(true).then(verify);
      }
      throw firstError;
    });
  }

  window.__pvzInstantiateWasm = function (imports, receiveInstance) {
    if (!loadPromise) loadPromise = loadVerifiedWasm();
    loadPromise
      .then(function (bytes) {
        report("compiling", WASM_SIZE, "正在编译引擎");
        return WebAssembly.instantiate(bytes, imports);
      })
      .then(function (result) {
        report("ready", WASM_SIZE, "引擎已就绪");
        receiveInstance(result.instance || result);
      })
      .catch(function (error) {
        report("error", window.__pvzWasmProgress && window.__pvzWasmProgress.loaded, error.message || String(error));
        console.error("[PvZ] WebAssembly 引擎加载失败：", error);
        if (typeof window._rejectModuleReady === "function") window._rejectModuleReady(error);
      });
    // 老版 Emscripten 会等待 receiveInstance 回调；异步路径这里返回空对象即可。
    return {};
  };
})();
