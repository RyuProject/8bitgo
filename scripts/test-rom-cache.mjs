/**
 * ROM 本地缓存（src/emulator/romCache.ts）的回归测试。
 *
 *   npm run test:romcache
 *
 * 为什么值得写：这块最容易出错的两条路径 —— LRU 淘汰、配额被拒后重试 ——
 * 在真实浏览器里只有「玩家硬盘快满了」才会走到，正常开发根本测不着，
 * 出问题的表现又只是「缓存悄悄失效」，没人会报 bug。所以这里造一个假的
 * IndexedDB（带可调配额）把它们逼出来。
 *
 * 假的 IndexedDB 只实现 romCache.ts 真正用到的那几个方法。它不是通用实现，
 * romCache.ts 用到新 API 时这里要跟着补 —— 补不上会直接报错，不会静默放过。
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/* ---------------- 假的 IndexedDB ---------------- */

/** 请求结果要在调用方挂上 onsuccess 之后才回调，跟真实 IDB 的时序一致 */
const soon = (fn) => queueMicrotask(fn)

function createFakeIdb() {
  /** 报给 storage.estimate() 的配额；romCache 拿它的一半当预算 */
  let reportedQuota = 1_000_000
  /** 真正写得进去的上限。和 reportedQuota 分开，才能造出「以为放得下、实际被拒」 */
  let hardLimit = Number.POSITIVE_INFINITY
  /** name -> Map(key -> value) */
  const stores = new Map()

  // 值可能是 ArrayBuffer（卡带机 ROM）也可能是 Blob（光盘镜像），两种都要会数
  const sizeOf = (v) => (v instanceof Blob ? v.size : (v?.byteLength ?? 0))
  const usedBytes = () => {
    let n = 0
    for (const v of (stores.get('blobs') ?? new Map()).values()) n += sizeOf(v)
    return n
  }

  function makeRequest() {
    return { onsuccess: null, onerror: null, result: undefined, error: null }
  }

  function makeStore(name, tx) {
    const map = () => {
      if (!stores.has(name)) stores.set(name, new Map())
      return stores.get(name)
    }
    const run = (req, work) => {
      tx.pending++
      soon(() => {
        try {
          work(req)
          req.onsuccess?.()
        } catch (e) {
          req.error = e
          tx.failed = e
          req.onerror?.()
          tx.abort(e)
        }
        tx.settle()
      })
      return req
    }
    return {
      get: (key) => run(makeRequest(), (r) => { r.result = map().get(key) }),
      getAll: () => run(makeRequest(), (r) => { r.result = [...map().values()] }),
      getAllKeys: () => run(makeRequest(), (r) => { r.result = [...map().keys()] }),
      delete: (key) => run(makeRequest(), () => { map().delete(key) }),
      put: (value, key) =>
        run(makeRequest(), () => {
          if (name === 'blobs') {
            const prev = map().get(key)?.byteLength ?? 0
            if (usedBytes() - prev + value.byteLength > hardLimit) {
              const err = new Error('quota')
              err.name = 'QuotaExceededError'
              throw err
            }
          }
          map().set(key, value)
        }),
    }
  }

  function makeTransaction(names) {
    const list = Array.isArray(names) ? names : [names]
    for (const n of list) if (!stores.has(n)) throw new Error(`没有这个 store：${n}`)
    const tx = {
      pending: 0,
      done: false,
      failed: null,
      error: null,
      oncomplete: null,
      onabort: null,
      onerror: null,
      objectStore: (n) => {
        if (!list.includes(n)) throw new Error(`事务没带上 store：${n}`)
        return makeStore(n, tx)
      },
      abort(err) {
        if (tx.done) return
        tx.done = true
        tx.error = err ?? null
        soon(() => tx.onabort?.())
      },
      settle() {
        tx.pending--
        if (tx.pending > 0 || tx.done) return
        tx.done = true
        soon(() => tx.oncomplete?.())
      },
    }
    // 事务开出来一个请求都不发的情况（romCache 里没有，但别让它永远悬着）
    soon(() => {
      if (tx.pending === 0 && !tx.done) {
        tx.done = true
        tx.oncomplete?.()
      }
    })
    return tx
  }

  const db = {
    objectStoreNames: { contains: (n) => stores.has(n) },
    createObjectStore: (n) => { stores.set(n, new Map()); return makeStore(n, { pending: 0, settle() {}, abort() {} }) },
    transaction: makeTransaction,
  }

  return {
    indexedDB: {
      open() {
        const req = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null, result: db }
        soon(() => {
          req.onupgradeneeded?.()
          req.onsuccess?.()
        })
        return req
      },
    },
    navigator: { storage: { estimate: async () => ({ quota: reportedQuota, usage: usedBytes() }) } },
    setQuota: (v) => { reportedQuota = v },
    setHardLimit: (v) => { hardLimit = v },
    stores,
    usedBytes,
  }
}

/* ---------------- 造一个可控的时钟，LRU 排序要靠它 ---------------- */

const realNow = Date.now
let clock = 1_000_000
const tick = (ms = 1000) => { clock += ms }
Date.now = () => clock

/* ---------------- 每个场景拿一份全新的模块实例 ---------------- */

/**
 * 直接 import 那份 .ts，不再先用 esbuild 打包。
 *
 * 为什么换：esbuild 装的是平台相关的原生二进制，这个仓库的 node_modules 是在 macOS 上
 * 装的，挂到 Linux 侧跑就报 "You installed esbuild for another platform" ——
 * 于是 romCache 这块**在半数环境里根本测不了**，而它正是那种「悄悄失效没人报 bug」的代码。
 * 走 ts-register 之后到哪儿都能跑。理由和 scripts/helpers/ts-loader.mjs 的文件头是同一条。
 */
const SOURCE = pathToFileURL(path.resolve('src/emulator/romCache.ts')).href

/**
 * 断言失败靠进程级钩子收口：下面每个场景都在顶层 await，
 * 用 try/catch 包不住（真包了还得把 Date.now 的还原重复写一遍）。
 */
process.on('uncaughtException', (e) => {
  console.error('\n❌ 测试失败：', e?.message ?? e)
  if (e?.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'))
  Date.now = realNow
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  console.error('\n❌ 测试失败：', e?.message ?? e)
  if (e?.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'))
  Date.now = realNow
  process.exit(1)
})
{
  let instance = 0
  /** romCache 内部把打开的 DB 缓存在模块作用域里，所以每个场景都要重新 import（查询串用来绕开模块缓存） */
  async function freshCache() {
    const fake = createFakeIdb()
    globalThis.indexedDB = fake.indexedDB
    Object.defineProperty(globalThis, 'navigator', { value: fake.navigator, configurable: true, writable: true })
    const mod = await import(`${SOURCE}?${instance++}`)
    return { ...mod, fake }
  }

  const buf = (n) => new ArrayBuffer(n)
  const url = (name) => `https://assets.8bitgo.com/roms/nes/${name}.zip?romv=abc123`

  /* --- 1. 什么地址才配缓存 --- */
  {
    const { romCacheKey } = await freshCache()
    assert.equal(romCacheKey('blob:https://8bitgo.com/uuid'), '', 'blob: 是本地文件，不该缓存')
    assert.equal(romCacheKey('data:application/zip;base64,AAAA'), '', 'data: 不该缓存')
    assert.equal(romCacheKey('https://assets.8bitgo.com/roms/nes/a.zip'), '', '没有 romv 就没有内容版本号，不能缓存')
    assert.equal(romCacheKey(''), '', '空地址')
    assert.equal(romCacheKey(url('a')), url('a'), '带 romv 的正常地址应可缓存')
    assert.equal(
      romCacheKey('/roms/nes/a.zip?romv=x'),
      '/roms/nes/a.zip?romv=x',
      '同源相对路径（ROM_BASE 填 /roms 时）也要认',
    )
    console.log('✓ 缓存键：blob / data / 无 romv 一律不缓存')
  }

  /* --- 2. 存进去能原样读出来 --- */
  {
    const { romCachePut, romCacheGet, romCacheStats } = await freshCache()
    await romCachePut(url('a'), buf(128))
    const got = await romCacheGet(url('a'))
    assert.ok(got instanceof ArrayBuffer, '应该读回 ArrayBuffer')
    assert.equal(got.byteLength, 128)
    assert.equal(await romCacheGet(url('nope')), null, '没存过的应返回 null')
    const stats = await romCacheStats()
    assert.equal(stats.count, 1)
    assert.equal(stats.bytes, 128)
    console.log('✓ 读写往返 + 统计')
  }

  /* --- 3. 空 buffer 不写（被 transfer 走的游离 buffer 就长这样） --- */
  {
    const { romCachePut, romCacheGet } = await freshCache()
    await romCachePut(url('empty'), buf(0))
    assert.equal(await romCacheGet(url('empty')), null, '0 字节不该被当成有效 ROM 存下来')
    console.log('✓ 0 字节 / 游离 buffer 不入缓存')
  }

  /* --- 4. LRU：淘汰的必须是最久没用的那个，不是最早存的那个 --- */
  {
    const { romCachePut, romCacheGet, romCacheStats, fake } = await freshCache()
    fake.setQuota(1000) // 预算 = 配额的一半 = 500，装得下两个 200
    await romCachePut(url('a'), buf(200))
    tick()
    await romCachePut(url('b'), buf(200))
    tick()
    // 重新玩一次 a，它就成了「最近用过的」
    await romCacheGet(url('a'))
    await new Promise((r) => setTimeout(r, 10)) // touch 是异步的，等它落盘
    tick()
    await romCachePut(url('c'), buf(200))

    assert.ok(await romCacheGet(url('a')), 'a 刚玩过，不该被淘汰')
    assert.equal(await romCacheGet(url('b')), null, 'b 最久没用，应该被淘汰')
    assert.ok(await romCacheGet(url('c')), 'c 是刚存的')
    const stats = await romCacheStats()
    assert.equal(stats.count, 2, '淘汰后应只剩两条')
    assert.equal(stats.bytes, 400, '元信息里的总量要跟着淘汰一起减')
    console.log('✓ LRU 淘汰按「最近使用」而不是「存入顺序」')
  }

  /* --- 5. 超出预算的单个文件直接不存，不要把整个缓存清空去迁就它 --- */
  {
    const { romCachePut, romCacheGet, romCacheStats, fake } = await freshCache()
    fake.setQuota(1000) // 预算 500
    await romCachePut(url('keep'), buf(100))
    await romCachePut(url('huge'), buf(900)) // 预算 500，一个都放不下
    assert.equal(await romCacheGet(url('huge')), null, '放不下的不该存')
    assert.ok(await romCacheGet(url('keep')), '已有的不该为了放不下的那个被清掉')
    assert.equal((await romCacheStats()).count, 1)
    console.log('✓ 单个超预算的文件被跳过，不牵连已有缓存')
  }

  /* --- 6. 被浏览器以配额为由拒了之后，腾空间重试一次 --- */
  {
    const cache = await freshCache()
    cache.fake.setQuota(1000) // 预算 500
    cache.fake.setHardLimit(250)
    await cache.romCachePut(url('a'), buf(200))
    assert.ok(await cache.romCacheGet(url('a')), 'a 在硬上限之内，应存下')
    await cache.romCachePut(url('b'), buf(200)) // 400 > 250 → 被拒 → 腾空间 → 重试
    assert.ok(await cache.romCacheGet(url('b')), '配额被拒后应腾出空间重试成功')
    assert.equal(await cache.romCacheGet(url('a')), null, '为了放下 b，a 应被淘汰')
    console.log('✓ 配额被拒 → 淘汰 → 重试一次')
  }

  /* --- 7. 没有 IndexedDB 时一切照旧（无痕模式 / SSR） --- */
  {
    globalThis.indexedDB = undefined
    // 连 storage.estimate() 也没有，才是真的老浏览器 / SSR，走兜底预算
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true })
    const mod = await import(`${SOURCE}?nodb${instance++}`)
    assert.equal(await mod.romCacheGet(url('a')), null, '没有 IndexedDB 时读应返回 null 而不是抛错')
    await mod.romCachePut(url('a'), buf(10)) // 不该抛
    assert.deepEqual(await mod.romCacheStats(), { count: 0, bytes: 0, budget: 1024 * 1024 * 1024 })
    await mod.romCacheClear()
    console.log('✓ 无 IndexedDB 环境下静默降级，不抛错')
  }

  /* --- 8. 清空只清缓存 --- */
  {
    const { romCachePut, romCacheClear, romCacheStats } = await freshCache()
    await romCachePut(url('a'), buf(100))
    await romCachePut(url('b'), buf(100))
    await romCacheClear()
    assert.deepEqual((await romCacheStats()).count, 0, '清空后应一条不剩')
    console.log('✓ 清空缓存')
  }

  /* --- 9. 光盘那条路：存 Blob，读回来还是 Blob --- */
  {
    const { romCachePutBlob, romCacheGetBlob, romCacheGet, romCacheStats, fake } = await freshCache()
    fake.setQuota(100_000) // 预算 50_000
    await romCachePutBlob(url('disc'), new Blob([new Uint8Array(1024)]))
    const got = await romCacheGetBlob(url('disc'))
    assert.ok(got instanceof Blob, '光盘镜像应原样读回 Blob —— 转成 ArrayBuffer 就等于要一整块连续内存')
    assert.equal(got.size, 1024)
    assert.equal((await romCacheStats()).bytes, 1024, '元信息要按 Blob 的 size 记，不是 byteLength')
    assert.equal(await romCacheGet(url('disc')), null, 'ArrayBuffer 接口不该把 Blob 当成自己的东西返回')
    console.log('✓ Blob 存取：光盘镜像不经过连续内存')
  }

  /* --- 10. ArrayBuffer 存的也能按 Blob 读回来（平台改判成光盘之后，老缓存不该白白落空） --- */
  {
    const { romCachePut, romCacheGetBlob } = await freshCache()
    await romCachePut(url('old'), buf(256))
    const got = await romCacheGetBlob(url('old'))
    assert.ok(got instanceof Blob)
    assert.equal(got.size, 256)
    console.log('✓ 旧的 ArrayBuffer 缓存也能按 Blob 读')
  }

  /* --- 11. 一个条目最多占预算的一半 --- */
  {
    const { romCachePutBlob, romCacheGetBlob, romCacheStats, fake } = await freshCache()
    fake.setQuota(2000) // 预算 1000，单条上限 500
    await romCachePutBlob(url('big'), new Blob([new Uint8Array(600)]))
    assert.equal(await romCacheGetBlob(url('big')), null, '超过预算一半的不该存')
    assert.equal((await romCacheStats()).count, 0)
    await romCachePutBlob(url('ok'), new Blob([new Uint8Array(400)]))
    assert.ok(await romCacheGetBlob(url('ok')), '预算一半以内的正常存')
    console.log('✓ 单条不得超过预算一半（否则两款游戏轮着玩就是每次都重下）')
  }

  console.log('\n全部通过 ✅')
}
Date.now = realNow
