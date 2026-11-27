/*
 * 8BitGo：游戏详情页里的塞班 / N-Gage 播放器（EKA2L1-WEB 运行目录里的 play.html 加载它）。
 *
 * 为什么不直接复用 run.html：run.html 依赖程序库页先把设备固件和游戏装进 IndexedDB（/eka2l1 挂 IDBFS），
 * 玩家要自备固件、自己装游戏。详情页要的是「点开始就玩」：每局在内存里从零装一台机器，
 *   1. 核心开机，/eka2l1 不挂 IDBFS（留在根 MEMFS 里），不碰 /symbian 程序库的数据；
 *   2. 卡带转储（.zip）在激活设备之前写进 E: —— 应用列表只在设备激活时扫描 System\Apps；
 *      预建 C:\System\Apps\<代号> 也在这一步（见 eka2l1-ngage-card.js）；
 *   3. 用站点下发的固件 ROM 安装并激活设备（EKA1 机型一步完成，ROM 拷进设备目录后删掉暂存件）；
 *   4. .sis 在设备激活之后安装，安装本身会重扫应用列表；
 *   5. 记下 C: / E: 的文件快照，再写回上次的存档，按 UID 启动，等第一帧。
 * 存档：游戏自己写在 C: / E: 上的文件（例如 C:\System\Apps\6RAK\THESIMS.SAV）。saveArchive() 把相对开局快照
 * 有变化的文件打成一个小包交给站点适配器，由它按「电池存档」的方式存本地 / 云端，下次开局经 start() 写回。
 *
 * 纯逻辑挂在 globalThis.EightBitGoSymbianPlayer 上，scripts/test-eka2l1-player.mjs 在 Node 里直接测。
 */
(function (root) {
  'use strict';

  const DRIVES = '/eka2l1/drives';
  const ROM_STAGING = '/eka2l1/8bitgo-device.rom';
  const SIS_STAGING = '/eka2l1/8bitgo-game.sis';
  const ARCHIVE_MAGIC = [0x38, 0x42, 0x47, 0x53, 0x59, 0x4D, 0x31, 0x00]; // "8BGSYM1\0"
  const MAX_ARCHIVE_BYTES = 2 * 1048576;
  const MAX_ARCHIVE_FILES = 4096;
  const FIRST_FRAME_TIMEOUT_MS = 120000;
  const CORE_ASSET_IDLE_TIMEOUT_MS = 30000;
  const CORE_ASSET_RETRIES = 2;
  const MAX_CORE_WASM_BYTES = 64 * 1048576;
  const MAX_CORE_DATA_BYTES = 32 * 1048576;
  const SISX_UID1 = 0x10201A7A;

  /**
   * 系统自己会改写、不属于游戏进度的位置（相对 drives，小写比较）。其余 C: / E: 上的新文件与改动都进存档：
   * N-Gage 卡带游戏多半写 C:\System\Apps\<代号>\，也有写 E: 或 C:\Nokia\ 的。
   */
  const EXCLUDED_PREFIXES = [
    'c/system/temp/', 'c/system/mail/', 'c/system/mtm/', 'c/system/shareddata/',
    // 开机时系统服务会写 T9 词库和短信设置（每局都变），不是游戏存档
    'c/system/data/t9', 'c/system/data/sms_settings.dat', 'c/system/system.ini', 'c/sys/', 'c/private/',
    'c/system/bootdata/', 'c/system/install/',
  ];

  /** EKA2L1 的按键扫描码（与 js/boot.js 的 EKA2L1.keys 一致） */
  const SCAN = Object.freeze({
    UP: 0x10, DOWN: 0x11, LEFT: 0x0e, RIGHT: 0x0f, OK: 0xa7, LSK: 0xa4, RSK: 0xa5,
    CLEAR: 0x01, STAR: 0x85, HASH: 0x7f,
    D0: 0x30, D1: 0x31, D2: 0x32, D3: 0x33, D4: 0x34, D5: 0x35, D6: 0x36, D7: 0x37, D8: 0x38, D9: 0x39,
  });

  /** 物理键盘 → 手机按键。只接管这些键，别的键照常交给页面 */
  const KEYBOARD = Object.freeze({
    ArrowUp: SCAN.UP, ArrowDown: SCAN.DOWN, ArrowLeft: SCAN.LEFT, ArrowRight: SCAN.RIGHT,
    Enter: SCAN.OK, NumpadEnter: SCAN.OK, Space: SCAN.OK,
    KeyQ: SCAN.LSK, F1: SCAN.LSK, KeyE: SCAN.RSK, F2: SCAN.RSK,
    Backspace: SCAN.CLEAR, Delete: SCAN.CLEAR,
    KeyX: SCAN.STAR, NumpadMultiply: SCAN.STAR, KeyC: SCAN.HASH, NumpadDivide: SCAN.HASH,
    Digit0: SCAN.D0, Digit1: SCAN.D1, Digit2: SCAN.D2, Digit3: SCAN.D3, Digit4: SCAN.D4,
    Digit5: SCAN.D5, Digit6: SCAN.D6, Digit7: SCAN.D7, Digit8: SCAN.D8, Digit9: SCAN.D9,
    Numpad0: SCAN.D0, Numpad1: SCAN.D1, Numpad2: SCAN.D2, Numpad3: SCAN.D3, Numpad4: SCAN.D4,
    Numpad5: SCAN.D5, Numpad6: SCAN.D6, Numpad7: SCAN.D7, Numpad8: SCAN.D8, Numpad9: SCAN.D9,
  });

  /**
   * 站点手柄按钮 → 手机按键。N-Gage 游戏的主要动作键是 5 和 7（「Press 5 to start」），
   * 摇杆中键是 OK；软键留给 select / start。
   */
  const PAD = Object.freeze({
    up: SCAN.UP, down: SCAN.DOWN, left: SCAN.LEFT, right: SCAN.RIGHT,
    a: SCAN.D5, b: SCAN.D7, select: SCAN.LSK, start: SCAN.OK,
  });

  class PlayerError extends Error {
    constructor(code, detail, scope) {
      super(detail ? code + ': ' + detail : code);
      this.name = 'PlayerError';
      this.code = code;
      this.detail = detail || '';
      this.scope = scope || 'runtime';
    }
  }

  function assetError(message, retryable) {
    const error = new Error(message);
    error.retryable = Boolean(retryable);
    return error;
  }

  /**
   * 核心的 wasm / data 走 Emscripten 原生下载时，响应体一旦停流就会一直等；data 包即使 HTTP 200 被截断，
   * 上游也会把短包继续拆进虚拟文件系统。这里按已知上限流式读、逐块设空闲超时并校验完整长度，
   * 网络失速或短包最多重试两次。data 的预分配缓冲避免「分块数组 + 最终拼接」同时驻留，降低手机峰值内存。
   */
  async function fetchCoreAsset(fetcher, url, options) {
    const expectedBytes = Number.isSafeInteger(options.expectedBytes) ? options.expectedBytes : 0;
    const expectedSha256 = String(options.expectedSha256 || '').toLowerCase();
    const maxBytes = options.maxBytes;
    const idleTimeoutMs = options.idleTimeoutMs || CORE_ASSET_IDLE_TIMEOUT_MS;
    const retries = Number.isSafeInteger(options.retries) ? options.retries : CORE_ASSET_RETRIES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || (expectedBytes && (expectedBytes <= 0 || expectedBytes > maxBytes))) {
      throw assetError('EKA2L1 核心资源大小配置无效', false);
    }
    if (expectedSha256 && !/^[a-f0-9]{64}$/.test(expectedSha256)) {
      throw assetError('EKA2L1 核心资源 SHA-256 清单无效', false);
    }

    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      let callerAborted = false;
      let timedOut = false;
      let reader = null;
      const abortFromCaller = () => { callerAborted = true; controller.abort(); };
      if (options.signal) {
        if (options.signal.aborted) throw new DOMException('已取消', 'AbortError');
        options.signal.addEventListener('abort', abortFromCaller, { once: true });
      }
      const withinIdleLimit = async (promise, stage) => {
        let timer;
        try {
          return await Promise.race([
            promise,
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                timedOut = true;
                controller.abort();
                reject(assetError(`EKA2L1 ${stage}超过 ${Math.round(idleTimeoutMs / 1000)} 秒没有数据`, true));
              }, idleTimeoutMs);
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      };

      try {
        const response = await withinIdleLimit(fetcher(url, { credentials: 'same-origin', cache: attempt ? 'reload' : 'default', signal: controller.signal }), '核心连接');
        if (!response || response.status !== 200) {
          const status = response ? response.status : 0;
          throw assetError(`EKA2L1 核心资源 HTTP ${status}`, status === 0 || status === 408 || status === 429 || status >= 500);
        }
        const contentType = response.headers && response.headers.get('content-type') || '';
        if (/text\/html|application\/(?:json|xhtml)/i.test(contentType)) {
          throw assetError('EKA2L1 核心资源返回了网页或错误 JSON', false);
        }
        if (!response.body || typeof response.body.getReader !== 'function') {
          throw assetError('浏览器不支持流式读取 EKA2L1 核心资源', false);
        }

        reader = response.body.getReader();
        const chunks = expectedBytes ? null : [];
        const output = expectedBytes ? new Uint8Array(expectedBytes) : null;
        let loaded = 0;
        for (;;) {
          const part = await withinIdleLimit(reader.read(), '核心下载');
          if (part.done) break;
          const chunk = part.value instanceof Uint8Array ? part.value : new Uint8Array(part.value);
          loaded += chunk.byteLength;
          if (loaded > maxBytes || (expectedBytes && loaded > expectedBytes)) {
            throw assetError('EKA2L1 核心资源超过声明大小', false);
          }
          if (output) output.set(chunk, loaded - chunk.byteLength);
          else chunks.push(chunk);
          if (typeof options.onChunk === 'function') options.onChunk(loaded, expectedBytes || 0);
        }
        if (!loaded || (expectedBytes && loaded !== expectedBytes)) {
          throw assetError(`EKA2L1 核心资源不完整：收到 ${loaded} / ${expectedBytes || '未知'} 字节`, true);
        }
        if (options.signal && options.signal.aborted) throw new DOMException('已取消', 'AbortError');
        const bytes = output || new Uint8Array(loaded);
        if (!output) {
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        }
        if (expectedSha256) {
          const subtle = root.crypto && root.crypto.subtle;
          if (!subtle) throw assetError('浏览器不支持 SHA-256，无法安全加载 EKA2L1 核心', false);
          const actual = Array.from(new Uint8Array(await subtle.digest('SHA-256', bytes)),
            (byte) => byte.toString(16).padStart(2, '0')).join('');
          if (actual !== expectedSha256) throw assetError('EKA2L1 核心资源 SHA-256 不匹配', true);
        }
        if (options.signal && options.signal.aborted) throw new DOMException('已取消', 'AbortError');
        return { bytes, contentType };
      } catch (error) {
        if (reader) {
          try { void reader.cancel().catch(() => {}); } catch { /* 下载已结束或浏览器已取消 */ }
        }
        if (callerAborted || (options.signal && options.signal.aborted)) throw new DOMException('已取消', 'AbortError');
        const retryable = Boolean(error && error.retryable) || timedOut || (error && error.name === 'TypeError');
        if (!retryable || attempt >= retries) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      } finally {
        if (options.signal) options.signal.removeEventListener('abort', abortFromCaller);
      }
    }
  }

  function u32(bytes, at) {
    return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
  }

  /** 'card'（卡带转储 ZIP）、'sis'（S60 1/2 版、N-Gage 的 SIS）、'sisx'（S60 第三版）、'unknown' */
  function detectGameKind(bytes) {
    if (!bytes || bytes.length < 4) return 'unknown';
    if (bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04) return 'card';
    const uid1 = u32(bytes, 0);
    if (uid1 === SISX_UID1) return 'sisx';
    // EPOC 的老 SIS：第三个 UID 是 KUidInstallApp（0x10000419），前两个是包自己的 UID
    if (bytes.length >= 12 && u32(bytes, 8) === 0x10000419) return 'sis';
    return 'unknown';
  }

  function isSaveCandidate(rel) {
    const lower = rel.toLowerCase();
    if (!(lower.startsWith('c/') || lower.startsWith('e/'))) return false;
    return !EXCLUDED_PREFIXES.some((prefix) => lower.startsWith(prefix));
  }

  /** 相对 drives 的安全路径：c/… 或 e/…，没有空段、.、..、反斜杠和控制字符 */
  function isSafeRel(rel) {
    if (typeof rel !== 'string' || rel.length > 400) return false;
    // eslint-disable-next-line no-control-regex -- 就是要拦控制字符
    if (/[\\\u0000-\u001f]/.test(rel)) return false;
    const parts = rel.split('/');
    if (parts[0] !== 'c' && parts[0] !== 'e') return false;
    return parts.length >= 2 && parts.every((p) => p && p !== '.' && p !== '..');
  }

  // ---- 存档包：magic + u32 文件数 + [u16 路径长 + 路径 UTF-8 + u32 长度 + 内容]… ----

  function encodeSaveArchive(files) {
    const encoder = new TextEncoder();
    const parts = [];
    let total = ARCHIVE_MAGIC.length + 4;
    for (const file of files) {
      const path = encoder.encode(file.path);
      if (path.length > 0xFFFF) throw new PlayerError('save-path', file.path);
      parts.push([path, file.data]);
      total += 2 + path.length + 4 + file.data.length;
    }
    if (total > MAX_ARCHIVE_BYTES) throw new PlayerError('save-too-large', String(total));
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    out.set(ARCHIVE_MAGIC, 0);
    let p = ARCHIVE_MAGIC.length;
    view.setUint32(p, files.length, true); p += 4;
    for (const [path, data] of parts) {
      view.setUint16(p, path.length, true); p += 2;
      out.set(path, p); p += path.length;
      view.setUint32(p, data.length, true); p += 4;
      out.set(data, p); p += data.length;
    }
    return out;
  }

  /** 解不开（magic、长度、路径不对）一律抛错：坏存档宁可不写，也不能往虚拟盘里写半份 */
  function decodeSaveArchive(bytes) {
    if (!bytes || bytes.length < ARCHIVE_MAGIC.length + 4) throw new PlayerError('save-corrupt', 'short');
    for (let i = 0; i < ARCHIVE_MAGIC.length; i++) {
      if (bytes[i] !== ARCHIVE_MAGIC[i]) throw new PlayerError('save-corrupt', 'magic');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let p = ARCHIVE_MAGIC.length;
    const count = view.getUint32(p, true); p += 4;
    if (count > MAX_ARCHIVE_FILES) throw new PlayerError('save-corrupt', 'count');
    const files = [];
    const seen = new Set();
    for (let i = 0; i < count; i++) {
      if (p + 2 > bytes.length) throw new PlayerError('save-corrupt', 'truncated');
      const pathLength = view.getUint16(p, true); p += 2;
      if (p + pathLength + 4 > bytes.length) throw new PlayerError('save-corrupt', 'truncated');
      let path;
      try { path = decoder.decode(bytes.subarray(p, p + pathLength)); } catch { throw new PlayerError('save-corrupt', 'path'); }
      p += pathLength;
      const size = view.getUint32(p, true); p += 4;
      if (p + size > bytes.length) throw new PlayerError('save-corrupt', 'truncated');
      if (!isSafeRel(path) || seen.has(path.toLowerCase())) throw new PlayerError('save-corrupt', path);
      seen.add(path.toLowerCase());
      files.push({ path, data: bytes.slice(p, p + size) });
      p += size;
    }
    if (p !== bytes.length) throw new PlayerError('save-corrupt', 'trailing');
    return files;
  }

  // ---- 虚拟盘快照：路径 → 大小 + 修改时间（不读内容，存档时只读改过的文件） ----

  function mtimeOf(stat) {
    const t = stat.mtime;
    return t instanceof Date || (t && typeof t.getTime === 'function') ? t.getTime() : Number(t) || 0;
  }

  function snapshotDrives(FS, base = DRIVES) {
    const out = new Map();
    const walk = (dir, rel) => {
      let names;
      try { names = FS.readdir(dir); } catch { return; }
      for (const name of names) {
        if (name === '.' || name === '..') continue;
        const path = dir + '/' + name;
        const relPath = rel ? rel + '/' + name : name;
        let stat;
        try { stat = FS.stat(path); } catch { continue; }
        if (FS.isDir(stat.mode)) walk(path, relPath);
        else out.set(relPath, { size: stat.size, mtime: mtimeOf(stat) });
      }
    };
    for (const drive of ['c', 'e']) walk(base + '/' + drive, drive);
    return out;
  }

  /** 相对开局快照新增或改过（大小 / 修改时间不同）、且属于游戏进度的文件 */
  function changedSaveFiles(baseline, current) {
    const changed = [];
    for (const [path, info] of current) {
      if (!isSaveCandidate(path)) continue;
      const before = baseline.get(path);
      if (!before || before.size !== info.size || before.mtime !== info.mtime) changed.push(path);
    }
    return changed.sort();
  }

  function scanFor(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return 0;
    return KEYBOARD[event.code] || 0;
  }

  const api = {
    SCAN, KEYBOARD, PAD, PlayerError,
    detectGameKind, isSaveCandidate, isSafeRel, encodeSaveArchive, decodeSaveArchive, fetchCoreAsset,
    snapshotDrives, changedSaveFiles, scanFor,
  };
  root.EightBitGoSymbianPlayer = api;

  if (typeof document === 'undefined') return;

  // ---- 运行时接线（play.html） ----------------------------------------------

  const canvas = document.getElementById('canvas');
  let session = null; // { FS, baseline, uid, name }
  let coreBootPromise = null;
  const coreAborter = new AbortController();
  let coreActivity = () => {};
  let keyboardInstalled = false;
  const heldKeys = new Set();
  let geometryListener = null;
  let lastGeometry = '';

  /** SDL 在知道屏幕尺寸、以及旋转时会改 canvas 的 width/height：按比例铺满 iframe，并把新尺寸告诉站点 */
  function fitCanvas() {
    if (!canvas) return;
    const bw = canvas.width || 176;
    const bh = canvas.height || 208;
    let scale = Math.min(root.innerWidth / bw, root.innerHeight / bh);
    if (!isFinite(scale) || scale <= 0) scale = 1;
    canvas.style.width = Math.max(1, Math.floor(bw * scale)) + 'px';
    canvas.style.height = Math.max(1, Math.floor(bh * scale)) + 'px';
    const key = bw + 'x' + bh;
    if (session && geometryListener && key !== lastGeometry && bw >= 64 && bh >= 64) {
      lastGeometry = key;
      try { geometryListener({ width: bw, height: bh }); } catch { /* 站点那边拆了 */ }
    }
  }
  if (canvas) {
    root.addEventListener('resize', fitCanvas);
    new MutationObserver(fitCanvas).observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
  }

  /** /eka2l1 不挂 IDBFS：本局数据只在内存里，关页即弃，不碰 /symbian 程序库的 IndexedDB */
  function useMemoryStorage() {
    const factory = root.createEKA2L1Module;
    if (typeof factory !== 'function' || factory.__8bitgoMemory) return typeof factory === 'function';
    const wrapped = function (options) {
      const nativeFetch = root.fetch;
      const originalFetch = (input, init) => nativeFetch.call(root, input, init);
      const isCoreAsset = (input, suffix) => {
        try {
          const value = typeof input === 'string' ? input : input && input.url;
          const url = new URL(value, root.location.href);
          return url.origin === root.location.origin && url.pathname.endsWith(suffix);
        } catch { return false; }
      };
      const moduleOptions = Object.assign({}, options);
      const assetSizes = root.EKA2L1_ASSET_SIZES || {};
      const assetIntegrity = root.EKA2L1_ASSET_INTEGRITY || {};
      const expectedDataBytes = Number(assetSizes.data);
      const expectedWasmBytes = Number(assetSizes.wasm);
      if (!Number.isSafeInteger(expectedDataBytes) || expectedDataBytes <= 0 || expectedDataBytes > MAX_CORE_DATA_BYTES
        || !Number.isSafeInteger(expectedWasmBytes) || expectedWasmBytes <= 0 || expectedWasmBytes > MAX_CORE_WASM_BYTES) {
        return Promise.reject(assetError('EKA2L1 核心资源大小清单缺失或无效', false));
      }
      if (!/^[a-f0-9]{64}$/.test(String(assetIntegrity.data || '')) || !/^[a-f0-9]{64}$/.test(String(assetIntegrity.wasm || ''))) {
        return Promise.reject(assetError('EKA2L1 核心资源 SHA-256 清单缺失或无效', false));
      }
      const locateFile = typeof moduleOptions.locateFile === 'function'
        ? moduleOptions.locateFile
        : (path, prefix) => (prefix || '') + path;
      const dataUrl = new URL(locateFile('eka2l1.data', ''), root.location.href).href;
      const wasmUrl = new URL(locateFile('eka2l1.wasm', ''), root.location.href).href;
      // 两份核心文件并行取回；wasm 下载期间，data 完整性校验通过后再同步交给 Emscripten。
      const dataPromise = fetchCoreAsset(originalFetch, dataUrl, {
        expectedBytes: expectedDataBytes, expectedSha256: assetIntegrity.data,
        maxBytes: MAX_CORE_DATA_BYTES, signal: coreAborter.signal,
        onChunk: () => coreActivity(),
      });
      // 转成结果联合类型，避免 wasm 快速失败而 data 仍在下载时产生未处理拒绝。
      const wasmPromise = fetchCoreAsset(originalFetch, wasmUrl, {
        expectedBytes: expectedWasmBytes, expectedSha256: assetIntegrity.wasm,
        maxBytes: MAX_CORE_WASM_BYTES, signal: coreAborter.signal,
        onChunk: () => coreActivity(),
      }).then((result) => ({ result }), (error) => ({ error }));
      moduleOptions.getPreloadedPackage = function (url, size) {
        if (!isCoreAsset(url, '/eka2l1.data')) return null;
        if (Number(size) !== expectedDataBytes || !preloadedData) {
          throw assetError('EKA2L1 data 预加载长度与运行时清单不一致', false);
        }
        // 上游胶水在同步调用点检查 ArrayBuffer，不能返回 Promise。
        return preloadedData.buffer;
      };
      const guardedFetch = function (input, init) {
        if (!isCoreAsset(input, '/eka2l1.wasm')) return originalFetch(input, init);
        return wasmPromise.then(({ result, error }) => {
          if (error) throw error;
          const headers = new Headers(result.contentType ? [['content-type', result.contentType]] : []);
          if (!headers.has('content-type')) headers.set('content-type', 'application/wasm');
          return new Response(result.bytes.buffer, { status: 200, headers });
        });
      };
      root.fetch = guardedFetch;
      let preloadedData;
      const restoreFetch = () => {
        if (root.fetch === guardedFetch) root.fetch = nativeFetch;
      };
      return dataPromise.then((result) => {
        preloadedData = result.bytes;
        return factory(moduleOptions);
      }).then((mod) => {
        restoreFetch();
        const mount = mod.FS.mount;
        mod.FS.mount = function (type, opts, mountpoint) {
          // 根文件系统本来就是 MEMFS：不挂就等于挂了一块内存盘；syncfs 对它是空操作
          if (mountpoint === '/eka2l1') return null;
          return mount.call(mod.FS, type, opts, mountpoint);
        };
        return mod;
      }, (error) => {
        restoreFetch();
        throw error;
      });
    };
    wrapped.__8bitgoMemory = true;
    root.createEKA2L1Module = wrapped;
    return true;
  }

  function prepare(onActivity) {
    if (typeof onActivity === 'function') coreActivity = onActivity;
    if (coreBootPromise) return coreBootPromise;
    const E = root.EKA2L1;
    if (!E || !useMemoryStorage()) return Promise.reject(new PlayerError('runtime-missing', '', 'runtime'));
    const env = E.environmentProblem && E.environmentProblem();
    if (env) return Promise.reject(new PlayerError('environment', env, 'config'));
    coreBootPromise = Promise.resolve().then(() => E.boot({ canvas }));
    return coreBootPromise;
  }

  function sendKey(scan, down) {
    if (!session || !scan) return;
    try { root.EKA2L1.sendKey(scan, down ? 1 : 0); } catch { /* 核心退出后忽略 */ }
  }

  function releaseAll() {
    for (const scan of heldKeys) sendKey(scan, false);
    heldKeys.clear();
  }

  function installKeyboard() {
    if (keyboardInstalled) return;
    keyboardInstalled = true;
    // 捕获阶段接管：映射过的键不再往下传，免得 SDL 自己再按一次；没映射的键照常交给页面
    root.addEventListener('keydown', (event) => {
      const scan = scanFor(event);
      if (!scan) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat || heldKeys.has(scan)) return;
      heldKeys.add(scan);
      sendKey(scan, true);
    }, true);
    root.addEventListener('keyup', (event) => {
      const scan = scanFor(event) || KEYBOARD[event.code];
      if (!scan) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!heldKeys.delete(scan)) return;
      sendKey(scan, false);
    }, true);
    root.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
  }

  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  function installErrorText(code) {
    try { return root.EKA2L1.decodeInstallError(code) || String(code); } catch { return String(code); }
  }

  async function launch(uid, onStage) {
    const E = root.EKA2L1;
    const before = E.redrawCount ? E.redrawCount() : 0;
    let result = -999;
    // -100 / -101：应用列表或启动服务还没就绪（程序库的 run.js 同样会让核心继续跑再重试）
    for (let attempt = 0; attempt < 20; attempt++) {
      result = E.launchApp(uid);
      if (result !== -100 && result !== -101) break;
      E.setPaused(false);
      onStage('launch', { attempt: attempt + 1 });
      await sleep(1000);
    }
    if (result !== 0) throw new PlayerError('launch-failed', String(result));
    E.setPaused(false);
    const started = performance.now();
    let hiddenSince = document.hidden ? started : 0;
    let hiddenTotal = 0;
    for (;;) {
      const exited = E.lastAppExit && E.lastAppExit();
      if (exited) {
        throw new PlayerError('app-exited', (exited.name || '?') + ' ' + (exited.category || '?') + ' ' + exited.reason);
      }
      if (E.redrawCount && E.redrawCount() > before) return;
      const now = performance.now();
      // 只数前台时间：窗口在后台时浏览器会停掉帧循环，核心根本跑不动
      if (document.hidden) { if (!hiddenSince) hiddenSince = now; } else if (hiddenSince) { hiddenTotal += now - hiddenSince; hiddenSince = 0; }
      const foreground = now - started - hiddenTotal - (hiddenSince ? now - hiddenSince : 0);
      if (foreground > FIRST_FRAME_TIMEOUT_MS) throw new PlayerError('first-frame-timeout', '');
      onStage('first-frame', { elapsed: Math.round(foreground) });
      await sleep(250);
    }
  }

  function restoreSave(FS, archive) {
    if (!archive || !archive.length) return 0;
    const files = decodeSaveArchive(archive);
    for (const file of files) {
      const path = DRIVES + '/' + file.path;
      FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
      FS.writeFile(path, file.data);
    }
    return files.length;
  }

  /**
   * opts: { firmware: ArrayBuffer, game: ArrayBuffer, gameName, save?: Uint8Array, onStage(stage, info) }
   * 成功返回 { uid, name, width, height, restored }；失败抛 PlayerError（带 scope）。
   */
  async function start(opts) {
    if (session) throw new PlayerError('already-started', '');
    const onStage = typeof opts.onStage === 'function' ? opts.onStage : () => {};
    const E = root.EKA2L1;
    if (!E) throw new PlayerError('runtime-missing', '', 'runtime');
    const env = E.environmentProblem && E.environmentProblem();
    if (env) throw new PlayerError('environment', env, 'config');

    let gameBytes = new Uint8Array(opts.game);
    const assetConsumed = (asset) => {
      if (typeof opts.onAssetConsumed === 'function') {
        try { opts.onAssetConsumed(asset); } catch { /* 释放通知不能中断游戏安装 */ }
      }
      if (asset === 'game') {
        gameBytes = null;
        opts.game = new ArrayBuffer(0);
      } else if (asset === 'firmware') {
        opts.firmware = new ArrayBuffer(0);
      }
    };
    const kind = detectGameKind(gameBytes);
    if (kind === 'sisx') throw new PlayerError('needs-s60v3', '', 'config');
    if (kind === 'unknown') throw new PlayerError('unknown-package', '', 'content');

    onStage('boot', { pct: 0 });
    await prepare();
    const FS = E.module.FS;
    try { E.applyPerfPrefs(); } catch { /* 偏好读不到就用核心默认值 */ }

    let uid = 0;
    let name = '';
    if (kind === 'card') {
      onStage('install', { kind });
      const card = root.EightBitGoNgageCard;
      if (!card) throw new PlayerError('runtime-missing', 'card', 'runtime');
      try {
        const result = await card.installCard(new Blob([gameBytes]), { FS, savePaths: async () => {} });
        uid = result.plan.appUid;
        name = result.plan.title;
        assetConsumed('game');
      } catch (err) {
        throw new PlayerError('card-invalid', (err && (err.code || err.message)) || String(err), 'content');
      }
    }

    onStage('device', {});
    FS.writeFile(ROM_STAGING, new Uint8Array(opts.firmware), { canOwn: true });
    await sleep(30); // 下面是几秒的同步调用，先让出一帧把进度画出去
    const device = E.initDevice(ROM_STAGING, '');
    try { FS.unlink(ROM_STAGING); } catch { /* 安装器已经拷走 ROM */ }
    assetConsumed('firmware');
    if (device !== 0) throw new PlayerError('device-failed', installErrorText(device), 'config');

    if (kind === 'sis') {
      onStage('install', { kind });
      const before = new Set(E.appList().map((app) => app.uid >>> 0));
      FS.writeFile(SIS_STAGING, gameBytes);
      const installed = E.installPackage(SIS_STAGING);
      try { FS.unlink(SIS_STAGING); } catch { /* ignore */ }
      assetConsumed('game');
      if (installed !== 0) throw new PlayerError('install-failed', installErrorText(installed), 'content');
      const fresh = E.appList().filter((app) => !before.has(app.uid >>> 0) && !app.sys);
      if (!fresh.length) throw new PlayerError('no-app', '', 'content');
      uid = fresh[0].uid >>> 0;
      name = fresh[0].name || '';
    }
    if (!uid) throw new PlayerError('no-app', '', 'content');
    const listed = E.appList().find((app) => (app.uid >>> 0) === uid);
    if (!listed) throw new PlayerError('no-app', '0x' + uid.toString(16), 'content');
    name = listed.name || name;

    // 先记快照再写回存档：写回的文件修改时间晚于快照，下次存档会原样带上
    const baseline = snapshotDrives(FS);
    let restored = 0;
    try { restored = restoreSave(FS, opts.save); } catch (err) {
      console.warn('[8BitGo] 塞班存档写不回去，本局从头开始：', err);
    }

    session = { FS, baseline, uid, name };
    geometryListener = typeof opts.onGeometry === 'function' ? opts.onGeometry : null;
    installKeyboard();
    onStage('launch', { uid });
    await launch(uid, onStage);
    fitCanvas();
    try { canvas.focus({ preventScroll: true }); } catch { /* ignore */ }
    const sane = canvas.width >= 64 && canvas.height >= 64;
    return { uid, name, width: sane ? canvas.width : 176, height: sane ? canvas.height : 208, restored };
  }

  /** 相对开局快照改过的游戏文件打成一个包；没有改动返回 null */
  function saveArchive() {
    if (!session) return null;
    const { FS, baseline } = session;
    const paths = changedSaveFiles(baseline, snapshotDrives(FS));
    if (!paths.length) return null;
    return encodeSaveArchive(paths.map((path) => ({ path, data: FS.readFile(DRIVES + '/' + path) })));
  }

  root.EightBitGoSymbianPlayer = Object.assign(api, {
    prepare,
    cancelBoot() { coreAborter.abort(); releaseAll(); },
    start,
    saveArchive,
    canvas,
    started: () => Boolean(session),
    setPaused(paused) { if (session) root.EKA2L1.setPaused(Boolean(paused)); if (paused) releaseAll(); },
    setVolume(volume) { if (session) root.EKA2L1.setVolume(Math.round(Math.max(0, Math.min(1, volume)) * 100)); },
    pressPad(button, down) {
      const scan = PAD[button];
      if (!scan) return;
      if (down) heldKeys.add(scan); else heldKeys.delete(scan);
      sendKey(scan, down);
    },
    releaseAll,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
