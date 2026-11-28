/**
 * 分片下载与断点重传（src/emulator/loadProgress.ts 的 fetchBlobWithProgress）的回归测试。
 *
 *   npm run test:chunked-fetch
 *
 * 造一个假服务器（可控地在第 N 次请求上失败）来逼出重传那条路 ——
 * 真实浏览器里只有「下到一半切网络」才会走到，正常开发根本测不着，
 * 而它坏掉的表现是「大文件永远下不完」或者更糟：**拼出一份字节错位的镜像**，
 * 后者不会报错，只会让游戏莫名其妙跑不起来。
 */
import assert from 'node:assert/strict'
import { adaptiveChunkConcurrency, fetchBlobWithProgress, CHUNK_BYTES } from '../src/emulator/loadProgress.ts'
import { loadGameBytes } from '../src/emulator/romLoader.ts'

let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ❌ ${name}\n     ${e.message}`)
  }
}

/** 第 i 个字节 = i % 251（质数，错位一格立刻看得出来） */
const byteAt = (i) => i % 251
const bodyFor = (start, endInclusive) => {
  const out = new Uint8Array(endInclusive - start + 1)
  for (let i = 0; i < out.length; i++) out[i] = byteAt(start + i)
  return out
}

/** 把 Uint8Array 包成一条可读流，模拟真实响应体（走 drain 那条路） */
const streamOf = (bytes, pieces = 3) =>
  new ReadableStream({
    start(controller) {
      const step = Math.max(1, Math.ceil(bytes.length / pieces))
      for (let at = 0; at < bytes.length; at += step) controller.enqueue(bytes.subarray(at, at + step))
      controller.close()
    },
  })

const headers = (map) => ({ get: (k) => map[k.toLowerCase()] ?? null })

/**
 * 假服务器。
 * @param size          文件大小
 * @param opts.noRange  不认 Range，一律回 200 整份
 * @param opts.failOn   这些「第几次请求」要失败（1 起数）
 * @param opts.truncate 这些请求少给几个字节（造「流正常结束但文件不完整」）
 */
function server(size, opts = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const n = calls.length + 1
    const range = init?.headers?.Range ?? ''
    calls.push(range)
    if (opts.failOn?.includes(n)) throw new TypeError('network error')

    if (opts.noRange) {
      const bytes = bodyFor(0, size - 1)
      return { ok: true, status: 200, headers: headers({ 'content-length': String(size) }), body: streamOf(bytes) }
    }
    const m = /bytes=(\d+)-(\d+)/.exec(range)
    const start = Number(m[1])
    const end = Math.min(Number(m[2]), size - 1)
    let bytes = bodyFor(start, end)
    if (opts.truncate?.includes(n)) bytes = bytes.subarray(0, bytes.length - 1)
    return {
      ok: true,
      status: 206,
      headers: headers({
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': String(end - start + 1),
      }),
      body: streamOf(bytes),
    }
  }
  return { fetchImpl, calls }
}

/** 跨两次 fetchBlobWithProgress 调用保存现场，等价于浏览器刷新前后的 IndexedDB。 */
function memoryResumeStore() {
  const sessions = new Map()
  let clears = 0
  return {
    async load(key, chunkBytes) {
      const session = sessions.get(key)
      if (!session || session.chunkBytes !== chunkBytes) return null
      return { total: session.total, chunkBytes, parts: new Map(session.parts) }
    },
    async put(key, total, chunkBytes, index, blob) {
      let session = sessions.get(key)
      if (!session || session.total !== total || session.chunkBytes !== chunkBytes) {
        session = { total, chunkBytes, parts: new Map() }
        sessions.set(key, session)
      }
      session.parts.set(index, blob)
    },
    async clear(key) {
      clears++
      sessions.delete(key)
    },
    sessions,
    get clears() { return clears },
  }
}

const readAll = async (blob) => new Uint8Array(await blob.arrayBuffer())
const expectExact = (bytes, size) => {
  assert.equal(bytes.length, size, `长度应为 ${size}，实际 ${bytes.length}`)
  for (let i = 0; i < size; i++) {
    if (bytes[i] !== byteAt(i)) throw new Error(`第 ${i} 个字节错了：应为 ${byteAt(i)}，实际 ${bytes[i]}`)
  }
}

console.log('一、拼接正确性')

await check('正好整数片', async () => {
  const size = 4096
  const { fetchImpl, calls } = server(size)
  const blob = await fetchBlobWithProgress('u', { fetchImpl, chunkBytes: 1024 })
  expectExact(await readAll(blob), size)
  assert.equal(calls.length, 4)
})

await check('最后一片不满（最容易拼错的情况）', async () => {
  const size = 4096 + 7
  const { fetchImpl, calls } = server(size)
  const blob = await fetchBlobWithProgress('u', { fetchImpl, chunkBytes: 1024 })
  expectExact(await readAll(blob), size)
  assert.equal(calls.length, 5)
  assert.equal(calls[4], 'bytes=4096-4102', '末片的 Range 不能超过文件实际大小')
})

await check('文件比一片还小：只发一次请求，不进循环', async () => {
  const size = 300
  const { fetchImpl, calls } = server(size)
  const blob = await fetchBlobWithProgress('u', { fetchImpl, chunkBytes: 1024 })
  expectExact(await readAll(blob), size)
  assert.equal(calls.length, 1)
})

await check('单片小 ROM 不写临时库，避免下载完成后马上又删除一笔 IndexedDB 事务', async () => {
  const resumeStore = memoryResumeStore()
  const { fetchImpl, calls } = server(300)
  const blob = await fetchBlobWithProgress('u', {
    fetchImpl, chunkBytes: 1024, resumeKey: 'rom?v=1', resumeStore,
  })
  expectExact(await readAll(blob), 300)
  assert.equal(calls.length, 1)
  assert.equal(resumeStore.sessions.size, 0)
})

await check('服务器不认 Range：退回整份下载，照样能用', async () => {
  const size = 5000
  const { fetchImpl, calls } = server(size, { noRange: true })
  const blob = await fetchBlobWithProgress('u', { fetchImpl, chunkBytes: 1024 })
  expectExact(await readAll(blob), size)
  assert.equal(calls.length, 1, '不认 Range 就不该再发后续分片请求')
})

console.log('二、断点重传')

await check('第一片建连失败也会重试（不能只有第二片以后才有重试）', async () => {
  const size = 2048
  const { fetchImpl, calls } = server(size, { failOn: [1] })
  const blob = await fetchBlobWithProgress('u', { fetchImpl, chunkBytes: 1024, retries: 2 })
  expectExact(await readAll(blob), size)
  assert.equal(calls.length, 3, '首片重试一次 + 第二片，应共三次请求')
  assert.equal(calls[0], calls[1], '重试的必须仍是第 0 片')
})

await check('第一片截断会重试，残片不能进入最终 Blob', async () => {
  const size = 2048
  const { fetchImpl, calls } = server(size, { truncate: [1] })
  const blob = await fetchBlobWithProgress('u', { fetchImpl, chunkBytes: 1024, retries: 2 })
  expectExact(await readAll(blob), size)
  assert.equal(calls.length, 3)
  assert.equal(calls[0], calls[1])
})

await check('中间一片失败：只重传那一片，不是从头来', async () => {
  const size = 4096
  // 第 3 次请求（第 3 片）失败一次
  const { fetchImpl, calls } = server(size, { failOn: [3] })
  const blob = await fetchBlobWithProgress('u', { fetchImpl, chunkBytes: 1024, retries: 3 })
  expectExact(await readAll(blob), size)
  assert.equal(calls.length, 5, `应为 4 片 + 1 次重传 = 5 次，实际 ${calls.length}`)
  assert.equal(calls[2], calls[3], '重传的必须是同一片')
})

await check('同一片连续失败多次，仍在重试次数内就该成功', async () => {
  const size = 2048
  const { fetchImpl, calls } = server(size, { failOn: [2, 3, 4] })
  const blob = await fetchBlobWithProgress('u', { fetchImpl, chunkBytes: 1024, retries: 3 })
  expectExact(await readAll(blob), size)
  assert.equal(calls.length, 5)
})

await check('超过重试次数才真的失败', async () => {
  const size = 2048
  const { fetchImpl } = server(size, { failOn: [2, 3, 4, 5] })
  await assert.rejects(
    () => fetchBlobWithProgress('u', { fetchImpl, chunkBytes: 1024, retries: 2 }),
    /network error/,
  )
})

await check('弱网退避结束后摘掉取消监听，长 ROM 重试不会累积闭包', async () => {
  const ctrl = new AbortController()
  const active = new Set()
  const add = ctrl.signal.addEventListener.bind(ctrl.signal)
  const remove = ctrl.signal.removeEventListener.bind(ctrl.signal)
  ctrl.signal.addEventListener = (type, listener, options) => {
    if (type === 'abort') active.add(listener)
    return add(type, listener, options)
  }
  ctrl.signal.removeEventListener = (type, listener, options) => {
    if (type === 'abort') active.delete(listener)
    return remove(type, listener, options)
  }
  const { fetchImpl } = server(300, { failOn: [1] })
  const blob = await fetchBlobWithProgress('u', {
    fetchImpl,
    chunkBytes: 1024,
    retries: 1,
    signal: ctrl.signal,
  })
  expectExact(await readAll(blob), 300)
  assert.equal(active.size, 0, '下载完成后，重试退避和看门狗都必须从父 signal 解绑')
})

await check('分片少给了字节：当失败重传，绝不把残片拼进去', async () => {
  const size = 2048
  // 第 2 次请求少给一个字节；重传时给全
  const { fetchImpl, calls } = server(size, { truncate: [2] })
  const blob = await fetchBlobWithProgress('u', { fetchImpl, chunkBytes: 1024, retries: 2 })
  expectExact(await readAll(blob), size)
  assert.equal(calls.length, 3, '截断的那一片要重传一次')
})

await check('取消：不空转重试，直接抛 AbortError', async () => {
  const size = 4096
  const ctrl = new AbortController()
  const { fetchImpl, calls } = server(size, { failOn: [2] })
  const wrapped = async (url, init) => {
    if (calls.length >= 1) ctrl.abort()
    return fetchImpl(url, init)
  }
  await assert.rejects(
    () => fetchBlobWithProgress('u', { fetchImpl: wrapped, chunkBytes: 1024, signal: ctrl.signal, retries: 5 }),
    (e) => e instanceof Error,
  )
  assert.ok(calls.length <= 2, `取消后不该继续重试，实际发了 ${calls.length} 次`)
})

await check('连接卡死会换新 signal 自动重试，进度不倒退', async () => {
  const size = 300
  const next = server(size)
  let calls = 0
  const seen = []
  const fetchImpl = async (url, init) => {
    calls++
    if (calls > 1) return next.fetchImpl(url, init)
    return await new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('超时', 'AbortError')), { once: true })
    })
  }
  const blob = await fetchBlobWithProgress('u', {
    fetchImpl,
    chunkBytes: 1024,
    retries: 1,
    stallMs: 5,
    onProgress: (progress) => seen.push(progress.loaded ?? 0),
  })
  expectExact(await readAll(blob), size)
  assert.equal(calls, 2, '卡死那次和自动重试各一次')
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], `进度倒退：${seen[i - 1]} -> ${seen[i]}`)
})

console.log('三、跨刷新续传')

await check('刷新前已完成的分片落盘，刷新后只补缺失片', async () => {
  const size = 4096
  const resumeStore = memoryResumeStore()
  const firstRun = server(size, { failOn: [3] })
  await assert.rejects(
    () => fetchBlobWithProgress('u', {
      fetchImpl: firstRun.fetchImpl,
      chunkBytes: 1024,
      retries: 0,
      resumeKey: 'rom?v=1',
      resumeStore,
    }),
    /network error/,
  )
  assert.deepEqual([...resumeStore.sessions.get('rom?v=1').parts.keys()], [0, 1], '刷新前应已保存前两片')

  // 第二次调用代表页面刷新：用同一个内容版本键和同一个持久化仓库恢复。
  const secondRun = server(size)
  const blob = await fetchBlobWithProgress('u', {
    fetchImpl: secondRun.fetchImpl,
    chunkBytes: 1024,
    resumeKey: 'rom?v=1',
    resumeStore,
  })
  expectExact(await readAll(blob), size)
  assert.deepEqual(secondRun.calls, ['bytes=2048-3071', 'bytes=3072-4095'])
  assert.equal(resumeStore.sessions.has('rom?v=1'), false, '合并成功后应清掉临时片，避免占双份空间')
})

await check('内容版本变化：旧分片绝不能给新 ROM 复用', async () => {
  const size = 2048
  const resumeStore = memoryResumeStore()
  await resumeStore.put('rom?v=old', size, 1024, 0, new Blob([bodyFor(0, 1023)]))
  const next = server(size)
  const blob = await fetchBlobWithProgress('u', {
    fetchImpl: next.fetchImpl,
    chunkBytes: 1024,
    resumeKey: 'rom?v=new',
    resumeStore,
  })
  expectExact(await readAll(blob), size)
  assert.equal(next.calls[0], 'bytes=0-1023', '版本键变化后必须从第 0 片重新开始')
})

await check('所有分片都已落盘：刷新后零网络请求也能完成合并', async () => {
  const size = 2048
  const resumeStore = memoryResumeStore()
  await resumeStore.put('rom?v=1', size, 1024, 0, new Blob([bodyFor(0, 1023)]))
  await resumeStore.put('rom?v=1', size, 1024, 1, new Blob([bodyFor(1024, 2047)]))
  const blob = await fetchBlobWithProgress('u', {
    fetchImpl: async () => { throw new Error('不应该联网') },
    chunkBytes: 1024,
    resumeKey: 'rom?v=1',
    resumeStore,
  })
  expectExact(await readAll(blob), size)
  assert.equal(resumeStore.sessions.has('rom?v=1'), false)
})

await check('临时存储不可用：降级为普通下载，不影响开局', async () => {
  const size = 2048
  const brokenStore = {
    async load() { throw new Error('IndexedDB disabled') },
    async put() { throw new Error('quota exceeded') },
    async clear() { throw new Error('IndexedDB disabled') },
  }
  const { fetchImpl } = server(size)
  const blob = await fetchBlobWithProgress('u', {
    fetchImpl,
    chunkBytes: 1024,
    resumeKey: 'rom?v=1',
    resumeStore: brokenStore,
  })
  expectExact(await readAll(blob), size)
})

await check('服务端回错 Range：拒绝等长错片，不能静默拼坏 ROM', async () => {
  const size = 2048
  const { fetchImpl: good } = server(size)
  const wrong = async (url, init) => {
    const response = await good(url, init)
    const original = response.headers
    return {
      ...response,
      headers: headers({
        'content-range': response.status === 206 ? 'bytes 0-1023/2048' : original.get('content-range'),
        'content-length': original.get('content-length'),
      }),
    }
  }
  await assert.rejects(
    () => fetchBlobWithProgress('u', { fetchImpl: wrong, chunkBytes: 1024, retries: 0 }),
    /分片范围不匹配/,
  )
})

console.log('四、进度')

await check('进度是整份的口径，不是分片内的（否则每片都会从 0 重来一遍）', async () => {
  const size = 4096
  const { fetchImpl } = server(size)
  const seen = []
  await fetchBlobWithProgress('u', {
    fetchImpl,
    chunkBytes: 1024,
    onProgress: (p) => seen.push(p),
  })
  assert.ok(seen.length > 0)
  // 第一帧是在探测请求发出**之前**打的，那时候还不知道总量 —— total 为 undefined 是对的，
  // 它的作用是让进度条立刻出现而不是先空着。之后每一帧的 total 都必须是整份大小。
  assert.equal(seen[0].total, undefined, '第一帧不该凭空编一个总量出来')
  for (const p of seen.slice(1)) {
    assert.equal(p.total, size, `total 应是整份大小 ${size}，出现了 ${p.total}`)
    assert.ok((p.loaded ?? 0) <= size, 'loaded 不该超过整份大小')
  }
  // 只进不退
  let prev = -1
  for (const p of seen) {
    assert.ok((p.loaded ?? 0) >= prev, `进度回退了：${prev} -> ${p.loaded}`)
    prev = p.loaded ?? 0
  }
  const last = seen[seen.length - 1]
  assert.equal(last.loaded, size, '最后一帧必须走满')
  assert.equal(last.ratio, 1)
})

console.log('五、默认值')

await check('默认片长是 8MB', () => {
  assert.equal(CHUNK_BYTES, 8 * 1024 * 1024)
})

console.log('六、自适应并发')

await check('快网最多四路，省流量与 2G 始终单路', () => {
  assert.equal(adaptiveChunkConcurrency(8 * 1024 * 1024, 500, { rttMs: 80 }), 4)
  assert.equal(adaptiveChunkConcurrency(8 * 1024 * 1024, 500), 4, '没有 Network Information API 时也要相信真实测速')
  assert.equal(adaptiveChunkConcurrency(8 * 1024 * 1024, 500, { saveData: true }), 1)
  assert.equal(adaptiveChunkConcurrency(8 * 1024 * 1024, 500, { effectiveType: '2g' }), 1)
})

await check('有真实样本时不因浏览器报 3g 压成单路（2026-11-18《西游释厄传》：报 3g，实测 9.5 Mbps）', () => {
  const hints = { effectiveType: '3g', downlinkMbps: 1.25, rttMs: 250 }
  // 256KB 正文 220ms ≈ 9.5 Mbps
  assert.equal(adaptiveChunkConcurrency(256 * 1024, 220, hints), 3)
  assert.equal(adaptiveChunkConcurrency(256 * 1024, 2000, hints), 1, '样本本身慢（约 1 Mbps）仍单路')
  assert.equal(adaptiveChunkConcurrency(0, 0, hints), 1, '还没测到时按浏览器提示兜底')
})

await check('低内存或双核设备把并发封顶为两路', () => {
  assert.equal(adaptiveChunkConcurrency(8 * 1024 * 1024, 500, { deviceMemoryGb: 2 }), 2)
  assert.equal(adaptiveChunkConcurrency(8 * 1024 * 1024, 500, { hardwareConcurrency: 2 }), 2)
})

const concurrentServer = (size, delayedMs = 12) => {
  let active = 0
  let peak = 0
  let calls = 0
  const fetchImpl = async (_url, init) => {
    calls++
    active++
    peak = Math.max(peak, active)
    // 第一片也是测速片，让它立即完成；后续片保留一点延迟，才能观察到是否真的重叠。
    if (calls > 1) await new Promise((resolve) => setTimeout(resolve, delayedMs))
    const m = /bytes=(\d+)-(\d+)/.exec(init.headers.Range)
    const start = Number(m[1])
    const end = Math.min(Number(m[2]), size - 1)
    const bytes = bodyFor(start, end)
    active--
    return {
      ok: true,
      status: 206,
      headers: headers({
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': String(bytes.length),
      }),
      body: streamOf(bytes),
    }
  }
  return { fetchImpl, peak: () => peak }
}

await check('快网在首片测速后自动并发下载剩余分片', async () => {
  const source = concurrentServer(6 * 1024)
  const blob = await fetchBlobWithProgress('u', {
    fetchImpl: source.fetchImpl,
    chunkBytes: 1024,
    maxConcurrency: 4,
    networkHints: { effectiveType: '4g', rttMs: 80, deviceMemoryGb: 8, hardwareConcurrency: 8 },
  })
  expectExact(await readAll(blob), 6 * 1024)
  assert.ok(source.peak() >= 2, `快网应至少观察到双路请求，实际峰值 ${source.peak()}`)
  assert.ok(source.peak() <= 4, `并发不能越过四路硬上限，实际峰值 ${source.peak()}`)
})

await check('省流量模式即使调用方允许四路也保持串行', async () => {
  const source = concurrentServer(5 * 1024)
  const blob = await fetchBlobWithProgress('u', {
    fetchImpl: source.fetchImpl,
    chunkBytes: 1024,
    maxConcurrency: 4,
    networkHints: { saveData: true, effectiveType: '4g' },
  })
  expectExact(await readAll(blob), 5 * 1024)
  assert.equal(source.peak(), 1)
})

await check('断点写盘与下一片网络重叠，不在每个 8MB 边界停住', async () => {
  const size = 3 * 1024
  const source = server(size)
  let releaseFirstWrite
  const firstWriteDone = new Promise((resolve) => { releaseFirstWrite = resolve })
  const secondRequestStarted = new Promise((resolve) => {
    const timer = setInterval(() => {
      if (source.calls.length >= 2) {
        clearInterval(timer)
        resolve(true)
      }
    }, 1)
    setTimeout(() => {
      clearInterval(timer)
      resolve(false)
    }, 100)
  })
  const resumeStore = {
    async load() { return null },
    async put(_key, _total, _chunkBytes, index) {
      if (index === 0) await firstWriteDone
    },
    async clear() {},
  }
  const downloading = fetchBlobWithProgress('u', {
    fetchImpl: source.fetchImpl,
    chunkBytes: 1024,
    maxConcurrency: 1,
    resumeKey: 'rom?v=pipeline',
    resumeStore,
  })
  const overlapped = await secondRequestStarted
  releaseFirstWrite()
  const blob = await downloading
  expectExact(await readAll(blob), size)
  assert.equal(overlapped, true, '下一片应在首片写盘完成前开始下载')
})

await check('完整 ROM 到手后不等待临时分片删除才启动', async () => {
  const size = 2 * 1024
  const source = server(size)
  let releaseClear
  const clearDone = new Promise((resolve) => { releaseClear = resolve })
  let clearStarted = false
  const resumeStore = {
    async load() { return null },
    async put() {},
    async clear() {
      clearStarted = true
      await clearDone
    },
  }
  const downloading = fetchBlobWithProgress('u', {
    fetchImpl: source.fetchImpl,
    chunkBytes: 1024,
    maxConcurrency: 1,
    resumeKey: 'rom?v=background-clear',
    resumeStore,
  })
  const result = await Promise.race([
    downloading.then((blob) => ({ blob })),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 100)),
  ])
  assert.equal(result.timeout, undefined, '删除临时缓存不应阻塞 ROM 返回')
  assert.equal(clearStarted, true)
  releaseClear()
  expectExact(await readAll(result.blob), size)
})

await check('并发期间 CDN 突然忽略 Range：停掉其它片并采用完整 200', async () => {
  const size = 6 * 1024
  let calls = 0
  const fetchImpl = async (_url, init) => {
    calls++
    const range = /bytes=(\d+)-(\d+)/.exec(init.headers.Range)
    const start = Number(range[1])
    const end = Math.min(Number(range[2]), size - 1)
    if (calls === 2) {
      const bytes = bodyFor(0, size - 1)
      return {
        ok: true,
        status: 200,
        headers: headers({ 'content-length': String(size) }),
        body: streamOf(bytes),
      }
    }
    const bytes = bodyFor(start, end)
    return {
      ok: true,
      status: 206,
      headers: headers({
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': String(bytes.length),
      }),
      body: streamOf(bytes),
    }
  }
  const blob = await fetchBlobWithProgress('u', {
    fetchImpl,
    chunkBytes: 1024,
    maxConcurrency: 4,
    networkHints: { effectiveType: '4g', rttMs: 80 },
  })
  expectExact(await readAll(blob), size)
})

console.log('七、NDS 大文件下载的内存边界')

await check('无效上限不能悄悄变成无限下载', async () => {
  await assert.rejects(() => fetchBlobWithProgress('u', {
    fetchImpl: async () => { throw new Error('不能联网') }, maxBytes: Number.NaN,
  }), /无效的分片下载上限/)
})

await check('异常 Content-Range 总量在分片表分配前拒绝', async () => {
  let bodyRead = false
  const fetchImpl = async () => ({
    ok: true, status: 206,
    headers: headers({ 'content-range': 'bytes 0-1023/9007199254740991' }),
    body: { cancel: async () => {}, getReader() { bodyRead = true; throw new Error('不应读取巨大响应体') } },
  })
  await assert.rejects(() => fetchBlobWithProgress('u', {
    fetchImpl, chunkBytes: 1024, maxBytes: 2048, retries: 0,
  }), /超过浏览器下载上限/)
  assert.equal(bodyRead, false, '读包体或分配分片表前就应该拒绝畸形总量')
})

await check('Content-Range 声称小片但实际回巨大流时立即截断', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls++
    const first = calls === 1
    return {
      ok: true, status: 206,
      headers: headers({ 'content-range': first ? 'bytes 0-1023/2048' : 'bytes 1024-2047/2048' }),
      body: streamOf(first ? bodyFor(0, 1023) : bodyFor(1024, 4095)),
    }
  }
  await assert.rejects(() => fetchBlobWithProgress('u', {
    fetchImpl, chunkBytes: 1024, maxBytes: 2048, retries: 3,
  }), /文件过大/)
  assert.equal(calls, 2, '畸形的第二片不能重试，更不能无限攒入内存')
})

await check('服务器忽略 Range 时仍受 Content-Length 和流式字节上限约束', async () => {
  const source = server(4096, { noRange: true })
  await assert.rejects(() => fetchBlobWithProgress('u', {
    fetchImpl: source.fetchImpl, chunkBytes: 1024, maxBytes: 2048, retries: 0,
  }), /超过浏览器下载上限/)
  assert.equal(source.calls.length, 1, '已知整包超限不应重试或继续读四千字节')
  let unknownCalls = 0
  const unknownLength = async () => {
    unknownCalls++
    return { ok: true, status: 200, headers: headers({}), body: streamOf(bodyFor(0, 4095)) }
  }
  await assert.rejects(() => fetchBlobWithProgress('u', {
    fetchImpl: unknownLength, chunkBytes: 1024, maxBytes: 2048, retries: 3,
  }), /文件过大/)
  assert.equal(unknownCalls, 1, '未知总量触及硬上限后不能重复下载同一包体')
})

await check('损坏的续传总量先清理，不用巨大 Array.from 阻塞页面', async () => {
  const source = server(2048)
  let cleared = false
  const resumeStore = {
    async load() { return { total: Number.MAX_SAFE_INTEGER, chunkBytes: 1024, parts: new Map([[0, new Blob([new Uint8Array(1024)])]]) } },
    async put() {},
    async clear() { cleared = true },
  }
  const blob = await fetchBlobWithProgress('u', {
    fetchImpl: source.fetchImpl, chunkBytes: 1024, maxBytes: 2048, retries: 0,
    resumeKey: 'bad-record', resumeStore,
  })
  expectExact(await readAll(blob), 2048)
  assert.equal(cleared, true)
})

console.log('八、轻量运行时的实际入口')

await check('有内容版本的通用 ROM 探测 Range；无版本外链仍单次 GET', async () => {
  const oldFetch = globalThis.fetch
  const oldWindow = globalThis.window
  const requests = []
  const bytes = new Uint8Array([0x4e, 0x45, 0x53, 0x1a, ...Array(12).fill(0)])
  globalThis.window = { location: { href: 'https://8bitgo.com/' } }
  globalThis.fetch = async (_url, init) => {
    const range = init?.headers?.Range
    requests.push(range)
    return new Response(bytes, {
      status: range ? 206 : 200,
      headers: range
        ? { 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}`, 'content-length': String(bytes.length) }
        : { 'content-length': String(bytes.length) },
    })
  }
  try {
    const versioned = await loadGameBytes('https://assets.example/game.nes?romv=one')
    assert.deepEqual(new Uint8Array(versioned.data), bytes)
    await loadGameBytes('https://files.example/game.nes')
    assert.deepEqual(requests, ['bytes=0-8388607', undefined])
  } finally {
    globalThis.fetch = oldFetch
    globalThis.window = oldWindow
  }
})

await check('本地 ROM 缓存只复用已验证的同版本清单；旧缓存仍等待当前清单', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../src/emulator/romLoader.ts', import.meta.url), 'utf8')
  assert.match(source, /const savedManifest = romIntegrityManifestForUrl\(game, cachedIntegrityManifest, cached\.byteLength\)/,
    '缓存内的清单必须匹配当前 URL、ROM key 与字节数')
  assert.match(source, /const integrity = savedManifest \?\? await getIntegrityManifest\(\)/,
    '无已验证清单的旧缓存必须等待当前 Worker 清单')
  assert.match(source, /const getIntegrityManifest = \(\) =>\s*\{\s*if \(!integrityTask\)\s*\{\s*integrityTask = fetchRomIntegrityManifest/,
    '热缓存先验证本地证明，不应无条件发清单请求')
  assert.match(source, /if \(integrity\)\s*\{\s*const repaired = await verifyRomBytes\(game, cached, integrity, signal\)/,
    '本地缓存仍须按清单逐块复验后才交给模拟器')
  assert.match(source, /romCacheMarkIntegrityManifestVerified\(cacheKey, integrity, cached\.byteLength, cachedIdentity\)/,
    '旧缓存复验成功后只更新元数据，下次可本地复验')
  assert.match(source, /cachedIntegrityRequired === true && !integrity[\s\S]*?throw new Error\(/,
    '曾被标为必校验的缓存缺清单时必须失败关闭')
  assert.doesNotMatch(source, /cachedIntegrityRequired === false[\s\S]{0,120}optionalManifestWithin/,
    '缓存命中不得因 150ms 超时而漏掉迟到的 sidecar 或强制校验策略')
})

await check('小 ROM 首次下载及时拿到可选清单时先校验，再把证明随缓存保存', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../src/emulator/romLoader.ts', import.meta.url), 'utf8')
  assert.match(source,
    /const verifiedIntegrityManifest = integrityRequired\s*\? await getIntegrityManifest\(\)\s*:\s*cacheKey \? await optionalManifestWithin\(getIntegrityManifest\(\), signal\) : null/,
    '旧对象只在 150ms 内拿到清单时参与本次验证，迟到清单不得给已返回字节背书')
  assert.match(source,
    /if \(!integrityRequired && verifiedIntegrityManifest\) \{\s*await verifyRomBytes\(game, data, verifiedIntegrityManifest, signal\)\s*\}/,
    '可选清单必须先逐块校验小 ROM 字节，才可以进入本地缓存')
  assert.match(source, /romCachePut\(cacheKey, data, integrityRequired, verifiedIntegrityManifest\)/,
    '经过验证的可选清单应和小 ROM 缓存字节一起保存')
})

await check('ROM 阶段起始回调先于缓存/网络异步等待', async () => {
  const oldFetch = globalThis.fetch
  const events = []
  const bytes = new Uint8Array([0x4e, 0x45, 0x53, 0x1a, 0, 0, 0, 0])
  globalThis.fetch = async () => {
    events.push('fetch')
    return new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } })
  }
  try {
    const loaded = await loadGameBytes(
      'https://files.example/start.nes', undefined, undefined, {},
      () => events.push('rom-start'),
    )
    assert.deepEqual(new Uint8Array(loaded.data), bytes)
    assert.ok(events.indexOf('rom-start') >= 0 && events.indexOf('rom-start') < events.indexOf('fetch'),
      '开始事件必须在首个请求前同步发出，覆盖首字节等待与缓存查询')
  } finally {
    globalThis.fetch = oldFetch
  }
})

await check('普通小 ROM 直接写目标缓冲，超出安全阈值不按 Content-Length 预分配', async () => {
  const oldFetch = globalThis.fetch
  const oldUint8Array = globalThis.Uint8Array
  const bytes = new oldUint8Array([0x4e, 0x45, 0x53, 0x1a, ...Array(12).fill(0)])
  const maxPreallocation = 32 * 1024 * 1024
  const observeAllocation = (expectedSize) => {
    let bodyStarted = false
    let allocatedBeforeBody = false
    globalThis.Uint8Array = new Proxy(oldUint8Array, {
      construct(target, args) {
        if (!bodyStarted && typeof args[0] === 'number' && args[0] === expectedSize) allocatedBeforeBody = true
        return Reflect.construct(target, args, target)
      },
    })
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: headers({ 'content-length': String(expectedSize) }),
      body: new ReadableStream({
        pull(controller) {
          bodyStarted = true
          controller.enqueue(bytes)
          controller.close()
        },
      }, { highWaterMark: 0 }),
    })
    return () => allocatedBeforeBody
  }

  try {
    const smallAllocated = observeAllocation(bytes.byteLength)
    const loaded = await loadGameBytes('https://assets.example/tiny.nes')
    assert.deepEqual(new oldUint8Array(loaded.data), bytes)
    assert.equal(smallAllocated(), true, '已知长度的小 ROM 应直接写最终缓冲，不再保留网络块后复制')

    const largeSize = maxPreallocation + 1
    const largeAllocated = observeAllocation(largeSize)
    await assert.rejects(
      () => loadGameBytes('https://assets.example/oversized-length.nes'),
      /下载不完整/,
      '夹具只提供少量正文，长度核验仍应拒绝伪造的超大声明',
    )
    assert.equal(largeAllocated(), false, '超出 32 MiB 的声明不能提前申请整块内存')
  } finally {
    globalThis.fetch = oldFetch
    globalThis.Uint8Array = oldUint8Array
  }
})

await check('带有限大小上限的普通 ROM 启用已知长度预分配', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../src/emulator/romLoader.ts', import.meta.url), 'utf8')
  assert.match(source, /const boundedRecord = limits\.maxBytes !== undefined\s*\? await romCacheGetBoundedRecord\(cacheKey, limits\.maxBytes\)\s*:\s*null/,
    '有大小上限时必须先按缓存元数据限额读取，并保留 ArrayBuffer / Blob 原类型')
  assert.match(source, /boundedRecord\?\.value instanceof ArrayBuffer \? boundedRecord\.value : null/,
    '限额内的 ArrayBuffer 缓存应直接交给轻量运行时，避免 Blob 转换和二次读取')
  assert.match(
    source,
    /const boundedMaxBytes = typeof limits\.maxBytes === 'number' &&\s*Number\.isSafeInteger\(limits\.maxBytes\) && limits\.maxBytes > 0[\s\S]*?preallocateKnownLength:\s*true[\s\S]*?preallocateMaxBytes:\s*boundedMaxBytes \? limits\.maxBytes : SMALL_ROM_PREALLOCATE_MAX_BYTES/,
    '有上限时按调用方限额预分配；无上限外链只允许小 ROM 使用 32 MiB 安全阈值',
  )
  assert.match(source, /smallRomMemoryLimit\s*=\s*boundedMaxBytes\s*&&\s*limits\.maxBytes!\s*<=\s*CHUNK_BYTES\s*\?\s*limits\.maxBytes!\s*:\s*undefined/,
    '只有总上限不超过一片时才能关闭续传并使用内存 ROM；更大上限必须保留跨刷新续传')
  assert.match(source, /inMemoryUpTo:\s*smallRomMemoryLimit/)

  const oldFetch = globalThis.fetch
  const oldUint8Array = globalThis.Uint8Array
  const bytes = new oldUint8Array([0x4e, 0x45, 0x53, 0x1a, ...Array(12).fill(0)])
  const observePreallocation = async (bounded) => {
    let bodyStarted = false
    let allocatedBeforeBody = false
    globalThis.Uint8Array = new Proxy(oldUint8Array, {
      construct(target, args) {
        if (!bodyStarted && typeof args[0] === 'number' && args[0] === bytes.byteLength) allocatedBeforeBody = true
        return Reflect.construct(target, args, target)
      },
    })
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: headers({ 'content-length': String(bytes.byteLength) }),
      body: new ReadableStream({
        pull(controller) {
          bodyStarted = true
          controller.enqueue(bytes)
          controller.close()
        },
      }, { highWaterMark: 0 }),
    })
    try {
      const loaded = await loadGameBytes('https://files.example/limited.nes', undefined, undefined,
        bounded ? { maxBytes: 1024 } : {})
      assert.deepEqual(new oldUint8Array(loaded.data), bytes)
    } finally {
      globalThis.fetch = oldFetch
      globalThis.Uint8Array = oldUint8Array
    }
    return allocatedBeforeBody
  }

  assert.equal(await observePreallocation(true), true, '有限上限且 Content-Length 已知时应在读正文前分配最终缓冲')
  assert.equal(await observePreallocation(false), true, '无上限外链的小 ROM 也应在 32 MiB 阈值内直接写最终缓冲')
})

console.log('六、第一片期间的进度也要带总量')

await check('⚠️ 第一片还没读完时每帧都带 Content-Range 给的总量（《主题医院》150MB 卡在 67%）', async () => {
  const size = 1024 * 10
  const { fetchImpl } = server(size)
  const events = []
  await fetchBlobWithProgress('u', { fetchImpl, chunkBytes: 1024, onProgress: (p) => events.push(p) })
  const firstChunk = events.filter((e) => (e.loaded ?? 0) > 0 && (e.loaded ?? 0) <= 1024)
  assert.ok(firstChunk.length > 0, '第一片期间应有进度帧')
  for (const e of firstChunk) {
    assert.equal(e.total, size, `loaded=${e.loaded} 的帧缺总量`)
    assert.ok(e.ratio !== undefined && e.ratio <= 1024 / size + 1e-9, `第一片的比例只能是 ${(1024 / size).toFixed(2)} 以内`)
  }
})

console.log('\n八、一条 CDN 线路不通时换另一条（2026-11-10 墨西哥《合金弹头 3》Failed to fetch）')

await check('当前线路重试用光后改走 alternateUrl，同一份内容完整拿到', async () => {
  const size = 3072
  const good = server(size)
  const urls = []
  const fetchImpl = async (url, init) => {
    urls.push(String(url))
    if (String(url).startsWith('https://primary.test/')) throw new TypeError('Failed to fetch')
    return good.fetchImpl(url, init)
  }
  const blob = await fetchBlobWithProgress('https://primary.test/roms/arcade/mslug3.zip.8bg?romv=a', {
    fetchImpl, chunkBytes: 1024, retries: 1,
    alternateUrl: 'https://mirror.test/roms/arcade/mslug3.zip.8bg?romv=a',
  })
  expectExact(await readAll(blob), size)
  assert.equal(urls.filter((u) => u.startsWith('https://primary.test/')).length, 2, '主线路按 retries 试满')
  assert.ok(urls.slice(2).every((u) => u.startsWith('https://mirror.test/')), '之后全部改走另一条线路')
})

await check('另一条线路也不通时原样报错，只换一次不来回横跳', async () => {
  const urls = []
  const fetchImpl = async (url) => { urls.push(String(url)); throw new TypeError('Failed to fetch') }
  await assert.rejects(
    fetchBlobWithProgress('https://primary.test/x?romv=a', { fetchImpl, chunkBytes: 1024, retries: 0, alternateUrl: 'https://mirror.test/x?romv=a' }),
    /Failed to fetch/,
  )
  assert.deepEqual(urls, ['https://primary.test/x?romv=a', 'https://mirror.test/x?romv=a'])
})

await check('超过大小上限（RangeError）是对象本身的问题，不换线路', async () => {
  const urls = []
  const big = server(4096)
  const fetchImpl = async (url, init) => { urls.push(String(url)); return big.fetchImpl(url, init) }
  await assert.rejects(
    fetchBlobWithProgress('https://primary.test/x', { fetchImpl, chunkBytes: 1024, retries: 0, maxBytes: 2048, alternateUrl: 'https://mirror.test/x' }),
    RangeError,
  )
  assert.ok(urls.every((u) => u.startsWith('https://primary.test/')))
})

await check('没指定 retries 时网络层失败按 NETWORK_RETRIES 重试（比普通失败多）', async () => {
  const { NETWORK_RETRIES, CHUNK_RETRIES } = await import('../src/emulator/loadProgress.ts')
  assert.ok(NETWORK_RETRIES > CHUNK_RETRIES)
  const src = (await import('node:fs')).readFileSync(new URL('../src/emulator/loadProgress.ts', import.meta.url), 'utf8')
  assert.equal((src.match(/attempt >= \(isNetworkFetchError\(error\) \? networkRetries : retries\)/g) ?? []).length, 2, '首片与后续分片两处都要用')
})

console.log('\n九、续传仓库挂死不能挡住开局（2026-11-11 大陆 Chrome 132《植物大战僵尸》下完 100% 后停 120 秒）')

await check('withResumeTimeout：挂死的操作按时返回哨兵，快的操作照常返回且不留定时器', async () => {
  const { withResumeTimeout, RESUME_TIMED_OUT } = await import('../src/emulator/loadProgress.ts')
  assert.equal(await withResumeTimeout(new Promise(() => {}), 20), RESUME_TIMED_OUT)
  assert.equal(await withResumeTimeout(Promise.resolve(true), 20), true)
  // 快的那次若不清定时器，进程会多挂 1 秒；这里只验返回值，清定时器由下面的源码断言守
})

await check('load / put / clear 三处都经 withResumeTimeout，put 超时后本局放弃续传', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/emulator/loadProgress.ts', import.meta.url), 'utf8')
  assert.match(src, /withResumeTimeout\(resumeStore\.load\(/)
  assert.match(src, /withResumeTimeout\(resumeStore\.put\(/)
  assert.match(src, /withResumeTimeout\(resumeStore\.clear\(/)
  assert.match(src, /stored === RESUME_TIMED_OUT\) resumeStore = null/)
  assert.match(src, /finally \{\n    clearTimeout\(timer\)/)
  const cache = (await import('node:fs')).readFileSync(new URL('../src/emulator/romCache.ts', import.meta.url), 'utf8')
  assert.equal((cache.match(/askWithin\(db\.transaction\(STORE_BLOB, 'readonly'\)/g) ?? []).length, 2, 'romCache 两处开局读都要有上限')
})

// 2026-11-12《口袋妖怪：白 2》：同一页重开 7 次，续传片拼出来的 ROM 一次读包永不返回、一次抛 NotReadableError
class UnreadableBlob extends Blob {
  slice() { return { arrayBuffer: () => Promise.reject(new DOMException('gone', 'NotReadableError')) } }
}
await check('续传片读不出来：整组作废、本局不再写续传，从头下载出完整 ROM', async () => {
  const size = 3000
  const resumeStore = memoryResumeStore()
  await resumeStore.put('rom?v=bad', size, 1024, 0, new UnreadableBlob([new Uint8Array(1024)]))
  const { fetchImpl, calls } = server(size)
  const blob = await fetchBlobWithProgress('u', { fetchImpl, chunkBytes: 1024, resumeKey: 'rom?v=bad', resumeStore })
  expectExact(await readAll(blob), size)
  assert.ok(calls.length >= 3, '三片都要重新下载')
  assert.equal(resumeStore.sessions.size, 0, '坏的续传片必须清掉，不能留给下一局')
})

await check('续传片可读：照常复用，不重复下载', async () => {
  const size = 3000
  const resumeStore = memoryResumeStore()
  await resumeStore.put('rom?v=ok', size, 1024, 0, new Blob([bodyFor(0, 1023)]))
  const { fetchImpl, calls } = server(size)
  const blob = await fetchBlobWithProgress('u', { fetchImpl, chunkBytes: 1024, resumeKey: 'rom?v=ok', resumeStore })
  expectExact(await readAll(blob), size)
  assert.ok(!calls.some((c) => /bytes=0-/.test(String(c.range ?? c))), '第 0 片来自续传，不该再请求')
})

await check('续传写盘明显慢于网络时停止落盘，不挡 ROM 交给模拟器', async () => {
  const chunkBytes = 1024
  const size = 3 * chunkBytes
  const pendingPuts = []
  let clears = 0
  const resumeStore = {
    async load() { return null },
    put() { return new Promise((resolve) => pendingPuts.push(resolve)) },
    async clear() { clears++ },
  }
  const { fetchImpl } = server(size)
  const download = fetchBlobWithProgress('u', {
    fetchImpl, chunkBytes, resumeKey: 'rom?v=slow-storage', resumeStore,
  })
  const result = await Promise.race([
    download.then((blob) => ({ kind: 'complete', blob })),
    new Promise((resolve) => setTimeout(() => resolve({ kind: 'blocked' }), 1800)),
  ])
  for (const resolve of pendingPuts) resolve(true)
  const blob = result.kind === 'complete' ? result.blob : await download
  assert.equal(result.kind, 'complete', '坏存储不应等到 15 秒分片写超时才交付完整 ROM')
  expectExact(await readAll(blob), size)
  assert.ok(pendingPuts.length <= 2, '放弃写盘前仍遵守两笔在途事务上限')
  assert.equal(clears, 0, '迟到写入可能仍在完成时不能并发清理它')
})

await check('大量续传片的可读性探测限制为四路并行', async () => {
  const chunkBytes = 1024
  const savedParts = 12
  const size = (savedParts + 1) * chunkBytes
  const tracker = { active: 0, maximum: 0 }
  class TrackedReadableBlob extends Blob {
    slice(start, end, type) {
      const sliced = super.slice(start, end, type)
      return {
        arrayBuffer: async () => {
          tracker.active++
          tracker.maximum = Math.max(tracker.maximum, tracker.active)
          try {
            await new Promise((resolve) => setTimeout(resolve, 2))
            return await sliced.arrayBuffer()
          } finally {
            tracker.active--
          }
        },
      }
    }
  }
  const resumeStore = memoryResumeStore()
  for (let index = 0; index < savedParts; index++) {
    await resumeStore.put('rom?v=bounded', size, chunkBytes, index,
      new TrackedReadableBlob([bodyFor(index * chunkBytes, (index + 1) * chunkBytes - 1)]))
  }
  const { fetchImpl } = server(size)
  const blob = await fetchBlobWithProgress('u', { fetchImpl, chunkBytes, resumeKey: 'rom?v=bounded', resumeStore })
  expectExact(await readAll(blob), size)
  assert.ok(tracker.maximum > 1, '探测仍应有限并发，避免把每片改成完全串行')
  assert.ok(tracker.maximum <= 4, `最多允许四路探测，实际 ${tracker.maximum}`)
})

await check('inMemoryUpTo：整份留在内存（memoryRomBlob 替身），一个真 Blob 都不建、不写续传片', async () => {
  const { memoryRomOf } = await import('../src/services/memoryRom.ts')
  const size = 4096 + 7
  const resumeStore = memoryResumeStore()
  const { fetchImpl } = server(size)
  const RealBlob = globalThis.Blob
  let created = 0
  globalThis.Blob = class extends RealBlob { constructor(...a) { super(...a); created++ } }
  let blob
  try {
    blob = await fetchBlobWithProgress('u', { fetchImpl, chunkBytes: 1024, inMemoryUpTo: 1 << 20, resumeKey: 'rom?v=m', resumeStore })
  } finally {
    globalThis.Blob = RealBlob
  }
  assert.ok(memoryRomOf(blob), '结果应是内存 ROM 替身')
  assert.equal(created, 0, '内存模式不能建任何真 Blob（华为浏览器上建出来就读不出）')
  assert.equal(resumeStore.sessions.size, 0, '内存模式不写 IndexedDB 续传片')
  assert.equal(blob.size, size)
  expectExact(await readAll(blob), size)
  assert.deepEqual([...new Uint8Array(await blob.slice(1020, 1030).arrayBuffer())], [...bodyFor(1020, 1029)], '跨片切片也要对')
})

await check('inMemoryUpTo：超过上限的大文件照常走 Blob；服务器不认 Range 时整份也留在内存', async () => {
  const { memoryRomOf } = await import('../src/services/memoryRom.ts')
  const big = await fetchBlobWithProgress('u', { fetchImpl: server(4096).fetchImpl, chunkBytes: 1024, inMemoryUpTo: 2048 })
  assert.equal(memoryRomOf(big), undefined, '放不进内存的不能硬塞')
  expectExact(await readAll(big), 4096)
  const whole = await fetchBlobWithProgress('u', { fetchImpl: server(5000, { noRange: true }).fetchImpl, chunkBytes: 1024, inMemoryUpTo: 1 << 20 })
  assert.ok(memoryRomOf(whole))
  expectExact(await readAll(whole), 5000)
})

await check('下载好的 ROM 读不出：记下 Blob 存储已坏并改内存重下（2026-11-15 华为浏览器《拳皇 97 风云再起 Plus》）', async () => {
  const { readFileSync } = await import('node:fs')
  const ejs = readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
  const fn = ejs.match(/function retryModeAfterBlobReadError[\s\S]*?\n\}/)?.[0]
  assert.ok(fn, '缺 retryModeAfterBlobReadError')
  const { transformSync } = await import('esbuild')
  const vm = await import('node:vm')
  const marks = []
  const ctx = { MEMORY_ROM_MAX_BYTES: 520 * 1024 * 1024, markRomBlobStorageBroken: (w) => marks.push(w) }
  vm.runInNewContext(`${transformSync(fn, { loader: 'ts' }).code};globalThis.f=retryModeAfterBlobReadError`, ctx)
  assert.equal(ctx.f(40 << 20, true), 'memory', '街机包放得进内存：内存重下，不再建第二个读不出的 Blob')
  assert.equal(ctx.f(40 << 20, false), 'memory', '没有内容版本也能内存重下')
  assert.equal(ctx.f(700 << 20, true), 'fresh', '放不进内存的大光盘照旧整包重下')
  assert.equal(ctx.f(700 << 20, false), null)
  assert.equal(marks.length, 4, '每次都要记下 Blob 存储已坏（3 天内直接内存下载）')
  // romBlobBrokenNow() = 本机 Blob 存储坏过 || AI 临时修补 memory_rom（shared/hotfix.js）
  assert.match(ejs, /const romBlobBrokenNow = \(\): boolean => romBlobStorageBroken \|\| hotfixFlags\(\)\.memoryRom/)
  assert.match(ejs, /const firstDownloadMode = \(\): 'preemptive-memory' \| 'resume' => \(romBlobBrokenNow\(\) \? 'preemptive-memory' : 'resume'\)/)
  assert.match(ejs, /let stored = await download\(firstDownloadMode\(\)\)/, '街机第一次下载就要看 Blob 存储是否坏过')
  assert.match(ejs, /let blob = await download\(romBlobBrokenNow\(\) \? 'preemptive-memory'/, '光盘 / NDS 同理')
  assert.equal((ejs.match(/inMemoryUpTo: memoryLimitFor\(mode\)/g) ?? []).length, 2)
  // 先发制人的那次按设备内存收着；确认读不出之后才放到最大
  const limitFn = ejs.match(/function preemptiveMemoryRomBytes[\s\S]*?\n\}/)?.[0]
  const limitOf = ejs.match(/const memoryLimitFor = [\s\S]*?\n\n/)?.[0]
  assert.ok(limitFn && limitOf)
  const lctx = { MEMORY_ROM_MAX_BYTES: 520 * 1024 * 1024, Number, Math }
  vm.runInNewContext(`${transformSync(`${limitFn}\n${limitOf}`, { loader: 'ts' }).code};globalThis.f=memoryLimitFor`, lctx)
  const MB = 1024 * 1024
  const limitWith = (deviceMemory, mode) => { lctx.navigator = { deviceMemory }; return lctx.f(mode) }
  assert.equal(limitWith(2, 'preemptive-memory'), 128 * MB, '2GB 设备先发制人只到 128MB')
  assert.equal(limitWith(2, 'memory'), 520 * MB, '确认读不出之后放到最大')
  assert.equal(limitWith(8, 'preemptive-memory'), 520 * MB)
  assert.equal(limitWith(undefined, 'preemptive-memory'), 256 * MB, '读不到内存按 4GB 算')
  assert.equal(limitWith(4, 'resume'), undefined)
  // 读魔数要有时限：坏掉的 IDB Blob 会永不返回，以前整局停在这里等看门狗
  assert.equal((ejs.match(/const magic = await readRomMagic\(stored\)/g) ?? []).length, 2)
  assert.match(ejs, /new Uint8Array\(await readBlobRange\(blob, 0, 4, ROM_MAGIC_READ_TIMEOUT_MS\)\)/)
  // 缓存读不出也记 Blob 存储已坏；内存下载的密文解一块放一块
  assert.equal((ejs.match(/if \(isBlobReadError\(error\)\) markRomBlobStorageBroken\('读 ROM 缓存'\)/g) ?? []).length, 2)
  assert.match(ejs, /if \(memoryRomOf\(stored\)\) return toMemory\(true\)/)
  assert.match(ejs, /if \(cacheKey && !memoryRomOf\(stored\)\) void romCachePutBlob/, '内存那份不是真 Blob，不能写缓存')
  assert.match(ejs,
    /if \(cacheKey && !memoryRomOf\(blob\)\) \{[\s\S]{0,600}?cacheRomBlob\(cacheKey, blob, romBlobIntegrityTag\(blob\), romBlobIntegrityManifest\(blob\)\)/,
    '只有下载器确实校验过的 ROM 才能给完整缓存写入 SHA-256 印记和清单')
  assert.match(ejs, /const savedManifest = romIntegrityManifestForUrl\(url, cachedRecord\?\.integrityManifest, cached\.size\)/,
    '大型 ROM 缓存必须先验证持久化清单仍匹配 URL、版本与字节数')
  assert.match(ejs, /const integrity = savedManifest \?\? await getIntegrityManifest\(\)/,
    '没有可信本地清单的旧缓存才请求当前 sidecar')
  assert.match(ejs,
    /if \(cached\.size !== integrity\.size \|\| !romCacheIntegrityIsFresh\(cachedRecord, integrityTag\)\) \{[\s\S]{0,350}?romCacheMarkIntegrityVerified\(cacheKey, integrityTag, cached\.size, cachedRecord, integrity\)/,
    '大型 ROM 缓存过期后要按清单重新哈希并一起更新清单与印记')
  assert.match(ejs, /let integrityTask: ReturnType<typeof fetchRomIntegrityManifest> \| null = null/,
    '缓存命中不能无条件发起网络清单请求')
  assert.match(ejs, /return \{ url: objectUrlForEngine\(output\), name, hack, mameMedia, namcoSet,(?: mameCatalogSet,)? blob: output \}/, '街机内存 ROM 不能直接 createObjectURL')
})

await check('读包卡死：readBlobRange 到时抛 NotReadableError，调用方据此重下', async () => {
  const { readBlobRange, isBlobReadError } = await import('../src/services/romPack.ts')
  const stuck = { slice: () => ({ arrayBuffer: () => new Promise(() => {}) }) }
  const started = Date.now()
  await assert.rejects(readBlobRange(stuck, 0, 8, 30), (e) => isBlobReadError(e))
  assert.ok(Date.now() - started < 1000)
  assert.equal(isBlobReadError(new DOMException('x', 'NotReadableError')), true)
  assert.equal(isBlobReadError(new Error('解密失败')), false)
})

await check('解包逐块报进度；读不出时作废续传 / 缓存只重下一次（街机、NDS / 光盘、DOS）', async () => {
  const { readFileSync } = await import('node:fs')
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
  const pack = read('src/services/romPack.ts')
  assert.match(pack, /const cipher = await readBlobRange\(blob, cipherAt, cipherAt \+ meta\.cipherSize, ROM_PACK_READ_TIMEOUT_MS, signal\)/)
  assert.match(pack, /onProgress\?\.\(\{ loaded: unpacked, total: header\.originalSize \}\)/)
  const ejs = read('src/emulator/adapters/emulatorjs.ts')
  // 街机也走带内存退路的解包入口；unpackRomPackBlob 只剩 unpackRomPackForEngine 里那一处
  assert.equal((ejs.match(/unpackRomPackBlob\(stored, romPackUnpackProgress\(onProgress\)\)/g) ?? []).length, 1)
  assert.equal((ejs.match(/const unpacked = await unpackRomPackForEngine\(stored, onProgress\)/g) ?? []).length, 2)
  assert.equal((ejs.match(/if \(!isBlobReadError\(error\) \|\| memoryRomOf\((?:stored|blob)\)\) throw error/g) ?? []).length, 2)
  const dos = read('src/emulator/dosBundleSource.ts')
  assert.match(dos, /decodeDosBundle\(stored, fallbackName, report, signal\)/)
  assert.match(dos, /if \(!cacheKey \|\| !isBlobReadError\(error\)\) throw error/)
})

await check('Blob 存储坏掉：内存 ROM 替身可切片校验，交给引擎时逐块流出（2026-11-13 宝可梦白 2 / 黑）', async () => {
  const { memoryRomBlob, memoryRomOf, RomBlobStorageError, isBlobReadError } = await import('../src/services/romPack.ts')
  const parts = [new Uint8Array([0, 1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6, 7, 8])]
  const view = memoryRomBlob(parts)
  assert.equal(view.size, 9)
  assert.deepEqual([...new Uint8Array(await view.slice(3, 7).arrayBuffer())], [3, 4, 5, 6])
  assert.deepEqual([...new Uint8Array(await view.slice(-2).arrayBuffer())], [7, 8])
  assert.deepEqual([...new Uint8Array(await view.slice(2).slice(1, 3).arrayBuffer())], [3, 4])
  assert.equal(view.slice(8, 2).size, 0)
  const rom = memoryRomOf(view)
  assert.ok(rom && rom.parts.length === 3 && rom.size === 9)
  assert.equal(memoryRomOf(new Blob([parts[0]])), undefined)
  rom.parts[0] = null
  await assert.rejects(view.slice(0, 2).arrayBuffer(), (e) => isBlobReadError(e))
  const err = new RomBlobStorageError()
  assert.equal(isBlobReadError(err), true)

  const { readFileSync } = await import('node:fs')
  const ejs = readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
  assert.match(ejs, /const unpacked = await unpackRomPackForEngine\(stored, onProgress\)/, '光盘 / NDS 解包要走带内存退路的入口')
  assert.match(ejs, /isNativeBlobReadMessage\(message\)/, '引擎读 ROM 报 NotReadableError 时要标记本页 Blob 存储已坏')
  assert.match(ejs, /const memory = memoryRomOf\(blob\)/, '引擎取 ROM 的快捷回应要认内存 ROM')
  const pack = readFileSync(new URL('../src/services/romPack.ts', import.meta.url), 'utf8')
  assert.match(pack, /await Promise\.all\(parts\.map\(\(part\) => \(part\.size \? readBlobRange\(part, 0, 1, BLOB_STORAGE_PROBE_MS, signal\) : null\)\)\)/, '解包后要探每个 Blob 块是否存在且可取消')
  assert.match(pack, /const probeBytes = Math\.min\(combined\.size, 4 \* 1024 \* 1024\)/, '还要按引擎的 4MB 读取大小探合并后的 ROM')
  assert.match(ejs, /onBlobReadError\?\.\(error\)/, '引擎读取 Blob 失败时要主动通知启动恢复')
  assert.match(ejs, /failLoad\(fmt\(rt\.ejsEngineError, \{ msg: message \}\), 'runtime'\)/, 'Blob 读取失败应重挂一次并保留 ROM 候选')
  // 跨访问记住：同一台 2GB 机器第 7、8 次开局都要先失败一次才走内存
  assert.match(ejs, /let romBlobStorageBroken = readRomBlobBroken\(\)/, 'Blob 存储坏的结论要从 localStorage 读回')
  assert.match(ejs, /localStorage\.setItem\(ROM_BLOB_BROKEN_KEY, String\(Date\.now\(\)\)\)/, '标记时要写进 localStorage')
  const fnText = ejs.match(/export function romBlobBrokenRecently[\s\S]*?\n\}/)?.[0]
  assert.ok(fnText, '缺 romBlobBrokenRecently')
  const { transformSync } = await import('esbuild')
  const vm = await import('node:vm')
  const ctx = { ROM_BLOB_BROKEN_TTL_MS: 3 * 24 * 3600_000 }
  vm.runInNewContext(`${transformSync(fnText.replace(/^export /, ''), { loader: 'ts' }).code};globalThis.f=romBlobBrokenRecently`, ctx)
  const now = 1_800_000_000_000
  assert.equal(ctx.f(null, now), false)
  assert.equal(ctx.f('garbage', now), false)
  assert.equal(ctx.f(String(now - 3600_000), now), true, '一小时前标记过：仍走内存')
  assert.equal(ctx.f(String(now - 4 * 24 * 3600_000), now), false, '三天后过期，重新试 Blob')
  assert.equal(ctx.f(String(now + 60_000), now), false, '时钟回拨写出的未来时间不算')
})

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过 ✅')
process.exit(failed ? 1 : 0)
