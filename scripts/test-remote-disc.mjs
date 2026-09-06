/**
 * 远程光盘（src/emulator/remoteDisc.ts）的回归测试。
 *
 *   npm run test:remote-disc
 *
 * 测的是真代码：把 fetchRange 换成一个内存里的假盘，就能在 node 里跑完整逻辑，
 * 不需要浏览器也不需要网络。
 *
 * 为什么这块值得单独测：它是 PS2 能不能上网页的唯一前提。而它出错的方式很难发现 ——
 * 分块拼接差一个字节，症状是游戏里某张贴图花了、某段语音噼啪响，不会有任何报错；
 * LRU 算错则表现为「玩久了越来越卡」。这两类都不可能靠手点发现。
 */
import assert from 'node:assert/strict'
import { RemoteDisc, probeRange } from '../src/emulator/remoteDisc.ts'

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

/** 一张假盘：第 i 个字节就是 i % 251（用质数，错位一格立刻就能看出来） */
const DISC_SIZE = 10 * 1024 * 1024
const byteAt = (i) => i % 251
function fakeDisc(size = DISC_SIZE) {
  const calls = []
  const fetchRange = async (start, endInclusive) => {
    calls.push([start, endInclusive])
    const len = endInclusive - start + 1
    const out = new Uint8Array(len)
    for (let i = 0; i < len; i++) out[i] = byteAt(start + i)
    return out.buffer
  }
  return { fetchRange, calls }
}

const expectBytes = (buf, from, to) => {
  const got = new Uint8Array(buf)
  assert.equal(got.length, to - from, `长度应为 ${to - from}，实际 ${got.length}`)
  for (let i = 0; i < got.length; i++) {
    if (got[i] !== byteAt(from + i)) {
      throw new Error(`偏移 ${from + i} 的字节错了：应为 ${byteAt(from + i)}，实际 ${got[i]}`)
    }
  }
}

console.log('一、读取正确性')

await check('块内读：不跨块的一段', async () => {
  const { fetchRange } = fakeDisc()
  const d = new RemoteDisc({ size: DISC_SIZE, fetchRange, chunkBytes: 64 * 1024, prefetch: false })
  expectBytes(await d.slice(1000, 3048).arrayBuffer(), 1000, 3048)
})

await check('跨块读：正好跨过块边界（拼接差一格这里就会炸）', async () => {
  const chunk = 64 * 1024
  const { fetchRange } = fakeDisc()
  const d = new RemoteDisc({ size: DISC_SIZE, fetchRange, chunkBytes: chunk, prefetch: false })
  expectBytes(await d.slice(chunk - 10, chunk + 10).arrayBuffer(), chunk - 10, chunk + 10)
})

await check('跨很多块的一段（过场动画那种连续大读）', async () => {
  const { fetchRange } = fakeDisc()
  const d = new RemoteDisc({ size: DISC_SIZE, fetchRange, chunkBytes: 8 * 1024, prefetch: false })
  expectBytes(await d.slice(5000, 5000 + 100 * 1024).arrayBuffer(), 5000, 5000 + 100 * 1024)
})

await check('读到盘末：不越界，也不报错', async () => {
  const { fetchRange } = fakeDisc()
  const d = new RemoteDisc({ size: DISC_SIZE, fetchRange, chunkBytes: 8 * 1024, prefetch: false })
  const buf = await d.slice(DISC_SIZE - 100, DISC_SIZE + 5000).arrayBuffer()
  expectBytes(buf, DISC_SIZE - 100, DISC_SIZE)
})

await check('盘末之后整段读：给空的，不发请求（核心探测盘尾时会这么读）', async () => {
  const { fetchRange, calls } = fakeDisc()
  const d = new RemoteDisc({ size: DISC_SIZE, fetchRange, chunkBytes: 8 * 1024, prefetch: false })
  const buf = await d.slice(DISC_SIZE + 10, DISC_SIZE + 2048).arrayBuffer()
  assert.equal(buf.byteLength, 0)
  assert.equal(calls.length, 0)
})

await check('slice() 必须同步返回带 arrayBuffer 的对象（Play! 就是这么调的）', () => {
  const { fetchRange } = fakeDisc()
  const d = new RemoteDisc({ size: DISC_SIZE, fetchRange, chunkBytes: 8 * 1024, prefetch: false })
  const s = d.slice(0, 16)
  assert.equal(typeof s.arrayBuffer, 'function', 'slice() 写成 async 的话这里就是 undefined')
})

console.log('二、请求次数（延迟是这条路的命门）')

await check('一块只取一次：同一块反复读不重复走网络', async () => {
  const { fetchRange, calls } = fakeDisc()
  const d = new RemoteDisc({ size: DISC_SIZE, fetchRange, chunkBytes: 64 * 1024, prefetch: false })
  for (let i = 0; i < 20; i++) await d.slice(i * 2048, (i + 1) * 2048).arrayBuffer()
  // 20 × 2048 = 40KB，全在第 0 块里
  assert.equal(calls.length, 1, `应该只发 1 次，实际 ${calls.length} 次`)
  assert.equal(d.stats.hits, 19)
})

await check('一次 Range 换回上千次扇区读（这就是分块的全部意义）', async () => {
  const { calls, fetchRange } = fakeDisc()
  const d = new RemoteDisc({ size: DISC_SIZE, fetchRange, chunkBytes: 2 * 1024 * 1024, prefetch: false })
  // 顺序读 1MB，按 2048 字节一个扇区
  for (let off = 0; off < 1024 * 1024; off += 2048) await d.slice(off, off + 2048).arrayBuffer()
  assert.equal(calls.length, 1)
})

await check('并发要同一块只发一次请求（去重）', async () => {
  const { fetchRange, calls } = fakeDisc()
  const d = new RemoteDisc({ size: DISC_SIZE, fetchRange, chunkBytes: 64 * 1024, prefetch: false })
  await Promise.all([0, 1, 2, 3, 4].map((i) => d.slice(i * 1024, (i + 1) * 1024).arrayBuffer()))
  assert.equal(calls.length, 1, `并发去重失效，发了 ${calls.length} 次`)
})

await check('顺序预取：读完第 0 块会顺手把第 1 块拉了', async () => {
  const { fetchRange, calls } = fakeDisc()
  const d = new RemoteDisc({ size: DISC_SIZE, fetchRange, chunkBytes: 64 * 1024, prefetch: true })
  await d.slice(0, 1024).arrayBuffer()
  // 预取是 fire-and-forget，让出一轮微任务给它
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(calls[0], [0, 64 * 1024 - 1])
  assert.equal(calls.length, 2, '第 1 块应该被预取')
  assert.deepEqual(calls[1], [64 * 1024, 128 * 1024 - 1])
})

await check('预取不会越过盘末', async () => {
  const size = 64 * 1024
  const { fetchRange, calls } = fakeDisc(size)
  const d = new RemoteDisc({ size, fetchRange, chunkBytes: 64 * 1024, prefetch: true })
  await d.slice(0, 1024).arrayBuffer()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(calls.length, 1)
})

await check('最后一块的 Range 不超过盘的实际大小', async () => {
  const size = 100 * 1024 + 7
  const { fetchRange, calls } = fakeDisc(size)
  const d = new RemoteDisc({ size, fetchRange, chunkBytes: 64 * 1024, prefetch: false })
  await d.slice(size - 10, size).arrayBuffer()
  assert.equal(calls[0][1], size - 1, `末块的 endInclusive 应为 ${size - 1}，实际 ${calls[0][1]}`)
})

console.log('三、缓存上限')

await check('超出上限按最久未用淘汰，不会无限吃内存', async () => {
  const chunk = 64 * 1024
  const { fetchRange, calls } = fakeDisc()
  // 只装得下 4 块
  const d = new RemoteDisc({ size: DISC_SIZE, fetchRange, chunkBytes: chunk, cacheBytes: 4 * chunk, prefetch: false })
  for (let i = 0; i < 8; i++) await d.slice(i * chunk, i * chunk + 16).arrayBuffer()
  assert.equal(calls.length, 8)
  // 第 0 块早被挤掉了，再读要重新取
  await d.slice(0, 16).arrayBuffer()
  assert.equal(calls.length, 9, '第 0 块应该已经被淘汰')
  // 而最近读过的第 7 块还在
  await d.slice(7 * chunk, 7 * chunk + 16).arrayBuffer()
  assert.equal(calls.length, 9, '第 7 块不该被淘汰')
})

await check('反复读同一块会把它保住（LRU 认的是最近使用，不是插入顺序）', async () => {
  const chunk = 64 * 1024
  const { fetchRange, calls } = fakeDisc()
  const d = new RemoteDisc({ size: DISC_SIZE, fetchRange, chunkBytes: chunk, cacheBytes: 3 * chunk, prefetch: false })
  await d.slice(0, 16).arrayBuffer() // 第 0 块
  for (let i = 1; i <= 2; i++) await d.slice(i * chunk, i * chunk + 16).arrayBuffer()
  await d.slice(0, 16).arrayBuffer() // 再摸一次第 0 块 -> 变成最近使用
  const before = calls.length
  await d.slice(3 * chunk, 3 * chunk + 16).arrayBuffer() // 装不下了，该淘汰第 1 块而不是第 0 块
  await d.slice(0, 16).arrayBuffer()
  assert.equal(calls.length, before + 1, '第 0 块被误淘汰了 —— LRU 没有认「最近使用」')
})

await check('dispose 之后缓存放掉，不跟着页面一直留着', async () => {
  const { fetchRange, calls } = fakeDisc()
  const d = new RemoteDisc({ size: DISC_SIZE, fetchRange, chunkBytes: 64 * 1024, prefetch: false })
  await d.slice(0, 16).arrayBuffer()
  d.dispose()
  await d.slice(0, 16).arrayBuffer()
  assert.equal(calls.length, 2)
})

console.log('四、Range 探测')

const withFetch = async (impl, fn) => {
  const saved = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await fn()
  } finally {
    globalThis.fetch = saved
  }
}
const res = (status, headers) => ({ ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null } })

await check('206 + Content-Range -> 支持，整盘大小取斜杠后面那个数', async () => {
  const r = await withFetch(async () => res(206, { 'content-range': 'bytes 0-1/4700372992', 'content-length': '2' }), () =>
    probeRange('https://example.com/game.iso'),
  )
  assert.equal(r.rangeSupported, true)
  // ⚠️ 不能取 Content-Length：206 的 Content-Length 是这一片的长度（2），不是整盘
  assert.equal(r.size, 4700372992)
})

await check('回 200 = 不支持 Range（服务器把整份吐出来了）', async () => {
  const r = await withFetch(async () => res(200, { 'content-length': '700000000' }), () =>
    probeRange('https://example.com/game.iso'),
  )
  assert.equal(r.rangeSupported, false)
  assert.equal(r.size, 700000000)
})

await check('网络错误 -> 不支持，不抛异常', async () => {
  const r = await withFetch(async () => {
    throw new Error('boom')
  }, () => probeRange('https://example.com/game.iso'))
  assert.deepEqual(r, { rangeSupported: false, size: 0 })
})

await check('404 -> 不支持', async () => {
  const r = await withFetch(async () => res(404, {}), () => probeRange('https://example.com/game.iso'))
  assert.equal(r.rangeSupported, false)
})

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过 ✅')
process.exit(failed ? 1 : 0)
