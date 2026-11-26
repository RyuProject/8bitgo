import assert from 'node:assert/strict'

const DELETE = Symbol('delete')

class Request {
  result = undefined
  error = undefined
  onsuccess = null
  onerror = null

  succeed(value) {
    this.result = value
    queueMicrotask(() => this.onsuccess?.({ target: this }))
  }
}

class StoreData {
  constructor(name, keyPath) {
    this.name = name
    this.keyPath = keyPath
    this.records = new Map()
    this.indexes = new Set()
  }
}

class Database {
  stores = new Map()
  quotaBytes
  sessionsGetAllReads = 0

  constructor(quotaBytes) { this.quotaBytes = quotaBytes }
  get objectStoreNames() { return { contains: (name) => this.stores.has(name) } }
  createObjectStore(name, { keyPath }) {
    const store = new StoreData(name, keyPath)
    this.stores.set(name, store)
    return { createIndex: (index) => store.indexes.add(index) }
  }
  transaction(names, mode) { return new Transaction(this, Array.isArray(names) ? names : [names], mode) }
}

class Transaction {
  changes = new Map()
  oncomplete = null
  onabort = null
  onerror = null
  aborted = false
  scheduled = false

  constructor(db, names, mode) { this.db = db; this.names = names; this.mode = mode }
  objectStore(name) {
    assert.ok(this.names.includes(name))
    return new ObjectStore(this, this.db.stores.get(name))
  }
  changeMap(name) {
    let changes = this.changes.get(name)
    if (!changes) this.changes.set(name, changes = new Map())
    return changes
  }
  partBytesAfterChanges() {
    const records = new Map(this.db.stores.get('parts').records)
    for (const [key, value] of this.changes.get('parts') ?? []) {
      if (value === DELETE) records.delete(key)
      else records.set(key, value)
    }
    return [...records.values()].reduce((sum, record) => sum + record.blob.size, 0)
  }
  stage(name, key, value) {
    if (this.mode !== 'readwrite') throw new Error('readonly transaction')
    this.changeMap(name).set(key, value)
    if (this.partBytesAfterChanges() > this.db.quotaBytes) this.aborted = true
    this.schedule()
  }
  schedule() {
    if (this.scheduled) return
    this.scheduled = true
    setTimeout(() => {
      if (this.aborted) {
        this.onabort?.({ target: this })
        return
      }
      for (const [name, changes] of this.changes) {
        const records = this.db.stores.get(name).records
        for (const [key, value] of changes) {
          if (value === DELETE) records.delete(key)
          else records.set(key, value)
        }
      }
      this.oncomplete?.({ target: this })
    }, 0)
  }
}

const normalizedKey = (key) => Array.isArray(key) ? JSON.stringify(key) : String(key)

class ObjectStore {
  constructor(transaction, store) { this.transaction = transaction; this.store = store }
  get indexNames() { return { contains: (name) => this.store.indexes.has(name) } }
  recordKey(value) {
    return this.store.name === 'parts'
      ? JSON.stringify([value.downloadKey, value.index])
      : String(value.key)
  }
  get(key) {
    const request = new Request()
    request.succeed(this.store.records.get(normalizedKey(key)) ?? null)
    return request
  }
  getAll() {
    if (this.store.name === 'sessions') this.transaction.db.sessionsGetAllReads += 1
    const request = new Request()
    request.succeed([...this.store.records.values()])
    return request
  }
  put(value) {
    const request = new Request()
    request.succeed(undefined)
    this.transaction.stage(this.store.name, this.recordKey(value), value)
    return request
  }
  delete(key) {
    this.transaction.stage(this.store.name, normalizedKey(key), DELETE)
  }
  index(name) {
    assert.ok(this.store.indexes.has(name))
    return new Index(this.transaction, this.store)
  }
}

class Index {
  constructor(transaction, store) { this.transaction = transaction; this.store = store }
  matching(query) { return [...this.store.records.values()].filter((record) => record.downloadKey === query) }
  getAll(query) {
    const request = new Request()
    request.succeed(this.matching(query))
    return request
  }
  openKeyCursor(query) {
    const request = new Request()
    const records = this.matching(query)
    let at = 0
    const step = () => {
      if (at >= records.length) {
        request.result = null
        request.onsuccess?.({ target: request })
        return
      }
      const record = records[at++]
      request.result = {
        primaryKey: [record.downloadKey, record.index],
        continue: () => queueMicrotask(step),
      }
      request.onsuccess?.({ target: request })
    }
    queueMicrotask(step)
    return request
  }
}

const database = new Database(4 * 1024)
const fakeIndexedDb = {
  open() {
    const request = new Request()
    queueMicrotask(() => {
      request.result = database
      if (!database.stores.size) request.onupgradeneeded?.({ target: request })
      request.onsuccess?.({ target: request })
    })
    return request
  },
}

Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: fakeIndexedDb })
Object.defineProperty(globalThis, 'IDBKeyRange', { configurable: true, value: { only: (value) => value } })

const { downloadResumeStore } = await import('../src/emulator/downloadResume.ts')
assert.equal(await downloadResumeStore.load('warmup', 1024), null)

// 一局分成多个分片时，正常巡检只扫一次会话表，而不是每片都重复 getAll。
for (let index = 0; index < 4; index += 1) {
  assert.equal(await downloadResumeStore.put(
    'routine-cleanup', 4 * 1024, 1024, index, new Blob([new Uint8Array(1024)]),
  ), true)
}
assert.equal(database.sessionsGetAllReads, 1, '同一轮分片写入的常规清理应合并为一次会话扫描')
await downloadResumeStore.clear('routine-cleanup')

// 四个未过期会话刚好占满仓库。新 ROM 首片第一次写入触发配额中止后，应删除最旧的整局，再重试。
const now = Date.now()
for (let index = 0; index < 4; index += 1) {
  const key = `old-${index}`
  database.stores.get('sessions').records.set(key, {
    key, total: 2048, chunkBytes: 1024, updatedAt: now - (index + 1) * 1000,
  })
  database.stores.get('parts').records.set(JSON.stringify([key, 0]), {
    downloadKey: key, index: 0, blob: new Blob([new Uint8Array(1024)]),
  })
}

const saved = await downloadResumeStore.put('new-game', 2048, 1024, 0, new Blob([new Uint8Array(1024)]))
assert.equal(saved, true, '清理一局旧续传片后，新游戏片段应能持久化')
assert.equal(database.stores.get('sessions').records.has('old-3'), false, '应淘汰最久未活动的整局')
assert.equal(database.stores.get('parts').records.has(JSON.stringify(['old-3', 0])), false, '淘汰会话时必须一并删除其分片')
assert.equal(database.stores.get('sessions').records.has('new-game'), true)
assert.equal(database.stores.get('parts').records.has(JSON.stringify(['new-game', 0])), true)
assert.equal(database.sessionsGetAllReads, 2, '配额失败应立即扫描一次，成功后的常规巡检复用该结果')

console.log('✅ 临时 ROM 存储配额满时淘汰最旧完整会话并重试；当前游戏仍可续传')
