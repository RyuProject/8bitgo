/**
 * 游戏录制：最长 60 秒，录完直接下载到本地，不经过服务器。
 *
 * 画面来源有两种：
 *   - canvas：用 captureStream() 拿实时画面（jsnes / js-dos / EmulatorJS / Ruffle 都是画在 canvas 上）
 *   - stream：已经有现成的 MediaStream（云联机的 WebRTC 流，音视频都在里面）
 *
 * 声音是各引擎最不统一的地方：能给到 AudioNode 或 MediaStreamTrack 就混进去，
 * 给不了就只录画面 —— 宁可没声音，也不要因为拿不到音频就整个录不了。
 */

/** 硬上限。超过就自动停，避免录出几百 MB 的文件把内存吃光 */
export const MAX_RECORD_MS = 60_000

export interface RecordSources {
  /** 画面：canvas（会调 captureStream） */
  canvas?: HTMLCanvasElement | null
  /** 画面 + 声音：现成的 MediaStream（云联机） */
  stream?: MediaStream | null
  /** 声音：WebAudio 节点（会接一个 MediaStreamDestination 出来） */
  audioNode?: AudioNode | null
  /** 声音所在的 AudioContext（配合 audioNode 用） */
  audioContext?: AudioContext | null
}

export interface Recording {
  blob: Blob
  /** 实际时长（毫秒） */
  durationMs: number
  hasAudio: boolean
}

export interface Recorder {
  readonly recording: boolean
  /** 已录制毫秒数 */
  elapsed: () => number
  stop: () => Promise<Recording | null>
  /** 提前放弃，不产出文件 */
  cancel: () => void
}

/** 挑一个浏览器支持的封装格式：优先 vp9，退回 vp8，再退回默认 webm */
function pickMimeType(): string | undefined {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ]
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type
  }
  return undefined
}

export function canRecord(sources: RecordSources): boolean {
  if (typeof MediaRecorder === 'undefined') return false
  if (sources.stream) return true
  return Boolean(sources.canvas && typeof sources.canvas.captureStream === 'function')
}

/**
 * 开始录制。返回的 stop() 给出 webm；到 60 秒会自动停，
 * 这时 stop() 拿到的仍然是完整的那 60 秒。
 */
export function startRecording(sources: RecordSources, opts: { fps?: number; maxMs?: number; onAutoStop?: () => void } = {}): Recorder | null {
  if (!canRecord(sources)) return null

  const maxMs = opts.maxMs ?? MAX_RECORD_MS
  const tracks: MediaStreamTrack[] = []
  /** 录完要断开的临时节点 */
  let audioDest: MediaStreamAudioDestinationNode | null = null

  if (sources.stream) {
    tracks.push(...sources.stream.getTracks())
  } else if (sources.canvas) {
    const videoStream = sources.canvas.captureStream(opts.fps ?? 30)
    tracks.push(...videoStream.getVideoTracks())
  }

  // 单独给的音频源（canvas 那条路才需要）
  if (!sources.stream && sources.audioNode && sources.audioContext) {
    try {
      audioDest = sources.audioContext.createMediaStreamDestination()
      sources.audioNode.connect(audioDest)
      tracks.push(...audioDest.stream.getAudioTracks())
    } catch {
      // 接不上就只录画面
      audioDest = null
    }
  }

  if (tracks.length === 0) return null
  const hasAudio = tracks.some((t) => t.kind === 'audio')
  const stream = new MediaStream(tracks)

  const mimeType = pickMimeType()
  let recorder: MediaRecorder
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 2_500_000 } : undefined)
  } catch {
    return null
  }

  const chunks: BlobPart[] = []
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data)
  }

  const startedAt = performance.now()
  let stoppedAt = 0
  let autoStopTimer = 0
  let done: Promise<void> | null = null

  const cleanup = () => {
    window.clearTimeout(autoStopTimer)
    if (audioDest && sources.audioNode) {
      try {
        sources.audioNode.disconnect(audioDest)
      } catch {
        /* 已经断了 */
      }
    }
    // 只停我们自己从 canvas 拿的轨；云联机那条流还在播，不能停
    if (!sources.stream) for (const t of tracks) t.stop()
  }

  const finish = () => {
    if (done) return done
    stoppedAt = performance.now()
    done = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve()
      try {
        if (recorder.state !== 'inactive') recorder.stop()
        else resolve()
      } catch {
        resolve()
      }
    }).then(cleanup)
    return done
  }

  recorder.start(200) // 每 200ms 产出一块，中途停也不会丢
  autoStopTimer = window.setTimeout(() => {
    void finish().then(() => opts.onAutoStop?.())
  }, maxMs)

  return {
    get recording() {
      return recorder.state === 'recording'
    },
    elapsed: () => Math.min((stoppedAt || performance.now()) - startedAt, maxMs),
    stop: async () => {
      const durationMs = Math.min((stoppedAt || performance.now()) - startedAt, maxMs)
      await finish()
      if (chunks.length === 0) return null
      return { blob: new Blob(chunks, { type: mimeType || 'video/webm' }), durationMs, hasAudio }
    },
    cancel: () => {
      chunks.length = 0
      void finish()
    },
  }
}

/* ---------------- 下载 ---------------- */

/** 存到本地。全程在浏览器里，不上传任何东西 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立刻 revoke 会让 Safari 来不及取文件，等一下再放
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** 用游戏名 + 时间戳拼一个不会互相覆盖的文件名 */
export function mediaFileName(gameName: string, ext: string): string {
  const safe = (gameName || 'game').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40)
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `${safe}-${stamp}.${ext}`
}

/** canvas 转 blob（截屏用）。WebGL 画布必须在同一帧里取，调用方注意时机 */
export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png'): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), type)
    } catch {
      resolve(null)
    }
  })
}

/** ImageData 转 blob（js-dos 的 ci.screenshot() 给的是 ImageData） */
export function imageDataToBlob(data: ImageData, type = 'image/png'): Promise<Blob | null> {
  const canvas = document.createElement('canvas')
  canvas.width = data.width
  canvas.height = data.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.resolve(null)
  ctx.putImageData(data, 0, 0)
  return canvasToBlob(canvas, type)
}
