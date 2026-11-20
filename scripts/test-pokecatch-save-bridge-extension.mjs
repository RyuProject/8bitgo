import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const extensionRoot = new URL('../browser-extension/pokecatch-save-bridge/', import.meta.url)
const backgroundSource = await readFile(new URL('background.js', extensionRoot), 'utf8')
const chromeManifest = JSON.parse(await readFile(new URL('manifest.json', extensionRoot), 'utf8'))
const firefoxManifest = JSON.parse(await readFile(new URL('manifest.firefox-android.json', extensionRoot), 'utf8'))
const validRaw = JSON.stringify({ v: 1, mons: Array.from({ length: 45 }, (_, index) => index + 1) })
const plain = (value) => JSON.parse(JSON.stringify(value))

function createHarness({
  firefox = false,
  gameSave = validRaw,
  gameTabs = [{ id: 3, url: 'https://pokecatch-online.netlify.app/#' }],
  appTabs = [{ id: 4, url: 'https://8bitgo.com/games/pokecatch' }],
  frames,
} = {}) {
  const gameStore = new Map([['gachamon-save-v1', gameSave], ['unrelated-auth-token', 'must-not-read']])
  const appStore = new Map()
  const readKeys = []
  const writeKeys = []
  const reloads = []
  const injections = []
  let messageHandler

  function storageFor(map) {
    return {
      getItem(key) {
        readKeys.push(key)
        return map.has(key) ? map.get(key) : null
      },
      setItem(key, value) {
        writeKeys.push(key)
        map.set(key, String(value))
      },
    }
  }

  const pageFrames = frames || [{ frameId: 0, url: 'https://pokecatch-online.netlify.app/#' }]

  const chrome = {
    runtime: { onMessage: { addListener(handler) { messageHandler = handler } } },
    tabs: {
      async query({ url }) { return url?.[0]?.includes('pokecatch-online.netlify.app') ? gameTabs : appTabs },
    },
    scripting: {
      async executeScript(details) {
        injections.push(details)
        const selected = details.target.frameIds
          ? pageFrames.filter((frame) => details.target.frameIds.includes(frame.frameId))
          : pageFrames
        return selected.map((frame) => {
          const gameFrame = new URL(frame.url).hostname === 'pokecatch-online.netlify.app'
          const localStorage = storageFor(gameFrame ? gameStore : appStore)
          const pageContext = vm.createContext({
            location: { hostname: new URL(frame.url).hostname, reload: () => reloads.push(frame.frameId) },
            localStorage,
            setTimeout: (callback) => { reloads.push(callback); return reloads.length },
          })
          const injected = vm.runInContext(`(${details.func.toString()})`, pageContext)
          return { frameId: frame.frameId, result: injected(...details.args) }
        })
      },
    },
    storage: {
      local: {
        async set() {},
        async get() { return {} },
        async remove() {},
      },
    },
  }
  if (!firefox) chrome.webNavigation = { async getAllFrames() { return pageFrames } }

  const context = vm.createContext({ chrome, TextEncoder, URL, setTimeout })
  vm.runInContext(backgroundSource, context, { filename: 'background.js' })

  async function message(message) {
    assert.equal(typeof messageHandler, 'function', 'background message listener registered')
    return new Promise((resolve) => {
      const keepChannelOpen = messageHandler(message, {}, resolve)
      assert.equal(keepChannelOpen, true)
    })
  }

  return { message, gameStore, readKeys, writeKeys, reloads, injections }
}

const chromeHarness = createHarness()
const read = await chromeHarness.message({ type: 'pokecatch-read-embedded' })
assert.deepEqual(plain(read), { ok: true, raw: validRaw, origin: 'https://8bitgo.com' })
assert.deepEqual(chromeHarness.readKeys, ['gachamon-save-v1'], 'reads only the game save key')
assert.deepEqual(plain(chromeHarness.injections[0].target), { tabId: 3, frameIds: [0] }, 'Chrome targets the direct game tab top frame')
assert.equal(chromeHarness.injections[0].world, 'MAIN')

const replacement = JSON.stringify({ v: 1, mons: [1, 2, 3] })
const restoreHarness = createHarness()
const restored = await restoreHarness.message({ type: 'pokecatch-restore-embedded', raw: replacement })
assert.deepEqual(plain(restored), { ok: true, mons: 3 })
assert.equal(restoreHarness.gameStore.get('gachamon-save-v1'), replacement)
assert.equal(restoreHarness.gameStore.get('8bitgo.pokecatch.backup.v1'), validRaw, 'backs up the prior game save')
assert.deepEqual(restoreHarness.readKeys, ['gachamon-save-v1'])
assert.deepEqual(restoreHarness.writeKeys, ['8bitgo.pokecatch.backup.v1', 'gachamon-save-v1'])
assert.equal(typeof restoreHarness.reloads[0], 'function', 'reload is deferred until after the extension reply')
restoreHarness.reloads[0]()
assert.deepEqual(restoreHarness.reloads.slice(1), [0])

const invalidHarness = createHarness({ gameSave: '{not-json' })
const invalidRead = await invalidHarness.message({ type: 'pokecatch-read-embedded' })
assert.deepEqual(plain(invalidRead), { ok: false, error: '游戏页面里的存档格式无法识别，未读取或上传。' })
assert.deepEqual(invalidHarness.writeKeys, [], 'invalid data is not modified')

const firefoxHarness = createHarness({ firefox: true })
const firefoxRead = await firefoxHarness.message({ type: 'pokecatch-read-embedded' })
assert.deepEqual(plain(firefoxRead), { ok: true, raw: validRaw, origin: 'https://8bitgo.com' })
assert.deepEqual(plain(firefoxHarness.injections[0].target), { tabId: 3, allFrames: true }, 'Firefox falls back to frame self-identification on the direct game tab')
assert.deepEqual(firefoxHarness.readKeys, ['gachamon-save-v1'], 'Firefox reads only the direct game tab save key')

assert.equal(firefoxManifest.manifest_version, 3)
assert.deepEqual(firefoxManifest.background, { scripts: ['background.js'] }, 'Firefox Android uses an event-page background')
assert.equal(firefoxManifest.permissions.includes('webNavigation'), false, 'Firefox Android does not request unused webNavigation access')
assert.equal(firefoxManifest.browser_specific_settings.gecko.strict_min_version, '128.0')
assert.equal(firefoxManifest.browser_specific_settings.gecko_android.strict_min_version, '128.0')
assert.ok(chromeManifest.content_scripts[0].matches.includes('https://8bitgo.com/*/pokecatch-save-sync*'), 'Chrome extension matches localized save pages')
assert.ok(firefoxManifest.content_scripts[0].matches.includes('https://cn.8bitgo.com/*/pokecatch-save-sync*'), 'Firefox extension matches localized save pages')

const legacyHarness = createHarness({
  gameTabs: [],
  frames: [
    { frameId: 0, url: 'https://8bitgo.com/games/pokecatch' },
    { frameId: 7, url: 'https://pokecatch-online.netlify.app/' },
  ],
})
const legacyRead = await legacyHarness.message({ type: 'pokecatch-read-embedded' })
assert.deepEqual(plain(legacyRead), { ok: true, raw: validRaw, origin: 'https://8bitgo.com' })
assert.deepEqual(plain(legacyHarness.injections[0].target), { tabId: 4, frameIds: [7] }, 'older embedded sessions still work as a fallback')

const cnOriginHarness = createHarness({ appTabs: [{ id: 4, url: 'https://cn.8bitgo.com/en/games/pokecatch' }] })
const cnOriginRead = await cnOriginHarness.message({ type: 'pokecatch-read-embedded' })
assert.equal(cnOriginRead.origin, 'https://cn.8bitgo.com', 'the transfer opens on the already signed-in 8BitGo host')

console.log('✅ 扩展读取 Pokecatch 顶层游戏页；旧内嵌页仍可用，Chrome / Firefox Android 均限读指定存档键，恢复前备份再刷新')
