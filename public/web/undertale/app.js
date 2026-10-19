const APP_VERSION = '2026.10.19.1'
const OPFS_ROOT = '8bitgo-undertale'
const LIBRARY_DIR = 'library-v1'
const SAVE_DIR = 'saves'
const METADATA_KEY = '8bitgo.undertale.library.v1'
const WAD_NAMES = new Set(['data.win', 'game.unx', 'game.ios', 'game.droid'])
const REQUIRED_HEADROOM = 128 * 1024 * 1024

const $ = (selector) => document.querySelector(selector)
const launcher = $('#launcher')
const gameView = $('#game-view')
const canvas = $('#canvas')
const canvasStage = $('#canvas-stage')
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

let modulePromise
let moduleInstance
let activeRun
let inputController
let gamepadFrame
let importedMetadata
const pressedKeys = new Set()
const gamepadKeys = new Set()

function setMessage(text, kind = '') {
  message.textContent = text
  message.className = `message ${kind}`.trim()
}

function setRuntimeState(text, kind = '') {
  runtimeState.textContent = text
  stateDot.className = `state-dot ${kind}`.trim()
}

function setBusy(busy) {
  selectFolderButton.disabled = busy
  startCachedButton.disabled = busy
  clearLibraryButton.disabled = busy
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

function updateProgress(done, total, label) {
  const ratio = total > 0 ? Math.min(1, done / total) : 0
  const percent = Math.round(ratio * 100)
  progressWrap.hidden = false
  progress.value = percent
  progressLabel.textContent = label
  progressValue.textContent = `${percent}%`
}

function setSupport(check, ok, label) {
  const item = document.querySelector(`[data-check="${check}"]`)
  item.classList.toggle('ok', ok)
  item.classList.toggle('bad', !ok)
  item.querySelector('b').textContent = label
}

function checkSupport() {
  const jspi = typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function'
  const opfs = typeof navigator.storage?.getDirectory === 'function'
  const probe = document.createElement('canvas')
  const webgl = Boolean(probe.getContext('webgl2'))
  setSupport('jspi', jspi, jspi ? '支持' : '不支持')
  setSupport('opfs', opfs, opfs ? '支持' : '不支持')
  setSupport('webgl', webgl, webgl ? '支持' : '不支持')
  return { jspi, opfs, webgl, all: jspi && opfs && webgl }
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

function normalizedSelection(files) {
  const rows = files.map((file) => ({
    file,
    path: safePath(file.webkitRelativePath || file.name),
  }))
  const firstSegments = new Set(rows.map(({ path }) => path.split('/')[0]))
  // webkitdirectory 总会加上被选目录名；移掉共同的第一段，目标路径才与原安装目录一致。
  if (firstSegments.size === 1 && rows.every(({ path }) => path.includes('/'))) {
    for (const row of rows) row.path = row.path.split('/').slice(1).join('/')
  }
  return rows
}

async function inspectSelection(fileList) {
  const rows = normalizedSelection([...fileList])
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
  const bundle = rows
    .filter(({ path }) => path.startsWith(base))
    .map(({ file, path }) => ({ file, path: safePath(path.slice(base.length)) }))
    .filter(({ path }) => path !== '')
  const totalBytes = bundle.reduce((sum, { file }) => sum + file.size, 0)
  if (!bundle.length || totalBytes <= wad.file.size) {
    throw new Error('安装目录缺少配套资源。请不要只选 data.win，要选择完整游戏文件夹。')
  }

  const wadRelativePath = safePath(wad.path.slice(base.length))
  return { bundle, totalBytes, wadRelativePath }
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

async function writeFileStreaming(parent, relativePath, file, onChunk) {
  const parts = safePath(relativePath).split('/')
  const name = parts.pop()
  const directory = await directoryForPath(parent, parts, true)
  const handle = await directory.getFileHandle(name, { create: true })
  const writable = await handle.createWritable({ keepExistingData: false })
  const reader = file.stream().getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      await writable.write(value)
      onChunk(value.byteLength)
    }
    await writable.close()
  } catch (error) {
    await writable.abort().catch(() => {})
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

async function importBundle(selection) {
  await ensureStorageCapacity(selection.totalBytes)
  await navigator.storage.persist?.().catch(() => false)

  const root = await storageRoot()
  const appRoot = await getDirectory(root, OPFS_ROOT, true)
  await removeEntryIfPresent(appRoot, LIBRARY_DIR)
  const library = await getDirectory(appRoot, LIBRARY_DIR, true)
  let written = 0

  try {
    for (let index = 0; index < selection.bundle.length; index += 1) {
      const entry = selection.bundle[index]
      await writeFileStreaming(library, entry.path, entry.file, (bytes) => {
        written += bytes
        updateProgress(written, selection.totalBytes, `正在复制 ${index + 1}/${selection.bundle.length}：${entry.path}`)
      })
    }
  } catch (error) {
    // 就绪信息只在全部文件落盘后写入；失败时删掉半成品，避免下次把残缺目录当成可玩版本。
    await removeEntryIfPresent(appRoot, LIBRARY_DIR).catch(() => {})
    throw error
  }

  const metadata = {
    format: '8bitgo.undertale.local-library.v1',
    appVersion: APP_VERSION,
    wadRelativePath: selection.wadRelativePath,
    fileCount: selection.bundle.length,
    totalBytes: selection.totalBytes,
    importedAt: new Date().toISOString(),
  }
  localStorage.setItem(METADATA_KEY, JSON.stringify(metadata))
  return metadata
}

async function fileExists(relativePath) {
  try {
    const root = await storageRoot()
    const appRoot = await getDirectory(root, OPFS_ROOT)
    const library = await getDirectory(appRoot, LIBRARY_DIR)
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
    if (value?.format !== '8bitgo.undertale.local-library.v1') return null
    if (!WAD_NAMES.has(safePath(value.wadRelativePath).split('/').at(-1).toLowerCase())) return null
    return (await fileExists(value.wadRelativePath)) ? value : null
  } catch {
    return null
  }
}

async function clearLocalLibrary() {
  const root = await storageRoot()
  try {
    const appRoot = await getDirectory(root, OPFS_ROOT)
    await removeEntryIfPresent(appRoot, LIBRARY_DIR)
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
    if (event.repeat || !activeRun) return
    if (captured.has(event.keyCode)) event.preventDefault()
    pressedKeys.add(event.keyCode)
    runtime._onKeyDown(event.keyCode)
  }, { signal })
  window.addEventListener('keyup', (event) => {
    if (!activeRun) return
    if (captured.has(event.keyCode)) event.preventDefault()
    pressedKeys.delete(event.keyCode)
    runtime._onKeyUp(event.keyCode)
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
    setMessage('当前浏览器缺少运行所需能力。请使用最新版 Chrome 或 Edge 桌面版。', 'error')
    return
  }
  importedMetadata = await readCachedMetadata()
  if (!importedMetadata) {
    setMessage('没有找到完整的本机游戏副本，请先选择正版安装目录。', 'error')
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
    const wadPath = `/butterscotch/${OPFS_ROOT}/${LIBRARY_DIR}/${safePath(importedMetadata.wadRelativePath)}`
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
    setMessage(`启动失败：${error?.message || error}`, 'error')
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
}

async function handleFolderSelection() {
  if (!folderInput.files?.length) return
  setBusy(true)
  setMessage('正在检查安装目录…')
  updateProgress(0, 1, '正在检查文件…')
  try {
    const selection = await inspectSelection(folderInput.files)
    setMessage(`找到 ${selection.bundle.length} 个文件，共 ${formatBytes(selection.totalBytes)}。正在写入浏览器私有存储…`)
    importedMetadata = await importBundle(selection)
    startCachedButton.hidden = false
    clearLibraryButton.hidden = false
    updateProgress(selection.totalBytes, selection.totalBytes, '导入完成')
    setMessage('本机游戏副本已准备好。文件没有离开这台设备。', 'success')
  } catch (error) {
    console.error(error)
    progressWrap.hidden = true
    setMessage(error?.message || String(error), 'error')
  } finally {
    folderInput.value = ''
    setBusy(false)
  }
}

async function initialize() {
  const support = checkSupport()
  selectFolderButton.disabled = !support.all
  if (!support.all) {
    setRuntimeState('浏览器不兼容', 'bad')
    setMessage('需要最新版 Chrome 或 Edge：当前浏览器缺少 JSPI、OPFS 或 WebGL 2。', 'error')
    return
  }

  importedMetadata = await readCachedMetadata()
  if (importedMetadata) {
    startCachedButton.hidden = false
    clearLibraryButton.hidden = false
    setMessage(`已找到本机副本：${importedMetadata.fileCount} 个文件，${formatBytes(importedMetadata.totalBytes)}。`, 'success')
  }

  // 先编译 2 MB WASM，用户选择文件时可以与 OPFS 复制并行，缩短点击“启动”后的等待。
  loadRuntime()
    .then(() => setRuntimeState('开源运行端已就绪', 'ok'))
    .catch((error) => {
      console.error(error)
      setRuntimeState('运行端加载失败', 'bad')
      setMessage(`运行端加载失败：${error?.message || error}`, 'error')
    })

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/web/undertale/sw.js', { scope: '/web/undertale/' }).catch(() => {})
  }
}

selectFolderButton.addEventListener('click', () => folderInput.click())
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

initialize().catch((error) => {
  console.error(error)
  setRuntimeState('初始化失败', 'bad')
  setMessage(error?.message || String(error), 'error')
})
