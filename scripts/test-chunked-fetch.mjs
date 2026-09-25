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
import { fetchBlobWithProgress, CHUNK_BYTES } from '../src/emulator/loadProgress.ts'

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

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过 ✅')
process.exit(failed ? 1 : 0)
