/** PokeCatch 跨浏览器云存档交接：只用合成进度，不接触玩家真实存档。 */
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {
  parsePokecatchSave,
  pokecatchBookmarklet,
  pokecatchCloudImportUrl,
  pokecatchGameImportUrl,
  pokecatchAutoUploadAction,
  readPokecatchTransferHash,
  POKECATCH_SAVE_KEY,
} from '../src/emulator/pokecatchCloudSave.ts'
import { decodeSaveArchive, encodeSaveArchive } from '../src/emulator/saveEnvelope.ts'
import { MAX_SAVE_BYTES, saveCoords } from '../server/src/routes/saves.js'

const save = JSON.stringify({ v: 2, mons: Array.from({ length: 45 }, (_, id) => ({ id })) })
const valid = parsePokecatchSave(save)
assert.equal(valid.mons.length, 45)
assert.throws(() => parsePokecatchSave('{broken'), /有效的 Pokecatch 存档/)
assert.throws(() => parsePokecatchSave(JSON.stringify({ v: 2, mons: Array(152) })), /存档结构不匹配/)

for (const url of [pokecatchCloudImportUrl(save), pokecatchGameImportUrl(save)]) {
  assert.equal(readPokecatchTransferHash(new URL(url).hash), save)
}
assert.equal(readPokecatchTransferHash('#other=ignore'), null)
assert.equal(pokecatchAutoUploadAction({ exists: false, raw: null }, save), 'upload')
assert.equal(pokecatchAutoUploadAction({ exists: true, raw: save }, save), 'already-synced')
assert.equal(pokecatchAutoUploadAction({ exists: true, raw: 'older-save' }, save), 'confirm-overwrite')
assert.equal(pokecatchAutoUploadAction({ exists: true, raw: null }, save), 'confirm-overwrite')

const coordinate = { runtime: 'html5', gameSlug: 'pokecatch', slot: 0 }
assert.deepEqual(saveCoords({ runtime: coordinate.runtime, slug: coordinate.gameSlug, slot: coordinate.slot }), {
  ok: true,
  runtime: coordinate.runtime,
  slug: coordinate.gameSlug,
  slot: coordinate.slot,
})
const archive = await encodeSaveArchive(new TextEncoder().encode(save), coordinate, { core: 'pokecatch-web', format: 'gachamon-save-v1' })
const decoded = await decodeSaveArchive(archive, coordinate)
assert.equal(new TextDecoder().decode(decoded.payload), save)
assert.equal(decoded.header?.format, 'gachamon-save-v1')
assert.ok(new TextEncoder().encode(save).length < MAX_SAVE_BYTES)

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.textContent = ''; this.href = '' }
  append(child) { this.children.push(child) }
  remove() { this.removed = true }
}

function executeBookmarklet({ hostname = 'pokecatch-online.netlify.app', hash = '', original = save, allow = true } = {}) {
  const values = new Map([[POKECATCH_SAVE_KEY, original]])
  const nodes = []
  const alerts = []
  let reloads = 0
  const document = {
    createElement(tag) { return new Element(tag) },
    body: { append(node) { nodes.push(node) } },
  }
  const sandbox = {
    document,
    location: { hostname, hash, pathname: '/', search: '', reload() { reloads++ } },
    history: { replaceState(_state, _title, path) { sandbox.cleanedPath = path } },
    localStorage: {
      getItem(key) { return values.has(key) ? values.get(key) : null },
      setItem(key, value) { values.set(key, String(value)) },
    },
    alert(message) { alerts.push(message) },
    confirm() { return allow },
    TextEncoder,
    Blob,
    URL: { createObjectURL() { return 'blob:test-save' }, revokeObjectURL() {} },
    setTimeout,
    JSON,
    Number,
    Array,
    String,
  }
  const source = pokecatchBookmarklet().slice('javascript:'.length)
  vm.runInNewContext(source, sandbox)
  return { values, nodes, alerts, get reloads() { return reloads }, sandbox }
}

const bookmark = pokecatchBookmarklet()
const exported = executeBookmarklet()
const box = exported.nodes[0]
const syncLink = box.children.find((node) => node.tagName === 'a' && node.target === '_blank')
assert.ok(syncLink, '一枚同步书签生成 8BitGo 交接链接')
assert.equal(readPokecatchTransferHash(new URL(syncLink.href).hash), save)
assert.ok(box.children.some((node) => node.tagName === 'button' && node.textContent === '从 JSON 文件恢复'), '同一书签提供大文件恢复入口')
assert.ok(bookmark.startsWith('javascript:') && bookmark.length < 3000, '单枚同步书签适配常见书签网址长度')

const gameUrl = pokecatchGameImportUrl(save)
const imported = executeBookmarklet({ hash: new URL(gameUrl).hash, original: JSON.stringify({ v: 2, mons: [{ id: 'old' }] }) })
assert.equal(imported.values.get(POKECATCH_SAVE_KEY), save, '目标浏览器写回 Pokecatch 存档键')
assert.ok(imported.values.has('8bitgo.pokecatch.backup.v1'), '覆盖前备份目标浏览器原存档')
assert.equal(imported.reloads, 1, '导入后刷新游戏')
assert.equal(imported.sandbox.cleanedPath, '/', '导入前清理地址片段')

const cancelled = executeBookmarklet({ hash: new URL(gameUrl).hash, original: 'keep-me', allow: false })
assert.equal(cancelled.values.get(POKECATCH_SAVE_KEY), 'keep-me', '取消确认时保留目标本机存档')
assert.equal(cancelled.values.has('8bitgo.pokecatch.backup.v1'), false)
assert.equal(cancelled.reloads, 0)

const blockedHost = executeBookmarklet({ hostname: 'evil.example' })
assert.equal(blockedHost.nodes.length, 0, '导出书签拒绝非游戏域名')
assert.equal(blockedHost.alerts.length, 1)

// 用浏览器存储和云 API 替身跑真实 saves.ts：模拟源设备 PUT、目标设备 GET。
globalThis.__viteEnv = { VITE_API_URL: 'https://api.test' }
const token = `header.${Buffer.from(JSON.stringify({ uid: 'pokecatch-test-user' })).toString('base64url')}.signature`
const browserValues = new Map([['8bitgo.token', token]])
globalThis.localStorage = {
  getItem(key) { return browserValues.has(key) ? browserValues.get(key) : null },
  setItem(key, value) { browserValues.set(key, String(value)) },
  removeItem(key) { browserValues.delete(key) },
}

const databases = new Map()
class IdbRequest {
  onsuccess = null
  onerror = null
  onupgradeneeded = null
  onblocked = null
  result = undefined
}
function makeTransaction(stores) {
  const transaction = {
    pending: 0,
    completeScheduled: false,
    completed: false,
    oncomplete: null,
    onerror: null,
    onabort: null,
    settleRequest(request, result) {
      request.result = result
      transaction.pending++
      queueMicrotask(() => {
        request.onsuccess?.()
        transaction.pending--
        if (transaction.pending || transaction.completeScheduled || transaction.completed) return
        transaction.completeScheduled = true
        queueMicrotask(() => {
          transaction.completeScheduled = false
          if (transaction.pending || transaction.completed) return
          transaction.completed = true
          transaction.oncomplete?.()
        })
      })
      return request
    },
    objectStore(name) {
      if (!stores.has(name)) stores.set(name, new Map())
      const values = stores.get(name)
      return {
        get(key) { return transaction.settleRequest(new IdbRequest(), values.has(key) ? structuredClone(values.get(key)) : undefined) },
        put(value, key) { values.set(key, structuredClone(value)); return transaction.settleRequest(new IdbRequest(), key) },
        delete(key) { values.delete(key); return transaction.settleRequest(new IdbRequest(), undefined) },
        getAllKeys() { return transaction.settleRequest(new IdbRequest(), [...values.keys()]) },
      }
    },
  }
  return transaction
}
globalThis.indexedDB = {
  open(name) {
    const fresh = !databases.has(name)
    if (fresh) databases.set(name, new Map())
    const stores = databases.get(name)
    const request = new IdbRequest()
    request.result = {
      objectStoreNames: { contains: (store) => stores.has(store) },
      createObjectStore: (store) => (stores.set(store, new Map()), {}),
      transaction: () => makeTransaction(stores),
    }
    queueMicrotask(() => {
      if (fresh) request.onupgradeneeded?.()
      request.onsuccess?.()
    })
    return request
  },
}

let cloudArchive = null
let cloudRevision = null
const responseHeaders = (entries = {}) => ({ get(name) { return entries[String(name).toLowerCase()] ?? null } })
globalThis.fetch = async (url, init = {}) => {
  if (init.method === 'PUT') {
    const body = init.body instanceof Uint8Array ? init.body : new Uint8Array(init.body)
    cloudArchive = body.slice()
    cloudRevision = init.headers['x-save-revision']
    return { ok: true, status: 200, headers: responseHeaders({ 'x-save-revision': cloudRevision }), json: async () => ({ revision: cloudRevision }) }
  }
  if (String(url).includes('/meta?')) {
    return cloudArchive
      ? { ok: true, status: 200, headers: responseHeaders({ 'x-save-revision': cloudRevision }), json: async () => ({ revision: cloudRevision }) }
      : { ok: true, status: 204, headers: responseHeaders(), json: async () => ({}) }
  }
  if (!cloudArchive) return { ok: false, status: 404, headers: responseHeaders(), json: async () => ({}) }
  const archiveBytes = cloudArchive.slice()
  return {
    ok: true,
    status: 200,
    headers: responseHeaders({ 'x-save-revision': cloudRevision, 'x-save-updated-at': String(Date.now()) }),
    arrayBuffer: async () => archiveBytes.buffer.slice(archiveBytes.byteOffset, archiveBytes.byteOffset + archiveBytes.byteLength),
  }
}

const { pushSave, fetchCloudSaveStrict } = await import('../src/services/saves.ts')
const pushed = await pushSave('html5', 'pokecatch', new TextEncoder().encode(save), 0, 'cloud', { core: 'pokecatch-web', format: 'gachamon-save-v1' })
assert.equal(pushed.where, 'cloud', '真实前端云存档服务将存档上传到账号云端')
// 不读取源设备的 IndexedDB；目标设备通过云接口单独取回并核对原始游戏 JSON。
const pulled = await fetchCloudSaveStrict('html5', 'pokecatch', 0)
assert.ok(pulled)
assert.equal(new TextDecoder().decode(pulled.data), save, '另一设备从云端取回的游戏存档逐字节一致')
assert.equal(pulled.format, 'gachamon-save-v1')

console.log('✅ 一枚 PokeCatch 书签可导出或恢复合成存档，并交接到另一设备')
console.log('✅ html5 / pokecatch / slot 0 可进入云存档坐标，存档封装解码后 payload 原样一致')
console.log('✅ 真实 pushSave / fetchCloudSaveStrict 服务完成跨设备上传与下载往返')
console.log('✅ 取消覆盖不会改动目标存档，书签脚本仅在游戏精确域名执行')
