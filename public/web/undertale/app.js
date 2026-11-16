const APP_VERSION = '2026.11.16.8'
const OPFS_ROOT = '8bitgo-undertale'
// 旧版固定写 library-v1；新版每次导入写独立目录，成功后才切换，失败或取消时旧副本照常可玩。
const LIBRARY_DIR = 'library-v1'
const LIBRARY_PREFIX = 'library-'
const STALE_IMPORT_MS = 6 * 60 * 60 * 1000
const MAX_IMPORT_FILES = 20000
// 资源直连授权分发主机；仅本站 HTTPS 主域与子域能启动远端分发。
const DISTRIBUTION_MANIFEST_URL = '/web/undertale/distribution-manifest.json'
const DISTRIBUTION_RESOURCE_BASE = 'https://html5.8bitgo.com/undertale/'
const DISTRIBUTION_ALLOWED_PAGE_ORIGINS = ['https://8bitgo.com', 'https://*.8bitgo.com']
// 每段 close() 后都会真正落进 OPFS；中断时下一次从已提交的文件长度继续取 Range。
const DISTRIBUTION_CHUNK_BYTES = 8 * 1024 * 1024
const DISTRIBUTION_CONCURRENCY = 4
// 运行端只读 WAD、外置音频和 included files；Windows/macOS 可执行文件与调试符号不会被打开，复制它们只是占用浏览器配额。
const SKIPPED_EXTENSIONS = new Set(['exe', 'dll', 'pdb', 'dylib', 'lib'])
const SKIPPED_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])
const SKIPPED_DIRS = new Set(['__macosx'])
const SAVE_DIR = 'saves'
const METADATA_KEY = '8bitgo.undertale.library.v1'
const WAD_NAMES = new Set(['data.win', 'game.unx', 'game.ios', 'game.droid'])
const REQUIRED_HEADROOM = 128 * 1024 * 1024

const $ = (selector) => document.querySelector(selector)
const launcher = $('#launcher')
const gameView = $('#game-view')
const canvas = $('#canvas')
const canvasStage = $('#canvas-stage')
const startAuthorizedButton = $('#start-authorized')
const selectFolderButton = $('#select-folder')
const startCachedButton = $('#start-cached')
const clearLibraryButton = $('#clear-library')
const folderInput = $('#folder-input')
const progressWrap = $('#progress-wrap')
const progress = $('#progress')
const progressLabel = $('#progress-label')
const progressValue = $('#progress-value')
const message = $('#message')
const stateDot = $('#state-dot')
const runtimeState = $('#runtime-state')
const gameStatus = $('#game-status')
const audioGate = $('#audio-gate')
const cancelImportButton = $('#cancel-import')
const importCard = $('#import-card')

let modulePromise
let moduleInstance
let activeRun
let inputController
let gamepadFrame
let importedMetadata
let importController
let distributionManifestPromise
const pressedKeys = new Set()
const gamepadKeys = new Set()

function setMessage(text, kind = '') {
  const visible = Boolean(text) && kind === 'error'
  message.hidden = !visible
  message.textContent = visible ? text : ''
  message.className = `message ${visible ? kind : ''}`.trim()
}

function setRuntimeState(text, kind = '') {
  runtimeState.textContent = text
  stateDot.className = `state-dot ${kind}`.trim()
}

function setBusy(busy) {
  const support = checkSupport().all
  startAuthorizedButton.disabled = busy || !support || !isDistributionOriginAllowed()
  selectFolderButton.disabled = busy || !support
  startCachedButton.disabled = busy
  clearLibraryButton.disabled = busy
}

function isDistributionOriginAllowed() {
  // R2 的通配来源不包含主域本身，也不允许自定义端口；代码侧保持同一边界。
  try {
    const pageOrigin = new URL(location.origin)
    const host = pageOrigin.hostname.toLowerCase()
    return pageOrigin.protocol === 'https:' && !pageOrigin.port &&
      (host === '8bitgo.com' || host.endsWith('.8bitgo.com'))
  } catch {
    return false
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`
}

let progressFrame = 0
let pendingProgress
function updateProgress(done, total) {
  pendingProgress = { done, total }
  if (progressFrame) return
  // 流式写入每个块都会回调；合并到下一帧再改 DOM，避免几千次小写入把主线程拖慢。
  progressFrame = requestAnimationFrame(() => {
    progressFrame = 0
    const { done: d, total: t } = pendingProgress
    const ratio = t > 0 ? Math.min(1, d / t) : 0
    const percent = Math.round(ratio * 100)
    progressWrap.hidden = false
    progress.value = percent
    progressLabel.textContent = '正在加载游戏'
    progressValue.textContent = `${percent}%`
  })
}

async function showCompletedProgress() {
  if (document.visibilityState !== 'visible') return
  // 先让满格状态绘制一帧，再切到游戏画布，避免下载结束时进度条直接消失。
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

function setSupport(check, ok, label) {
  const item = document.querySelector(`[data-check="${check}"]`)
  item.classList.toggle('ok', ok)
  item.classList.toggle('bad', !ok)
  item.querySelector('b').textContent = label
}

let supportResult
function checkSupport() {
  // 只探测一次：每次新建 WebGL 2 上下文会占用浏览器有限的上下文名额。
  if (supportResult) return supportResult
  const jspi = typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function'
  const opfs = typeof navigator.storage?.getDirectory === 'function'
  const probe = document.createElement('canvas')
  const webgl = Boolean(probe.getContext('webgl2'))
  setSupport('jspi', jspi, jspi ? '支持' : '不支持')
  setSupport('opfs', opfs, opfs ? '支持' : '不支持')
  setSupport('webgl', webgl, webgl ? '支持' : '不支持')
  supportResult = { jspi, opfs, webgl, all: jspi && opfs && webgl }
  return supportResult
}

function safePath(path) {
  const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '')
  const parts = normalized.split('/').filter(Boolean)
  if (!parts.length || parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) {
    throw new Error(`不安全的文件路径：${path}`)
  }
  if (parts.some((part) => part.length > 180) || normalized.length > 800) {
    throw new Error(`文件路径过长：${path}`)
  }
  return parts.join('/')
}

function pathDepth(path) {
  return safePath(path).split('/').length
}

function isSkippedPath(path) {
  const parts = path.toLowerCase().split('/')
  const name = parts.at(-1)
  if (SKIPPED_NAMES.has(name) || name.startsWith('._')) return true
  if (parts.slice(0, -1).some((part) => SKIPPED_DIRS.has(part))) return true
  const dot = name.lastIndexOf('.')
  return dot > 0 && SKIPPED_EXTENSIONS.has(name.slice(dot + 1))
}

function rowsFromFileList(fileList) {
  return normalizedSelection([...fileList].map((file) => ({
    file,
    path: safePath(file.webkitRelativePath || file.name),
  })))
}

// 选择器 / 拖放得到的是目录句柄：逐层枚举，路径不含所选目录本身的名字。
async function rowsFromDirectoryHandle(handle, signal, prefix = '', rows = []) {
  for await (const entry of handle.values()) {
    signal?.throwIfAborted()
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.kind === 'directory') {
      if (SKIPPED_DIRS.has(entry.name.toLowerCase())) continue
      await rowsFromDirectoryHandle(entry, signal, path, rows)
    } else {
      if (rows.length >= MAX_IMPORT_FILES) throw new Error(`所选目录文件过多（超过 ${MAX_IMPORT_FILES} 个），请只选择 UNDERTALE 的安装目录。`)
      rows.push({ file: await entry.getFile(), path: safePath(path) })
    }
  }
  return rows
}

// 不支持 getAsFileSystemHandle 的浏览器退回旧的 webkitGetAsEntry 接口。
async function rowsFromEntry(entry, signal, prefix = '', rows = [], root = true) {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name
  if (entry.isFile) {
    if (rows.length >= MAX_IMPORT_FILES) throw new Error(`所选目录文件过多（超过 ${MAX_IMPORT_FILES} 个），请只选择 UNDERTALE 的安装目录。`)
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject))
    rows.push({ file, path: safePath(path) })
    return rows
  }
  if (SKIPPED_DIRS.has(entry.name.toLowerCase())) return rows
  const reader = entry.createReader()
  while (true) {
    signal?.throwIfAborted()
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))
    if (!batch.length) break
    for (const child of batch) await rowsFromEntry(child, signal, root ? '' : path, rows, false)
  }
  return rows
}

function normalizedSelection(rows) {
  const firstSegments = new Set(rows.map(({ path }) => path.split('/')[0]))
  // webkitdirectory 总会加上被选目录名；移掉共同的第一段，目标路径才与原安装目录一致。
  if (firstSegments.size === 1 && rows.every(({ path }) => path.includes('/'))) {
    for (const row of rows) row.path = row.path.split('/').slice(1).join('/')
  }
  return rows
}

async function inspectSelection(rows) {
  if (!rows.length) throw new Error('没有读取到任何文件。请直接选择 UNDERTALE 的安装目录。')

  const wadCandidates = rows
    .filter(({ path }) => WAD_NAMES.has(path.split('/').at(-1).toLowerCase()))
    .sort((left, right) => pathDepth(left.path) - pathDepth(right.path))
  const wad = wadCandidates[0]
  if (!wad) throw new Error('所选目录里没有找到 data.win 或 game.unx。请重新选择正版游戏安装目录。')
  if (wad.file.size < 1024 * 1024) throw new Error('游戏数据文件异常小，可能选错了目录或文件已经损坏。')

  const magic = new TextDecoder('ascii').decode(await wad.file.slice(0, 4).arrayBuffer())
  if (magic !== 'FORM') throw new Error('游戏数据头不是有效的 GameMaker FORM，拒绝写入本地游戏库。')

  const slash = wad.path.lastIndexOf('/')
  const base = slash >= 0 ? wad.path.slice(0, slash + 1) : ''
  const inBase = rows
    .filter(({ path }) => path.startsWith(base))
    .map(({ file, path }) => ({ file, path: safePath(path.slice(base.length)) }))
    .filter(({ path }) => path !== '')
  const bundle = inBase.filter(({ path }) => !isSkippedPath(path))
  const skipped = inBase.filter(({ path }) => isSkippedPath(path))
  const skippedBytes = skipped.reduce((sum, { file }) => sum + file.size, 0)
  const totalBytes = bundle.reduce((sum, { file }) => sum + file.size, 0)
  if (!bundle.length || totalBytes <= wad.file.size) {
    throw new Error('安装目录缺少配套资源。请不要只选 data.win，要选择完整游戏文件夹。')
  }

  const wadRelativePath = safePath(wad.path.slice(base.length))
  return { bundle, totalBytes, wadRelativePath, skippedCount: skipped.length, skippedBytes }
}

async function storageRoot() {
  return navigator.storage.getDirectory()
}

async function getDirectory(parent, name, create = false) {
  return parent.getDirectoryHandle(name, { create })
}

async function removeEntryIfPresent(parent, name) {
  try {
    await parent.removeEntry(name, { recursive: true })
  } catch (error) {
    if (error?.name !== 'NotFoundError') throw error
  }
}

async function directoryForPath(parent, parts, create = false) {
  let current = parent
  for (const part of parts) current = await getDirectory(current, part, create)
  return current
}

async function writeFileStreaming(parent, relativePath, file, onChunk, signal) {
  const parts = safePath(relativePath).split('/')
  const name = parts.pop()
  const directory = await directoryForPath(parent, parts, true)
  const handle = await directory.getFileHandle(name, { create: true })
  const writable = await handle.createWritable({ keepExistingData: false })
  const reader = file.stream().getReader()
  try {
    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      await writable.write(value)
      onChunk(value.byteLength)
    }
    await writable.close()
  } catch (error) {
    await writable.abort().catch(() => {})
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
}

async function ensureStorageCapacity(requiredBytes) {
  const estimate = await navigator.storage.estimate?.()
  if (!estimate?.quota || !Number.isFinite(estimate.usage)) return
  const available = estimate.quota - estimate.usage
  if (available < requiredBytes + REQUIRED_HEADROOM) {
    throw new Error(`浏览器可用空间不足：需要约 ${formatBytes(requiredBytes + REQUIRED_HEADROOM)}，当前约 ${formatBytes(available)}。`)
  }
}

function libraryDirFor(metadata) {
  const dir = metadata?.libraryDir || LIBRARY_DIR
  if (dir !== LIBRARY_DIR && !/^library-(?:\d{13}|remote-[a-z0-9.-]{1,64})$/.test(dir)) {
    throw new Error('本机游戏库记录损坏，请重新导入。')
  }
  return dir
}

async function importBundle(selection, signal) {
  await ensureStorageCapacity(selection.totalBytes)
  await navigator.storage.persist?.().catch(() => false)

  const root = await storageRoot()
  const appRoot = await getDirectory(root, OPFS_ROOT, true)
  const libraryDir = `${LIBRARY_PREFIX}${Date.now()}`
  const library = await getDirectory(appRoot, libraryDir, true)
  let written = 0

  try {
    for (let index = 0; index < selection.bundle.length; index += 1) {
      const entry = selection.bundle[index]
      await writeFileStreaming(library, entry.path, entry.file, (bytes) => {
        written += bytes
        updateProgress(written, selection.totalBytes, `正在复制 ${index + 1}/${selection.bundle.length}：${entry.path}`)
      }, signal)
    }
  } catch (error) {
    // 新副本写在独立目录：失败或取消只删这一份半成品，上一次导入的完整副本保持可玩。
    await removeEntryIfPresent(appRoot, libraryDir).catch(() => {})
    throw error
  }

  const previousDir = importedMetadata ? libraryDirFor(importedMetadata) : null
  const metadata = {
    format: '8bitgo.undertale.local-library.v1',
    appVersion: APP_VERSION,
    libraryDir,
    wadRelativePath: selection.wadRelativePath,
    fileCount: selection.bundle.length,
    totalBytes: selection.totalBytes,
    importedAt: new Date().toISOString(),
  }
  // 就绪记录只在全部文件落盘后才切到新目录，之后再删旧副本。
  localStorage.setItem(METADATA_KEY, JSON.stringify(metadata))
  if (previousDir && previousDir !== libraryDir) await removeEntryIfPresent(appRoot, previousDir).catch(() => {})
  return metadata
}

// 清掉崩溃或关页留下的导入半成品；只删较旧的，避免误删另一个标签页正在写的目录。
async function cleanupStaleImports(liveDir) {
  try {
    const appRoot = await getDirectory(await storageRoot(), OPFS_ROOT)
    for await (const [name, handle] of appRoot.entries()) {
      if (handle.kind !== 'directory' || name === liveDir) continue
      const stamp = /^library-(\d{13})$/.exec(name)?.[1]
      const stale = name === LIBRARY_DIR || (stamp && Date.now() - Number(stamp) > STALE_IMPORT_MS)
      if (stale) await removeEntryIfPresent(appRoot, name).catch(() => {})
    }
  } catch (error) {
    if (error?.name !== 'NotFoundError') console.warn('[undertale] 清理旧导入失败', error)
  }
}

async function fileExists(libraryDir, relativePath) {
  try {
    const root = await storageRoot()
    const appRoot = await getDirectory(root, OPFS_ROOT)
    const library = await getDirectory(appRoot, libraryDir)
    const parts = safePath(relativePath).split('/')
    const name = parts.pop()
    const directory = await directoryForPath(library, parts)
    await directory.getFileHandle(name)
    return true
  } catch {
    return false
  }
}

async function readCachedMetadata() {
  try {
    const value = JSON.parse(localStorage.getItem(METADATA_KEY) || 'null')
    if (!['8bitgo.undertale.local-library.v1', '8bitgo.undertale.distribution-library.v1'].includes(value?.format)) return null
    if (!WAD_NAMES.has(safePath(value.wadRelativePath).split('/').at(-1).toLowerCase())) return null
    return (await fileExists(libraryDirFor(value), value.wadRelativePath)) ? value : null
  } catch {
    return null
  }
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

// 授权清单的 CRC 来自 ZIP 中央目录；边流式写盘边校验，避免把 63 MiB 主数据重新攒进内存。
function updateCrc32(crc, bytes) {
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return crc >>> 0
}

function finishCrc32(crc) {
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')
}

async function crc32OfFile(file) {
  const reader = file.stream().getReader()
  let crc = 0xffffffff
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      crc = updateCrc32(crc, value)
    }
  } finally {
    reader.releaseLock()
  }
  return crc
}

async function loadDistributionManifest() {
  if (!isDistributionOriginAllowed()) {
    throw new Error('授权分发资源只允许从 https://8bitgo.com 或其 HTTPS 子域读取。')
  }
  if (!distributionManifestPromise) {
    distributionManifestPromise = (async () => {
      const response = await fetch(DISTRIBUTION_MANIFEST_URL, { cache: 'no-cache', credentials: 'same-origin' })
      if (!response.ok) throw new Error(`授权资源清单加载失败（HTTP ${response.status}）。`)
      const manifest = await response.json()
      if (manifest?.format !== '8bitgo.undertale.distribution.v1' ||
          manifest.resourceBase !== DISTRIBUTION_RESOURCE_BASE ||
          JSON.stringify(manifest.allowedPageOrigins) !== JSON.stringify(DISTRIBUTION_ALLOWED_PAGE_ORIGINS) ||
          !/^[a-z0-9.-]{1,64}$/.test(manifest.packageVersion) ||
          !Array.isArray(manifest.files) || manifest.files.length === 0) {
        throw new Error('授权资源清单无效，已停止下载。')
      }
      const paths = new Set()
      let totalBytes = 0
      for (const entry of manifest.files) {
        const path = safePath(entry.path)
        if (path !== entry.path || paths.has(path) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[0-9a-f]{8}$/.test(entry.crc32)) {
          throw new Error(`授权资源清单中的文件记录无效：${entry.path}`)
        }
        paths.add(path)
        totalBytes += entry.bytes
      }
      if (totalBytes !== manifest.totalBytes || !paths.has(manifest.wadPath) || !WAD_NAMES.has(manifest.wadPath.toLowerCase())) {
        throw new Error('授权资源清单的大小或游戏数据文件不匹配。')
      }
      return manifest
    })().catch((error) => {
      distributionManifestPromise = null
      throw error
    })
  }
  return distributionManifestPromise
}

function distributionUrl(path) {
  const encodedPath = safePath(path).split('/').map((part) => encodeURIComponent(part)).join('/')
  const url = new URL(encodedPath, DISTRIBUTION_RESOURCE_BASE)
  if (url.origin !== new URL(DISTRIBUTION_RESOURCE_BASE).origin || !url.pathname.startsWith('/undertale/')) {
    throw new Error(`授权资源地址越界：${path}`)
  }
  return url.href
}

async function distributionFileHandle(library, relativePath, create = true) {
  const parts = safePath(relativePath).split('/')
  const name = parts.pop()
  const directory = await directoryForPath(library, parts, create)
  return { directory, handle: await directory.getFileHandle(name, { create }), name }
}

async function readExistingDistributionFile(library, path) {
  try {
    const { handle } = await distributionFileHandle(library, path, false)
    return await handle.getFile()
  } catch (error) {
    if (error?.name === 'NotFoundError') return null
    throw error
  }
}

async function fetchDistributionResponse(entry, signal, offset = null) {
  const headers = offset === null ? undefined : { Range: `bytes=${offset}-${Math.min(entry.bytes, offset + DISTRIBUTION_CHUNK_BYTES) - 1}` }
  const response = await fetch(distributionUrl(entry.path), {
    method: 'GET',
    mode: 'cors',
    credentials: 'omit',
    cache: 'no-store',
    headers,
    signal,
  })
  const finalUrl = new URL(response.url)
  if (finalUrl.origin !== new URL(DISTRIBUTION_RESOURCE_BASE).origin || !finalUrl.pathname.startsWith('/undertale/')) {
    const error = new Error(`授权资源 ${entry.path} 被重定向到未授权地址。`)
    error.retryable = false
    throw error
  }
  const expectedStatus = offset === null ? 200 : 206
  if (response.status !== expectedStatus) {
    const error = new Error(`授权资源 ${entry.path} 请求失败（HTTP ${response.status}）。`)
    error.retryable = response.status >= 500 || response.status === 429
    throw error
  }
  return response
}

async function writeDistributionResponse(entry, handle, response, expectedBytes, crc, offset, signal, onBytes) {
  if (!response.body) throw new Error(`浏览器无法读取授权资源 ${entry.path}。`)

  const writable = await handle.createWritable({ keepExistingData: offset > 0 })
  const reader = response.body.getReader()
  let received = 0
  try {
    if (offset > 0) await writable.seek(offset)
    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > expectedBytes) {
        const error = new Error(`授权资源 ${entry.path} 超过清单中的大小。`)
        error.integrityFailure = true
        throw error
      }
      crc = updateCrc32(crc, value)
      await writable.write(value)
      onBytes(value.byteLength)
    }
    if (received !== expectedBytes) throw new Error(`授权资源 ${entry.path} 下载不完整（${received}/${expectedBytes} 字节）。`)
    const fileEndsHere = offset + received === entry.bytes
    if (fileEndsHere && finishCrc32(crc) !== entry.crc32) {
      const error = new Error(`授权资源 ${entry.path} 校验失败，请稍后重试。`)
      error.integrityFailure = true
      throw error
    }
    await writable.close()
    return crc
  } catch (error) {
    await writable.abort().catch(() => {})
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
}

async function withDistributionRetry(operation, signal) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    signal?.throwIfAborted()
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (error?.name === 'AbortError' || error?.retryable === false || error?.integrityFailure || error?.name === 'QuotaExceededError') throw error
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
    }
  }
  throw lastError
}

async function downloadDistributionFile(library, entry, signal, onBytes) {
  const { directory, name } = await distributionFileHandle(library, entry.path)
  let handle = await directory.getFileHandle(name)
  let file = await handle.getFile()
  if (file.size === entry.bytes) return
  if (file.size > entry.bytes) {
    await removeEntryIfPresent(directory, name)
    handle = await directory.getFileHandle(name, { create: true })
    file = await handle.getFile()
  }

  if (entry.bytes <= DISTRIBUTION_CHUNK_BYTES) {
    await withDistributionRetry(async () => {
      const response = await fetchDistributionResponse(entry, signal)
      await writeDistributionResponse(entry, handle, response, entry.bytes, 0xffffffff, 0, signal, onBytes)
    }, signal)
    return
  }

  let offset = file.size
  let crc = offset ? await crc32OfFile(file) : 0xffffffff
  while (offset < entry.bytes) {
    signal?.throwIfAborted()
    const length = Math.min(DISTRIBUTION_CHUNK_BYTES, entry.bytes - offset)
    const currentOffset = offset
    crc = await withDistributionRetry(async () => {
      const response = await fetchDistributionResponse(entry, signal, currentOffset)
      return writeDistributionResponse(entry, handle, response, length, crc, currentOffset, signal, onBytes)
    }, signal)
    offset += length
  }
}

async function downloadDistribution(manifest, signal) {
  const root = await storageRoot()
  const appRoot = await getDirectory(root, OPFS_ROOT, true)
  const libraryDir = `library-remote-${manifest.packageVersion}`
  const library = await getDirectory(appRoot, libraryDir, true)
  const files = []
  let alreadyAvailable = 0
  let totalRemaining = 0
  for (const entry of manifest.files) {
    const file = await readExistingDistributionFile(library, entry.path)
    const size = file && file.size <= entry.bytes ? file.size : 0
    alreadyAvailable += size
    if (file?.size === entry.bytes) continue
    totalRemaining += entry.bytes - size
    files.push(entry)
  }
  updateProgress(alreadyAvailable, manifest.totalBytes)
  await ensureStorageCapacity(totalRemaining)
  await navigator.storage.persist?.().catch(() => false)
  if (files.length) {
    let next = 0
    let completed = manifest.files.length - files.length
    let doneBytes = alreadyAvailable
    const worker = async () => {
      while (next < files.length) {
        signal?.throwIfAborted()
        const entry = files[next]
        next += 1
        await downloadDistributionFile(library, entry, signal, (amount) => {
          doneBytes += amount
          updateProgress(doneBytes, manifest.totalBytes, `正在下载授权资源 (${completed}/${manifest.files.length})：${entry.path}`)
        })
        completed += 1
        updateProgress(doneBytes, manifest.totalBytes, `正在下载授权资源 (${completed}/${manifest.files.length})：${entry.path}`)
      }
    }
    await Promise.all(Array.from({ length: Math.min(DISTRIBUTION_CONCURRENCY, files.length) }, () => worker()))
  }

  const previousMetadata = await readCachedMetadata()
  const metadata = {
    format: '8bitgo.undertale.distribution-library.v1',
    source: 'authorized-distribution',
    appVersion: APP_VERSION,
    packageVersion: manifest.packageVersion,
    libraryDir,
    wadRelativePath: manifest.wadPath,
    fileCount: manifest.files.length,
    totalBytes: manifest.totalBytes,
    sourceArchiveSha256: manifest.sourceArchiveSha256,
    importedAt: new Date().toISOString(),
  }
  localStorage.setItem(METADATA_KEY, JSON.stringify(metadata))
  importedMetadata = metadata
  if (previousMetadata && libraryDirFor(previousMetadata) !== libraryDir) {
    await removeEntryIfPresent(appRoot, libraryDirFor(previousMetadata)).catch(() => {})
  }
  updateProgress(manifest.totalBytes, manifest.totalBytes, '授权资源已校验并准备完成')
  startCachedButton.hidden = false
  clearLibraryButton.hidden = false
  setMessage(`授权版已准备好：${manifest.files.length} 个资源，${formatBytes(manifest.totalBytes)}。文件只保存在当前浏览器。`, 'success')
  return metadata
}

async function clearLocalLibrary() {
  const root = await storageRoot()
  try {
    const appRoot = await getDirectory(root, OPFS_ROOT)
    const names = []
    for await (const [name, handle] of appRoot.entries()) {
      if (handle.kind === 'directory' && name.startsWith(LIBRARY_PREFIX)) names.push(name)
    }
    for (const name of names) await removeEntryIfPresent(appRoot, name)
  } catch (error) {
    if (error?.name !== 'NotFoundError') throw error
  }
  localStorage.removeItem(METADATA_KEY)
  importedMetadata = null
  startCachedButton.hidden = true
  clearLibraryButton.hidden = true
  setMessage('已清除本机保存的游戏副本；游戏存档仍保留。', 'success')
}

async function loadRuntime() {
  if (modulePromise) return modulePromise
  modulePromise = (async () => {
    installFogUniformPrecisionCompat()
    const createButterscotch = (await import('/web/undertale/runtime/butterscotch.mjs')).default
    const runtime = await createButterscotch({
      locateFile: (name) => `/web/undertale/runtime/${name}`,
      print: (line) => console.info('[butterscotch]', line),
      printErr: (line) => console.error('[butterscotch]', line),
    })
    await runtime._mountOpfs()
    runtime.specialHTMLTargets['#canvas'] = canvas
    moduleInstance = runtime
    return runtime
  })()
  return modulePromise
}

function installFogUniformPrecisionCompat() {
  // 个别 WebGL 驱动会把跨顶点 / 片元着色器的默认精度推导成不同值；显式统一雾颜色精度，避免整个默认程序链接失败。
  const prototypes = new Set([
    window.WebGLRenderingContext?.prototype,
    window.WebGL2RenderingContext?.prototype,
  ].filter(Boolean))

  for (const prototype of prototypes) {
    if (prototype.__8bitgoFogUniformPrecisionCompat) continue
    const originalShaderSource = prototype.shaderSource
    if (typeof originalShaderSource !== 'function') continue

    const shaderSource = function (shader, source) {
      const compatibleSource = typeof source === 'string' && source.includes('uFogColor')
        ? source.replace(/uniform\s+(?:(?:lowp|mediump|highp)\s+)?vec4\s+uFogColor\b/g, 'uniform highp vec4 uFogColor')
        : source
      return originalShaderSource.call(this, shader, compatibleSource)
    }
    Object.defineProperty(prototype, 'shaderSource', {
      configurable: true,
      writable: true,
      value: shaderSource,
    })
    Object.defineProperty(prototype, '__8bitgoFogUniformPrecisionCompat', { value: true })
  }
}

function releaseAllKeys() {
  if (!moduleInstance) return
  for (const key of pressedKeys) moduleInstance._onKeyUp(key)
  for (const key of gamepadKeys) moduleInstance._onKeyUp(key)
  pressedKeys.clear()
  gamepadKeys.clear()
  document.querySelectorAll('[data-key].active').forEach((button) => button.classList.remove('active'))
}

function attachInputs(runtime) {
  inputController?.abort()
  inputController = new AbortController()
  const { signal } = inputController
  const captured = new Set([13, 27, 32, 37, 38, 39, 40, 67, 88, 90])

  window.addEventListener('keydown', (event) => {
    if (captured.has(event.keyCode)) event.preventDefault()
    if (event.repeat || !activeRun) return
    // Butterscotch 把长按 Esc 作为退出；这里将 Esc 当作确认键，开场可继续，也不会误关 runner。
    const keyCode = event.key === 'Escape' || event.keyCode === 27 ? 90 : event.keyCode
    pressedKeys.add(keyCode)
    runtime._onKeyDown(keyCode)
  }, { signal })
  window.addEventListener('keyup', (event) => {
    if (captured.has(event.keyCode)) event.preventDefault()
    if (!activeRun) return
    const keyCode = event.key === 'Escape' || event.keyCode === 27 ? 90 : event.keyCode
    pressedKeys.delete(keyCode)
    runtime._onKeyUp(keyCode)
  }, { signal })
  window.addEventListener('blur', releaseAllKeys, { signal })
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseAllKeys()
  }, { signal })

  canvas.addEventListener('mousedown', (event) => runtime._onMouseDown(event.button), { signal })
  window.addEventListener('mouseup', (event) => runtime._onMouseUp(event.button), { signal })
  window.addEventListener('mousemove', (event) => {
    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    runtime._onMouseMove(
      (event.clientX - rect.left) * canvas.width / rect.width,
      (event.clientY - rect.top) * canvas.height / rect.height,
    )
  }, { signal })
  canvas.addEventListener('contextmenu', (event) => event.preventDefault(), { signal })

  for (const button of document.querySelectorAll('[data-key]')) {
    const key = Number(button.dataset.key)
    const down = (event) => {
      event.preventDefault()
      button.setPointerCapture?.(event.pointerId)
      if (pressedKeys.has(key)) return
      pressedKeys.add(key)
      button.classList.add('active')
      runtime._onKeyDown(key)
    }
    const up = (event) => {
      event.preventDefault()
      if (!pressedKeys.delete(key)) return
      button.classList.remove('active')
      runtime._onKeyUp(key)
    }
    button.addEventListener('pointerdown', down, { signal })
    button.addEventListener('pointerup', up, { signal })
    button.addEventListener('pointercancel', up, { signal })
    button.addEventListener('lostpointercapture', up, { signal })
  }

  pollGamepad(runtime)
}

function pollGamepad(runtime) {
  cancelAnimationFrame(gamepadFrame)
  const keyForControl = new Map([
    ['up', 38], ['left', 37], ['down', 40], ['right', 39],
    ['confirm', 90], ['cancel', 88], ['menu', 67], ['start', 13],
  ])
  const tick = () => {
    if (!activeRun) return
    const pad = [...(navigator.getGamepads?.() || [])].find(Boolean)
    const next = new Set()
    if (pad) {
      if (pad.buttons[12]?.pressed || pad.axes[1] < -0.5) next.add(keyForControl.get('up'))
      if (pad.buttons[14]?.pressed || pad.axes[0] < -0.5) next.add(keyForControl.get('left'))
      if (pad.buttons[13]?.pressed || pad.axes[1] > 0.5) next.add(keyForControl.get('down'))
      if (pad.buttons[15]?.pressed || pad.axes[0] > 0.5) next.add(keyForControl.get('right'))
      if (pad.buttons[0]?.pressed) next.add(keyForControl.get('confirm'))
      if (pad.buttons[1]?.pressed) next.add(keyForControl.get('cancel'))
      if (pad.buttons[2]?.pressed || pad.buttons[3]?.pressed) next.add(keyForControl.get('menu'))
      if (pad.buttons[9]?.pressed) next.add(keyForControl.get('start'))
    }
    for (const key of next) if (!gamepadKeys.has(key)) runtime._onKeyDown(key)
    for (const key of gamepadKeys) if (!next.has(key)) runtime._onKeyUp(key)
    gamepadKeys.clear()
    for (const key of next) gamepadKeys.add(key)
    gamepadFrame = requestAnimationFrame(tick)
  }
  gamepadFrame = requestAnimationFrame(tick)
}

function callStartRunner(runtime, args) {
  const strings = args.map((value) => runtime.stringToNewUTF8(value))
  const argv = runtime._malloc((strings.length + 1) * 4)
  strings.forEach((pointer, index) => runtime.setValue(argv + index * 4, pointer, '*'))
  runtime.setValue(argv + strings.length * 4, 0, '*')
  return Promise.resolve(runtime._startRunner(strings.length, argv)).finally(() => {
    strings.forEach((pointer) => runtime._free(pointer))
    runtime._free(argv)
  })
}

async function startGame() {
  if (activeRun) return
  const support = checkSupport()
  if (!support.all) {
    setMessage('当前浏览器暂不支持。', 'error')
    return
  }
  importedMetadata = await readCachedMetadata()
  if (!importedMetadata) {
    setMessage('本机游戏资源未就绪。', 'error')
    return
  }

  setBusy(true)
  setRuntimeState('正在启动本机游戏…')
  launcher.hidden = true
  gameView.hidden = false
  gameStatus.textContent = '正在读取本机游戏文件…'
  canvas.focus({ preventScroll: true })

  try {
    const runtime = await loadRuntime()
    attachInputs(runtime)
    const wadPath = `/butterscotch/${OPFS_ROOT}/${libraryDirFor(importedMetadata)}/${safePath(importedMetadata.wadRelativePath)}`
    const savePath = `/butterscotch/${OPFS_ROOT}/${SAVE_DIR}`
    activeRun = callStartRunner(runtime, [
      '--save-folder', savePath,
      '--disable-log-colours',
      wadPath,
    ])
    gameStatus.textContent = '运行中 · 方向键 / Z / X / C · 标准手柄可用'
    setRuntimeState('游戏正在本机运行', 'ok')
    audioGate.hidden = false
    await activeRun
  } catch (error) {
    console.error(error)
    setMessage('游戏启动失败，请刷新重试。', 'error')
  } finally {
    activeRun = null
    inputController?.abort()
    cancelAnimationFrame(gamepadFrame)
    releaseAllKeys()
    gameView.hidden = true
    launcher.hidden = false
    setBusy(false)
    setRuntimeState('开源运行端已就绪', 'ok')
  }
}

async function stopGame() {
  if (!activeRun || !moduleInstance) return
  gameStatus.textContent = '正在安全退出并保存…'
  releaseAllKeys()
  moduleInstance._requestRunnerExit()
  await activeRun.catch(() => {})
  // 启动页没有第二个按钮；退出后回主站，避免停在满格但无法再次操作的空页。
  location.assign('/')
}

async function startAuthorizedGame() {
  if (activeRun || importController) return
  if (!isDistributionOriginAllowed()) {
    setMessage('请从 8bitgo.com 打开。', 'error')
    return
  }
  if (!checkSupport().all) {
    setMessage('当前浏览器暂不支持。', 'error')
    return
  }

  const controller = new AbortController()
  importController = controller
  setBusy(true)
  cancelImportButton.hidden = false
  cancelImportButton.textContent = '取消下载'
  setMessage('')
  updateProgress(0, 1)
  try {
    const manifest = await loadDistributionManifest()
    await downloadDistribution(manifest, controller.signal)
    cancelImportButton.hidden = true
    importController = null
    await showCompletedProgress()
    await startGame()
  } catch (error) {
    controller.abort()
    if (error?.name === 'AbortError') {
      setMessage('')
    } else {
      console.error(error)
      setMessage('加载失败，请刷新重试。', 'error')
    }
  } finally {
    importController = null
    cancelImportButton.hidden = true
    cancelImportButton.textContent = '取消导入'
    setBusy(false)
  }
}

async function runImport(collectRows) {
  if (importController || activeRun) return
  importController = new AbortController()
  const { signal } = importController
  setBusy(true)
  cancelImportButton.hidden = false
  setMessage('正在检查安装目录…')
  updateProgress(0, 1, '正在读取目录…')
  try {
    const rows = await collectRows(signal)
    const selection = await inspectSelection(rows)
    const skippedNote = selection.skippedCount
      ? `（跳过 ${selection.skippedCount} 个运行时用不到的程序文件，${formatBytes(selection.skippedBytes)}）`
      : ''
    setMessage(`找到 ${selection.bundle.length} 个文件，共 ${formatBytes(selection.totalBytes)}${skippedNote}。正在写入浏览器私有存储…`)
    importedMetadata = await importBundle(selection, signal)
    startCachedButton.hidden = false
    clearLibraryButton.hidden = false
    updateProgress(selection.totalBytes, selection.totalBytes, '导入完成')
    setMessage(`本机游戏副本已准备好${skippedNote}。文件没有离开这台设备。`, 'success')
  } catch (error) {
    progressWrap.hidden = true
    if (error?.name === 'AbortError') {
      setMessage(importedMetadata ? '已取消导入，之前的本机副本保持不变。' : '已取消导入。')
    } else {
      console.error(error)
      setMessage(error?.message || String(error), 'error')
    }
  } finally {
    importController = null
    cancelImportButton.hidden = true
    folderInput.value = ''
    setBusy(false)
  }
}

async function handleFolderSelection() {
  if (!folderInput.files?.length) return
  const files = folderInput.files
  await runImport(async () => rowsFromFileList(files))
}

// showDirectoryPicker 只请求“读取文件夹”权限；webkitdirectory 在 Chrome 里会弹“上传 N 个文件”的确认框，
// 和“零上传”自相矛盾，所以优先用前者，仅在不支持时退回 input。
async function pickFolder() {
  if (typeof window.showDirectoryPicker !== 'function') {
    folderInput.click()
    return
  }
  let handle
  try {
    handle = await window.showDirectoryPicker({ id: '8bitgo-undertale', mode: 'read' })
  } catch (error) {
    if (error?.name === 'AbortError') return
    // 某些嵌入环境禁止选择器（SecurityError），退回 input。
    console.warn('[undertale] 目录选择器不可用，改用文件输入', error)
    folderInput.click()
    return
  }
  await runImport((signal) => rowsFromDirectoryHandle(handle, signal))
}

async function handleDrop(event) {
  event.preventDefault()
  importCard.classList.remove('dragover')
  if (selectFolderButton.disabled || importController || activeRun) return
  const items = [...(event.dataTransfer?.items || [])].filter((item) => item.kind === 'file')
  if (!items.length) return
  // 必须在 drop 事件同步阶段取出句柄 / entry，await 之后 DataTransfer 就失效了。
  const handlePromises = items.map((item) => item.getAsFileSystemHandle?.())
  const entries = items.map((item) => item.webkitGetAsEntry?.())
  await runImport(async (signal) => {
    const handles = (await Promise.all(handlePromises.map((p) => p?.catch(() => null)))).filter(Boolean)
    const dirHandle = handles.find((handle) => handle.kind === 'directory')
    if (dirHandle) return rowsFromDirectoryHandle(dirHandle, signal)
    const dirEntry = entries.find((entry) => entry?.isDirectory)
    if (dirEntry) return rowsFromEntry(dirEntry, signal)
    throw new Error('请拖入整个游戏文件夹，而不是单个文件。')
  })
}

async function initialize() {
  const support = checkSupport()
  selectFolderButton.disabled = !support.all
  startAuthorizedButton.disabled = !support.all || !isDistributionOriginAllowed()
  if (!support.all) {
    setRuntimeState('浏览器不兼容', 'bad')
    setMessage('当前浏览器暂不支持。', 'error')
    return
  }

  if (!isDistributionOriginAllowed()) {
    setMessage('请从 8bitgo.com 打开。', 'error')
    return
  }

  importedMetadata = await readCachedMetadata()
  cleanupStaleImports(importedMetadata ? libraryDirFor(importedMetadata) : null)

  // 运行端预热与授权资源下载并行；资源进度到 100% 后立即进入游戏。
  loadRuntime()
    .then(() => setRuntimeState('开源运行端已就绪', 'ok'))
    .catch((error) => {
      console.error(error)
      setRuntimeState('运行端加载失败', 'bad')
      setMessage('运行端加载失败，请刷新重试。', 'error')
    })

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/web/undertale/sw.js', { scope: '/web/undertale/' }).catch(() => {})
  }

  await startAuthorizedGame()
}

selectFolderButton.addEventListener('click', () => {
  pickFolder().catch((error) => setMessage(error?.message || String(error), 'error'))
})
startAuthorizedButton.addEventListener('click', startAuthorizedGame)
cancelImportButton.addEventListener('click', () => importController?.abort())
importCard.addEventListener('dragover', (event) => {
  if (![...(event.dataTransfer?.types || [])].includes('Files')) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
  importCard.classList.add('dragover')
})
importCard.addEventListener('dragleave', (event) => {
  if (!importCard.contains(event.relatedTarget)) importCard.classList.remove('dragover')
})
importCard.addEventListener('drop', (event) => {
  handleDrop(event).catch((error) => setMessage(error?.message || String(error), 'error'))
})
folderInput.addEventListener('change', handleFolderSelection)
startCachedButton.addEventListener('click', startGame)
clearLibraryButton.addEventListener('click', async () => {
  if (!confirm('只清除浏览器里的游戏副本？存档会保留。')) return
  setBusy(true)
  try {
    await clearLocalLibrary()
  } catch (error) {
    setMessage(`清除失败：${error?.message || error}`, 'error')
  } finally {
    setBusy(false)
  }
})
$('#back-to-launcher').addEventListener('click', stopGame)
$('#fullscreen').addEventListener('click', async () => {
  if (document.fullscreenElement) await document.exitFullscreen()
  else await gameView.requestFullscreen()
})
audioGate.addEventListener('click', () => {
  audioGate.hidden = true
  canvas.focus({ preventScroll: true })
})
canvasStage.addEventListener('pointerdown', () => {
  audioGate.hidden = true
  canvas.focus({ preventScroll: true })
})

// 在页面启动时先改好 WebGL 入口：运行端会并行预热，避免冷启动先创建着色器再安装兼容层。
installFogUniformPrecisionCompat()
initialize().catch((error) => {
  console.error(error)
  setRuntimeState('初始化失败', 'bad')
  setMessage('启动失败，请刷新重试。', 'error')
})
