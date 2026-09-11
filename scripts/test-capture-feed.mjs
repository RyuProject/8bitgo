/**
 * createCaptureFeed 的 Insertable Streams / Worker 那条路的回归测试。
 * 跑：npm run test:capture-feed
 *
 * 为什么必须有它：`test-capture-worker` 只驱动 Worker 内部的消息协议，
 * `test-broadcast-idle` 在 node 里连 Insertable Streams 都没有 —— **两边都碰不到
 * captureFeed 的 Worker 分支**。09-10 复审查出的那个致命 bug（Worker 异步加载失败时
 * 主线程已经把唯一的写入口 transfer 走了，generator 轨活着但永远不出帧、且不可恢复）
 * 就躺在这片盲区里，53 项测试全绿也没拦住。
 *
 * 这里把 MediaStreamTrackProcessor / Generator / VideoFrame / Worker 全部造出来，
 * 直接驱动 createCaptureFeed。
 */
import { readFileSync } from 'node:fs'

let pass = 0
let fail = 0
const ok = (c, m) => {
  c ? (pass++, console.log('✅ ' + m)) : (fail++, console.log('❌ ' + m))
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- 假环境 ---------------- */

let openFrames = 0
class FakeVideoFrame {
  constructor(src, init) {
    openFrames++
    this.closed = false
    this.tag = src?.tag ?? 'f'
    this.timestamp = init?.timestamp ?? src?.timestamp ?? 0
  }
  clone() {
    const c = new FakeVideoFrame(this)
    c.timestamp = this.timestamp
    return c
  }
  close() {
    if (!this.closed) {
      this.closed = true
      openFrames--
    }
  }
}

/** 每条 track 配一条可控的源流 */
const sources = new Map()
class FakeTrack {
  constructor(kind = 'video') {
    this.kind = kind
    this.readyState = 'live'
    this.frameRate = 30
    let ctl
    this.stream = new ReadableStream({
      start(c) {
        ctl = c
      },
    })
    this.push = (tag) => {
      const f = new FakeVideoFrame()
      f.tag = tag
      try {
        ctl.enqueue(f)
      } catch {
        f.close()
      }
    }
    sources.set(this, this.stream)
  }
  stop() {
    this.readyState = 'ended'
  }
  async applyConstraints(c) {
    this.frameRate = c.frameRate
  }
  getSettings() {
    return { width: 304, height: 224, frameRate: this.frameRate }
  }
}

let processorThrows = false
globalThis.MediaStreamTrackProcessor = class {
  constructor({ track }) {
    if (processorThrows) throw new Error('processor unavailable')
    this.readable = sources.get(track) ?? new ReadableStream({ start: (c) => c.close() })
  }
}

const generators = []
globalThis.MediaStreamTrackGenerator = class {
  constructor() {
    this.kind = 'video'
    this.readyState = 'live'
    this.stopped = false
    this.written = []
    const self = this
    this.writable = new WritableStream({
      write(f) {
        self.written.push(f.tag)
        f.close()
      },
    })
    generators.push(this)
  }
  stop() {
    this.stopped = true
    this.readyState = 'ended'
  }
}

globalThis.VideoFrame = FakeVideoFrame
globalThis.MediaStream = class {
  constructor(tracks = []) {
    this._t = tracks
  }
  getTracks() {
    return this._t
  }
  getVideoTracks() {
    return this._t.filter((t) => t.kind === 'video')
  }
  addTrack(t) {
    this._t.push(t)
  }
  removeTrack(t) {
    this._t = this._t.filter((x) => x !== t)
  }
}
globalThis.window = {
  setTimeout: (f, m) => setTimeout(f, m),
  clearTimeout: (i) => clearTimeout(i),
  setInterval: (f, m) => setInterval(f, m),
  clearInterval: (i) => clearInterval(i),
}

/** 可配置的假 Worker：never / error / ready */
let workerMode = 'none'
const workers = []
class FakeWorker {
  constructor() {
    this.terminated = false
    this.msgs = []
    this.transfers = []
    this.lockedAtTransfer = null
    workers.push(this)
    queueMicrotask(() => {
      if (workerMode === 'error') this.onerror?.(new Error('chunk 404'))
      else if (workerMode === 'ready') this.onmessage?.({ data: { t: 'ready' } })
      // 'never' 就什么都不发
    })
  }
  postMessage(msg, transfer) {
    this.msgs.push(msg.t)
    if (msg.t === 'init') this.lockedAtTransfer = msg.writable?.locked
    if (transfer) this.transfers.push(...transfer)
  }
  terminate() {
    this.terminated = true
  }
}

const { createCaptureFeed } = await import('../src/emulator/captureFeed.ts')

function makeCanvas() {
  const track = new FakeTrack()
  return {
    track,
    sources: {
      canvas: {
        width: 304,
        height: 224,
        isConnected: true,
        captureStream: () => new globalThis.MediaStream([track]),
      },
    },
  }
}

/* ---------------- 跑 ---------------- */

console.log('── 没有 Worker：主线程那条路必须自己能跑 ──')
{
  workerMode = 'none'
  delete globalThis.Worker
  const { track, sources: src } = makeCanvas()
  const feed = createCaptureFeed(() => src, 30)
  ok(feed?.keepAlive === true, 'keepAlive 为 true（走的是 Insertable Streams）')
  track.push('a')
  track.push('b')
  await tick(40)
  const gen = generators.at(-1)
  ok(gen.written.join(',') === 'a,b', '帧原样写进了 generator')
  const seed = feed.release()
  ok(seed && !seed.closed, 'release 交出了一张没被关掉的种子帧')
  seed.close()
  ok(gen.stopped, 'generator 被停掉了')
}

console.log('\n── ⭐ Worker 加载失败（onerror）：不能黑屏 ──')
{
  workerMode = 'error'
  globalThis.Worker = FakeWorker
  workers.length = 0
  const { track, sources: src } = makeCanvas()
  const feed = createCaptureFeed(() => src, 30)
  await tick(40)
  const gen = generators.at(-1)
  ok(workers.at(-1).terminated, 'Worker 被掐掉了')
  ok(workers.at(-1).msgs.length === 0, '⭐ 从没给它发过 init —— 写入口一步都没交出去')
  track.push('x')
  await tick(40)
  ok(gen.written.includes('x'), '⭐ 主线程照常出帧（这就是「不黑屏」）')
  feed.release()?.close()
}

console.log('\n── ⭐ Worker 起来了但永远不报 ready：超时后退回主线程 ──')
{
  workerMode = 'never'
  workers.length = 0
  const { track, sources: src } = makeCanvas()
  const feed = createCaptureFeed(() => src, 30)
  const gen = generators.at(-1)
  track.push('before')
  await tick(40)
  ok(gen.written.includes('before'), '等待期间主线程就在出帧，没有空窗')
  ok(workers.at(-1).msgs.length === 0, '没 ready 就不发 init')
  await tick(3200)
  ok(workers.at(-1).terminated, '⭐ 超时之后 Worker 被掐掉')
  track.push('after')
  await tick(40)
  ok(gen.written.includes('after'), '⭐ 掐完之后主线程仍在出帧')
  feed.release()?.close()
}

console.log('\n── ⭐ Worker 报了 ready：干净交接 ──')
{
  workerMode = 'ready'
  workers.length = 0
  const { track, sources: src } = makeCanvas()
  const feed = createCaptureFeed(() => src, 30)
  await tick(60)
  const wk = workers.at(-1)
  ok(wk.msgs[0] === 'init', '交接时第一条消息是 init')
  ok(wk.lockedAtTransfer === false, '⭐ transfer 之前 writable 已经解锁（锁着的流转移不了）')
  ok(wk.transfers.length >= 1, 'writable 确实进了 transfer 列表')
  ok(wk.msgs.includes('src'), '交接完用 Worker 重新接上了源')
  ok(!wk.terminated, 'Worker 留着干活')
  feed.release()
  ok(wk.msgs.includes('stop'), 'release 通知 Worker 收尾')
}

console.log('\n── ⭐ 换源时 pump 失败要整个回滚 ──')
{
  workerMode = 'none'
  delete globalThis.Worker
  const a = makeCanvas()
  const b = makeCanvas()
  let cur = a.sources
  const feed = createCaptureFeed(() => cur, 30)
  await tick(20)

  // 让旧画布「死掉」，并把换源目标指向 b
  a.sources.canvas.isConnected = false
  cur = b.sources
  processorThrows = true // 新源接不上
  const swapped = feed.check()
  processorThrows = false
  ok(swapped === false, '⭐ pump 失败时 check() 返回 false，不再谎报「无缝接上」')
  ok(a.track.readyState === 'live', '⭐ 旧轨没被停掉 —— 它还在出帧，观众不会冻住')
  ok(b.track.readyState === 'ended', '刚建的那条被停掉了，没泄漏')

  // 再试一次，这回接得上
  const again = feed.check()
  ok(again === true, '下一拍重试成功')
  feed.release()?.close()
}

console.log('\n── 源码守卫 ──')
{
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const feed = strip(readFileSync(new URL('../src/emulator/captureFeed.ts', import.meta.url), 'utf8'))
  ok(/onerror = giveUp/.test(feed), 'Worker 挂了 onerror —— 加载失败是异步的，new Worker 的 try 接不住')
  ok(/'ready'/.test(feed), '交接前要等 Worker 自报 ready')
  ok(/releaseLock\(\)/.test(feed), '交接前先 releaseLock')
  ok(/if \(!pump\(cand\.track\)\)/.test(feed), 'check() 看 pump 的返回值')
}

console.log(`\n${fail ? '❌' : '✅'} captureFeed Worker 路径：${pass} 项通过，${fail} 项失败`)
process.exit(fail ? 1 : 0)
