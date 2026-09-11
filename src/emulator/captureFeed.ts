/**
 * 推流用的「采集源」：把 CaptureSources 变成一条能一直喂给 PeerConnection 的流，
 * 并且**源静了、源换了，观众那边都不断**。
 *
 * 为什么不像以前那样直接把 canvas.captureStream() 交给 addTrack —— 2026-09-06 实测出两个坑：
 *
 * 1. **画布静止 = 后进的观众永远拿不到第一帧。**
 *    captureStream 只在画布**被绘制**时出帧（定速的 captureStream(30) 一样，
 *    `track.requestFrame()` 也救不了 —— 它只让「下一次绘制」出帧，画布不画它就不出）。
 *    游戏暂停、Flash 停在静态菜单时：先进来的观众手里有最后一帧，没事；
 *    后进来的那位，编码器一帧都拿不到 → 观众端 videoWidth 一直是 0、轨 muted →
 *    75 秒后报「连不上主播」，而网络其实好好的。
 *
 * 2. **画布被换掉 = 直播冻住。**
 *    Ruffle 的 reload()（读档时会调）会把 <canvas> 整个换成新的。抓屏那条轨还绑在
 *    脱离了文档的旧画布上：readyState 照样 live、muted 照样 false，画面却永远停在
 *    读档前那一帧，界面写着「在看」，谁也不会报错。
 *
 * 两个坑一个解法：发给观众的不是画布那条轨，而是我们自己的一条 generator 轨
 * （Insertable Streams：MediaStreamTrackProcessor → MediaStreamTrackGenerator）。
 * 画布出帧就原样转发；画布静了就把最后一帧盖个新时间戳重发（心跳）；
 * 画布换了就把 processor 接到新画布上 —— 观众那头的轨从头到尾是同一条，连 replaceTrack 都不用。
 *
 * 这两个 API 只有 Chromium 有（Safari / Firefox 没有）。没有就退回直接用画布那条轨：
 * 换源走 replaceTrack（onVideoTrackReplaced），心跳做不到 —— 那部分靠观众端把话说清楚。
 */
import type { CaptureSources } from './types'
import { sizeOfTrack, usableVideoSize } from './videoTuning'

export type SourceResolver = () => CaptureSources | null

/**
 * 源静止多久之后开始补帧。
 * 500ms：远大于一帧的间隔（30fps 是 33ms），又让后进的观众最多多等半秒就能拿到关键帧。
 */
export const HEARTBEAT_MS = 500

/**
 * 抓屏帧率的下限。编码器那侧降到再低，画布也不该采得比这还稀 ——
 * 低于 10 帧观众看到的就不是「降档」而是「坏了」。
 */
export const MIN_CAPTURE_FPS = 10

/**
 * Worker 往主线程回传「最后一帧快照」的间隔。
 * `release()` 是同步的、必须当场交出种子帧，而 Worker 回消息是异步的 ——
 * 所以低频推快照，主线程手里永远攥着一张够新的。种子本来就至少是 3 秒前的画面
 * （空闲放手要等 3 秒），再旧 2 秒完全无所谓。
 */
const SNAP_MS = 2000

/**
 * 等 Worker 自报「我活着」的上限。等不到就一直留在主线程那条路上 —— 功能完全一样，
 * 只是逐帧搬运继续占着模拟器那根线程。给得宽松点：拉不到 chunk 的代价只是没优化，
 * 而误判成「起来了」的代价是永久黑屏。
 */
const WORKER_READY_MS = 3000

/**
 * 起一个转发泵 Worker。起不来就返回 null，退回主线程那条老路 —— 功能完全一样，
 * 只是逐帧搬运会重新占用模拟器那根线程。
 *
 * `new URL(..., import.meta.url)` 是 Vite 认的写法，会把它单独打成一个 chunk；
 * 不用静态 import，模拟器那个 chunk 的边界不受影响（见 test:bundle-split）。
 */
function spawnPumpWorker(): Worker | null {
  if (typeof Worker !== 'function') return null
  try {
    return new Worker(new URL('./captureWorker.ts', import.meta.url), { type: 'module' })
  } catch {
    return null
  }
}

export interface CaptureFeed {
  /** 交给 PeerConnection 的流。有 Insertable Streams 时视频轨自始至终是同一条 */
  readonly stream: MediaStream
  /** 是不是走了 Insertable Streams 这条路（能补帧、换源无感） */
  readonly keepAlive: boolean
  /**
   * 视频源的**实际**尺寸，给编码参数用（见 videoTuning）。
   * 别去读 sender.track.getSettings()：generator 轨那里多半是空的，会让 160×144 的 Game Boy
   * 被当成大源去缩分辨率。
   */
  videoSize(): { width?: number; height?: number }
  /**
   * 源还健康吗？画布脱离文档 / 塌成废尺寸 / 轨结束了，就重新向运行时要一次源。
   * 拿到一块**不同的、可用的**画布才换；还是那块废的就等下一轮。返回这一次是否换了源。
   */
  check(): boolean
  /** 换源导致视频轨变了（只在没有 Insertable Streams 的回退路径上发生）—— 调用方得对每个 sender replaceTrack */
  onVideoTrackReplaced?: (track: MediaStreamTrack) => void
  /**
   * 放掉一切，**把最后一帧交还给调用方**（没有 Insertable Streams 时为 null）。
   *
   * 为什么要交还：抓屏是按需建的，观众走光 3 秒就放掉。游戏暂停着、主播人不在，
   * 下一个观众进来时新建的 feed 面对一块**静止的**画布 —— 一帧都不会出（见文件头第 1 条），
   * 而心跳没有「最后一帧」也无从补。把上一轮的最后一帧当种子传给下一轮，
   * 观众半秒内就能看到暂停前的画面；画布一动，真帧立刻把它顶掉。
   * 接手的人负责 close（喂给下一轮 createCaptureFeed 就行，它会接管）。
   */
  release(): VideoFrame | null
  /**
   * 改**抓屏**帧率（不是编码帧率）。
   *
   * 为什么需要它：`applyFpsCap` 一直只改 `tuneSender` 的 maxFramerate，也就是只管编码器。
   * 可 `canvas.captureStream(fps)` 那一路一动没动 —— 7 个观众时编码降到 20 帧了，
   * 画布仍然每秒被拷 30 次。而**画布读回才是最贵的那笔**（EmulatorJS 的画布是 WebGL 的，
   * 每一帧都是一次 GPU 读回/纹理拷贝，跟模拟器抢同一根线程），编码器少编几帧
   * 完全不会让它少拷几帧。降档降了个寂寞。
   *
   * 会被夹在 [MIN_CAPTURE_FPS, 建流时的基准帧率] 之间。分享标签页那条流不是我们
   * captureStream 出来的，动不了，直接忽略。
   */
  setCaptureFps(fps: number): void
}

/* ---------------- 非标准 API 的最小类型（lib.dom 里没有） ---------------- */

interface TrackProcessor {
  readable: ReadableStream<VideoFrame>
}
type TrackGenerator = MediaStreamTrack & { writable: WritableStream<VideoFrame> }
interface InsertableWindow {
  MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack }) => TrackProcessor
  MediaStreamTrackGenerator?: new (init: { kind: 'video' }) => TrackGenerator
}

/** 这个浏览器有 Insertable Streams 吗 */
export function hasInsertableStreams(): boolean {
  const w = globalThis as unknown as InsertableWindow
  return typeof w.MediaStreamTrackProcessor === 'function' && typeof w.MediaStreamTrackGenerator === 'function' && typeof VideoFrame === 'function'
}

/* ---------------- 原始采集 ---------------- */

interface RawVideo {
  track: MediaStreamTrack
  /** 是我们自己 captureStream 出来的（release 时要 stop）；分享标签页那条流不是我们的 */
  owned: boolean
  /** 抓的是哪块画布（分享标签页时为 null） */
  canvas: HTMLCanvasElement | null
}

function captureRaw(sources: CaptureSources, fps: number): RawVideo | null {
  if (sources.stream) {
    const track = sources.stream.getVideoTracks()[0]
    return track ? { track, owned: false, canvas: null } : null
  }
  const canvas = sources.canvas
  if (!canvas || typeof canvas.captureStream !== 'function') return null
  // 废画布（2×2 那种）抓出来是一条谁也看不懂的黑屏轨，不如没有
  if (!usableVideoSize(canvas.width, canvas.height)) return null
  const track = canvas.captureStream(fps).getVideoTracks()[0]
  return track ? { track, owned: true, canvas } : null
}

/**
 * 只探一下「这个源到底抓不抓得出画面」，不留任何东西。
 * 开播前调用方靠它决定要不要落到「手动分享标签页」那条路。
 */
export function probeCapture(sources: CaptureSources | null | undefined, fps: number): boolean {
  if (!sources) return false
  const raw = captureRaw(sources, fps)
  if (!raw) return false
  if (raw.owned) raw.track.stop()
  return true
}

function buildAudio(sources: CaptureSources): { tracks: MediaStreamTrack[]; release: () => void } {
  if (sources.stream) return { tracks: sources.stream.getAudioTracks(), release: () => {} }
  const { audioNode, audioContext } = sources
  if (audioNode && audioContext) {
    try {
      const dest = audioContext.createMediaStreamDestination()
      audioNode.connect(dest)
      const tracks = dest.stream.getAudioTracks()
      return {
        tracks,
        release: () => {
          try {
            audioNode.disconnect(dest)
          } catch {
            /* 已经断了 */
          }
          for (const t of tracks) t.stop()
        },
      }
    } catch {
      /* 音频图接不上就只推画面 */
    }
  }
  return { tracks: [], release: () => {} }
}

/* ---------------- 采集源 ---------------- */

/**
 * 建一条采集源。拿不到可用画面返回 null（调用方按「没有源」处理）。
 *
 * `resolve` 每次都会被重新调用（开始时一次、每次 check 发现源废了再一次），
 * 所以运行时那边的 captureSources() 必须**现查**，不能缓存画布 —— Ruffle 的就是这么写的。
 */
export function createCaptureFeed(resolve: SourceResolver, fps: number, seed: VideoFrame | null = null): CaptureFeed | null {
  const sources = resolve()
  if (!sources) {
    seed?.close()
    return null
  }
  const first = captureRaw(sources, fps)
  if (!first) {
    seed?.close()
    return null
  }
  // 换源时会被替换，所以是 let；类型收窄成非空，闭包里才不用一路 !
  let raw: RawVideo = first
  const audio = buildAudio(sources)
  /** 当前**实际**在用的抓屏帧率。换源、重建轨都要沿用它，不能退回建流时的 fps */
  let curFps = fps
  /** setCaptureFps 的代际：applyConstraints 是异步的，回来时可能已经不是最新那次请求了 */
  let fpsGen = 0

  let released = false
  const w = globalThis as unknown as InsertableWindow

  /* ---- Insertable Streams：generator 轨 + 转发 + 心跳 ---- */
  let generator: TrackGenerator | null = null
  /** 转发泵所在的 Worker。为 null = 退回主线程那条路（writer 才会被用上） */
  let pumpWorker: Worker | null = null
  /** Worker 定期回传的「最后一帧」快照，release() 当场把它当种子交出去 */
  let snapFrame: VideoFrame | null = null
  /** 正在自证的 Worker（还没交接）。release 时要把它掐掉 */
  let upgrading: Worker | null = null
  let writer: WritableStreamDefaultWriter<VideoFrame> | null = null
  let reader: ReadableStreamDefaultReader<VideoFrame> | null = null
  /** 最后一帧的副本（心跳用）。换源时故意**不清**：新画布出第一帧之前观众继续看着旧画面，比黑一下好 */
  let last: VideoFrame | null = null
  let lastAt = 0
  let heartbeat = 0
  /** 换源计数。旧的转发循环靠它认出自己已经过时，别把旧画布的帧混进来 */
  let pumpGen = 0

  /**
   * 把这条 track 接上转发链。**返回是否接上了** —— 调用方必须看返回值。
   *
   * ⚠️ 以前它没有返回值，于是 `check()` 换源时不管成没成，照样把 `raw` 换掉、
   * 把旧轨 stop 掉、返回 true 并打印「观众那头无缝接上」。真失败了的后果是：
   * Worker/主线程手里还是**旧** readable，而旧轨刚被停掉 → 读循环走到 done 退出 →
   * 从此只剩心跳在重发那一张旧帧，**观众看着换源前那一帧直到本场结束**，
   * 而 check() 再也不会触发（新的 raw.track 是 live 的）。
   */
  const pump = (track: MediaStreamTrack): boolean => {
    if (!w.MediaStreamTrackProcessor) return false
    if (pumpWorker) {
      /**
       * Worker 那条路：主线程只负责把这条 track 的 readable **转移**过去，
       * 之后每一帧都在 Worker 里读、克隆、写。
       * 换源的代际守卫在 Worker 里（它自己 ++gen），这边不用管。
       */
      try {
        // postMessage 也要包进来 —— 它抛出的话异常会一路冒进 setInterval 回调没人接
        const readable = new w.MediaStreamTrackProcessor({ track }).readable
        pumpWorker.postMessage({ t: 'src', readable }, [readable as unknown as Transferable])
        return true
      } catch {
        return false
      }
    }
    if (!writer) return false
    const mine = ++pumpGen
    let r: ReadableStreamDefaultReader<VideoFrame>
    try {
      r = new w.MediaStreamTrackProcessor({ track }).readable.getReader()
    } catch {
      return false
    }
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
        if (released || mine !== pumpGen) {
          frame.close()
          break
        }
        last?.close()
        last = frame.clone()
        lastAt = performance.now()
        try {
          // generator 的 writable 接管这一帧并负责 close
          await writer!.write(frame)
        } catch {
          frame.close()
          break
        }
      }
    })()
    return true
  }

  /**
   * 心跳：源静了就把最后一帧再发一次。
   * 时间戳沿着源自己的时间轴往后推（last.timestamp + 静止时长），不用 performance.now() 另起一套 ——
   * 编码器要的是单调递增，两套时钟混着走会让恢复后的真帧被当成「过时」丢掉。
   */
  const beat = () => {
    if (released || !last || !writer) return
    const idle = performance.now() - lastAt
    if (idle < HEARTBEAT_MS) return
    let dup: VideoFrame
    try {
      dup = new VideoFrame(last, { timestamp: last.timestamp + Math.round(idle * 1000) })
    } catch {
      return
    }
    writer.write(dup).catch(() => dup.close())
  }

  let keepAlive = false
  /**
   * 起主线程那套泵：generator 的 writer + 读循环 + 心跳。
   * 交接失败时也靠它把状态救回来 —— 任何时刻都必须有人在写 generator，
   * 否则那条轨就是「活着但永远不出帧」。
   */
  const startMainPump = (): boolean => {
    if (!generator || writer) return false
    try {
      writer = generator.writable.getWriter()
    } catch {
      return false
    }
    if (!pump(raw.track)) {
      try {
        writer.releaseLock()
      } catch {
        /* ignore */
      }
      writer = null
      return false
    }
    heartbeat = window.setInterval(beat, HEARTBEAT_MS)
    return true
  }

  /**
   * 把写入口从主线程交接给 Worker。成功返回 true。
   *
   * 顺序要紧：先停主线程的读循环和心跳 → releaseLock（锁着的流 transfer 不了）→
   * 转移 writable → 把手里的最后一帧当种子转过去 → 用 Worker 重新 pump。
   * 中途任何一步失败都把主线程那套原样拉回来。
   */
  const handOver = (worker: Worker): boolean => {
    if (!generator || !writer || released) return false
    try {
      pumpGen++
      void reader?.cancel().catch(() => {})
      reader = null
      if (heartbeat) {
        window.clearInterval(heartbeat)
        heartbeat = 0
      }
      writer.releaseLock()
      writer = null

      pumpWorker = worker
      worker.postMessage(
        { t: 'init', writable: generator.writable, heartbeatMs: HEARTBEAT_MS, snapMs: SNAP_MS },
        [generator.writable as unknown as Transferable],
      )
      if (last) {
        const s = last
        last = null
        worker.postMessage({ t: 'seed', frame: s }, [s as unknown as Transferable])
      }
      if (!pump(raw.track)) throw new Error('worker pump failed')
      return true
    } catch {
      pumpWorker = null
      // writable 已经转移出去的话 getWriter() 会抛，startMainPump 自己接得住
      if (!startMainPump()) console.warn('[live] 转发泵交接失败且没能退回主线程，这一路画面可能是死的')
      return false
    }
  }

  /**
   * 试着把泵升级到 Worker —— **升级成功之前，主线程那套一直在正常干活**。
   *
   * ⚠️ 不能反过来（先把 writable 交给 Worker，再指望它能跑起来）。Worker 的加载失败
   * 全是**异步**的（chunk 404、CSP 挡 worker-src、弱网拉一半断、模块求值抛异常），
   * `new Worker()` 外面那个 try 一个都接不住。真那么写的话，一个永远不会运行的 Worker
   * 攥着唯一的写入口，generator 轨活着、muted 是 false、但一帧不出且永远好不了。
   * 而这个 chunk 是**第一个观众进来那一刻**才去拉的，可能是开播半小时之后。
   */
  const tryUpgradeToWorker = () => {
    const worker = spawnPumpWorker()
    if (!worker) return
    upgrading = worker
    let settled = false
    const giveUp = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      if (upgrading === worker) upgrading = null
      worker.terminate()
    }
    const timer = window.setTimeout(giveUp, WORKER_READY_MS)
    worker.onerror = giveUp
    worker.onmessageerror = giveUp
    worker.onmessage = (e: MessageEvent<{ t?: string; frame?: VideoFrame }>) => {
      const msg = e.data
      if (msg?.t === 'ready') {
        if (settled || released) return giveUp()
        settled = true
        window.clearTimeout(timer)
        upgrading = null
        if (!handOver(worker)) worker.terminate()
        return
      }
      if (msg?.t !== 'snap' || !msg.frame) return
      // 放掉之后还在路上的快照直接丢，别把它当种子攥着
      if (released) {
        msg.frame.close()
        return
      }
      snapFrame?.close()
      snapFrame = msg.frame
    }
  }

  if (hasInsertableStreams()) {
    try {
      generator = new w.MediaStreamTrackGenerator!({ kind: 'video' })
      if (seed) {
        /**
         * 种子帧（上一轮放掉时交还的最后一帧）：让心跳下一拍就能补出去。
         * lastAt 只往回拨半个心跳，不拨到 0 —— 心跳的时间戳是 last.timestamp + 静止时长，
         * 拨太多会让合成帧的时间戳**跑到真实采集时钟前面**，随后画布一动，真帧因为时间戳
         * 「倒退」被编码器整批丢掉（libwebrtc 会丢 ntp 不递增的帧）。种子至少是 3 秒前抓的
         * （空闲放手的延迟），所以真帧的时钟永远领先合成帧至少 2.5 秒，安全。
         */
        last = seed
        lastAt = performance.now() - HEARTBEAT_MS
      }
      if (startMainPump()) {
        keepAlive = true
        // 先跑起来，再异步去试 Worker。升不上去就一直留在这条路上。
        tryUpgradeToWorker()
      } else {
        // ⚠️ generator 建了但没人写 —— 必须停掉，否则每个 feed 漏一条活着的轨
        try {
          generator.stop()
        } catch {
          /* ignore */
        }
        generator = null
        if (last === seed) last = null
      }
    } catch {
      // API 在但建不起来：老老实实用画布那条轨
      try {
        generator?.stop()
      } catch {
        /* ignore */
      }
      generator = null
      writer = null
      if (last === seed) last = null
    }
  }
  if (!keepAlive) seed?.close()

  const stream = new MediaStream([keepAlive && generator ? generator : raw.track, ...audio.tracks])

  const feed: CaptureFeed = {
    stream,
    keepAlive,
    videoSize() {
      return raw.canvas ? { width: raw.canvas.width, height: raw.canvas.height } : sizeOfTrack(raw.track)
    },
    check() {
      if (released) return false
      const cur = raw
      const dead =
        cur.track.readyState === 'ended' ||
        (cur.canvas !== null && (!cur.canvas.isConnected || !usableVideoSize(cur.canvas.width, cur.canvas.height)))
      if (!dead) return false
      const next = resolve()
      if (!next) return false
      // 还是那块废画布 / 那条结束了的轨：这一轮等，下一轮再问
      if (next.canvas && next.canvas === cur.canvas) return false
      if (next.stream && next.stream.getVideoTracks()[0] === cur.track) return false
      const cand = captureRaw(next, curFps)
      if (!cand) return false
      raw = cand
      if (keepAlive) {
        if (!pump(cand.track)) {
          // 接不上就整个回滚：旧轨别停（它还在出帧，观众至少不会冻住），
          // 刚建的那条要停掉别泄漏，这一轮当没换过，下一拍再试。
          raw = cur
          if (cand.owned) cand.track.stop()
          return false
        }
      } else {
        stream.removeTrack(cur.track)
        stream.addTrack(cand.track)
        feed.onVideoTrackReplaced?.(cand.track)
      }
      if (cur.owned) cur.track.stop()
      return true
    },
    setCaptureFps(next) {
      // 分享标签页那条流是别人的，我们既没建也无权改
      if (released || !raw.owned) return
      const want = Math.max(MIN_CAPTURE_FPS, Math.min(fps, Math.round(next)))
      if (!Number.isFinite(want) || want === curFps) return
      curFps = want
      const gen = ++fpsGen
      const track = raw.track
      void (async () => {
        let applied = false
        try {
          await track.applyConstraints?.({ frameRate: want })
          const got = track.getSettings?.().frameRate
          // 读不到就当生效了 —— 有的实现不回填 frameRate，那不代表约束没应用
          applied = typeof got !== 'number' || Math.abs(got - want) < 1
        } catch {
          applied = false
        }
        // 等回来的这段时间里：放掉了 / 又改了一次 / 换源了 —— 都不该再动手
        if (released || gen !== fpsGen || raw.track !== track) return
        if (applied) return

        /**
         * applyConstraints 对 canvas 轨不是哪儿都支持。退路是**重建采集轨**，
         * 而这条退路只有 Insertable Streams 那条路能走：交给 PeerConnection 的是
         * generator 轨，底下换哪块画布、换多少帧率 sender 一无所知 ——
         * 不用 replaceTrack，不用重新协商，观众那边一帧都不会断。
         *
         * 回退路径（generator 建不起来时）交出去的就是画布轨本身，
         * 换掉它得对每个 sender replaceTrack，为了省几帧读回不值当，就不降了。
         */
        if (!keepAlive) return
        const fresh = resolve()
        // 画布已经不是原来那块了：那是换源的活，交给 check() 去做，别在这儿抢
        if (!fresh || fresh.canvas !== raw.canvas) return
        const cand = captureRaw(fresh, want)
        if (!cand) return
        const prev = raw
        raw = cand
        if (!pump(cand.track)) {
          // 同 check()：接不上就回滚，宁可维持旧帧率也不能把画面弄没
          raw = prev
          if (cand.owned) cand.track.stop()
          return
        }
        if (prev.owned) prev.track.stop()
      })()
    },
    release() {
      if (released) return null
      released = true
      pumpGen++
      if (heartbeat) window.clearInterval(heartbeat)
      void reader?.cancel().catch(() => {})
      reader = null
      void writer?.close().catch(() => {})
      writer = null
      // 最后一帧不 close，交还给调用方当下一轮的种子（见接口注释）。
      // Worker 那条路上「最后一帧」是它定期推过来的快照 —— release 必须同步返回，
      // 现问 Worker 要来不及，所以攥的是最近那张。
      const keep = pumpWorker ? snapFrame : last
      snapFrame = null
      // ⚠️ 别把正要交出去的那一帧 close 掉。回退路径上 keep 就是 last 本身；
      //    Worker 路径上 last 恒为 null，这行只是保险。
      if (keep !== last) last?.close()
      last = null
      if (pumpWorker) {
        // Worker 收到 stop 会自己关掉 writer、close 掉手里的帧，然后 self.close()
        pumpWorker.postMessage({ t: 'stop' })
        pumpWorker = null
      }
      // 还在自证、没来得及交接的那个直接掐掉，别留着空转
      if (upgrading) {
        upgrading.terminate()
        upgrading = null
      }
      try {
        generator?.stop()
      } catch {
        /* ignore */
      }
      if (raw.owned) raw.track.stop()
      audio.release()
      return keep
    },
  }
  return feed
}
