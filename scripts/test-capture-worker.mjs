/**
 * 转发泵 Worker 的回归测试。跑：npm run test:capture-worker
 *
 * 为什么值得单独钉：这段代码 2026-09-09 从主线程搬进了 Worker（模拟器也在主线程，
 * 每秒 30 次读帧/克隆/写帧是直接插在它的帧循环里的）。搬进去之后**出了 bug 几乎看不见** ——
 * Worker 里没有 console 面板、抛异常也不会冒到页面上，表现只会是「观众那边黑屏」或者
 * 「玩着玩着内存涨」。所以这里用假的 VideoFrame / 流把整套消息协议在 node 里跑一遍，
 * 顺带数帧有没有泄漏。
 */
import assert from 'node:assert/strict'

let pass = 0
let failedChecks = 0
/**
 * ⚠️ 断言失败**不再抛异常**，而是记一笔继续往下跑。
 *
 * 原来是 `assert.ok(cond, msg)` —— 第一条炸了整个进程就退出，后面的用例一条都不执行。
 * 2026-09-11 的教训：test:indexnow 从 09-08 起就红着，28 条里只跑到第 6 条，
 * 后面 22 条三天没被执行过，而没人知道，因为根本没人跑它（现在有 `npm test` 了）。
 * 一条小毛病不该把整套的价值清零。
 *
 * 退出码由下面那个 exit 钩子负责 —— 有失败就是非零，绝不会变成静默通过。
 */
const ok = (c, m) => {
  if (c) {
    pass++
    console.log('✅ ' + m)
    return
  }
  failedChecks++
  console.log('❌ ' + m)
}
process.on('exit', () => {
  if (failedChecks) {
    console.log(`\n❌ ${failedChecks} 项失败（上面带 ❌ 的那几条）`)
    process.exitCode = 1
  }
})

/* ---------------- 假环境（必须在 import worker 之前装好） ---------------- */

let open = 0
let made = 0
const all = []
class FakeVideoFrame {
  constructor(src, init) {
    made++
    open++
    this.closed = false
    this.tag = src?.tag ?? `f${made}`
    this.timestamp = init?.timestamp ?? src?.timestamp ?? 0
    all.push(this)
  }
  clone() {
    const c = new FakeVideoFrame(this)
    c.timestamp = this.timestamp
    return c
  }
  close() {
    if (this.closed) return
    this.closed = true
    open--
  }
}
globalThis.VideoFrame = FakeVideoFrame

/** 送回主线程的帧：在真实环境里 transfer 之后就归主线程了，这里替它记账 */
const posted = []
let selfClosed = false
globalThis.self = {
  onmessage: null,
  postMessage: (msg) => posted.push(msg),
  close: () => {
    selfClosed = true
  },
}

const written = []
let writerClosed = false
const writable = {
  getWriter: () => ({
    write: async (f) => {
      // generator 的 writable 接管这一帧并负责 close —— 真实行为就是这样
      written.push({ tag: f.tag, ts: f.timestamp })
      f.close()
    },
    close: async () => {
      writerClosed = true
    },
  }),
}

function makeSource() {
  let ctl
  const o = { cancelled: false }
  o.stream = new ReadableStream({
    start(c) {
      ctl = c
    },
    cancel() {
      o.cancelled = true
    },
  })
  /** 推一帧进去。流已经被 cancel 掉就返回 false（而不是抛） */
  o.push = (tag, ts) => {
    const f = Object.assign(new FakeVideoFrame(), { tag, timestamp: ts })
    try {
      ctl.enqueue(f)
      return true
    } catch {
      // 流已经关了，这一帧没人接手 —— 测试自己负责关掉，别算成 Worker 漏的
      f.close()
      return false
    }
  }
  return o
}

await import('../src/emulator/captureWorker.ts')
const send = (msg) => globalThis.self.onmessage({ data: msg })
const tick = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- 跑 ---------------- */

const HB = 60
send({ t: 'init', writable, heartbeatMs: HB, snapMs: 10_000 })

console.log('── 转发 ──')
{
  const src = makeSource()
  send({ t: 'src', readable: src.stream })
  src.push('a', 1000)
  src.push('b', 2000)
  await tick(30)
  ok(written.map((x) => x.tag).join(',') === 'a,b', '读到的帧原样写进了 generator')
  ok(posted.filter((m) => m.t === 'snap').length === 1, '第一帧就推了一张快照回主线程（feed 活得短也有种子）')
}

console.log('\n── 心跳：源静了要补帧，且时间戳只能往前 ──')
{
  const before = written.length
  await tick(HB * 2.5)
  const beats = written.slice(before)
  ok(beats.length >= 1, '源静止后补出了帧')
  ok(
    beats.every((f) => f.tag === 'b'),
    '补的是最后一帧的复制品',
  )
  ok(beats[0].ts > 2000, `补帧时间戳沿源时钟往后推（${beats[0].ts} > 2000），不是另起一套 now()`)
  let mono = true
  for (let i = 1; i < written.length; i++) if (written[i].ts <= written[i - 1].ts) mono = false
  ok(mono, '⭐ 整条时间线严格单调递增 —— 倒退会让真帧被编码器整批丢掉')
}

console.log('\n── 换源：旧的读循环必须自己退出 ──')
{
  const old = makeSource()
  send({ t: 'src', readable: old.stream })
  await tick(10)
  const fresh = makeSource()
  send({ t: 'src', readable: fresh.stream })
  await tick(10)

  ok(old.cancelled, '⭐ 换源时旧的 readable 被 cancel —— 旧画布从源头就再也送不进来')
  const before = written.length
  ok(old.push('stale', 9_000_000) === false, '往旧源推帧已经推不动了')
  await tick(30)
  ok(
    written.slice(before).every((f) => f.tag !== 'stale'),
    '旧画布的帧一帧都没混进来',
  )

  fresh.push('new', 9_000_000)
  await tick(30)
  ok(
    written.some((f) => f.tag === 'new'),
    '新源的帧正常写出去',
  )
}

console.log('\n── 停 ──')
{
  send({ t: 'stop' })
  await tick(30)
  ok(writerClosed, 'writer 关掉了')
  ok(selfClosed, 'Worker 自己退出了（self.close）')
  const before = written.length
  await tick(HB * 2)
  ok(written.length === before, '停了之后心跳不再补帧')
}

console.log('\n── 帧有没有泄漏 ──')
{
  // 送回主线程的那些在真实环境里已经转移走了，由主线程负责 close
  for (const m of posted) m.frame?.close()
  if (open !== 0) console.log('未关闭的帧：', all.filter((f) => !f.closed).map((f) => `${f.tag}@${f.timestamp}`))
  ok(open === 0, `⭐ 一帧都没漏（造了 ${made} 个，全部 close）`)
}

console.log('\n── 源码守卫 ──')
{
  const { readFileSync } = await import('node:fs')
  // 先剥注释再断言 —— 上面那些解释病因的注释里就写着 import / captureFeed 之类的字眼
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

  const worker = strip(readFileSync(new URL('../src/emulator/captureWorker.ts', import.meta.url), 'utf8'))
  ok(
    !/^\s*import\s/m.test(worker),
    '⭐ captureWorker.ts 一个静态 import 都没有 —— 顺手 import 一下就会把模拟器那堆东西拽进这个 chunk',
  )

  const feed = strip(readFileSync(new URL('../src/emulator/captureFeed.ts', import.meta.url), 'utf8'))
  ok(
    /new Worker\(\s*new URL\('\.\/captureWorker\.ts', import\.meta\.url\)/.test(feed),
    'captureFeed 用 new URL(..., import.meta.url) 起 Worker（Vite 认这个写法，会单独打一个 chunk）',
  )
  ok(
    /typeof Worker !== 'function'/.test(feed),
    'Worker 起不来时要能退回主线程那条路（老浏览器 / node 测试环境）',
  )
}

console.log(`\n✅ 转发泵 Worker：${pass} 项通过`)
process.exit(failedChecks ? 1 : 0)
