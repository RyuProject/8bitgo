/**
 * MIDI 播放器：SMF 音符事件 → WebAudio 实时合成。
 *
 * 为什么不引采样库（soundfont 5~20 MB）：那会把 45 KB 的播放器直接撑成两位数 MB，
 * 和「传一个 zip 就能玩」的目标背道而驰。这里用基础振荡器 + 包络 + 低通合成，
 * 音色按 GM 音色族近似——游戏音乐听得出旋律、节奏、和声就行，不追求采样级真实。
 *
 * 调度用经典的「双时钟」做法：setInterval 25ms 跑一次，只把未来 200ms 内的音符
 * 交给 AudioContext 精确定时。setInterval 抖 50ms 也不会让音乐断断续续。
 */

import { isMidi, parseMidi, type MidiNoteEvent, type MidiSong } from './smf';

export interface MidiOptions {
  /** 音频状态变化时的提示（会被塞进游戏日志面板）。 */
  onLog?: (message: string) => void;
}

const LOOKAHEAD = 0.2;
const TIMER_MS = 25;
/** 同时发声上限，超了就丢新的（宁可少一个音也不要糊成噪音）。 */
const MAX_VOICES = 64;

type Voice = { amp: GainNode; sources: AudioScheduledSourceNode[] };

/** 一个音色的全部合成参数。 */
interface Timbre {
  waves: OscillatorType[];
  detunes: number[];
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  cutoff: number;
  peak: number;
  q: number;
  gain: number;
  /** 打击乐/噪声类音色走白噪声分支。 */
  noise?: { gain: number; decay: number; hp: number; bp?: number };
  /** 噪声之外再叠一个正弦/三角（例如军鼓=噪声+鼓身，底鼓=纯正弦）。 */
  tone?: { freq: number; gain: number; decay: number; sweepTo?: number };
}

interface DrumHit {
  noise?: { gain: number; decay: number; hp: number; bp?: number };
  tone?: { freq: number; gain: number; decay: number; sweepTo?: number };
  gain?: number;
}

function fam(program: number): number {
  return Math.floor(program / 8);
}

/** GM 音色族 → 合成参数。第 9 族里 8/9 号（钢片琴/颤音琴）单独给亮一点的参数。 */
function timbreFor(ev: MidiNoteEvent): Timbre {
  if (ev.drums) return drumHit(ev.note);
  const f = fam(ev.program);
  switch (f) {
    case 0: // 钢琴：三角波为主 + 轻微失谐正弦补体积
      return { waves: ['triangle', 'sine'], detunes: [0, 6], attack: 0.004, decay: 0.9, sustain: 0.16, release: 0.28, cutoff: 2400, peak: 3800, q: 0.7, gain: 0.5 };
    case 1: // 色彩打击乐
      return ev.program === 8
        ? { waves: ['sine', 'triangle'], detunes: [0, 1200], attack: 0.002, decay: 0.5, sustain: 0.05, release: 0.15, cutoff: 3200, peak: 3400, q: 1.1, gain: 0.42 }
        : { waves: ['sine'], detunes: [0], attack: 0.002, decay: 0.45, sustain: 0.05, release: 0.12, cutoff: 4200, peak: 4000, q: 1, gain: 0.45 };
    case 2: // 风琴：持续音
      return { waves: ['square', 'square'], detunes: [0, 9], attack: 0.012, decay: 0.06, sustain: 0.85, release: 0.12, cutoff: 2600, peak: 1200, q: 0.9, gain: 0.26 };
    case 3: // 吉他：拨弦感（快衰减）
      return { waves: ['sawtooth'], detunes: [0], attack: 0.003, decay: 0.5, sustain: 0.04, release: 0.2, cutoff: 2200, peak: 4000, q: 1.3, gain: 0.4 };
    case 4: // 贝斯：低通正弦
      return { waves: ['sine', 'triangle'], detunes: [0, 5], attack: 0.006, decay: 0.3, sustain: 0.55, release: 0.12, cutoff: 820, peak: 1300, q: 1.1, gain: 0.6 };
    case 5: // 弦乐
    case 6: // 合唱
      return { waves: ['sawtooth', 'sawtooth'], detunes: [0, 10], attack: 0.09, decay: 0.3, sustain: 0.8, release: 0.32, cutoff: 2000, peak: 1000, q: 0.6, gain: 0.28 };
    case 7: // 铜管
      return { waves: ['sawtooth'], detunes: [0], attack: 0.045, decay: 0.22, sustain: 0.75, release: 0.18, cutoff: 1600, peak: 2400, q: 1.2, gain: 0.32 };
    case 8: // 簧管
      return { waves: ['square'], detunes: [0], attack: 0.05, decay: 0.2, sustain: 0.8, release: 0.15, cutoff: 1900, peak: 1600, q: 0.9, gain: 0.28 };
    case 9: // 管乐（长笛/葫芦丝）
      return { waves: ['sine', 'triangle'], detunes: [0, 4], attack: 0.07, decay: 0.15, sustain: 0.85, release: 0.2, cutoff: 2500, peak: 900, q: 0.5, gain: 0.34 };
    case 10: // 合成主音
      return { waves: ['square'], detunes: [0], attack: 0.01, decay: 0.2, sustain: 0.7, release: 0.15, cutoff: 2600, peak: 2600, q: 1.5, gain: 0.28 };
    case 11: // 合成铺垫：慢起音
      return { waves: ['sawtooth', 'sawtooth'], detunes: [0, 13], attack: 0.16, decay: 0.4, sustain: 0.85, release: 0.5, cutoff: 1600, peak: 800, q: 0.5, gain: 0.24 };
    case 12: // 民族音色
      return { waves: ['triangle'], detunes: [0], attack: 0.01, decay: 0.3, sustain: 0.5, release: 0.25, cutoff: 2200, peak: 2200, q: 1, gain: 0.38 };
    case 13: // 打击性音色（马林巴/木琴）
      return { waves: ['sine', 'triangle'], detunes: [0, 7], attack: 0.002, decay: 0.32, sustain: 0.04, release: 0.2, cutoff: 3000, peak: 3200, q: 1.1, gain: 0.44 };
    case 14: // 特效音
      return { waves: ['sine'], detunes: [0], attack: 0.012, decay: 0.4, sustain: 0.4, release: 0.3, cutoff: 2800, peak: 2600, q: 2, gain: 0.28 };
    default: // 120~127 民族/杂项
      return { waves: ['triangle'], detunes: [0], attack: 0.008, decay: 0.3, sustain: 0.6, release: 0.25, cutoff: 2400, peak: 1800, q: 0.9, gain: 0.36 };
  }
}

/** GM 打击乐音键表：把 note 号映射成「底鼓/军鼓/踩镲/吊镲/嗵鼓/其他」。 */
function drumHit(note: number): Timbre {
  const hit = drumHitRaw(note);
  return {
    waves: ['sine'],
    detunes: [0],
    attack: 0.001,
    decay: hit.noise?.decay ?? hit.tone?.decay ?? 0.12,
    sustain: 0,
    release: 0.02,
    cutoff: 12000,
    peak: 0,
    q: 0.7,
    gain: hit.gain ?? 0.5,
    noise: hit.noise,
    tone: hit.tone,
  };
}

function drumHitRaw(note: number): DrumHit {
  switch (note) {
    case 35: // 底鼓
    case 36:
      return { tone: { freq: 62, gain: 0.9, decay: 0.26, sweepTo: 42 }, gain: 0.9 };
    case 37: // 边击
      return { noise: { gain: 0.35, decay: 0.05, hp: 2500 }, gain: 0.5 };
    case 38: // 军鼓
    case 40:
      return { noise: { gain: 0.5, decay: 0.16, hp: 900 }, tone: { freq: 190, gain: 0.3, decay: 0.1, sweepTo: 150 }, gain: 0.6 };
    case 39: // 拍手
      return { noise: { gain: 0.42, decay: 0.2, hp: 700, bp: 1600 }, gain: 0.55 };
    case 41:
    case 43:
    case 45:
    case 47:
    case 48:
    case 50: { // 嗵鼓
      const toms: Record<number, number> = { 41: 120, 43: 100, 45: 88, 47: 78, 48: 70, 50: 62 };
      const freq = toms[note] ?? 90;
      return { tone: { freq, gain: 0.6, decay: 0.28, sweepTo: freq * 0.7 }, gain: 0.6 };
    }
    case 42: // 闭合踩镲
    case 44:
      return { noise: { gain: 0.28, decay: 0.05, hp: 7000 }, gain: 0.45 };
    case 46: // 开镲
      return { noise: { gain: 0.26, decay: 0.3, hp: 6500 }, gain: 0.45 };
    case 51: // 溅镲
    case 53:
    case 59:
      return { noise: { gain: 0.3, decay: 0.55, hp: 6000 }, gain: 0.45 };
    case 49: // 吊镲
    case 52:
    case 55:
    case 57:
      return { noise: { gain: 0.32, decay: 1.1, hp: 4800 }, gain: 0.5 };
    default:
      return { noise: { gain: 0.3, decay: 0.1, hp: 1800 }, gain: 0.4 };
  }
}

/**
 * 全局唯一的 AudioContext 与总线：所有 player 共享，省电也省节点。
 * 浏览器的自动播放策略要求先有一次用户手势，所以 ctx 可能先是 suspended，
 * 这里负责在第一次输入时解锁。
 */
class AudioEngine {
  ctx: AudioContext | null = null;
  voiceBus: GainNode | null = null;
  /** 混音之后的总输出节点（已带余量衰减），自测时量它才是真实电平。 */
  output: GainNode | null = null;
  noiseBuffer: AudioBuffer | null = null;
  current: MidiPlayer | null = null;
  private unlocking = false;
  private unlockedLogged = false;

  constructor(private readonly onLog?: (message: string) => void) {}

  /** 拿（或建）AudioContext；浏览器不支持 WebAudio 时返回 null，全链路静默降级。 */
  acquire(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor =
      (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      this.onLog?.('浏览器不支持 WebAudio，MIDI 将静音');
      return null;
    }
    try {
      const ctx = new Ctor({ latencyHint: 'interactive' });
      const master = ctx.createGain();
      master.gain.value = 1;
      // 复音上限 64 个声部，叠满时总线峰值能到 1.16（会削顶）。
      // 这里先留 5.4dB 余量再进压限，压限就只做兜底而不��常工作（否则会泵动）。
      const headroom = ctx.createGain();
      headroom.gain.value = 0.5;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -10;
      comp.ratio.value = 8;
      comp.attack.value = 0.003;
      comp.release.value = 0.18;
      const bus = ctx.createGain();
      bus.connect(headroom);
      headroom.connect(comp);
      comp.connect(master);
      master.connect(ctx.destination);

      // 2 秒白噪声，打击乐复用。
      const frames = Math.floor(ctx.sampleRate * 2);
      const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
      const data = buf.getChannelData(0);
      let seed = 0x2f6e2b1;
      for (let i = 0; i < frames; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        data[i] = (seed / 0x3fffffff) - 1;
      }

      this.ctx = ctx;
      this.voiceBus = bus;
      this.output = headroom;
      this.noiseBuffer = buf;
      this.ensureUnlocked();
      return ctx;
    } catch (err) {
      this.onLog?.(`AudioContext 创建失败：${String(err)}`);
      return null;
    }
  }

  /** 自动播放策略：任何一次用户手势都尝试 resume，成功后撤掉监听。 */
  ensureUnlocked(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'running' || this.unlocking) return;
    this.unlocking = true;
    const handler = () => {
      if (!this.ctx) return;
      void this.ctx
        .resume()
        .then(() => {
          if (this.ctx?.state === 'running') {
            for (const ev of EVENTS) globalThis.removeEventListener(ev, handler, true);
            this.unlocking = false;
            if (!this.unlockedLogged) {
              this.unlockedLogged = true;
              this.onLog?.('音频已解锁，MIDI 开始发声');
            }
          }
        })
        .catch(() => {
          /* 下次手势再试 */
        });
    };
    for (const ev of EVENTS) globalThis.addEventListener(ev, handler, true);
  }

  noiseSource(ctx: AudioContext): { source: AudioBufferSourceNode; offset: number } {
    const source = ctx.createBufferSource();
    let offset = 0;
    if (this.noiseBuffer) {
      source.buffer = this.noiseBuffer;
      source.loop = true;
      source.loopStart = 0;
      source.loopEnd = this.noiseBuffer.duration;
      // 每次从不同位置起播，否则打击乐听起来像复读机。
      offset = Math.random() * Math.max(0, this.noiseBuffer.duration - 0.5);
    }
    return { source, offset };
  }
}

const EVENTS = ['pointerdown', 'keydown', 'touchstart', 'mousedown'] as const;

let engine: AudioEngine | null = null;

function getEngine(onLog?: (message: string) => void): AudioEngine {
  if (!engine) engine = new AudioEngine(onLog);
  return engine;
}

/**
 * 自测钩子：拿到 AudioContext 和总线，外部就能挂一个 AnalyserNode 量真实输出电平，
 * 用来验证「确实在发声」而不只是「调度函数被调用过」。
 */
export function audioProbe(): { ctx: AudioContext | null; out: GainNode | null } {
  return { ctx: engine?.ctx ?? null, out: engine?.output ?? null };
}

/** 对外：把一个 .mid 字节流变成可 start/stop 的播放器。解析失败时静默降级为无声。 */
export class MidiPlayer {
  readonly song: MidiSong | null;
  readonly error: string | null;
  /** 自测用计数：排进 AudioContext 的音符数 / 曾同时发声的最大声部数。 */
  readonly stats = { scheduled: 0, peakVoices: 0 };
  private readonly onLog?: (message: string) => void;
  private readonly engine: AudioEngine;
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private readonly voices = new Set<Voice>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private anchor = 0;
  private index = 0;
  private cycle = 0;
  private loopCount = -1;
  private playing = false;
  private closed = false;
  private dropped = 0;
  private volumeScale = 1;
  private muted = false;

  constructor(data: Uint8Array, options: MidiOptions = {}) {
    this.onLog = options.onLog;
    this.engine = getEngine(options.onLog);
    let song: MidiSong | null = null;
    let error: string | null = null;
    try {
      song = isMidi(data) ? parseMidi(data) : null;
      if (!song) error = '不是 MIDI 数据';
    } catch (err) {
      error = String(err instanceof Error ? err.message : err);
    }
    this.song = song;
    this.error = song ? null : error;
    if (song) {
      this.onLog?.(
        `MIDI 已解析：${song.notes.length} 个音符 / ${song.trackCount} 轨 / ${song.duration.toFixed(1)} 秒`,
      );
    } else if (error) {
      this.onLog?.(`MIDI 解析失败（静音）：${error}`);
    }
  }

  get durationMs(): number {
    return this.song ? Math.round(this.song.duration * 1000) : -1;
  }

  /** 因复音超限被丢掉的音符数（自测/诊断用）。 */
  get droppedCount(): number {
    return this.dropped;
  }

  setLoopCount(count: number): void {
    this.loopCount = count;
  }

  /** 0~1。 */
  setVolume(level: number): void {
    this.volumeScale = Math.max(0, Math.min(1, level));
    this.applyGain();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyGain();
  }

  private applyGain(): void {
    if (!this.out || !this.ctx) return;
    const value = this.muted ? 0 : this.volumeScale;
    this.out.gain.setTargetAtTime(value, this.ctx.currentTime, 0.02);
  }

  start(): void {
    if (this.closed || this.playing) return;
    this.playing = true;
    if (!this.song) return; // 解析失败/非 MIDI：保持「已启动」语义但不发声
    const ctx = this.engine.acquire();
    if (!ctx || !this.engine.voiceBus) return; // 没 WebAudio：同样静默
    this.ctx = ctx;
    if (!this.out) {
      this.out = ctx.createGain();
      this.out.connect(this.engine.voiceBus);
    }
    this.applyGain();
    // 手机上同一时刻只有一个 player 在响，换歌前先掐掉上一个。
    if (this.engine.current && this.engine.current !== this) this.engine.current.stop();
    this.engine.current = this;

    this.anchor = ctx.currentTime + 0.08;
    this.index = 0;
    this.cycle = 0;
    this.dropped = 0;
    this.engine.ensureUnlocked();
    this.timer = setInterval(() => this.pump(), TIMER_MS);
    this.pump();
  }

  stop(): void {
    if (!this.playing && !this.ctx) {
      this.playing = false;
      return;
    }
    this.playing = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.silenceVoices();
    if (this.engine.current === this) this.engine.current = null;
    if (this.dropped > 0) {
      this.onLog?.(`复音超限丢弃 ${this.dropped} 个音符`);
      this.dropped = 0;
    }
  }

  close(): void {
    if (this.closed) return;
    this.stop();
    this.closed = true;
    this.out?.disconnect();
    this.out = null;
  }

  /** 调度：只把未来 LOOKAHEAD 秒内的音符排进 AudioContext。 */
  private pump(): void {
    if (!this.playing || !this.ctx || !this.song) return;
    const ctx = this.ctx;
    const notes = this.song.notes;
    const duration = this.song.duration;
    const horizon = ctx.currentTime + LOOKAHEAD;
    const totalPasses = this.loopCount < 0 ? Infinity : this.loopCount + 1;
    let guard = 0;
    for (;;) {
      if (guard++ > 8192) break;
      if (this.index >= notes.length) {
        if (this.cycle + 1 >= totalPasses) {
          this.stop();
          return;
        }
        this.cycle++;
        this.index = 0;
        continue;
      }
      const ev = notes[this.index];
      const when = this.anchor + this.cycle * duration + ev.time;
      if (when > horizon) break;
      this.playNote(ev, when);
      this.index++;
    }
  }

  private playNote(ev: MidiNoteEvent, when: number): void {
    const ctx = this.ctx;
    const out = this.out;
    if (!ctx || !out) return;
    if (this.voices.size >= MAX_VOICES) {
      this.dropped++;
      return;
    }
    const tb = timbreFor(ev);
    const level = Math.pow(ev.velocity / 127, 1.35) * ev.volume * this.volumeScale;
    if (level < 0.004) return;

    const mix = ctx.createGain();
    mix.gain.value = 1;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = tb.q;
    const sources: AudioScheduledSourceNode[] = [];

    // 打击乐：噪声 + 鼓身两路叠加。
    if (tb.noise) {
      const { source: src, offset } = this.engine.noiseSource(ctx);
      const ng = ctx.createGain();
      const decay = tb.noise.decay;
      ng.gain.setValueAtTime(0.0001, when);
      ng.gain.linearRampToValueAtTime(tb.noise.gain * level, when + 0.001);
      ng.gain.exponentialRampToValueAtTime(0.0001, when + decay);
      if (tb.noise.bp) {
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = tb.noise.bp;
        src.connect(bp);
        bp.connect(ng);
      } else {
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = tb.noise.hp;
        src.connect(hp);
        hp.connect(ng);
      }
      ng.connect(mix);
      src.start(when, offset);
      sources.push(src);
    }

    if (tb.tone) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      const tg = ctx.createGain();
      osc.frequency.setValueAtTime(tb.tone.freq, when);
      if (tb.tone.sweepTo) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, tb.tone.sweepTo), when + tb.tone.decay);
      }
      tg.gain.setValueAtTime(0.0001, when);
      tg.gain.linearRampToValueAtTime(tb.tone.gain * level, when + 0.002);
      tg.gain.exponentialRampToValueAtTime(0.0001, when + tb.tone.decay);
      osc.connect(tg);
      tg.connect(mix);
      osc.start(when);
      sources.push(osc);
    }

    if (sources.length === 0) {
      // 旋律音色：按 waves 建一组振荡器。
      const freq = 440 * Math.pow(2, (ev.note - 69) / 12);
      for (let i = 0; i < tb.waves.length; i++) {
        const osc = ctx.createOscillator();
        osc.type = tb.waves[i];
        osc.frequency.value = freq;
        osc.detune.value = tb.detunes[i] ?? 0;
        const g = ctx.createGain();
        g.gain.value = tb.gain / tb.waves.length;
        osc.connect(g);
        g.connect(mix);
        osc.start(when);
        sources.push(osc);
      }
      const openAt = when + Math.max(tb.attack + tb.decay, Math.min(ev.duration, 2));
      filter.frequency.setValueAtTime(Math.min(18000, tb.cutoff + tb.peak * level), when);
      filter.frequency.exponentialRampToValueAtTime(Math.max(180, tb.cutoff), openAt);
      this.applyAdsr(mix, when, tb, ev.duration);
    } else {
      filter.frequency.value = 18000;
      filter.Q.value = 0.5;
    }

    const amp = ctx.createGain();
    amp.gain.value = 1;
    mix.connect(filter);
    filter.connect(amp);
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, ev.pan));
    amp.connect(panner);
    panner.connect(out);

    const stopAt = when + Math.max(ev.duration, tb.attack + tb.decay) + tb.release + 0.1;
    const voice: Voice = { amp, sources };
    this.voices.add(voice);
    this.stats.scheduled++;
    if (this.voices.size > this.stats.peakVoices) this.stats.peakVoices = this.voices.size;
    for (const src of sources) {
      try {
        src.stop(stopAt);
      } catch {
        /* 已停止 */
      }
    }
    // 最后一个源结束时回收节点引用。
    const last = sources[sources.length - 1];
    if (last) {
      last.onended = () => {
        this.voices.delete(voice);
        try {
          amp.disconnect();
          panner.disconnect();
          filter.disconnect();
          mix.disconnect();
        } catch {
          /* 已断开 */
        }
      };
    }
  }

  private applyAdsr(node: GainNode, when: number, tb: Timbre, duration: number): void {
    const param = node.gain;
    const peak = 1;
    const sustain = Math.max(0.0005, peak * tb.sustain);
    const off = when + Math.max(duration, tb.attack + tb.decay);
    param.setValueAtTime(0.0001, when);
    param.linearRampToValueAtTime(peak, when + tb.attack);
    param.exponentialRampToValueAtTime(sustain, when + tb.attack + tb.decay);
    param.setValueAtTime(sustain, off);
    param.exponentialRampToValueAtTime(0.0001, off + tb.release);
  }

  private silenceVoices(): void {
    const ctx = this.ctx;
    if (!ctx) {
      this.voices.clear();
      return;
    }
    const now = ctx.currentTime;
    for (const voice of this.voices) {
      voice.amp.gain.cancelScheduledValues(now);
      voice.amp.gain.setTargetAtTime(0, now, 0.015);
      for (const src of voice.sources) {
        try {
          src.stop(now + 0.06);
        } catch {
          /* 已停止 */
        }
      }
    }
  }
}