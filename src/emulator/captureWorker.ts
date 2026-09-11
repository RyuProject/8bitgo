/// <reference lib="webworker" />
/**
 * 抓屏转发泵 —— 跑在 Worker 里。
 *
 * 为什么要有这个文件（2026-09-09）：转发链原本整条都在主线程上 ——
 *
 *   MediaStreamTrackProcessor → reader.read() → last = frame.clone() → writer.write()
 *
 * 而**模拟器也在主线程**。30fps 就是每秒 30 次 JS 任务 + 30 次 VideoFrame 生命周期管理，
 * 硬插进模拟器的帧循环中间。玩家感觉到的「一开播就卡、跟观众多少没关系」主要来自这里，
 * 不是来自编码（编码是 N 路，那是「观众越多越卡」）。
 *
 * 搬到 Worker 之后主线程只剩两件事：建 track、把流 transfer 过来。逐帧搬运一次都不碰。
 *
 * 能这么搬是因为 `MediaStreamTrackProcessor.readable` 和 `MediaStreamTrackGenerator.writable`
 * 都是**可转移对象**：主线程建好，postMessage 转移给 Worker，之后两头的数据流
 * 完全不经过主线程。
 *
 * ⚠️ 这里**不导入任何模块**（含 captureFeed.ts）：Worker 是独立的模块图，
 * 顺手 import 一下就会把模拟器那堆东西也拽进这个 chunk。常量走 init 消息传进来。
 */

interface TrackProcessorCtor {
  new (init: { track: MediaStreamTrack }): { readable: ReadableStream<VideoFrame> }
}

type InMsg =
  | { t: 'init'; writable: WritableStream<VideoFrame>; heartbeatMs: number; snapMs: number }
  | { t: 'seed'; frame: VideoFrame }
  | { t: 'src'; readable: ReadableStream<VideoFrame> }
  | { t: 'stop' }

const ctx = self as unknown as DedicatedWorkerGlobalScope & { MediaStreamTrackProcessor?: TrackProcessorCtor }

let writer: WritableStreamDefaultWriter<VideoFrame> | null = null
let reader: ReadableStreamDefaultReader<VideoFrame> | null = null
/** 最后一帧的副本。心跳补帧用，也是回传给主线程当「种子」的那一份 */
let last: VideoFrame | null = null
let lastAt = 0
let heartbeatMs = 500
let heartbeat = 0
let snapTimer = 0
let stopped = false
/** 换源代际：旧的读循环靠它认出自己已经过时，别把旧画布的帧混进来 */
let gen = 0

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/**
 * 把当前最后一帧**复制一份**送回主线程。
 *
 * 为什么要定期送而不是等停的时候送：`CaptureFeed.release()` 是同步的，它得**当场**
 * 交出种子帧给下一轮 feed 用。而 Worker 回消息是异步的，等停了再要就来不及。
 * 所以在这边低频（默认 2 秒一次）推快照，主线程手里永远攥着一张够新的。
 *
 * 代价是每 2 秒一次 clone + transfer —— 相对每秒 30 帧的搬运可以忽略。
 * 种子本来就至少是 3 秒前的画面（空闲放手要等 3 秒），快照再旧 2 秒完全无所谓。
 */
const snap = () => {
  if (stopped || !last) return
  // ⚠️ copy 要声明在 try 外面：clone 成功但 postMessage 抛出时，这一帧没人接手，
  //    得由我们自己关掉。放在 try 里的话它就永远漏在那儿了（2 秒一次，无上限）。
  let copy: VideoFrame | null = null
  try {
    // transfer 会让发送方失去这一帧，所以送出去的必须是副本
    copy = last.clone()
    ctx.postMessage({ t: 'snap', frame: copy }, [copy as unknown as Transferable])
  } catch {
    copy?.close()
  }
}

/**
 * 心跳：源静了就把最后一帧再发一次。
 * 时间戳沿着源自己的时间轴往后推（last.timestamp + 静止时长），不用 now() 另起一套 ——
 * 编码器要的是单调递增，两套时钟混着走会让恢复后的真帧被当成「过时」丢掉。
 */
const beat = () => {
  if (stopped || !last || !writer) return
  const idle = now() - lastAt
  if (idle < heartbeatMs) return
  let dup: VideoFrame
  try {
    dup = new VideoFrame(last, { timestamp: last.timestamp + Math.round(idle * 1000) })
  } catch {
    return
  }
  writer.write(dup).catch(() => dup.close())
}

const pump = (readable: ReadableStream<VideoFrame>) => {
  if (!writer) {
    void readable.cancel().catch(() => {})
    return
  }
  const mine = ++gen
  const r = readable.getReader()
  void reader?.cancel().catch(() => {})
  reader = r
  void (async () => {
    for (;;) {
      let res: ReadableStreamReadResult<VideoFrame>
      try {
        res = await r.read()
      } catch {
        break
      }
      if (res.done) break
      const frame = res.value
      if (stopped || mine !== gen) {
        frame.close()
        break
      }
      const first = last === null
      last?.close()
      last = frame.clone()
      lastAt = now()
      // 第一帧立刻推一张快照：feed 活得很短时（观众点进来又马上退）也别让种子是空的
      if (first) snap()
      try {
        // generator 的 writable 接管这一帧并负责 close
        await writer.write(frame)
      } catch {
        frame.close()
        break
      }
    }
  })()
}

const stop = () => {
  if (stopped) return
  stopped = true
  gen++
  if (heartbeat) clearInterval(heartbeat)
  if (snapTimer) clearInterval(snapTimer)
  void reader?.cancel().catch(() => {})
  reader = null
  void writer?.close().catch(() => {})
  writer = null
  last?.close()
  last = null
  ctx.close()
}

/**
 * ⚠️ **脚本跑到这里就报一声「我活着」，主线程等的就是这一句。**
 *
 * 为什么非要有它：Worker 的加载失败（chunk 404、CSP 挡 worker-src、弱网拉一半断、
 * MIME 不对、模块求值抛异常）**全都是异步的**，`new Worker()` 那个 try 一个都接不住。
 * 主线程要是「建完就当它能用」，把 generator 的 writable transfer 过来之后，
 * 一个永远不会运行的 Worker 手里攥着唯一的写入口 —— generator 轨活着、muted 是 false、
 * 但一帧都不出，而且永远好不了（check() 查的是画布轨，查不出这种死法）。
 *
 * 所以约定改成：主线程先自己在主线程上跑起来（从第 0 帧就是对的），收到这条 ready
 * 才把写入口交过来。Worker 没起来 = 停在主线程那条路上，功能完全一样，只是占线程。
 */
ctx.postMessage({ t: 'ready' })

ctx.onmessage = (e: MessageEvent<InMsg>) => {
  const msg = e.data
  switch (msg.t) {
    case 'init':
      heartbeatMs = msg.heartbeatMs
      writer = msg.writable.getWriter()
      heartbeat = setInterval(beat, heartbeatMs) as unknown as number
      snapTimer = setInterval(snap, msg.snapMs) as unknown as number
      break
    case 'seed':
      last?.close()
      last = msg.frame
      // 种子来自上一轮，故意把它当成「半个心跳之前」的帧，好让下一拍就补出去。
      // 别拨到 0：心跳的时间戳是 last.timestamp + 静止时长，拨太多会让合成帧的时间戳
      // 跑到真实采集时钟前面，随后画布一动真帧因为时间戳「倒退」被整批丢掉。
      lastAt = now() - heartbeatMs
      break
    case 'src':
      pump(msg.readable)
      break
    case 'stop':
      stop()
      break
  }
}
