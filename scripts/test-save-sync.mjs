/**
 * 存档写入的并发与丢档防护。跑：npm run test:save-sync
 *
 * 盯的是 2026-09-11 审出来的两条丢档路径。它们的共同点是**失败时玩家什么都看不到**：
 * 界面说「已保存」，进度在下一次进游戏时悄悄退回去。
 *
 *   1. 同一个存档位并发写没有串行化 —— 两个 PUT 到达顺序反过来，云端留下更旧的那份；
 *   2. idbMark 只认 key 不认版本 —— 会把**别人刚写进去的**数据标成「已同步」，
 *      然后那一份在下次读档时被云端的旧档盖掉。
 *
 * 这里跑的是**真的** idb.ts 和 saves.ts：IndexedDB 用一个内存替身垫着（下面那 40 行），
 * fetch 和 localStorage 也是替身。不是在测替身。
 */
import assert from 'node:assert/strict'

/* ---------------- 浏览器侧的替身 ---------------- */

globalThis.__viteEnv = { VITE_API_URL: 'https://api.test' }

const store = new Map([['8bitgo.token', 'tok']])
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}

/** 够 src/lib/idb.ts 用的最小 IndexedDB。只实现它真正调到的那几个方法 */
const DBS = new Map()
class Req {
  constructor() {
    this.onsuccess = null
    this.onerror = null
    this.onupgradeneeded = null
    this.onblocked = null
    this.result = undefined
  }
}
const settle = (req, result) => {
  req.result = result
  queueMicrotask(() => req.onsuccess?.())
  return req
}
function objectStore(db, name) {
  if (!db.has(name)) db.set(name, new Map())
  const m = db.get(name)
  return {
    get: (k) => settle(new Req(), m.has(k) ? structuredClone(m.get(k)) : undefined),
    put: (v, k) => {
      m.set(k, structuredClone(v))
      return settle(new Req(), k)
    },
    delete: (k) => {
      m.delete(k)
      return settle(new Req(), undefined)
    },
    getAllKeys: () => settle(new Req(), [...m.keys()]),
  }
}
globalThis.indexedDB = {
  open(name) {
    const req = new Req()
    const fresh = !DBS.has(name)
    if (fresh) DBS.set(name, new Map())
    const db = DBS.get(name)
    req.result = {
      objectStoreNames: { contains: (s) => db.has(s) },
      createObjectStore: (s) => (db.set(s, new Map()), {}),
      transaction: (s) => ({ objectStore: () => objectStore(db, s) }),
    }
    queueMicrotask(() => {
      if (fresh) req.onupgradeneeded?.()
      req.onsuccess?.()
    })
    return req
  },
}

const later = (ms) => new Promise((r) => setTimeout(r, ms))

/** 可编排的假云端：plan 按 PUT 顺序消费，能让某一次慢、某一次失败 */
const cloud = { puts: [], plan: [], stored: null }
globalThis.fetch = async (url, init = {}) => {
  if (init.method === 'PUT') {
    const body = new Uint8Array(init.body)
    const step = cloud.plan.shift() ?? { delay: 0, ok: true }
    await later(step.delay)
    cloud.puts.push(body[0])
    if (!step.ok) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) }
    cloud.stored = body
    return { ok: true, status: 200, json: async () => ({}) }
  }
  if (cloud.stored === null) return { ok: false, status: 404, json: async () => ({}) }
  const buf = cloud.stored
  return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }
}

/* ---------------- 真模块 ---------------- */

const { idbGet, idbPut, idbMark } = await import('../src/lib/idb.ts')
const { pushSave, pullSave } = await import('../src/services/saves.ts')
const { setSaveTarget } = await import('../src/services/saveTarget.ts')

let n = 0
let failed = 0
const ok = (c, m) => {
  c ? (n++, console.log('✅ ' + m)) : (failed++, console.log('❌ ' + m))
}
const reset = () => {
  DBS.clear()
  cloud.puts = []
  cloud.plan = []
  cloud.stored = null
}
const bytes = (tag, len = 8) => {
  const b = new Uint8Array(len)
  b.fill(tag)
  return b
}

console.log('── idbMark 的版本守卫 ──')
{
  reset()
  await idbPut('k', bytes(1), 100, true)
  await idbMark('k', false, 100)
  ok((await idbGet('k')).dirty === false, '版本对得上 → 清掉「待同步」标记')

  await idbPut('k', bytes(2), 200, true)
  await idbMark('k', false, 100)
  ok(
    (await idbGet('k')).dirty === true,
    '⭐⭐ 版本对不上 → 什么都不做（这份已经是后来者写的，清它的标记就等于丢档）',
  )
  ok((await idbGet('k')).data[0] === 2, '而且不许把数据改回去')

  await idbPut('k', bytes(3), 300, true)
  await idbMark('k', false)
  ok((await idbGet('k')).dirty === false, '不传版本时保持老行为')
}

console.log('\n── ⭐⭐ 并发存两次：慢的那次先发、后回 ──')
{
  /*
    没有串行化时的剧本：
      存档 A 上路（PUT 慢）→ 玩家没看到反馈又按一次 → 存档 B 写本地、PUT B 快 →
      PUT A 后回且成功 → idbMark(clean) 清掉的是 **B** 的标记 →
      PUT B 失败 → 本地是 B 但标成已同步 → 下次读档读云端的 A。**B 没了。**
  */
  reset()
  setSaveTarget('cloud')
  cloud.plan = [
    { delay: 60, ok: true }, // A：慢，成功
    { delay: 0, ok: false }, // B：快，失败
  ]
  const pa = pushSave('jsdos', 'g', bytes(0xa), 0, 'cloud')
  await later(5)
  const pb = pushSave('jsdos', 'g', bytes(0xb), 0, 'cloud')
  await Promise.all([pa, pb])

  ok(cloud.puts.join(',') === '10,11', `⭐ 两个 PUT 按下发顺序到达（实际 ${cloud.puts.join(',')}）`)
  const local = await idbGet('jsdos:g:0')
  ok(local.data[0] === 0xb, '本地留的是后按的那一份 B')
  ok(local.dirty === true, '⭐⭐ B 的云端那一路失败了，本地必须仍然是「待同步」')

  const pulled = await pullSave('jsdos', 'g')
  ok(pulled?.where === 'local' && pulled.data[0] === 0xb, '⭐⭐ 读档读到 B，不是云端那份更旧的 A')
}

console.log('\n── ⭐ 两次都成功时，云端留下的必须是后按的那一份 ──')
{
  /*
    不串行化的话，HTTP/2 多路复用 / 代理重试都可能让后发的先到，
    而服务端是 last-writer-wins —— 云端最终留下更旧的 A，没有任何迹象。
  */
  reset()
  cloud.plan = [
    { delay: 80, ok: true }, // A：很慢
    { delay: 0, ok: true }, // B：立刻
  ]
  await Promise.all([
    pushSave('jsdos', 'g2', bytes(0xa), 0, 'cloud'),
    later(5).then(() => pushSave('jsdos', 'g2', bytes(0xb), 0, 'cloud')),
  ])
  ok(cloud.stored[0] === 0xb, `⭐⭐ 云端最终是 B（实际 0x${cloud.stored[0].toString(16)}）`)
  ok((await idbGet('jsdos:g2:0')).dirty === false, '都成功了，本地标记该被清掉')
}

console.log('\n── ⭐⭐ 另一个标签页插进来（串行化管不到的地方）──')
{
  /*
    串行化只在**本标签页**的队列里生效。同一个玩家开两个标签页玩同一款游戏时，
    两边各有各的队列，共用同一个 IndexedDB —— 这正是版本守卫非有不可的场景：

      本页：idbPut(A, dirty) → PUT A 上路（慢）
      另一页：idbPut(B, dirty)        ← 直接写库，绕过本页的队列
      本页：PUT A 回来 200 → idbMark(clean)

    不带版本的话，被清掉标记的是**另一个标签页刚写进去的 B**，
    而云端是 A —— 下次读档读 A，B 没了。
  */
  reset()
  setSaveTarget('cloud')
  cloud.plan = [{ delay: 60, ok: true }]
  const p = pushSave('jsdos', 'g4', bytes(0xa), 0, 'cloud')
  await later(20)
  // 另一个标签页：不经过 pushSave，直接写同一个 key
  await idbPut('jsdos:g4:0', bytes(0xb), Date.now() + 1, true)
  await p

  const local = await idbGet('jsdos:g4:0')
  ok(local.data[0] === 0xb, '另一个标签页写的 B 还在')
  ok(
    local.dirty === true,
    '⭐⭐ B 的「待同步」标记不许被本页那次 PUT 的回调清掉（串行化管不到跨标签页，只有版本守卫能挡）',
  )
  const pulled = await pullSave('jsdos', 'g4')
  ok(pulled?.where === 'local' && pulled.data[0] === 0xb, '⭐⭐ 读档读到 B，不是云端的 A')
}

console.log('\n── 只存本地那条路不受影响 ──')
{
  reset()
  setSaveTarget('local')
  const r = await pushSave('jsdos', 'g3', bytes(0xc), 0, 'local')
  ok(r.ok && r.where === 'local', '写本地成功')
  ok(cloud.puts.length === 0, '没有往云端发任何请求')
  const pulled = await pullSave('jsdos', 'g3')
  ok(pulled?.where === 'local' && pulled.data[0] === 0xc, '读回来的是刚写的那份')
}

console.log(`\n${failed ? '❌' : '✅'} 存档同步：${n} 项通过，${failed} 项失败`)
process.exit(failed ? 1 : 0)
