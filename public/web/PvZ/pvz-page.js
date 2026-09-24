"use strict";

/*
 * PvZ Portable 的浏览器外壳。
 *
 * 上游把这段逻辑分别内联在中英文 HTML 里，修复很容易只落到其中一份。
 * 8BitGo 改成两种语言共用这一份文件，让资源导入、存档和退出处理保持一致。
 */

const collectedFiles = new Map();
const collectedBundles = [];

let hasPak = false;
let hasProperties = false;
let savesMounted = false;
let gameStarted = false;
let startGameInFlight = false;
let saveSyncIntervalId = null;
let saveSyncInFlight = null;
let saveSyncQueued = false;
let lastSaveSyncAt = 0;
let saveFsReadyPromise = null;
let runtimeReloadScheduled = false;

const MB = 1024 * 1024;
const SAVE_SYNC_INTERVAL_MS = 5000;
const SAVE_CLOSE_WARNING_MS = 7000;
const MODULE_READY_TIMEOUT_MS = 120000;
const EXIT_SAVE_TIMEOUT_MS = 10000;
const RESOURCE_IMPORT_LIMITS = { maxArchive: 256 * MB, maxExpanded: 384 * MB, maxFile: 160 * MB, maxFiles: 10000 };
const SAVE_IMPORT_LIMITS = { maxArchive: 64 * MB, maxExpanded: 128 * MB, maxFile: 32 * MB, maxFiles: 4096 };
const SAVE_BRIDGE_SOURCE = "8bitgo-save-bridge";
const SAVE_BRIDGE_VERSION = 1;

const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const browseFolderBtn = document.getElementById("browse-folder-btn");
const browseZipBtn = document.getElementById("browse-zip-btn");
const resourceZipInput = document.getElementById("resource-zip-input");
const fileListDiv = document.getElementById("file-list");
const loadStatus = document.getElementById("loading-drop-zone");
const uploadSaveImportBtn = document.getElementById("upload-save-import-btn");
const uploadSaveImportDirBtn = document.getElementById("upload-save-import-dir-btn");
const uploadSaveClearBtn = document.getElementById("upload-save-clear-btn");
const uploadSaveImportInput = document.getElementById("upload-save-import-input");
const uploadSaveImportDirInput = document.getElementById("upload-save-import-dir-input");
const saveExportBtn = document.getElementById("save-export-btn");
const saveImportBtn = document.getElementById("save-import-btn");
const saveImportInput = document.getElementById("save-import-input");
const reselectLink = document.getElementById("reselect-link");
const gameCanvas = document.getElementById("canvas");
const canvasContainer = document.getElementById("canvas-container");
const softKeyboardInput = document.getElementById("pvz-soft-keyboard");

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms);
    Promise.resolve(promise).then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      (error) => { window.clearTimeout(timer); reject(error); },
    );
  });
}

function cleanPathSegments(value) {
  if (typeof value !== "string" || value.includes("\0") || value.length > 1024) return null;
  const parts = value.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === ".." || part.length > 255)) return null;
  return parts;
}

function normalizeResourcePath(value) {
  const parts = cleanPathSegments(value);
  if (!parts) return "";
  const roots = new Set(["main.pak", "properties", "reanim", "images", "sounds", "music", "particles", "props", "waves"]);
  const rootIndex = parts.findIndex((part) => roots.has(part));
  if (rootIndex >= 0) return parts.slice(rootIndex).join("/");
  return parts.length > 1 ? parts.slice(1).join("/") : parts[0];
}

function normalizeSaveImportPath(value) {
  const parts = cleanPathSegments(value);
  if (!parts) return "";
  const userDataIndex = parts.indexOf("userdata");
  const relative = userDataIndex >= 0 ? parts.slice(userDataIndex + 1) : (parts.length > 1 ? parts.slice(1) : parts);
  return relative.join("/");
}

function ensureDirectory(path) {
  try {
    Module.FS.mkdir(path);
    return;
  } catch (error) {
    // mkdir 的 EEXIST 不能和权限、只读文件系统等错误一起吞掉，否则存档会静默丢失。
    try {
      const stat = Module.FS.stat(path);
      if (Module.FS.isDir(stat.mode)) return;
    } catch {}
    throw error;
  }
}

function ensureParentDirectories(path) {
  const parts = path.split("/");
  let current = "";
  for (let i = 1; i < parts.length - 1; i++) {
    if (!parts[i]) continue;
    current += "/" + parts[i];
    ensureDirectory(current);
  }
}

function byteLengthOf(value) {
  return value instanceof Uint8Array ? value.byteLength : Number(value && value.size) || 0;
}

async function readBytes(value) {
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(await value.arrayBuffer());
}

async function unpackPvzBundle(bundle, progressStart, progressTotal) {
  if (typeof DecompressionStream !== "function") throw new Error("当前浏览器不支持 gzip 流式解包，请升级浏览器");
  const bytes = bundle.bytes;
  const meta = bundle.meta;
  const stream = new DecompressionStream("gzip");
  const writer = stream.writable.getWriter();
  // 写入和读取必须并行；先把 50MB 全写完会被流的背压锁住。
  const pumpInput = (async () => {
    const chunkSize = 256 * 1024;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      await writer.write(bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize)));
    }
    await writer.close();
  })();
  const reader = stream.readable.getReader();
  const chunks = [];
  let available = 0;
  let ended = false;

  async function fill(size) {
    while (available < size && !ended) {
      const result = await reader.read();
      if (result.done) { ended = true; break; }
      chunks.push({ bytes: result.value, offset: 0 });
      available += result.value.byteLength;
    }
  }
  async function take(size) {
    await fill(size);
    if (available < size) throw new Error("PvZ 数据包被截断");
    const out = new Uint8Array(size);
    let written = 0;
    while (written < size) {
      const head = chunks[0];
      const amount = Math.min(size - written, head.bytes.byteLength - head.offset);
      out.set(head.bytes.subarray(head.offset, head.offset + amount), written);
      written += amount;
      head.offset += amount;
      available -= amount;
      if (head.offset === head.bytes.byteLength) chunks.shift();
    }
    return out;
  }

  const magic = new TextDecoder("ascii").decode(await take(7));
  if (magic !== "8BPVZ1\n") throw new Error("PvZ 数据包 magic 不匹配");
  const lengthBytes = await take(4);
  const headerLength = new DataView(lengthBytes.buffer, lengthBytes.byteOffset, 4).getUint32(0, true);
  if (!headerLength || headerLength > 4 * MB) throw new Error("PvZ 数据包索引长度异常");
  let header;
  try { header = JSON.parse(new TextDecoder().decode(await take(headerLength))); }
  catch (error) { throw new Error("PvZ 数据包索引损坏：" + error.message); }

  if (header.format !== "8bitgo.pvz.gzip-pack.v1" || !Array.isArray(header.files) ||
      header.fileCount !== meta.fileCount || header.files.length !== meta.fileCount ||
      header.unpackedBytes !== meta.unpackedBytes) {
    throw new Error("PvZ 数据包索引与清单不匹配");
  }
  const seen = new Set();
  let declaredTotal = 0;
  for (const item of header.files) {
    const parts = cleanPathSegments(item.path);
    if (!parts || parts[0] !== "reanim" || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > RESOURCE_IMPORT_LIMITS.maxFile) {
      throw new Error("PvZ 数据包含无效条目：" + String(item.path));
    }
    const path = parts.join("/");
    if (seen.has(path)) throw new Error("PvZ 数据包路径重复：" + path);
    seen.add(path);
    item.path = path;
    declaredTotal += item.size;
  }
  if (declaredTotal !== meta.unpackedBytes) throw new Error("PvZ 数据包解包长度与清单不匹配");

  let unpacked = 0;
  let yieldBytes = 0;
  for (const item of header.files) {
    const fileBytes = await take(item.size);
    ensureParentDirectories("/" + item.path);
    Module.FS.writeFile("/" + item.path, fileBytes);
    unpacked += item.size;
    yieldBytes += item.size;
    if (window.__pvzSetProgress) window.__pvzSetProgress((progressStart + unpacked) / progressTotal);
    if (yieldBytes >= 4 * MB) {
      yieldBytes = 0;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  }
  await fill(1);
  if (available !== 0) throw new Error("PvZ 数据包尾部含未声明数据");
  await pumpInput;
  return progressStart + unpacked;
}

function mergeFiles(target, source) {
  for (const [path, file] of source) target.set(path, file);
}

function checkSelectionLimits(files, limits, label) {
  if (files.length > limits.maxFiles) throw new Error(label + "文件过多（最多 " + limits.maxFiles + " 个）");
  let total = 0;
  for (const file of files) {
    const size = byteLengthOf(file);
    if (size > limits.maxFile) throw new Error(label + "单个文件过大：" + file.name);
    total += size;
    if (total > limits.maxExpanded) throw new Error(label + "总大小超过 " + Math.round(limits.maxExpanded / MB) + " MB");
  }
}

function inspectZip(zip, limits, normalize, label) {
  const entries = [];
  let total = 0;
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (entry.dir) continue;
    if (entries.length >= limits.maxFiles) throw new Error(label + "文件过多（最多 " + limits.maxFiles + " 个）");

    // JSZip 3.8+ 会清理 ../，但仍保留 unsafeOriginalName；继续校验原名才能真正挡住目录穿越包。
    const originalName = entry.unsafeOriginalName || name;
    const path = normalize(originalName);
    if (!path) throw new Error(label + "包含不安全或无效路径：" + originalName);

    const declared = Number(entry._data && entry._data.uncompressedSize);
    if (Number.isFinite(declared)) {
      if (declared > limits.maxFile) throw new Error(label + "单个文件解压后过大：" + originalName);
      total += declared;
      if (total > limits.maxExpanded) throw new Error(label + "解压后超过 " + Math.round(limits.maxExpanded / MB) + " MB");
    }
    entries.push({ entry, path, originalName, declared });
  }
  if (!entries.length) throw new Error(label + "中没有可导入的文件");
  return entries;
}

async function traverseEntry(entry, parent, target, state) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    const path = normalizeResourcePath(parent ? parent + "/" + entry.name : entry.name);
    if (!path) throw new Error("资源目录包含不安全路径：" + entry.name);
    state.count++;
    state.bytes += file.size;
    if (state.count > RESOURCE_IMPORT_LIMITS.maxFiles || file.size > RESOURCE_IMPORT_LIMITS.maxFile || state.bytes > RESOURCE_IMPORT_LIMITS.maxExpanded) {
      throw new Error("资源目录过大或文件过多");
    }
    target.set(path, file);
    return;
  }
  if (!entry.isDirectory) return;
  const nextParent = parent ? parent + "/" + entry.name : entry.name;
  const reader = entry.createReader();
  let batch;
  do {
    batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    for (const child of batch) await traverseEntry(child, nextParent, target, state);
  } while (batch.length > 0);
}

function handleFileList(files) {
  const list = Array.from(files || []);
  checkSelectionLimits(list, RESOURCE_IMPORT_LIMITS, "资源目录");
  const pending = new Map();
  for (const file of list) {
    const path = normalizeResourcePath(file.webkitRelativePath || file.name);
    if (!path) throw new Error("资源目录包含不安全路径：" + file.name);
    pending.set(path, file);
  }
  mergeFiles(collectedFiles, pending);
}

async function importResourceZip(file, button) {
  button.disabled = true;
  const oldHtml = button.innerHTML;
  button.textContent = "⏳ Importing ZIP…";
  try {
    if (file.size > RESOURCE_IMPORT_LIMITS.maxArchive) throw new Error("ZIP 超过 256 MB，拒绝在浏览器中解压");
    const zip = await JSZip.loadAsync(file);
    const entries = inspectZip(zip, RESOURCE_IMPORT_LIMITS, normalizeResourcePath, "资源 ZIP");
    const pending = new Map();
    let actualTotal = 0;
    for (const item of entries) {
      const bytes = await item.entry.async("uint8array");
      actualTotal += bytes.byteLength;
      if (bytes.byteLength > RESOURCE_IMPORT_LIMITS.maxFile || actualTotal > RESOURCE_IMPORT_LIMITS.maxExpanded) {
        throw new Error("资源 ZIP 解压后超过安全上限");
      }
      pending.set(item.path, bytes);
    }
    mergeFiles(collectedFiles, pending);
  } catch (error) {
    console.error("Resource ZIP import failed:", error);
    alert("Resource ZIP import failed: " + error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = oldHtml;
  }
}

function refreshUI() {
  hasPak = collectedFiles.has("main.pak");
  hasProperties = false;
  for (const path of collectedFiles.keys()) {
    if (path.startsWith("properties/")) { hasProperties = true; break; }
  }
  const ready = hasPak && hasProperties;
  const hasAny = collectedFiles.size > 0;
  fileListDiv.innerHTML = "";
  if (hasAny) {
    const add = (name, ok) => {
      const item = document.createElement("div");
      item.textContent = (ok ? "✓ " : "✗ ") + name;
      item.className = ok ? "ok" : "missing";
      fileListDiv.appendChild(item);
    };
    add("main.pak", hasPak);
    add("properties/", hasProperties);
  }
  fileListDiv.classList.toggle("has-items", hasAny);
  dropZone.classList.toggle("ready", ready);
  if (ready) {
    dropZone.setAttribute("tabindex", "0");
    dropZone.setAttribute("role", "button");
    dropZone.setAttribute("aria-label", "Start Game");
  } else {
    dropZone.removeAttribute("tabindex");
    dropZone.removeAttribute("role");
    dropZone.removeAttribute("aria-label");
  }
}

function handleDropZoneActivate(event) {
  if (!dropZone.classList.contains("ready")) return;
  if (event.target.closest("#drop-zone-reselect") || event.target.closest("#file-list")) return;
  void startGame();
}

function resizeCanvas() {
  const scale = Math.min(canvasContainer.clientWidth / gameCanvas.width, canvasContainer.clientHeight / gameCanvas.height);
  gameCanvas.style.width = Math.floor(gameCanvas.width * scale) + "px";
  gameCanvas.style.height = Math.floor(gameCanvas.height * scale) + "px";
}

/**
 * iOS 只允许在一次真实点击的同步调用栈里弹出软键盘。游戏先把触摸放进 SDL 队列，
 * 下一帧才调用 WasmStartSoftKeyboard；那时 input.focus() 已经失去用户授权，Safari 会静默拒绝。
 * 这里不猜游戏画面的坐标：等 WASM 明确进入文字输入状态后，再让玩家点画布或辅助按钮，
 * 并在这次可信手势里同步 focus。这样普通种植物、铲除等触摸不会误弹键盘。
 */
function installMobileSoftKeyboardAssist() {
  if (!softKeyboardInput || !gameCanvas || !canvasContainer) return () => {};

  const coarsePointer = typeof window.matchMedia === "function" ? window.matchMedia("(pointer: coarse)") : null;
  const isTouchDevice = () => navigator.maxTouchPoints > 0 || Boolean(coarsePointer && coarsePointer.matches);
  const chinese = (window.PVZ_LOCALE || document.documentElement.lang || "").toLowerCase().startsWith("zh");

  // opacity 不能是 0：部分 iOS 版本会把完全不可见的表单控件判定为不可交互并拒绝弹键盘。
  // 1px + pointer-events:none 让它仍属于可聚焦布局，同时不会盖住 Canvas 的任何触摸区域。
  softKeyboardInput.setAttribute("aria-label", chinese ? "植物大战僵尸文字输入" : "Plants vs. Zombies text input");
  softKeyboardInput.setAttribute("inputmode", "text");
  softKeyboardInput.style.cssText = [
    "position:fixed",
    "top:0",
    "left:50%",
    "width:1px",
    "height:1px",
    "padding:0",
    "border:0",
    "opacity:.01",
    "resize:none",
    "pointer-events:none",
    "font-size:16px",
    "color:transparent",
    "background:transparent",
    "caret-color:transparent",
    "transform:translateX(-50%)",
    "z-index:1",
  ].join(";");

  const keyboardButton = document.createElement("button");
  keyboardButton.id = "pvz-keyboard-btn";
  keyboardButton.type = "button";
  keyboardButton.hidden = true;
  keyboardButton.textContent = chinese ? "⌨️ 打开键盘" : "⌨️ Keyboard";
  keyboardButton.setAttribute("aria-label", chinese ? "打开文字输入键盘" : "Open the text input keyboard");
  keyboardButton.style.cssText = [
    "position:absolute",
    "left:max(8px,env(safe-area-inset-left))",
    "bottom:max(8px,env(safe-area-inset-bottom))",
    "z-index:12",
    "min-height:44px",
    "padding:0 14px",
    "border:1px solid #4ecca3",
    "border-radius:8px",
    "background:rgba(30,30,50,.88)",
    "color:#4ecca3",
    "font:600 16px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    "backdrop-filter:blur(4px)",
    "touch-action:manipulation",
  ].join(";");
  canvasContainer.appendChild(keyboardButton);

  // 桌面端原生键盘链路本来就正常，不挂触摸监听和轮询，避免给每个玩家增加无意义工作。
  if (!isTouchDevice()) return () => {};

  function keyboardRequested() {
    return Boolean(gameStarted && Module.wasmSoftKeyboardState && Module.wasmSoftKeyboardState.active);
  }

  function focusSoftKeyboard() {
    if (!isTouchDevice() || !keyboardRequested()) return false;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    try { softKeyboardInput.focus({ preventScroll: true }); }
    catch { softKeyboardInput.focus(); }
    // 老 iOS 不认识 preventScroll；还原页面位置，避免 1px 输入框把游戏画面推走。
    if (window.scrollX !== scrollX || window.scrollY !== scrollY) window.scrollTo(scrollX, scrollY);
    return document.activeElement === softKeyboardInput;
  }

  function refreshKeyboardButton() {
    const requested = isTouchDevice() && keyboardRequested();
    keyboardButton.hidden = !requested;
    keyboardButton.dataset.open = requested && document.activeElement === softKeyboardInput ? "true" : "false";
  }

  // capture 保证在 SDL 的触摸回调之前运行；只在引擎已经请求文字输入时接管焦点。
  gameCanvas.addEventListener("pointerdown", () => {
    if (keyboardRequested()) focusSoftKeyboard();
  }, { capture: true });
  // Canvas 带 tabindex，浏览器的 pointerdown 默认动作会把焦点抢回去；在手势结束时再校正一次。
  gameCanvas.addEventListener("pointerup", () => {
    if (keyboardRequested()) focusSoftKeyboard();
  }, { capture: true });
  // iOS 12 及更老版本没有 Pointer Events，保留 touchstart 兜底；重复 focus 是幂等的。
  gameCanvas.addEventListener("touchstart", () => {
    if (keyboardRequested()) focusSoftKeyboard();
  }, { capture: true, passive: true });
  gameCanvas.addEventListener("touchend", () => {
    if (keyboardRequested()) focusSoftKeyboard();
  }, { capture: true, passive: true });
  // 触摸设备还会合成 click；在这条最终的可信事件里聚焦，压过 Canvas 的默认聚焦行为。
  gameCanvas.addEventListener("click", () => {
    if (keyboardRequested()) focusSoftKeyboard();
  }, { capture: true });
  keyboardButton.addEventListener("click", () => {
    focusSoftKeyboard();
    refreshKeyboardButton();
  });
  softKeyboardInput.addEventListener("focus", refreshKeyboardButton);
  softKeyboardInput.addEventListener("blur", refreshKeyboardButton);

  // 文字输入状态由 WASM 在主循环里切换，无法用 DOM 事件观察；低频检查只在本页生命周期内运行。
  window.setInterval(refreshKeyboardButton, 150);
  refreshKeyboardButton();
  return refreshKeyboardButton;
}

const refreshMobileSoftKeyboard = installMobileSoftKeyboardAssist();

function canSyncSaves() {
  return savesMounted && Module.FS && typeof Module.FS.syncfs === "function";
}

async function ensureSaveFsReady() {
  if (saveFsReadyPromise) return saveFsReadyPromise;
  saveFsReadyPromise = (async () => {
    await withTimeout(window.moduleReadyPromise, MODULE_READY_TIMEOUT_MS, "WebAssembly 运行时加载超时");
    ensureDirectory("/saves");
    if (!savesMounted) {
      // 挂载失败必须阻止启动；继续运行后再把空目录写回去会覆盖玩家原有存档。
      Module.FS.mount(Module.FS.filesystems.IDBFS, {}, "/saves");
      savesMounted = true;
    }
    await new Promise((resolve, reject) => Module.FS.syncfs(true, (error) => error ? reject(error) : resolve()));
    lastSaveSyncAt = Date.now();
  })();
  try {
    return await saveFsReadyPromise;
  } catch (error) {
    saveFsReadyPromise = null;
    throw error;
  }
}

function persistSavesOnce() {
  return new Promise((resolve, reject) => {
    Module.FS.syncfs(false, (error) => {
      if (error) { reject(error); return; }
      lastSaveSyncAt = Date.now();
      resolve();
    });
  });
}

function syncSaves() {
  if (!canSyncSaves()) return Promise.resolve();
  saveSyncQueued = true;
  if (!saveSyncInFlight) {
    // while 循环把同步期间发生的第二次请求合并成最后一次写盘；调用方等待的是整条队列。
    saveSyncInFlight = (async () => {
      while (saveSyncQueued) {
        saveSyncQueued = false;
        await persistSavesOnce();
      }
    })().finally(() => { saveSyncInFlight = null; });
  }
  return saveSyncInFlight;
}

function startSaveAutosync() {
  if (saveSyncIntervalId !== null) return;
  saveSyncIntervalId = window.setInterval(() => {
    void syncSaves().catch((error) => console.warn("IDBFS persist error:", error));
  }, SAVE_SYNC_INTERVAL_MS);
}

async function startGame() {
  if (gameStarted || startGameInFlight) return;
  startGameInFlight = true;
  dropZone.classList.remove("ready");
  dropZone.classList.add("loading");
  dropZone.style.pointerEvents = "none";
  loadStatus.style.display = "block";
  loadStatus.classList.remove("has-error");
  try {
    refreshUI();
    if (!hasPak || !hasProperties) throw new Error("缺少 main.pak 或 properties/，无法启动");
    if (window.__pvzSetProgress) window.__pvzSetProgress(0);
    loadStatus.textContent = "";
    await withTimeout(window.moduleReadyPromise, MODULE_READY_TIMEOUT_MS, "WebAssembly 运行时加载超时");

    const entries = Array.from(collectedFiles.entries());
    const totalBytes = entries.reduce((sum, [, file]) => sum + byteLengthOf(file), 0) +
      collectedBundles.reduce((sum, bundle) => sum + bundle.meta.unpackedBytes, 0) || 1;
    let writtenBytes = 0;
    let yieldBytes = 0;
    for (const [path, file] of entries) {
      const size = byteLengthOf(file);
      if (window.__pvzSetProgress) window.__pvzSetProgress((writtenBytes + size) / totalBytes);
      const bytes = await readBytes(file);
      ensureParentDirectories("/" + path);
      Module.FS.writeFile("/" + path, bytes);
      writtenBytes += bytes.byteLength;
      yieldBytes += bytes.byteLength;
      // 写完立刻释放服务器资源的 Uint8Array，避免 main.pak 同时保留三份造成移动端 OOM。
      collectedFiles.delete(path);
      if (yieldBytes >= 4 * MB) {
        yieldBytes = 0;
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    }

    for (const bundle of collectedBundles) {
      writtenBytes = await unpackPvzBundle(bundle, writtenBytes, totalBytes);
      bundle.bytes = null;
    }
    collectedBundles.length = 0;

    if (window.__pvzSetProgress) window.__pvzSetProgress(1);
    await ensureSaveFsReady();
    document.body.classList.remove("upload-mode");
    document.body.classList.add("game-mode");
    document.getElementById("upload-screen").style.display = "none";
    document.getElementById("canvas-container").style.display = "flex";
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    loadStatus.style.display = "none";
    gameStarted = true;
    startSaveAutosync();
    gameCanvas.focus();
    refreshMobileSoftKeyboard();

    // 必须在资源写盘之后计时；慢设备写 70MB 可能超过 8 秒，提前计时会把开局崩溃误判成正常退出。
    window.__pvzStartTs = Date.now();
    Module.callMain([]);
  } catch (error) {
    console.error("Failed to start game:", error);
    collectedFiles.clear();
    collectedBundles.length = 0;
    loadStatus.textContent = "Error: " + (error.message || error);
    loadStatus.classList.add("has-error");
    document.getElementById("canvas-container").style.display = "none";
    document.getElementById("upload-screen").style.display = "";
    document.body.classList.remove("game-mode");
    document.body.classList.add("upload-mode");
    dropZone.classList.remove("loading");
    dropZone.style.pointerEvents = "";
    refreshUI();
  } finally {
    startGameInFlight = false;
  }
}

function collectSaveFiles(path) {
  const files = [];
  let names;
  try { names = Module.FS.readdir(path); } catch { return files; }
  for (const name of names) {
    if (name === "." || name === "..") continue;
    const child = path + "/" + name;
    const stat = Module.FS.stat(child);
    if (Module.FS.isDir(stat.mode)) files.push(...collectSaveFiles(child));
    else files.push(child);
  }
  return files;
}

/** 读档是“恢复快照”而不是合并目录；旧档多出来的文件必须一起移除，否则会串档。 */
function clearSaveTree(path, removeRoot) {
  let names;
  try { names = Module.FS.readdir(path); } catch { return; }
  for (const name of names) {
    if (name === "." || name === "..") continue;
    const child = path + "/" + name;
    const stat = Module.FS.stat(child);
    if (Module.FS.isDir(stat.mode)) clearSaveTree(child, true);
    else Module.FS.unlink(child);
  }
  if (removeRoot) Module.FS.rmdir(path);
}

async function buildSaveArchive() {
  await ensureSaveFsReady();
  await syncSaves();
  const files = collectSaveFiles("/saves/userdata");
  if (!files.length) throw new Error("No save data found.");
  const zip = new JSZip();
  for (const path of files) zip.file(path.replace(/^\/saves\//, ""), Module.FS.readFile(path));
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

async function exportSaves() {
  const button = saveExportBtn;
  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = "⏳ Exporting…";
  try {
    const bytes = await buildSaveArchive();
    const blob = new Blob([bytes], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "pvz-portable-savedata.zip";
    anchor.click();
    // Firefox 可能在 click 返回后才真正读取 URL，立即 revoke 会得到空下载。
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    console.error("Export failed:", error);
    alert("Export failed: " + error.message);
  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}

async function applySaveArchive(input) {
  await ensureSaveFsReady();
  if (byteLengthOf(input) > SAVE_IMPORT_LIMITS.maxArchive) throw new Error("存档 ZIP 超过 64 MB");
  const zip = await JSZip.loadAsync(input);
  const entries = inspectZip(zip, SAVE_IMPORT_LIMITS, normalizeSaveImportPath, "存档 ZIP");
  const pending = [];
  let actualTotal = 0;
  for (const item of entries) {
    const bytes = await item.entry.async("uint8array");
    actualTotal += bytes.byteLength;
    if (bytes.byteLength > SAVE_IMPORT_LIMITS.maxFile || actualTotal > SAVE_IMPORT_LIMITS.maxExpanded) {
      throw new Error("存档 ZIP 解压后超过安全上限");
    }
    pending.push({ path: "/saves/userdata/" + item.path, bytes });
  }
  if (!pending.length) throw new Error("存档 ZIP 没有可读取的 userdata 文件");

  // 先在内存留一份旧档：写入或持久化失败时回滚，不能让“读取失败”反而毁掉现有进度。
  const previous = collectSaveFiles("/saves/userdata").map((path) => ({
    path,
    bytes: new Uint8Array(Module.FS.readFile(path)),
  }));
  try {
    clearSaveTree("/saves/userdata", false);
    for (const item of pending) {
      ensureParentDirectories(item.path);
      Module.FS.writeFile(item.path, item.bytes);
    }
    await syncSaves();
  } catch (error) {
    try {
      clearSaveTree("/saves/userdata", false);
      for (const item of previous) {
        ensureParentDirectories(item.path);
        Module.FS.writeFile(item.path, item.bytes);
      }
      await syncSaves();
    } catch (rollbackError) {
      console.error("Save rollback failed:", rollbackError);
    }
    throw error;
  }
}

async function importSaves(file, button) {
  button.disabled = true;
  const oldText = button.textContent;
  button.textContent = "⏳ Importing…";
  try {
    await applySaveArchive(file);
    return true;
  } catch (error) {
    console.error("Import failed:", error);
    alert("Import failed: " + error.message);
    return false;
  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}

/**
 * 8BitGo 模拟器窗口只拿一份 ZIP，不直接摸 PvZ 的虚拟文件系统；账号令牌也永远不进 iframe。
 * 单独打开本页时保留原来的下载行为，只有同源父窗口嵌入时才把按钮交给统一存档面板。
 */
function hasEightBitGoSaveHost() {
  if (window.parent === window) return false;
  try { return new URL(document.referrer).origin === location.origin; }
  catch { return false; }
}

function postSaveBridge(message, transfer) {
  window.parent.postMessage(
    Object.assign({ source: SAVE_BRIDGE_SOURCE, version: SAVE_BRIDGE_VERSION }, message),
    location.origin,
    transfer || [],
  );
}

function installSaveBridge() {
  if (!hasEightBitGoSaveHost()) return false;
  const chinese = (window.PVZ_LOCALE || document.documentElement.lang || "").toLowerCase().startsWith("zh");
  saveExportBtn.textContent = chinese ? "💾 保存存档" : "💾 Save";
  saveExportBtn.title = chinese ? "保存到云端、本浏览器或文件" : "Save to cloud, this browser, or a file";
  saveImportBtn.textContent = chinese ? "📂 读取存档" : "📂 Load";
  saveImportBtn.title = chinese ? "从云端、本浏览器或文件读取" : "Load from cloud, this browser, or a file";

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.source !== SAVE_BRIDGE_SOURCE || message.version !== SAVE_BRIDGE_VERSION ||
        !Number.isInteger(message.requestId)) return;
    if (message.type !== "export" && message.type !== "import") return;

    void (async () => {
      try {
        if (message.type === "export") {
          const bytes = await buildSaveArchive();
          const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          postSaveBridge({ type: "response", requestId: message.requestId, ok: true, data }, [data]);
          return;
        }
        if (!(message.data instanceof ArrayBuffer) || message.data.byteLength === 0) {
          throw new Error("导入的存档为空");
        }
        await applySaveArchive(new Uint8Array(message.data));
        postSaveBridge({ type: "response", requestId: message.requestId, ok: true });
      } catch (error) {
        postSaveBridge({
          type: "response",
          requestId: message.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });
  postSaveBridge({ type: "ready" });
  return true;
}

async function importSaveDirectory(files, button) {
  await ensureSaveFsReady();
  button.disabled = true;
  const oldText = button.textContent;
  button.textContent = "⏳ Importing…";
  try {
    const list = Array.from(files || []);
    checkSelectionLimits(list, SAVE_IMPORT_LIMITS, "存档目录");
    for (const file of list) {
      const relative = normalizeSaveImportPath(file.webkitRelativePath || file.name);
      if (!relative) throw new Error("存档目录包含不安全路径：" + file.name);
      const path = "/saves/userdata/" + relative;
      ensureParentDirectories(path);
      Module.FS.writeFile(path, new Uint8Array(await file.arrayBuffer()));
    }
    await syncSaves();
  } catch (error) {
    console.error("Save folder import failed:", error);
    alert("Save folder import failed: " + error.message);
  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}

async function clearSaves(button) {
  try {
    await ensureSaveFsReady();
  } catch (error) {
    alert("无法读取浏览器存档：" + error.message);
    return;
  }
  if (!confirm("This will permanently delete ALL save data from your browser.\nThis cannot be undone. Continue?")) return;
  button.disabled = true;
  const oldText = button.textContent;
  button.textContent = "⏳ Clearing…";
  try {
    for (const path of collectSaveFiles("/saves")) {
      try { Module.FS.unlink(path); } catch {}
    }
    function removeDirectories(path) {
      let names;
      try { names = Module.FS.readdir(path); } catch { return; }
      for (const name of names) {
        if (name === "." || name === "..") continue;
        const child = path + "/" + name;
        try {
          const stat = Module.FS.stat(child);
          if (Module.FS.isDir(stat.mode)) removeDirectories(child);
        } catch {}
      }
      if (path !== "/saves") {
        try { Module.FS.rmdir(path); } catch {}
      }
    }
    removeDirectories("/saves");
    await syncSaves();
    alert("All save data has been cleared.");
  } catch (error) {
    console.error("Clear failed:", error);
    alert("Clear failed: " + error.message);
  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}

function showRuntimeMessage(message, isError) {
  document.getElementById("canvas-container").style.display = "none";
  document.getElementById("upload-screen").style.display = "";
  document.body.classList.remove("game-mode");
  document.body.classList.add("upload-mode");
  loadStatus.textContent = message;
  loadStatus.classList.toggle("has-error", !!isError);
  loadStatus.style.display = "block";
}

async function handleGameExit(reason) {
  if (runtimeReloadScheduled) return;
  runtimeReloadScheduled = true;
  const hadStarted = gameStarted;
  gameStarted = false;
  if (saveSyncIntervalId !== null) {
    window.clearInterval(saveSyncIntervalId);
    saveSyncIntervalId = null;
  }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  window.removeEventListener("resize", resizeCanvas);
  dropZone.classList.remove("loading");
  dropZone.style.pointerEvents = "";
  collectedFiles.clear();
  collectedBundles.length = 0;
  fileInput.value = "";
  resourceZipInput.value = "";
  refreshUI();
  showRuntimeMessage("正在保存并重置 WebAssembly 运行时…", false);

  if (hadStarted) {
    try {
      await withTimeout(syncSaves(), EXIT_SAVE_TIMEOUT_MS, "存档写入超时");
    } catch (error) {
      console.error("Final save sync failed:", error);
      showRuntimeMessage("游戏已退出，但最新存档尚未写入浏览器（" + (error.message || error) + "）。请先不要刷新页面。", true);
      runtimeReloadScheduled = false;
      return;
    }
  }

  if (reason) {
    showRuntimeMessage("游戏引擎崩溃：" + reason + "。请检查资源完整性后手动刷新。", true);
    return;
  }

  const ranLongEnough = hadStarted && Date.now() - (window.__pvzStartTs || 0) > 8000;
  if (!ranLongEnough) {
    showRuntimeMessage("游戏异常退出：可能资源缺失或引擎崩溃，请确认 main.pak、properties/ 与 reanim/ 完整后手动刷新。", true);
    return;
  }

  // 守卫返回 false 时必须原地停下；旧代码用 `guard() || reload()`，实际绕过了防循环逻辑。
  if (window.__pvzGuardedReload) {
    if (!window.__pvzGuardedReload()) {
      showRuntimeMessage("游戏连续退出次数过多，已停止自动刷新。请检查资源完整性后手动刷新。", true);
    }
  } else {
    window.location.reload();
  }
}

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", async (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragover");
  try {
    const items = event.dataTransfer.items;
    if (!items) return;
    const entries = [];
    for (const item of items) {
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry) entries.push(entry);
    }
    const pending = new Map();
    const state = { count: 0, bytes: 0 };
    for (const entry of entries) {
      if (entry.isFile && entry.name && entry.name.toLowerCase().endsWith(".zip")) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        await importResourceZip(file, browseZipBtn);
      } else {
        await traverseEntry(entry, "", pending, state);
      }
    }
    mergeFiles(collectedFiles, pending);
  } catch (error) {
    console.error("Resource drop failed:", error);
    alert("Resource import failed: " + error.message);
  }
  refreshUI();
});

browseFolderBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  try { handleFileList(fileInput.files); } catch (error) { alert("Resource import failed: " + error.message); }
  refreshUI();
});
browseZipBtn.addEventListener("click", () => resourceZipInput.click());
resourceZipInput.addEventListener("change", async () => {
  const file = resourceZipInput.files && resourceZipInput.files[0];
  if (file) await importResourceZip(file, browseZipBtn);
  resourceZipInput.value = "";
  refreshUI();
});
dropZone.addEventListener("click", handleDropZoneActivate);
dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    handleDropZoneActivate(event);
  }
});
reselectLink.addEventListener("click", (event) => {
  event.stopPropagation();
  collectedFiles.clear();
  collectedBundles.length = 0;
  fileInput.value = "";
  resourceZipInput.value = "";
  refreshUI();
});

window.addEventListener("fullscreenchange", resizeCanvas);
const saveBridgeInstalled = installSaveBridge();
const saveToolbarChinese = (window.PVZ_LOCALE || document.documentElement.lang || "").toLowerCase().startsWith("zh");
if (!saveBridgeInstalled && saveToolbarChinese) {
  saveExportBtn.textContent = "💾 导出存档";
  saveExportBtn.title = "把当前存档导出为 ZIP 文件";
  saveImportBtn.textContent = "📂 读取存档";
  saveImportBtn.title = "从 ZIP 文件读取存档并重新启动游戏";
}
saveExportBtn.addEventListener("click", () => {
  if (saveBridgeInstalled) postSaveBridge({ type: "request-save" });
  else void exportSaves();
});
saveImportBtn.addEventListener("click", () => {
  if (saveBridgeInstalled) postSaveBridge({ type: "request-load" });
  else saveImportInput.click();
});
saveImportInput.addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  const imported = await importSaves(file, saveImportBtn);
  if (!imported) return;
  alert(saveToolbarChinese ? "存档读取成功，游戏将重新启动。" : "Save loaded. The game will now restart.");
  window.location.reload();
});
uploadSaveImportBtn.addEventListener("click", () => uploadSaveImportInput.click());
uploadSaveImportInput.addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (file) void importSaves(file, uploadSaveImportBtn);
  event.target.value = "";
});
uploadSaveImportDirBtn.addEventListener("click", () => uploadSaveImportDirInput.click());
uploadSaveImportDirInput.addEventListener("change", async (event) => {
  const files = event.target.files;
  if (files && files.length) await importSaveDirectory(files, uploadSaveImportDirBtn);
  event.target.value = "";
});
uploadSaveClearBtn.addEventListener("click", () => { void clearSaves(uploadSaveClearBtn); });

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void syncSaves().catch((error) => console.warn("IDBFS persist error:", error));
});
window.addEventListener("pagehide", () => {
  void syncSaves().catch((error) => console.warn("IDBFS persist error:", error));
});
window.addEventListener("beforeunload", (event) => {
  if (!gameStarted) return;
  void syncSaves().catch(() => {});
  if (saveSyncInFlight || Date.now() - lastSaveSyncAt >= SAVE_CLOSE_WARNING_MS) {
    event.preventDefault();
    event.returnValue = "Recent save data may still be syncing. Wait a moment or export saves before leaving.";
  }
});

// onAbort 在运行时初始化后再次触发时，原来的 Promise.reject 已经没有作用；显式显示崩溃原因，避免只剩黑屏。
const originalOnAbort = Module.onAbort;
Module.onAbort = function (reason) {
  if (originalOnAbort) originalOnAbort.call(Module, reason);
  if (gameStarted) void handleGameExit(String(reason || "unknown abort"));
};

window.onGameExit = function () { void handleGameExit(""); };
