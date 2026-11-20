const GAME_HOST = 'pokecatch-online.netlify.app'
const GAME_URLS = [`https://${GAME_HOST}/*`]
const APP_GAME_URLS = [
  'https://8bitgo.com/games/pokecatch*',
  'https://8bitgo.com/*/games/pokecatch*',
  'https://cn.8bitgo.com/games/pokecatch*',
  'https://cn.8bitgo.com/*/games/pokecatch*',
]
const MAX_SAVE_BYTES = 4 * 1024 * 1024

function validSave(raw) {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > MAX_SAVE_BYTES) return false
  try {
    const save = JSON.parse(raw)
    return Boolean(save && Number.isInteger(save.v) && save.v > 0 && Array.isArray(save.mons) && save.mons.length <= 151)
  } catch {
    return false
  }
}

function gameFrameOperation(raw, mode) {
  const host = 'pokecatch-online.netlify.app'
  const key = 'gachamon-save-v1'
  const backupKey = '8bitgo.pokecatch.backup.v1'
  if (location.hostname !== host) return null
  try {
    if (mode === 'read') {
      const value = localStorage.getItem(key)
      if (!value) return { ok: false, code: 'missing' }
      let save
      try {
        save = JSON.parse(value)
      } catch {
        return { ok: false, code: 'invalid' }
      }
      if (!save || !Number.isInteger(save.v) || save.v < 1 || !Array.isArray(save.mons) || save.mons.length > 151) {
        return { ok: false, code: 'invalid' }
      }
      return { ok: true, raw: value }
    }
    const save = JSON.parse(raw)
    if (!save || !Number.isInteger(save.v) || save.v < 1 || !Array.isArray(save.mons) || save.mons.length > 151) {
      return { ok: false, code: 'invalid' }
    }
    const current = localStorage.getItem(key)
    if (current) localStorage.setItem(backupKey, current)
    localStorage.setItem(key, raw)
    // 先让扩展 API 把成功结果送回同步页，再刷新游戏；立即导航可能吞掉执行结果。
    setTimeout(() => location.reload(), 300)
    return { ok: true, mons: save.mons.length }
  } catch {
    return { ok: false, code: 'storage' }
  }
}

async function findGameTab() {
  const directTabs = await chrome.tabs.query({ url: GAME_URLS })
  if (directTabs.length > 1) return { error: '请只保留一个打开中的 Pokecatch 游戏标签页，再重试。' }
  if (directTabs.length === 1) return { tab: directTabs[0] }
  // 兼容仍开着旧版 8BitGo 内嵌页的玩家；新版入口会优先使用游戏顶层标签。
  const appTabs = await chrome.tabs.query({ url: APP_GAME_URLS })
  if (!appTabs.length) return { error: '请先打开 Pokecatch 游戏标签页。' }
  if (appTabs.length > 1) return { error: '请只保留一个打开中的《Pokecatch》游戏页，再重试。' }
  return { tab: appTabs[0] }
}

async function findSaveSyncOrigin() {
  const tabs = await chrome.tabs.query({ url: APP_GAME_URLS })
  const tab = tabs.find((item) => {
    try { return ['https:', 'http:'].includes(new URL(item.url).protocol) } catch { return false }
  })
  return tab ? new URL(tab.url).origin : 'https://8bitgo.com'
}

async function findGameFrame(tabId) {
  // Firefox for Android 暂不实现 getAllFrames；调用方会改为逐框注入并由游戏域名自检。
  if (typeof chrome.webNavigation?.getAllFrames !== 'function') return null
  const frames = await chrome.webNavigation.getAllFrames({ tabId })
  const matches = (frames || []).filter((frame) => {
    try {
      return new URL(frame.url).hostname === GAME_HOST
    } catch {
      return false
    }
  })
  if (!matches.length) throw new Error('没有找到 Pokecatch 游戏页面。请确认游戏已打开并等待加载完成。')
  if (matches.length > 1) throw new Error('页面里有多个 Pokecatch 游戏页面，请只保留一个后重试。')
  return matches[0].frameId
}

async function runGameFrameOperation(tabId, raw, mode) {
  const frameId = await findGameFrame(tabId)
  const target = frameId === null ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] }
  const frames = await chrome.scripting.executeScript({
    target,
    world: 'MAIN',
    func: gameFrameOperation,
    args: [raw, mode],
  })
  const result = frames.map((frame) => frame.result).find((item) => item && typeof item === 'object')
  if (!result) throw new Error('没有找到 Pokecatch 游戏页面。请确认游戏已打开并等待加载完成。')
  return result
}

async function readEmbeddedSave() {
  const { tab, error } = await findGameTab()
  if (!tab) throw new Error(error)
  const result = await runGameFrameOperation(tab.id, '', 'read')
  if (!result.ok) {
    if (result.code === 'missing') throw new Error('游戏页面里还没有本机存档。请先在游戏中完成一次保存。')
    if (result.code === 'invalid') throw new Error('游戏页面里的存档格式无法识别，未读取或上传。')
    throw new Error('读取游戏页面存储失败。')
  }
  if (!validSave(result.raw)) throw new Error('存档超过 4 MB 或格式无法识别，未交接。')
  return { raw: result.raw, origin: await findSaveSyncOrigin() }
}

async function restoreEmbeddedSave(raw) {
  if (!validSave(raw)) throw new Error('云端存档超过 4 MB 或格式无法识别。')
  const { tab, error } = await findGameTab()
  if (!tab) throw new Error(error)
  const result = await runGameFrameOperation(tab.id, raw, 'write')
  if (!result.ok) {
    if (result.code === 'storage') throw new Error('游戏页面拒绝写入存档，原进度未被覆盖。')
    throw new Error('云端存档格式无法识别，原进度未被覆盖。')
  }
  return { ok: true, mons: result.mons }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'pokecatch-read-embedded') {
    readEmbeddedSave().then((result) => sendResponse({ ok: true, ...result })).catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    })
    return true
  }
  if (message?.type === 'pokecatch-restore-embedded') {
    restoreEmbeddedSave(message.raw).then((result) => sendResponse(result)).catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    })
    return true
  }
  if (message?.type === 'pokecatch-store-pending') {
    if (!validSave(message.raw)) {
      sendResponse({ ok: false, error: '存档超过 4 MB 或格式无法识别。' })
      return false
    }
    chrome.storage.local.set({ pokecatchPendingUpload: message.raw }).then(() => sendResponse({ ok: true }))
    return true
  }
  if (message?.type === 'pokecatch-get-pending') {
    chrome.storage.local.get('pokecatchPendingUpload').then((values) => {
      sendResponse({ raw: values.pokecatchPendingUpload || null })
    })
    return true
  }
  if (message?.type === 'pokecatch-clear-pending') {
    chrome.storage.local.remove('pokecatchPendingUpload').then(() => sendResponse({ ok: true }))
    return true
  }
  return false
})
