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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

async function findGameTab() {
  const directTabs = await browser.tabs.query({ url: GAME_URLS })
  if (directTabs.length > 1) throw new Error('请只保留一个打开中的 Pokecatch 游戏标签页，再重试。')
  if (directTabs.length === 1) return directTabs[0]
  // 兼容仍开着旧版 8BitGo 内嵌页的玩家；新版入口会优先使用游戏顶层标签。
  const appTabs = await browser.tabs.query({ url: APP_GAME_URLS })
  if (!appTabs.length) throw new Error('请先打开 Pokecatch 游戏标签页。')
  if (appTabs.length > 1) throw new Error('请只保留一个打开中的《Pokecatch》游戏页，再重试。')
  return appTabs[0]
}

async function findSaveSyncOrigin() {
  const tabs = await browser.tabs.query({ url: APP_GAME_URLS })
  const tab = tabs.find((item) => {
    try { return ['https:', 'http:'].includes(new URL(item.url).protocol) } catch { return false }
  })
  return tab ? new URL(tab.url).origin : 'https://8bitgo.com'
}

async function requestGameFrame(tab, mode, raw = '') {
  try {
    // Safari 不支持 scripting.executeScript 的 frameId / allFrames；静态内容脚本只匹配游戏源站，并在命中的框里自检。
    return await browser.tabs.sendMessage(tab.id, { type: 'pokecatch-frame-operation', mode, raw })
  } catch {
    throw new Error('没有找到 Pokecatch 游戏页面。请确认游戏已打开并等待加载完成，且 Safari 已允许扩展访问游戏网站。')
  }
}

async function readEmbeddedSave() {
  const tab = await findGameTab()
  const result = await requestGameFrame(tab, 'read')
  if (!result?.ok) {
    if (result?.code === 'missing') throw new Error('游戏页面里还没有本机存档。请先在游戏中完成一次保存。')
    if (result?.code === 'invalid') throw new Error('游戏页面里的存档格式无法识别，未读取或上传。')
    if (result?.code === 'too-large') throw new Error('游戏存档超过 4 MB，未交接。')
    throw new Error('读取游戏页面存储失败。')
  }
  if (!validSave(result.raw)) throw new Error('存档超过 4 MB 或格式无法识别，未交接。')
  return { raw: result.raw, origin: await findSaveSyncOrigin() }
}

async function restoreEmbeddedSave(raw) {
  if (!validSave(raw)) throw new Error('云端存档超过 4 MB 或格式无法识别。')
  const tab = await findGameTab()
  const result = await requestGameFrame(tab, 'write', raw)
  if (!result?.ok) {
    if (result?.code === 'storage') throw new Error('游戏页面拒绝写入存档，原进度未被覆盖。')
    throw new Error('云端存档格式无法识别，原进度未被覆盖。')
  }
  return { ok: true, mons: result.mons }
}

function respond(promise, sendResponse) {
  promise.then(sendResponse).catch((error) => sendResponse({ ok: false, error: errorMessage(error) }))
  return true
}

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'pokecatch-read-embedded') return respond(readEmbeddedSave().then((result) => ({ ok: true, ...result })), sendResponse)
  if (message?.type === 'pokecatch-restore-embedded') return respond(restoreEmbeddedSave(message.raw), sendResponse)

  if (message?.type === 'pokecatch-store-pending') {
    if (!validSave(message.raw)) {
      sendResponse({ ok: false, error: '存档超过 4 MB 或格式无法识别。' })
      return false
    }
    return respond(browser.storage.local.set({ pokecatchPendingUpload: message.raw }).then(() => ({ ok: true })), sendResponse)
  }
  if (message?.type === 'pokecatch-get-pending') {
    return respond(browser.storage.local.get('pokecatchPendingUpload').then((values) => ({ raw: values.pokecatchPendingUpload || null })), sendResponse)
  }
  if (message?.type === 'pokecatch-clear-pending') {
    return respond(browser.storage.local.remove('pokecatchPendingUpload').then(() => ({ ok: true })), sendResponse)
  }
  return false
})
