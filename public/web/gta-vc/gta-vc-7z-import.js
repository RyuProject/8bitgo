const buttonLocal = document.getElementById('game-7z-btn')
const buttonR2 = document.getElementById('game-r2-btn')
const input = document.getElementById('game-7z-input')
const status = document.getElementById('spinner')
const progress = status?.querySelector('.progress-bar-fill')
const gameButton = document.getElementById('click-to-play-button')
const lang = document.getElementById('ui-lang')
const dropArea = document.getElementById('game-drop')

let busy = false
let activeWorker
let converterDone = false
let gameStarted = false
let importAttempted = false

function isChinese() {
  return String(lang?.value || navigator.language).toLowerCase().startsWith('zh')
}

function words(english, chinese) {
  return isChinese() ? chinese : english
}

function setBusy(value) {
  busy = value
  for (const button of [buttonLocal, buttonR2]) {
    if (button) button.disabled = value
  }
  if (input) input.disabled = value
  for (const button of document.querySelectorAll('#game-folder-btn, #game-zip-btn')) {
    button.disabled = value
  }
  if (dropArea) dropArea.dataset.importing = value ? '1' : '0'
}

function showStatus(message, state = 'busy', percent = null) {
  if (!status || !progress) return
  status.dataset.state = state
  if (percent !== null) {
    const value = Math.max(0, Math.min(100, percent))
    progress.style.width = `${value}%`
    status.setAttribute('aria-valuenow', String(Math.round(value)))
  }
  status.setAttribute('aria-label', state === 'error'
    ? words('Loading failed. Refresh to retry.', '加载失败，请刷新重试。')
    : words('Loading game resources', '正在加载游戏资源'))
  if (state === 'error') window.clearInterval(autoStartTimer)
  if (typeof message === 'string') status.title = message
}

function errorMessage(error, fallback = '导入失败') {
  if (typeof error === 'string') return error
  if (typeof error?.message === 'string' && error.message) return error.message
  try { return JSON.stringify(error) || fallback } catch { return fallback }
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let amount = value
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit++
  }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function temporaryRootParts(value) {
  const parts = String(value || '').split('/')
  if (parts.length !== 2 || !/^_gta_vc_7z_[0-9a-f-]{36}$/i.test(parts[0]) || parts[1] !== 'source') {
    throw new Error('7z 解包临时目录无效')
  }
  return parts
}

async function removeTemporaryRoot(id) {
  try {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry(`_gta_vc_7z_${id}`, { recursive: true })
  } catch {}
}

async function collectFiles(directory, prefix = '') {
  const found = []
  async function walk(current, currentPrefix) {
    for await (const [name, entry] of current.entries()) {
      if (!entry) throw new Error(`7z 解包目录中有无效条目：${currentPrefix ? `${currentPrefix}/` : ''}${name}`)
      if (name === '.DS_Store' || name.startsWith('._') || name === '__MACOSX') continue
      const path = currentPrefix ? `${currentPrefix}/${name}` : name
      if (entry.kind === 'directory') {
        await walk(entry, path)
      } else if (entry.kind === 'file' && typeof entry.getFile === 'function') {
        found.push({ path, handle: entry })
      } else {
        throw new Error(`7z 解包条目无法读取：${path}（${entry.kind || '未知类型'}）`)
      }
    }
  }
  await walk(directory, prefix)
  const files = []
  for (const { path, handle } of found) {
    files.push({ path, file: await handle.getFile() })
  }
  return files
}

function progressLabel(message) {
  if (message.phase === 'download') {
    const total = Number(message.total) || 0
    const done = Number(message.done) || 0
    const percent = total ? 2 + done / total * 24 : 8
    showStatus('', 'busy', percent)
    return
  }
  if (message.phase === 'checking') {
    showStatus('', 'busy', 27)
    return
  }
  if (message.phase === 'extract') {
    const total = Number(message.total) || 0
    const done = Number(message.done) || 0
    const percent = total ? 28 + done / total * 52 : 28
    showStatus('', 'busy', percent)
  }
}

function tryAutoStart() {
  if (gameStarted || busy || !converterDone || !gameButton || gameButton.disabled || window.__gtaGameReady !== true) return
  gameStarted = true
  showStatus('', 'busy', 100)
  window.clearInterval(autoStartTimer)
  window.setTimeout(() => gameButton.click(), 120)
}

const autoStartTimer = window.setInterval(tryAutoStart, 200)
const setupObserver = new MutationObserver(tryAutoStart)
if (gameButton) setupObserver.observe(gameButton, { attributes: true, attributeFilter: ['disabled'] })

function startR2Import() {
  if (importAttempted || busy) return
  if (window.__gtaGameReady === true && gameButton && !gameButton.disabled) {
    converterDone = true
    tryAutoStart()
    return
  }
  importAttempted = true
  void importExtracted({ url: '/game-data/revcdoseng.7z' }, 'revcdoseng.7z')
}

async function importExtracted(source, fileName) {
  if (busy) return
  if (!navigator.storage?.getDirectory || !window.Worker) {
    showStatus(words('This browser cannot import .7z files.', '当前浏览器不支持导入 .7z 文件。'), 'error', 100)
    return
  }

  setBusy(true)
  showStatus(words('Preparing the 7z decoder…', '正在准备 7z 解码器…'), 'busy', 0)
  const id = crypto.randomUUID()
  const worker = new Worker('/web/gta-vc/7z-extractor.worker.js', { type: 'module' })
  activeWorker = worker

  worker.addEventListener('message', async (event) => {
    const message = event.data
    if (message.id !== id) return
    if (message.type === 'progress') {
      progressLabel(message)
      return
    }
    if (message.type === 'error') {
      worker.terminate()
      activeWorker = null
      await removeTemporaryRoot(id)
      setBusy(false)
      showStatus(message.message || words('7z import failed.', '7z 导入失败。'), 'error', 100)
      return
    }
    if (message.type !== 'done') return

    worker.terminate()
    activeWorker = null
    try {
      showStatus('', 'busy', 82)
      const [tempName, sourceName] = temporaryRootParts(message.extractRoot)
      const root = await navigator.storage.getDirectory()
      const tempDirectory = await root.getDirectoryHandle(tempName)
      const sourceDirectory = await tempDirectory.getDirectoryHandle(sourceName)
      const entries = await collectFiles(sourceDirectory, sourceName)
      if (!entries.length) throw new Error('7z 中没有可导入的文件')

      showStatus('', 'busy', 82)
      const setupName = String(fileName || 'revcdoseng.7z').replace(/\.7z$/i, '')
      window.dispatchEvent(new CustomEvent('8bg-gta-vc-import-folder', {
        detail: { root: setupName, entries, cleanupRoot: tempName },
      }))
    } catch (error) {
      setBusy(false)
      try {
        const root = await navigator.storage.getDirectory()
        await root.removeEntry(message.cleanupRoot, { recursive: true })
      } catch {}
      showStatus(error?.message || words('Could not read extracted files.', '无法读取解压后的文件。'), 'error', 100)
    }
  })

  worker.addEventListener('error', (event) => {
    worker.terminate()
    activeWorker = null
    void removeTemporaryRoot(id)
    setBusy(false)
      showStatus(errorMessage(event.message, words('The 7z decoder stopped.', '7z 解码器意外停止。')), 'error', 100)
  })

  worker.postMessage({ type: 'extract', id, source })
}

buttonLocal?.addEventListener('click', () => input?.click())
input?.addEventListener('change', () => {
  const file = input.files?.[0]
  if (!file) return
  void importExtracted({ file }, file.name)
  input.value = ''
})

buttonR2?.addEventListener('click', startR2Import)

window.addEventListener('8bg-gta-vc-7z-file', (event) => {
  const file = event.detail?.file
  if (file) void importExtracted({ file }, file.name)
})

window.addEventListener('8bg-gta-vc-convert-status', (event) => {
  const message = event.detail
  if (!message || !busy) return
  if (message.type === 'progress' && message.phase === 'converting') {
    const total = Number(message.total) || 0
    const done = Number(message.done) || 0
    const percent = total ? 82 + done / total * 16 : 82
    showStatus('', 'busy', percent)
  } else if (message.type === 'done') {
    converterDone = true
    setBusy(false)
    showStatus('', 'busy', 98)
    tryAutoStart()
  } else if (message.type === 'error') {
    setBusy(false)
    showStatus(errorMessage(message.message), 'error', 100)
  }
})

window.addEventListener('8bg-gta-vc-setup', (event) => {
  if (event.detail?.ready) {
    converterDone = true
    showStatus('', 'busy', 100)
    tryAutoStart()
  } else {
    startR2Import()
  }
}, { once: true })
