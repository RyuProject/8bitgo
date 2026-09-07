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

  let released = false
  const w = globalThis as unknown as InsertableWindow

  /* ---- Insertable Streams：generator 轨 + 转发 + 心跳 ---- */
  let generator: TrackGenerator | null = null
  let writer: WritableStreamDefaultWriter<VideoFrame> | null = null
  let reader: ReadableStreamDefaultReader<VideoFrame> | null = null
  /** 最后一帧的副本（心跳用）。换源时故意**不清**：新画布出第一帧之前观众继续看着旧画面，比黑一下好 */
  let last: VideoFrame | null = null
  let lastAt = 0
  let heartbeat = 0
  /** 换源计数。旧的转发循环靠它认出自己已经过时，别把旧画布的帧混进来 */
  let pumpGen = 0

  const pump = (track: MediaStreamTrack) => {
    if (!writer || !w.MediaStreamTrackProcessor) return
    const mine = ++pumpGen
    let r: ReadableStreamDefaultReader<VideoFrame>
    try {
      r = new w.MediaStreamTrackProcessor({ track }).readable.getReader()
    } catch {
      return
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
  if (hasInsertableStreams()) {
    try {
      generator = new w.MediaStreamTrackGenerator!({ kind: 'video' })
      writer = generator.writable.getWriter()
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
      pump(raw.track)
      heartbeat = window.setInterval(beat, HEARTBEAT_MS)
      keepAlive = true
    } catch {
      // API 在但建不起来：老老实实用画布那条轨
      generator = null
      writer = null
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
      const cand = captureRaw(next, fps)
      if (!cand) return false
      raw = cand
      if (keepAlive) {
        pump(cand.track)
      } else {
        stream.removeTrack(cur.track)
        stream.addTrack(cand.track)
        feed.onVideoTrackReplaced?.(cand.track)
      }
      if (cur.owned) cur.track.stop()
      return true
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
      // 最后一帧不 close，交还给调用方当下一轮的种子（见接口注释）
      const keep = last
      last = null
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
