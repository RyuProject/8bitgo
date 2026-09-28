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
    if (copied < left.length) {
      left.fill(0, copied)
      right.fill(0, copied)
      // 只按音频回调记一次，不按缺失采样数放大；这个值用于判断稳定性趋势。
      this.underflows++
    }
    if (copied) Atomics.store(this.u32, this.readSlot, (read + copied) >>> 0)

    if (currentFrame >= this.reportAt) {
      this.port.postMessage({ type: 'stats', underflows: this.underflows })
      this.underflows = 0
      this.reportAt = currentFrame + sampleRate * 5
    }
    return true
  }
}

registerProcessor('ppsspp-audio', PpssppAudioProcessor)
