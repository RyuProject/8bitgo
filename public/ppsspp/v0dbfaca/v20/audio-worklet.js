/*
 * PPSSPP 音频消费端。
 *
 * 模拟线程把 PCM 写进 Wasm SharedArrayBuffer；AudioWorklet 在浏览器实时音频线程里
 * 直接读取，避免旧 ScriptProcessor 被页面布局、直播 UI 或聊天长任务打断后爆音。
 */
class PpssppAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.u32 = null
    this.f32 = null
    this.readSlot = 0
    this.writeSlot = 0
    this.ringBase = 0
    this.ringMask = 0
    this.underflows = 0
    this.missingFrames = 0
    this.lastLeft = 0
    this.lastRight = 0
    this.recovering = false
    this.reportAt = 0
    this.port.onmessage = (event) => {
      const data = event.data
      if (!data || data.type !== 'init' || !(data.memory instanceof SharedArrayBuffer)) return
      this.u32 = new Uint32Array(data.memory)
      this.f32 = new Float32Array(data.memory)
      this.readSlot = data.readSlot >>> 0
      this.writeSlot = data.writeSlot >>> 0
      this.ringBase = data.ringBase >>> 0
      this.ringMask = data.ringMask >>> 0
      this.reportAt = currentFrame + sampleRate * 5
    }
  }

  process(_inputs, outputs) {
    const left = outputs[0]?.[0]
    const right = outputs[0]?.[1]
    if (!left || !right || !this.u32 || !this.f32) {
      left?.fill(0)
      right?.fill(0)
      return true
    }

    let read = Atomics.load(this.u32, this.readSlot) >>> 0
    const write = Atomics.load(this.u32, this.writeSlot) >>> 0
    const available = Math.min((write - read) >>> 0, this.ringMask + 1)
    const copied = Math.min(left.length, available)
    for (let i = 0; i < copied; i++) {
      const sample = this.ringBase + (((read + i) & this.ringMask) * 2)
      left[i] = this.f32[sample]
      right[i] = this.f32[sample + 1]
    }
    if (copied && this.recovering) {
      // 欠载恢复时直接从 0 跳回真实波形会产生一次爆音；32 帧淡入只有约 0.7ms，
      // 不会给 DJMAX 这类音游增加可感知延迟，却能消掉最刺耳的波形断点。
      const fadeFrames = Math.min(32, copied)
      for (let i = 0; i < fadeFrames; i++) {
        const gain = (i + 1) / fadeFrames
        left[i] *= gain
        right[i] *= gain
      }
      this.recovering = false
    }
    if (copied < left.length) {
      // Range 请求偶发卡住时，突然补 0 会制造尖锐咔声。把最后一个有效采样平滑衰减到 0；
      // 这只是掩蔽断点，不伪造音频，也不扩大环形缓冲导致节奏判定延迟。
      const missing = left.length - copied
      const fromLeft = copied ? left[copied - 1] : this.lastLeft
      const fromRight = copied ? right[copied - 1] : this.lastRight
      for (let i = 0; i < missing; i++) {
        const gain = 1 - (i + 1) / missing
        left[copied + i] = fromLeft * gain
        right[copied + i] = fromRight * gain
      }
      this.underflows++
      this.missingFrames += missing
      this.lastLeft = 0
      this.lastRight = 0
      this.recovering = true
    } else if (copied) {
      this.lastLeft = left[copied - 1]
      this.lastRight = right[copied - 1]
    }
    if (copied) Atomics.store(this.u32, this.readSlot, (read + copied) >>> 0)

    if (currentFrame >= this.reportAt) {
      this.port.postMessage({
        type: 'stats',
        underflows: this.underflows,
        missingFrames: this.missingFrames,
        sampleRate,
      })
      this.underflows = 0
      this.missingFrames = 0
      this.reportAt = currentFrame + sampleRate * 5
    }
    return true
  }
}

registerProcessor('ppsspp-audio', PpssppAudioProcessor)
