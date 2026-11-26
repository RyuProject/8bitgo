/**
 * ROM 多线路：线路记分板 / 存在性检查对冲 / 分片按线路分配 + 慢片对冲 + 失败换线 / BIOS 可读线路。
 *
 *   npm run test:rom-route-health
 *
 * 2026-11-18《西游释厄传》浏览器实测：rom.8bitgo.com 的 HEAD 等满 4 秒超时才轮到 download.8bitgo.com（0.17 秒）；
 * 首段测速把握手和首字节算进吞吐，256KB 样本不到 3Mbps，三个 8MB 分片被压成串行下了 20 秒。
 * 这里锁住修法：几条线路读同一个 R2 对象（带同一个 romv），谁快用谁、谁坏绕开谁，但绝不把不同版本的字节拼在一起。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

globalThis.__viteEnv = {
  VITE_ROM_BASE_URL: 'https://download.example.com',
  VITE_ROM_MIRROR_URL: 'https://cn-assets.example.com',
  VITE_ROM_DOWNLOAD_URL: 'https://rom.example.com',
}
const storedValues = new Map()
const storageWrites = new Map()
globalThis.localStorage = {
  getItem: (key) => storedValues.get(key) ?? null,
  setItem: (key, value) => {
    storageWrites.set(key, (storageWrites.get(key) ?? 0) + 1)
    storedValues.set(key, String(value))
  },
  removeItem: (key) => storedValues.delete(key),
}
const windowListeners = new Map()
globalThis.window = {
  setTimeout: setTimeout.bind(globalThis),
  clearTimeout: clearTimeout.bind(globalThis),
  addEventListener: (type, listener) => {
    const listeners = windowListeners.get(type) ?? new Set()
    listeners.add(listener)
    windowListeners.set(type, listeners)
  },
  dispatchEvent: (event) => {
    for (const listener of windowListeners.get(event.type) ?? []) listener(event)
    return true
  },
}

const health = await import('../src/services/romRouteHealth.ts')
const { fetchBlobWithProgress, sameObjectRoutes } = await import('../src/emulator/loadProgress.ts')
const { probeRom, clearRomProbeCache, ROM_PROBE_HEDGE_MS } = await import('../src/services/roms.ts')
const { reachableRomAssetUrl, clearReachableRomOrigins } = await import('../src/services/romHosts.ts')
const { chooseRomHost } = await import('../src/services/romRoute.ts')

let failed = 0
const check = async (name, fn) => {
  health.resetRomRouteHealth()
  clearReachableRomOrigins()
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ❌ ${name}\n     ${e.stack ?? e.message}`)
  }
}

const abortError = () => new DOMException('已取消', 'AbortError')
const headers = (map) => ({ get: (k) => map[k.toLowerCase()] ?? null })
const byteAt = (i) => i % 251
const bodyFor = (start, end) => {
  const out = new Uint8Array(end - start + 1)
  for (let i = 0; i < out.length; i++) out[i] = byteAt(start + i)
  return out
}
const delay = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()) }, { once: true })
})
/** 一直不回响应头，直到被中止 */
const hang = (signal) => new Promise((_, reject) => {
  if (signal?.aborted) return reject(abortError())
  signal?.addEventListener('abort', () => reject(abortError()), { once: true })
})
/** 一个 206 回应；pieceDelay > 0 时正文分 4 段慢慢给，且能被中止 */
function rangeResponse(size, range, { pieceDelay = 0, signal } = {}) {
  const m = /bytes=(\d+)-(\d+)/.exec(range)
  const start = Number(m[1])
  const end = Math.min(Number(m[2]), size - 1)
  const bytes = bodyFor(start, end)
  const step = Math.ceil(bytes.length / 4)
  let at = 0
  const body = new ReadableStream({
    async pull(controller) {
      if (pieceDelay) await delay(pieceDelay, signal)
      if (signal?.aborted) throw abortError()
      if (at >= bytes.length) return controller.close()
      controller.enqueue(bytes.subarray(at, at + step))
      at += step
    },
  })
  return {
    ok: true,
    status: 206,
    headers: headers({ 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) }),
    body,
  }
}
const readAll = async (blob) => new Uint8Array(await blob.arrayBuffer())
const expectExact = (bytes, size) => {
  assert.equal(bytes.length, size, '总长度')
  for (let i = 0; i < size; i++) if (bytes[i] !== byteAt(i)) assert.fail(`第 ${i} 字节错位`)
}
const hostOf = (url) => new URL(url).host
const CHUNK = 65536
const SIZE = 4 * CHUNK

console.log('\n一、线路记分板')

await check('没有记录时保持调用方的原顺序', async () => {
  const A = 'https://a.test/r.zip?romv=1'
  const B = 'https://b.test/r.zip?romv=1'
  const C = 'https://c.test/r.zip?romv=1'
  assert.deepEqual(health.rankRomRoutes([A, B, C]), [A, B, C])
})

await check('高频分片样本合并写入；离页时持久化最新线路状态', async () => {
  const A = 'https://a.test/r.zip'
  const key = '8bitgo.rom-route-health.v1'
  const before = storageWrites.get(key) ?? 0
  health.recordRomRouteTransfer(A, 1_000_000, 500)
  health.recordRomRouteTransfer(A, 1_200_000, 500)
  health.recordRomRouteTransfer(A, 1_400_000, 500)
  assert.equal(storageWrites.get(key) ?? 0, before, '每片更新只改内存，不应同步重写 localStorage')
  assert.ok(health.romRouteRate(A) > 0, '同一页的线路排序应立即看到内存中的新样本')
  window.dispatchEvent({ type: 'pagehide' })
  assert.equal(storageWrites.get(key), before + 1, '离页时把合并后的最新状态写一次')
  const saved = JSON.parse(localStorage.getItem(key))
  assert.equal(saved['https://a.test'].rateAt > 0, true)
})

await check('一次故障排到后面，连续两次熔断，任何一次成功立即恢复', async () => {
  const A = 'https://a.test/r.zip'
  const B = 'https://b.test/r.zip'
  const t = Date.now()
  health.recordRomRouteFailure(A, 'network', t)
  assert.equal(health.isRomRouteOpen(A, t), false)
  assert.deepEqual(health.rankRomRoutes([A, B], t), [B, A])
  health.recordRomRouteFailure(A, 'timeout', t + 6000)
  assert.equal(health.isRomRouteOpen(A, t + 6000), true, '连续两次故障熔断')
  assert.deepEqual(health.rankRomRoutes([A, B], t + 6000), [B, A])
  health.recordRomRouteTransfer(A, 1 << 20, 100, t + 6000)
  assert.equal(health.isRomRouteOpen(A, t + 6000), false, '成功一次就恢复')
})

await check('同一批请求一起失败只算一次（2026-11-18 明文 + 8BG 两个 HEAD 同时超时，一次开页就熔断）', async () => {
  const A = 'https://a.test/r.zip'
  const t = Date.now()
  health.recordRomRouteFailure(A, 'timeout', t)
  health.recordRomRouteFailure(A, 'timeout', t + 1)
  health.recordRomRouteFailure(A, 'network', t + 4000)
  assert.equal(health.isRomRouteOpen(A, t + 4000), false, '5 秒内的几次失败合成一次')
  health.recordRomRouteFailure(A, 'timeout', t + 5000)
  assert.equal(health.isRomRouteOpen(A, t + 5000), true, '窗口从第一次失败算起、不顺延：5 秒后的再一次照常累计')
})

await check('熔断只是排到最后，不从候选里删掉', async () => {
  const A = 'https://a.test/r.zip'
  const B = 'https://b.test/r.zip'
  const t = Date.now()
  for (const url of [A, B]) {
    health.recordRomRouteFailure(url, 'network', t - 6000)
    health.recordRomRouteFailure(url, 'network', t)
    assert.equal(health.isRomRouteOpen(url, t), true)
  }
  assert.deepEqual(health.rankRomRoutes([A, B], t), [A, B], '全部熔断时仍按原顺序全部给出')
})

await check('真实吞吐快 15% 以上才越过排在前面的线路', async () => {
  const A = 'https://a.test/r.zip'
  const B = 'https://b.test/r.zip'
  health.recordRomRouteTransfer(A, 1_000_000, 1000)
  health.recordRomRouteTransfer(B, 1_100_000, 1000)
  assert.deepEqual(health.rankRomRoutes([A, B]), [A, B], '只快 10%：不换')
  health.resetRomRouteHealth()
  health.recordRomRouteTransfer(A, 1_000_000, 1000)
  health.recordRomRouteTransfer(B, 4_000_000, 1000)
  assert.deepEqual(health.rankRomRoutes([A, B]), [B, A])
})

await check('分片负载分摊沿用故障折扣，不让稍快但近期失败的线路反超', async () => {
  const A = 'https://a.test/x.zip?romv=1'
  const B = 'https://b.test/x.zip?romv=1'
  // B 的原始测速比 A 快 50%，但近期失败折扣后低于 A；首片也会把 A 的实测速率更新到低于 B 原始测速。
  health.recordRomRouteTransfer(A, 1_000_000, 1000)
  health.recordRomRouteTransfer(B, 1_500_000, 1000)
  health.recordRomRouteFailure(B, 'network')
  const size = 4 * CHUNK
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push(`${hostOf(url)} ${init.headers.Range}`)
    return rangeResponse(size, init.headers.Range, { pieceDelay: 10, signal: init.signal })
  }
  const blob = await fetchBlobWithProgress(A, {
    fetchImpl, chunkBytes: CHUNK, routeHealth: true, routeHedgeMs: 5000, maxConcurrency: 1,
    alternateUrls: [B], networkHints: { downlinkMbps: 100 },
  })
  expectExact(await readAll(blob), size)
  assert.ok(
    requests.includes(`a.test bytes=${CHUNK}-${2 * CHUNK - 1}`),
    `B 的原始速率较高但近期失败后，下一片应留在 A：${requests.join(', ')}`,
  )
})

await check('太小的样本和过期的吞吐都不算数', async () => {
  const A = 'https://a.test/r.zip'
  health.recordRomRouteTransfer(A, 1000, 50)
  assert.equal(health.romRouteRate(A), undefined, '1KB 主要是调度抖动')
  const now = Date.now()
  health.recordRomRouteTransfer(A, 1 << 20, 100, now - health.ROUTE_RATE_TTL_MS - 1000)
  assert.equal(health.romRouteRate(A, now), undefined, '半小时前的吞吐不再可信')
  health.recordRomRouteTransfer(A, 1 << 20, 100, now)
  assert.ok(health.romRouteRate(A, now) > 10_000)
})

console.log('\n二、哪些线路可以混着取分片')

await check('只有路径与查询串（含 romv）完全相同的线路才进分片池', async () => {
  const A = 'https://a.test/roms/arcade/x.zip?romv=etag1'
  assert.deepEqual(sameObjectRoutes(A, [
    'https://b.test/roms/arcade/x.zip?romv=etag1',
    'https://c.test/roms/arcade/x.zip?romv=etag2',
    'https://d.test/roms/arcade/y.zip?romv=etag1',
    'https://a.test/roms/arcade/x.zip?romv=etag1',
  ]), [A, 'https://b.test/roms/arcade/x.zip?romv=etag1'])
  assert.deepEqual(sameObjectRoutes('https://a.test/x.zip', ['https://b.test/x.zip']), ['https://a.test/x.zip'], '不带 romv 绝不混片')
})

console.log('\n三、分片下载')

await check('响应头迟迟不来：另一条线路同时请求，先回的赢，内容逐字节正确', async () => {
  const urls = []
  const fetchImpl = async (url, init) => {
    urls.push(String(url))
    if (hostOf(url) === 'a.test') return hang(init.signal)
    return rangeResponse(SIZE, init.headers.Range, { signal: init.signal })
  }
  const started = Date.now()
  const blob = await fetchBlobWithProgress('https://a.test/x.zip?romv=1', {
    fetchImpl, chunkBytes: CHUNK, routeHealth: true, routeHedgeMs: 30, maxConcurrency: 2,
    alternateUrls: ['https://b.test/x.zip?romv=1'], networkHints: {},
  })
  expectExact(await readAll(blob), SIZE)
  assert.ok(Date.now() - started < 3000, '不能等满看门狗')
  assert.ok(urls.some((url) => hostOf(url) === 'b.test'))
  assert.ok(health.romRouteRate('https://a.test/') === undefined)
})

await check('首片响应头对冲改线后，真实占用量跟随获胜线路，后续并发片不继续挤在该线路', async () => {
  const size = 6 * CHUNK
  const requests = []
  // 确保迁移到 B 的在途占用会让仍有较高有效速率的 A 接到下一片。
  health.recordRomRouteTransfer('https://a.test/x.zip?romv=1', 2_000_000, 1000)
  health.recordRomRouteTransfer('https://b.test/x.zip?romv=1', 1_000_000, 1000)
  const fetchImpl = async (url, init) => {
    const host = hostOf(url)
    const range = init.headers.Range
    requests.push(`${host} ${range}`)
    // 只有首片的原线路不回响应头，确保首片由备用域提供；其余范围两域都能正常服务。
    if (host === 'a.test' && range === 'bytes=0-65535') return hang(init.signal)
    return rangeResponse(size, range, { pieceDelay: 10, signal: init.signal })
  }
  const blob = await fetchBlobWithProgress('https://a.test/x.zip?romv=1', {
    fetchImpl, chunkBytes: CHUNK, routeHealth: true, routeHedgeMs: 20, maxConcurrency: 3,
    alternateUrls: ['https://b.test/x.zip?romv=1'], networkHints: { downlinkMbps: 100 },
  })
  expectExact(await readAll(blob), size)
  assert.ok(
    requests.includes(`a.test bytes=${CHUNK}-${2 * CHUNK - 1}`),
    `首片由 b.test 接手后，第一个并发新片应使用仍空闲的 a.test：${requests.join(', ')}`,
  )
})

await check('错误响应不能抢赢仍在等待的有效线路（快 404 / HTML + 慢 206）', async () => {
  const size = CHUNK
  for (const invalidResponse of [
    new Response('missing', { status: 404 }),
    new Response('<html>upstream error</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
  ]) {
    const urls = []
    const fetchImpl = async (url, init) => {
      const host = hostOf(url)
      urls.push(host)
      if (host === 'a.test') {
        await delay(80, init.signal)
        return rangeResponse(size, init.headers.Range, { signal: init.signal })
      }
      return invalidResponse
    }
    const blob = await fetchBlobWithProgress('https://a.test/x.zip?romv=1', {
      fetchImpl, chunkBytes: CHUNK, routeHealth: true, routeHedgeMs: 10, maxConcurrency: 1,
      alternateUrls: ['https://b.test/x.zip?romv=1'], networkHints: {},
      check: (res) => {
        if (/text\/html/i.test(res.headers.get('content-type') ?? '')) throw new Error('HTML error page')
      },
    })
    expectExact(await readAll(blob), size)
    assert.deepEqual(urls, ['a.test', 'b.test'], '两条线路都应响应，坏响应不得中止主线路')
  }
  assert.equal(health.isRomRouteOpen('https://a.test/x.zip'), false, '错误线路的快速 404 不能记成主线路失速')
})

await check('一片在一条线路上断了：换另一条重下这一片，不整局失败', async () => {
  const urls = []
  const fetchImpl = async (url, init) => {
    urls.push(`${hostOf(url)} ${init.headers.Range}`)
    if (hostOf(url) === 'a.test' && init.headers.Range.startsWith(`bytes=${CHUNK}-`)) throw new TypeError('Failed to fetch')
    return rangeResponse(SIZE, init.headers.Range, { signal: init.signal })
  }
  const blob = await fetchBlobWithProgress('https://a.test/x.zip?romv=1', {
    fetchImpl, chunkBytes: CHUNK, routeHealth: true, routeHedgeMs: 5000, maxConcurrency: 1, retries: 2,
    alternateUrls: ['https://b.test/x.zip?romv=1'], networkHints: {},
  })
  expectExact(await readAll(blob), SIZE)
  assert.ok(urls.includes(`b.test bytes=${CHUNK}-${2 * CHUNK - 1}`), `第二片应在 b.test 上重下：${urls.join(', ')}`)
})

await check('尾部对冲：一条线路上的片下得特别慢，空出来的一路去另一条线路重下，先完的落盘', async () => {
  const requests = []
  const fetchImpl = async (url, init) => {
    const range = init.headers.Range
    requests.push(`${hostOf(url)} ${range}`)
    // a.test 首片正常，之后的片正文每段要等 300ms（整片 1.2 秒）
    const slow = hostOf(url) === 'a.test' && !range.startsWith('bytes=0-')
    return rangeResponse(SIZE, range, { pieceDelay: slow ? 300 : 0, signal: init.signal })
  }
  const started = Date.now()
  const blob = await fetchBlobWithProgress('https://a.test/x.zip?romv=1', {
    fetchImpl, chunkBytes: CHUNK, routeHealth: true, routeHedgeMs: 40, maxConcurrency: 2,
    alternateUrls: ['https://b.test/x.zip?romv=1'], networkHints: { downlinkMbps: 100 },
  })
  expectExact(await readAll(blob), SIZE)
  const elapsed = Date.now() - started
  const slowOnA = requests.filter((r) => r.startsWith('a.test') && !r.includes('bytes=0-')).map((r) => r.split(' ')[1])
  assert.ok(slowOnA.length > 0, `测试前提：至少有一片分给了 a.test（${requests.join(', ')}）`)
  for (const range of slowOnA) assert.ok(requests.includes(`b.test ${range}`), `a.test 上的慢片 ${range} 应在 b.test 上对冲`)
  assert.ok(elapsed < 1000, `对冲后不必等满慢片的 1.2 秒（实际 ${elapsed}ms）`)
})

await check('不带 romv 的地址：不跨线路取分片、也不对冲', async () => {
  const urls = []
  const fetchImpl = async (url, init) => {
    urls.push(String(url))
    if (hostOf(url) === 'a.test') await delay(80, init.signal)
    return rangeResponse(SIZE, init.headers.Range, { signal: init.signal })
  }
  const blob = await fetchBlobWithProgress('https://a.test/x.zip', {
    fetchImpl, chunkBytes: CHUNK, routeHealth: true, routeHedgeMs: 10, maxConcurrency: 2,
    alternateUrls: ['https://b.test/x.zip'], networkHints: {},
  })
  expectExact(await readAll(blob), SIZE)
  assert.ok(urls.every((url) => hostOf(url) === 'a.test'), urls.join(', '))
})

await check('省流量模式：不为同一段字节同时问两条线路', async () => {
  const urls = []
  const fetchImpl = async (url, init) => {
    urls.push(String(url))
    if (hostOf(url) === 'a.test') await delay(80, init.signal)
    return rangeResponse(SIZE, init.headers.Range, { signal: init.signal })
  }
  const blob = await fetchBlobWithProgress('https://a.test/x.zip?romv=1', {
    fetchImpl, chunkBytes: CHUNK, routeHealth: true, routeHedgeMs: 10, maxConcurrency: 1,
    alternateUrls: ['https://b.test/x.zip?romv=1'], networkHints: { saveData: true },
  })
  expectExact(await readAll(blob), SIZE)
  const ranges = urls.length
  assert.equal(ranges, SIZE / CHUNK, `每片只请求一次（${urls.join(', ')}）`)
})

await check('记分板认定原线路熔断：开局就改走另一条', async () => {
  health.recordRomRouteFailure('https://a.test/', 'network', Date.now() - 6000)
  health.recordRomRouteFailure('https://a.test/', 'network')
  assert.equal(health.isRomRouteOpen('https://a.test/'), true)
  const urls = []
  const fetchImpl = async (url, init) => {
    urls.push(String(url))
    return rangeResponse(SIZE, init.headers.Range, { signal: init.signal })
  }
  const blob = await fetchBlobWithProgress('https://a.test/x.zip', {
    fetchImpl, chunkBytes: CHUNK, routeHealth: true, maxConcurrency: 1,
    alternateUrls: ['https://b.test/x.zip'], networkHints: {},
  })
  expectExact(await readAll(blob), SIZE)
  assert.equal(hostOf(urls[0]), 'b.test')
})

await check('首段吞吐从响应头算起，握手和首字节不压低并发', async () => {
  const src = readFileSync(new URL('../src/emulator/loadProgress.ts', import.meta.url), 'utf8')
  assert.match(src, /const sampleStartedAt = answer\.headersAt/)
  assert.match(src, /startedAt = monotonicNow\(\)\n      validateResponse\(res, opts\.check\)/, '备用线路采样同一口径')
})

await check('首片早期采样只做预取，正式并发按完整分片吞吐校正', async () => {
  const chunk = 1 << 20
  const size = 6 * chunk
  const starts = []
  let releaseParts
  const partsReleased = new Promise((resolve) => { releaseParts = resolve })
  let fourPartsStarted
  const fourStarted = new Promise((resolve) => { fourPartsStarted = resolve })
  const fetchImpl = async (_url, init) => {
    const range = init.headers.Range
    const match = /bytes=(\d+)-(\d+)/.exec(range)
    const start = Number(match[1])
    const end = Number(match[2])
    if (start === 0) {
      const bytes = bodyFor(0, end)
      const body = new ReadableStream({
        start(controller) {
          setTimeout(() => {
            // 256 KiB / 300 ms 看起来约 7 Mbps（两路）；整片 / 300 ms 约 28 Mbps（四路）。
            controller.enqueue(bytes.subarray(0, 256 * 1024))
            controller.enqueue(bytes.subarray(256 * 1024))
            controller.close()
          }, 300)
        },
      })
      return {
        ok: true,
        status: 206,
        headers: headers({ 'content-range': `bytes 0-${end}/${size}`, 'content-length': String(chunk) }),
        body,
      }
    }
    starts.push(start)
    if (starts.length === 4) fourPartsStarted()
    await partsReleased
    return rangeResponse(size, range)
  }
  const blobTask = fetchBlobWithProgress('https://a.test/first-sample.zip?romv=1', {
    fetchImpl,
    chunkBytes: chunk,
    maxConcurrency: 4,
    networkHints: { hardwareConcurrency: 8, deviceMemoryGb: 8 },
  })
  const reachedFour = await Promise.race([
    fourStarted.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
  ])
  releaseParts()
  const blob = await blobTask
  assert.equal(reachedFour, true, `整片测速应在后续分片中放开四路；实际起始偏移：${starts.join(', ')}`)
  assert.deepEqual(starts.slice(0, 4), [chunk, 2 * chunk, 3 * chunk, 4 * chunk])
  expectExact(await readAll(blob), size)
})

await check('完整首片降档时取消超出正式并发的早期预取', async () => {
  const chunk = 1 << 20
  const size = 4 * chunk
  const requestsByStart = new Map()
  let releasePartOne
  let abortedEarly = 0
  const abortedStarts = []
  let resolveAborts
  const twoAborts = new Promise((resolve) => { resolveAborts = resolve })
  const controller = new AbortController()
  const fetchImpl = async (_url, init) => {
    const match = /bytes=(\d+)-(\d+)/.exec(init.headers.Range)
    const start = Number(match[1])
    const end = Number(match[2])
    const attempt = (requestsByStart.get(start) ?? 0) + 1
    requestsByStart.set(start, attempt)
    if (start === 0) {
      const bytes = bodyFor(0, end)
      const body = new ReadableStream({
        start(stream) {
          // 256 KiB / 25 ms 约 84 Mbps，早期样本会先放出四路；整片延长到 1.2 秒后约 7 Mbps。
          setTimeout(() => {
            stream.enqueue(bytes.subarray(0, 256 * 1024))
            setTimeout(() => {
              stream.enqueue(bytes.subarray(256 * 1024))
              stream.close()
            }, 1175)
          }, 25)
        },
      })
      return {
        ok: true,
        status: 206,
        headers: headers({ 'content-range': `bytes 0-${end}/${size}`, 'content-length': String(chunk) }),
        body,
      }
    }
    // 首次请求是早期预取。保留 index 1，其余要在完整测速降档后被中止；正常 worker 会重下被取消的块。
    if (attempt === 1 && start === chunk) {
      return new Promise((resolve, reject) => {
        releasePartOne = () => resolve(rangeResponse(size, init.headers.Range))
        if (init.signal.aborted) return reject(abortError())
        init.signal.addEventListener('abort', () => reject(abortError()), { once: true })
      })
    }
    if (attempt === 1) {
      return new Promise((resolve, reject) => {
        if (init.signal.aborted) return reject(abortError())
        init.signal.addEventListener('abort', () => {
          abortedEarly++
          abortedStarts.push(start)
          if (abortedEarly === 2) resolveAborts()
          reject(abortError())
        }, { once: true })
      })
    }
    return rangeResponse(size, init.headers.Range)
  }
  const blobTask = fetchBlobWithProgress('https://a.test/slow-after-burst.zip?romv=1', {
    fetchImpl,
    chunkBytes: chunk,
    maxConcurrency: 4,
    signal: controller.signal,
    networkHints: { hardwareConcurrency: 8, deviceMemoryGb: 8 },
  })
  const canceled = await Promise.race([
    twoAborts.then(() => true),
    delay(2_500).then(() => false),
  ])
  if (!canceled) {
    controller.abort()
    await blobTask.catch(() => {})
    assert.equal(canceled, true, `降档后应中止多余预取；各 Range 请求数：${JSON.stringify([...requestsByStart])}`)
  }
  releasePartOne?.()
  const blob = await blobTask
  assert.equal(abortedEarly, 2, `只中止正式并发之外的两片；实为 ${abortedEarly} 次，偏移 ${JSON.stringify(abortedStarts)}，请求 ${JSON.stringify([...requestsByStart])}`)
  assert.equal(requestsByStart.get(chunk), 1, '正式两路预算内的早期分片应被保留')
  assert.equal(requestsByStart.get(2 * chunk), 2, '取消的分片应由正式 worker 按新预算重下')
  assert.equal(requestsByStart.get(3 * chunk), 2, '尚未轮到的早期分片也应取消后按新预算重下')
  expectExact(await readAll(blob), size)
})

await check('备用线路测速不暂停当前 ROM 正文；小文件首片结束就取消慢探测', async () => {
  const size = 1 << 20
  const chunk = size
  let alternateAborted = false
  let primaryChunks = 0
  const fetchImpl = async (url, init) => {
    if (hostOf(url) === 'b.test') {
      return new Promise((_, reject) => {
        if (init.signal.aborted) {
          alternateAborted = true
          reject(abortError())
          return
        }
        init.signal.addEventListener('abort', () => {
          alternateAborted = true
          reject(abortError())
        }, { once: true })
      })
    }
    const range = /bytes=(\d+)-(\d+)/.exec(init.headers.Range)
    const start = Number(range[1])
    const end = Math.min(Number(range[2]), size - 1)
    const bytes = bodyFor(start, end)
    let offset = 0
    const body = new ReadableStream({
      async pull(controller) {
        if (offset === 0) await delay(750, init.signal)
        if (init.signal.aborted) throw abortError()
        if (offset >= bytes.length) return controller.close()
        const next = Math.min(bytes.length, offset + 256 * 1024)
        controller.enqueue(bytes.subarray(offset, next))
        offset = next
        primaryChunks++
      },
    })
    return {
      ok: true,
      status: 206,
      headers: headers({ 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) }),
      body,
    }
  }
  const started = Date.now()
  const blob = await fetchBlobWithProgress('https://a.test/slow.bin?romv=1', {
    fetchImpl,
    chunkBytes: chunk,
    routeHealth: true,
    maxConcurrency: 1,
    alternateUrls: ['https://b.test/slow.bin?romv=1'],
    networkHints: {},
  })
  const elapsed = Date.now() - started
  expectExact(await readAll(blob), size)
  assert.equal(primaryChunks, 4, '首片正文应在备用线路探测等待期间继续读完')
  assert.ok(elapsed < 1_300, `备用线路失去响应不应在首片读包体中额外阻塞 1.5 秒（${elapsed}ms）`)
  assert.equal(alternateAborted, true, '首片已完整时应取消尚未返回响应头的测速请求')
})

console.log('\n四、ROM 存在性检查（HEAD）')

const ROM = 'https://rom.example.com/roms/nes/x.nes'
const headOk = (etag) => ({ ok: true, status: 200, headers: headers({ etag, 'content-length': '1024', 'content-type': 'application/octet-stream' }) })

await check('第一条线路不答复：约 1 秒后同时问下一条，先答「在」的赢，输家被中止', async () => {
  clearRomProbeCache()
  let romAborted = false
  globalThis.fetch = async (url, init) => {
    if (hostOf(url) === 'rom.example.com') {
      init.signal.addEventListener('abort', () => { romAborted = true }, { once: true })
      return hang(init.signal)
    }
    return headOk('"e1"')
  }
  const started = Date.now()
  const outcome = await probeRom(ROM, 4000, false, { retry: false })
  const elapsed = Date.now() - started
  assert.equal(outcome.url, 'https://download.example.com/roms/nes/x.nes?romv=e1')
  assert.ok(elapsed >= ROM_PROBE_HEDGE_MS - 50 && elapsed < ROM_PROBE_HEDGE_MS + 1500, `不必等满 4 秒（实际 ${elapsed}ms）`)
  assert.ok(romAborted, '赢家出现后输家立刻中止')
})

await check('原地址答「没有」就是最终结论，不再问别的线路', async () => {
  clearRomProbeCache()
  const asked = []
  globalThis.fetch = async (url) => {
    asked.push(hostOf(url))
    return { ok: false, status: 404, headers: headers({}) }
  }
  const outcome = await probeRom(ROM, 4000, false, { retry: false })
  assert.equal(outcome.url, '')
  assert.equal(outcome.certain, true)
  assert.deepEqual(asked, ['rom.example.com'])
})

await check('备用线路答「没有」不抢先定案：继续问其余线路', async () => {
  clearRomProbeCache()
  globalThis.fetch = async (url, init) => {
    const host = hostOf(url)
    if (host === 'rom.example.com') return hang(init.signal)
    if (host === 'download.example.com') return { ok: false, status: 404, headers: headers({}) }
    return headOk('"e2"')
  }
  const outcome = await probeRom(ROM, 1500, false, { retry: false })
  assert.equal(outcome.url, 'https://cn-assets.example.com/roms/nes/x.nes?romv=e2')
})

await check('超时过一次的线路排到后面：下一次检查先问别的线路', async () => {
  const asked = []
  globalThis.fetch = async (url, init) => {
    asked.push(hostOf(url))
    if (hostOf(url) === 'rom.example.com') return hang(init.signal)
    return headOk('"e3"')
  }
  clearRomProbeCache()
  await probeRom(ROM, 300, false, { retry: false })
  assert.equal(health.rankRomRoutes([ROM, 'https://download.example.com/roms/nes/x.nes'])[0], 'https://download.example.com/roms/nes/x.nes')
  clearRomProbeCache()
  asked.length = 0
  const started = Date.now()
  const outcome = await probeRom(ROM, 4000, false, { retry: false })
  assert.equal(asked[0], 'download.example.com')
  assert.ok(outcome.url.startsWith('https://download.example.com/'))
  assert.ok(Date.now() - started < 500, '不再先撞熔断中的线路')
})

console.log('\n五、BIOS / 线路选择也读记分板')

await check('BIOS：第一条线路不答复时 600ms 后同时问下一条', async () => {
  globalThis.fetch = async (url, init) => {
    if (hostOf(url) === 'download.example.com') return hang(init.signal)
    return { ok: true, status: 206, headers: headers({}), body: null }
  }
  const started = Date.now()
  const url = await reachableRomAssetUrl('https://download.example.com/roms/bios/neogeo.zip')
  assert.equal(hostOf(url), 'rom.example.com')
  assert.ok(Date.now() - started < 1500)
})

// 2026-11-20《实况足球 2000》大陆实测：优选域响应头秒回、正文 7 KB/s，1 字节探测选中它，512KB 的 PS1 BIOS 下了 74 秒
await check('BIOS：响应头秒回、正文很慢的线路输给先读完样本的线路', async () => {
  const BIOS = 512 * 1024
  globalThis.fetch = async (url, init) => {
    const slow = hostOf(url) === 'rom.example.com'
    return rangeResponse(BIOS, init.headers.Range, { pieceDelay: slow ? 1500 : 10, signal: init.signal })
  }
  const started = Date.now()
  const url = await reachableRomAssetUrl('https://rom.example.com/roms/bios/scph1001.bin')
  assert.notEqual(hostOf(url), 'rom.example.com', '不能只看响应头')
  assert.ok(Date.now() - started < 1500, '对冲后快线路先读完')
  assert.ok((health.romRouteRate(url) ?? 0) > 0, '样本吞吐记进记分板，下一局和 ROM 下载也看得见')
})

await check('BIOS：排第一的线路测过但很慢，不免探测', async () => {
  // 只有它测过（约 7 字节/毫秒）、别的没测过：排序把没测过的当成一样快，它仍排第一
  health.recordRomRouteTransfer('https://rom.example.com/', 64 * 1024, 9000)
  let calls = 0
  globalThis.fetch = async (url, init) => {
    calls++
    const slow = hostOf(url) === 'rom.example.com'
    return rangeResponse(512 * 1024, init.headers.Range, { pieceDelay: slow ? 1500 : 10, signal: init.signal })
  }
  const url = await reachableRomAssetUrl('https://rom.example.com/roms/bios/scph1001.bin')
  assert.ok(calls > 0, '慢线路不能免探测直接用')
  assert.notEqual(hostOf(url), 'rom.example.com')
})

await check('BIOS：探测只读 64KB 样本，不把整份 BIOS 拖下来', async () => {
  const ranges = []
  globalThis.fetch = async (url, init) => {
    ranges.push(init.headers.Range)
    return rangeResponse(4 << 20, init.headers.Range, { pieceDelay: 10, signal: init.signal })
  }
  await reachableRomAssetUrl('https://rom.example.com/roms/bios/neogeo.zip')
  assert.deepEqual([...new Set(ranges)], ['bytes=0-65535'])
})

await check('BIOS：排第一的线路刚有真实下载就直接用，不发探测', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('不该探测') }
  health.recordRomRouteTransfer('https://download.example.com/', 8 << 20, 1000)
  const url = await reachableRomAssetUrl('https://download.example.com/roms/bios/pgm.zip')
  assert.equal(hostOf(url), 'download.example.com')
  assert.equal(calls, 0)
})

await check('主域 / 镜像：记分板有结论时不跑 64KB 小探针', async () => {
  let calls = 0
  const counting = async () => { calls++; throw new Error('不该探测') }
  health.recordRomRouteFailure('https://cn-assets.example.com/', 'network', Date.now() - 6000)
  health.recordRomRouteFailure('https://cn-assets.example.com/', 'network')
  const opts = { fetchImpl: counting, cacheResults: true, storage: null }
  assert.equal(await chooseRomHost('https://download.example.com', 'https://cn-assets.example.com', { ...opts, prefer: 'mirror' }), 'primary', '镜像熔断：大陆访客也走主域')
  health.resetRomRouteHealth()
  health.recordRomRouteTransfer('https://download.example.com/', 1 << 20, 1000)
  health.recordRomRouteTransfer('https://cn-assets.example.com/', 8 << 20, 1000)
  assert.equal(await chooseRomHost('https://download.example.com', 'https://cn-assets.example.com', opts), 'mirror', '镜像真实吞吐快得多')
  assert.equal(calls, 0)
})

await check('光盘候选（PSP / Dolphin / PS2）都按记分板排序', async () => {
  for (const file of ['ppsspp', 'dolphin']) {
    const src = readFileSync(new URL(`../src/emulator/adapters/${file}.ts`, import.meta.url), 'utf8')
    // 这两处的多线路逐条探测上线后，候选必须经过记分板排序
    if (/alternateRomUrls\(game\)/.test(src)) {
      assert.match(src, /const candidates = rankRomRoutes\(\[game, \.\.\.alternateRomUrls\(game\)\]\)/, file)
    }
  }
  const play = readFileSync(new URL('../src/emulator/adapters/play.ts', import.meta.url), 'utf8')
  assert.match(play, /rankRomRoutes\(\[options\.game, \.\.\.alternateRomUrls\(options\.game\)\]\)/)
})

await check('真实用户回报：只计托管的优选域名，合并掉的同批失败不重复计', async () => {
  const report = await import('../src/services/romRouteReport.ts')
  report.takeRouteReport()
  const seen = []
  health.setRomRouteListener((origin, ok) => {
    seen.push([origin, ok])
    report.noteRouteResult(origin, ok)
  })
  try {
    const t = 5_000_000
    health.recordRomRouteFailure('https://rom.8bitgo.com/roms/a.zip', 'network', t)
    health.recordRomRouteFailure('https://rom.8bitgo.com/roms/a.zip.8bg', 'timeout', t + 100) // 同一批，合并
    health.recordRomRouteTransfer('https://download.8bitgo.com/roms/a.zip', 128 * 1024, 100, t + 200)
    health.recordRomRouteFailure('https://assets.8bitgo.com/roms/a.zip', 'network', t + 300) // 不托管
    assert.equal(seen.length, 3)
    const body = JSON.parse(report.takeRouteReport())
    assert.deepEqual(body.r, [{ h: 'rom.8bitgo.com', ok: 0, fail: 1 }, { h: 'download.8bitgo.com', ok: 1, fail: 0 }])
    assert.equal(report.takeRouteReport(), null, '取过一次就清空')
    assert.equal(report.routeReportHost('http://rom.8bitgo.com'), '', '只认 https')
  } finally {
    health.setRomRouteListener(null)
  }
})

if (failed) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过 ✅')
