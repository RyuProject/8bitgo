import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'

const extensionRoot = new URL('../browser-extension/pokecatch-save-bridge/', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('manifest.safari.json', extensionRoot), 'utf8'))
const backgroundSource = await readFile(new URL('background.safari.js', extensionRoot), 'utf8')
const mainSource = await readFile(new URL('game-main.safari.js', extensionRoot), 'utf8')
const bridgeSource = await readFile(new URL('game-bridge.safari.js', extensionRoot), 'utf8')
const pageBridgeSource = await readFile(new URL('bridge.js', extensionRoot), 'utf8')
const validRaw = JSON.stringify({ v: 1, mons: Array.from({ length: 45 }, (_, index) => index + 1) })

assert.equal(manifest.manifest_version, 2, 'Safari uses an event-page manifest rather than a service worker')
assert.deepEqual(manifest.background, { scripts: ['background.safari.js'], persistent: false })
assert.equal(manifest.permissions.includes('scripting'), false, 'Safari does not rely on dynamic frame injection')
assert.equal(manifest.permissions.includes('webNavigation'), false, 'Safari does not request frame enumeration')
const mainScript = manifest.content_scripts.find((script) => script.js.includes('game-main.safari.js'))
const gameBridgeScript = manifest.content_scripts.find((script) => script.js.includes('game-bridge.safari.js'))
const pageBridgeScript = manifest.content_scripts.find((script) => script.js.includes('bridge.js'))
assert.deepEqual(mainScript.matches, ['https://pokecatch-online.netlify.app/*'])
assert.equal(mainScript.world, 'MAIN')
assert.equal(mainScript.all_frames, true)
assert.equal(gameBridgeScript.all_frames, true)
assert.ok(pageBridgeScript.matches.includes('https://8bitgo.com/*/pokecatch-save-sync*'), 'Safari bridge also matches localized save pages')

function createHarness({
  gameSave = validRaw,
  gameTabs = [{ id: 3, url: 'https://pokecatch-online.netlify.app/#' }],
  appTabs = [{ id: 4, url: 'https://8bitgo.com/games/pokecatch' }],
  gameHost = 'pokecatch-online.netlify.app',
} = {}) {
  const gameStore = new Map([['gachamon-save-v1', gameSave], ['unrelated-auth-token', 'must-not-read']])
  const extensionStore = new Map()
  const readKeys = []
  const writeKeys = []
  const timers = new Map()
  const reloads = []
  let timerId = 0
  let backgroundListener
  let gameListener
  const windowListeners = new Map()
  const origin = `https://${gameHost}`
  const window = {
    addEventListener(type, listener) {
      const listeners = windowListeners.get(type) || []
      listeners.push(listener)
      windowListeners.set(type, listeners)
    },
    postMessage(data, targetOrigin) {
      if (targetOrigin !== origin) return
      for (const listener of windowListeners.get('message') || []) listener({ source: window, origin, data })
    },
  }
  const localStorage = {
    getItem(key) {
      readKeys.push(key)
      return gameStore.has(key) ? gameStore.get(key) : null
    },
    setItem(key, value) {
      writeKeys.push(key)
      gameStore.set(key, String(value))
    },
  }
  const timeout = (callback) => {
    const id = ++timerId
    timers.set(id, callback)
    return id
  }
  const clearTimeoutFake = (id) => timers.delete(id)

  const frameBrowser = {
    runtime: {
      onMessage: { addListener(listener) { gameListener = listener } },
    },
  }
  const frameContext = vm.createContext({
    window,
    location: { hostname: gameHost, origin, reload: () => reloads.push('game-frame') },
    localStorage,
    browser: frameBrowser,
    TextEncoder,
    crypto: webcrypto,
    Date,
    Uint8Array,
    setTimeout: timeout,
    clearTimeout: clearTimeoutFake,
    Promise,
  })
  vm.runInContext(mainSource, frameContext, { filename: 'game-main.safari.js' })
  vm.runInContext(bridgeSource, frameContext, { filename: 'game-bridge.safari.js' })

  const browser = {
    runtime: { onMessage: { addListener(listener) { backgroundListener = listener } } },
    tabs: {
      async query({ url }) {
        return url?.[0]?.includes('pokecatch-online.netlify.app')
          ? gameTabs.filter((tab) => tab.url.includes('pokecatch-online.netlify.app'))
          : appTabs
      },
      async sendMessage(tabId, message) {
        assert.ok([3, 4].includes(tabId))
        return new Promise((resolve) => {
          const keepChannelOpen = gameListener(message, { tab: { id: tabId, url: origin } }, resolve)
          assert.equal(keepChannelOpen, true)
        })
      },
    },
    storage: {
      local: {
        async set(values) { for (const [key, value] of Object.entries(values)) extensionStore.set(key, value) },
        async get(key) { return { [key]: extensionStore.get(key) } },
        async remove(key) { extensionStore.delete(key) },
      },
    },
  }
  vm.runInNewContext(backgroundSource, { browser, TextEncoder, URL, Promise, Map, Error }, { filename: 'background.safari.js' })

  async function message(message) {
    assert.equal(typeof backgroundListener, 'function', 'Safari background message listener registered')
    return new Promise((resolve) => {
      const keepChannelOpen = backgroundListener(message, {}, resolve)
      assert.equal(keepChannelOpen, true)
    })
  }

  return { message, gameStore, readKeys, writeKeys, timers, reloads }
}

const harness = createHarness()
const read = await harness.message({ type: 'pokecatch-read-embedded' })
assert.deepEqual(JSON.parse(JSON.stringify(read)), { ok: true, raw: validRaw, origin: 'https://8bitgo.com' })
assert.deepEqual(harness.readKeys, ['gachamon-save-v1'], 'Safari reads only the game save key')
assert.deepEqual(harness.writeKeys, [])

const replacement = JSON.stringify({ v: 1, mons: [1, 2, 3] })
const restoreHarness = createHarness()
const restored = await restoreHarness.message({ type: 'pokecatch-restore-embedded', raw: replacement })
assert.deepEqual(JSON.parse(JSON.stringify(restored)), { ok: true, mons: 3 })
assert.equal(restoreHarness.gameStore.get('8bitgo.pokecatch.backup.v1'), validRaw)
assert.equal(restoreHarness.gameStore.get('gachamon-save-v1'), replacement)
assert.deepEqual(restoreHarness.readKeys, ['gachamon-save-v1'])
assert.deepEqual(restoreHarness.writeKeys, ['8bitgo.pokecatch.backup.v1', 'gachamon-save-v1'])
assert.equal(restoreHarness.timers.size, 1, 'the Safari bridge clears its response timer and leaves only the delayed reload')
const [reloadTimer, reload] = restoreHarness.timers.entries().next().value
reload()
assert.deepEqual(restoreHarness.reloads, ['game-frame'])
restoreHarness.timers.delete(reloadTimer)

const invalidHarness = createHarness({ gameSave: '{not-json' })
const invalid = await invalidHarness.message({ type: 'pokecatch-read-embedded' })
assert.equal(invalid.ok, false)
assert.equal(invalid.error, '游戏页面里的存档格式无法识别，未读取或上传。')
assert.deepEqual(invalidHarness.writeKeys, [], 'invalid game storage is never changed')

const missingFrameHarness = createHarness({ gameTabs: [], gameHost: 'wrong.example' })
const missing = await missingFrameHarness.message({ type: 'pokecatch-read-embedded' })
assert.equal(missing.ok, false)
assert.match(missing.error, /没有找到 Pokecatch 游戏页面/)
assert.deepEqual(missingFrameHarness.readKeys, [], 'the page bridge does not inspect unrelated origins')

const pageMessages = []
const extensionMessages = []
const pageListeners = []
const pageWindow = {
  addEventListener(type, listener) { if (type === 'message') pageListeners.push(listener) },
  postMessage(data, targetOrigin) {
    assert.equal(targetOrigin, 'https://8bitgo.com')
    pageMessages.push(data)
  },
}
const pageContext = vm.createContext({
  window: pageWindow,
  location: { origin: 'https://8bitgo.com' },
  browser: {
    runtime: {
      sendMessage(message) {
        extensionMessages.push(message)
        if (message.type === 'pokecatch-get-pending') return Promise.resolve({ raw: validRaw })
        if (message.type === 'pokecatch-restore-embedded') return Promise.resolve({ ok: true, mons: 3 })
        return Promise.resolve({ ok: true })
      },
    },
  },
  Promise,
})
vm.runInContext(pageBridgeSource, pageContext, { filename: 'bridge.js' })
const sendPageMessage = (data) => pageListeners.forEach((listener) => listener({
  source: pageWindow,
  origin: 'https://8bitgo.com',
  data,
}))
sendPageMessage({ source: '8bitgo-pokecatch-page', type: 'ready' })
await new Promise((resolve) => setImmediate(resolve))
assert.ok(pageMessages.some((message) => message.type === 'bridge-ready'))
assert.ok(pageMessages.some((message) => message.type === 'embedded-save' && message.raw === validRaw))
sendPageMessage({ source: '8bitgo-pokecatch-page', type: 'restore-embedded', raw: replacement })
await new Promise((resolve) => setImmediate(resolve))
assert.deepEqual(extensionMessages.map((message) => message.type), [
  'pokecatch-get-pending',
  'pokecatch-restore-embedded',
])
assert.ok(pageMessages.some((message) => message.type === 'restore-result' && message.ok))
sendPageMessage({ source: '8bitgo-pokecatch-page', type: 'pending-save-received' })
assert.equal(extensionMessages.at(-1).type, 'pokecatch-clear-pending')

console.log('✅ Safari 静态主世界脚本仅读写指定存档键；支持顶层游戏标签，恢复前备份，且不依赖动态 frame 注入或 frameId API')
