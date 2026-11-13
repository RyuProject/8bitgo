/**
 * Standard MIDI File（SMF）解析器：把 .mid 字节流变成「带绝对时间的音符事件」。
 *
 * 为什么自己写而不用库：整个方案的成本底线是「播放器 45 KB、零依赖」。
 * 引入 midi-js 之类的 npm 包会带进几十 KB 依赖，而且它们只给事件不给时间轴，
 * 真正麻烦的 tempo map / running status / 多轨合并还是得自己写。
 *
 * 覆盖面按 J2ME 实际资源来定：本项目 jar 里 11 个 .mid 都是 format 0/1、
 * division 96~480 tick/四分音符、最多 19 轨、16 声道、含打击乐声道，
 * 没有 SMPTE 时基（division 高位为 1）这种极端情况；
 * 但 tempo map 仍然完整实现——变速是 MIDI 基本功，不能假设恒定速度。
 */

/** 一个已确定起止时间的音符。 */
export interface MidiNoteEvent {
  /** 相对曲子开头的秒数。 */
  time: number;
  /** 发声时长（秒）。 */
  duration: number;
  /** 0~15。 */
  channel: number;
  /** 0~127，60 = 中央 C。 */
  note: number;
  /** 1~127。 */
  velocity: number;
  /** 发声时刻的 GM 音色号 0~127。 */
  program: number;
  /** 是否打击乐声道（GM 约定第 10 声道 = 索引 9）。 */
  drums: boolean;
  /** -1~1，来自 CC10。 */
  pan: number;
  /** 0~1，来自 CC7。 */
  volume: number;
}

export interface MidiSong {
  notes: MidiNoteEvent[];
  /** 一遍曲子的长度（秒），已含尾音余量。 */
  duration: number;
  division: number;
  trackCount: number;
  format: number;
}

/** 解析中用的临时记录：先存 tick，解析完再统一换算成秒。 */
interface PendingNote {
  ev: MidiNoteEvent;
  tickStart: number;
  tickEnd: number;
}

const MTHD = 0x4d546864; // 'MThd'（大写 M T、小写 h d）
const MTRK = 0x4d54726b; // 'MTrk'

/** 尾音余量：最后一个音符的 release 也要响完，循环点才不会硬切。 */
const TAIL_SECONDS = 0.35;

/** 打击乐声道索引（GM 第 10 声道）。 */
const DRUM_CHANNEL = 9;

export function isMidi(data: Uint8Array): boolean {
  return data.length >= 14 && readTag(data, 0) === MTHD;
}

function readTag(d: Uint8Array, o: number): number {
  return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
}

function readU32(d: Uint8Array, o: number): number {
  return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
}

/** MIDI 可变长度数值（VLQ）：每字节 7 位，高位表示「后面还有」。 */
function readVlq(d: Uint8Array, o: number): { value: number; next: number } {
  let value = 0;
  let p = o;
  for (let i = 0; i < 4 && p < d.length; i++) {
    const b = d[p++];
    value = (value << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) return { value, next: p };
  }
  return { value, next: p };
}

/** tempo 段：第 tick 刻起，每个四分音符多少微秒。 */
interface TempoPoint {
  tick: number;
  usPerQuarter: number;
}

export function parseMidi(data: Uint8Array): MidiSong {
  if (!isMidi(data)) throw new Error('不是 Standard MIDI File（缺少 MThd）');
  const headerLen = readU32(data, 4);
  const format = (data[8] << 8) | data[9];
  const declaredTracks = (data[10] << 8) | data[11];
  const division = (data[12] << 8) | data[13];

  // SMPTE 时基（division 高位为 1）：帧/秒 + 每帧 tick 数。J2ME 资源基本不用，
  // 但换算成近似秒数总比直接抛异常好。
  const smpte = (division & 0x8000) !== 0;
  const secondsPerTick = smpte ? 1 / Math.max(1, (256 - (data[12] & 0xff)) * data[13]) : 1 / Math.max(1, division);

  const tempos: TempoPoint[] = [{ tick: 0, usPerQuarter: 500000 }];
  const pending: PendingNote[] = [];
  const programs = new Map<number, number>();
  const volumes = new Map<number, number>();
  const pans = new Map<number, number>();
  /** 同一 (声道, 音高) 可能重叠，用栈配对 note on/off。 */
  const active = new Map<number, PendingNote[]>();
  let maxTick = 0;
  let trackCount = 0;

  let pos = 8 + headerLen;
  while (pos + 8 <= data.length && readTag(data, pos) === MTRK) {
    const trackLen = readU32(data, pos + 4);
    const end = Math.min(pos + 8 + trackLen, data.length);
    pos += 8;
    trackCount++;

    let tick = 0;
    let running = 0;
    while (pos < end) {
      const dt = readVlq(data, pos);
      pos = dt.next;
      tick += dt.value;
      if (tick > maxTick) maxTick = tick;

      let status = data[pos];
      if (status === undefined) break;
      if (status & 0x80) {
        running = status;
        pos++;
      } else {
        status = running;
      }
      if (status === 0 || pos >= end) break; // 缺 running status / 落到轨外

      const type = status & 0xf0;
      const channel = status & 0x0f;

      switch (type) {
        case 0x80: {
          const note = data[pos];
          pos += 2;
          release(active, channel, note, tick);
          break;
        }
        case 0x90: {
          const note = data[pos];
          const velocity = data[pos + 1];
          pos += 2;
          if (velocity > 0) {
            const program = programs.get(channel) ?? 0;
            const rec: PendingNote = {
              ev: {
                time: 0,
                duration: 0,
                channel,
                note,
                velocity,
                program,
                // 打击乐约定是索引 9；若该声道显式切了非 0 音色，就当普通乐器。
                drums: channel === DRUM_CHANNEL && program === 0,
                pan: pans.get(channel) ?? 0,
                volume: (volumes.get(channel) ?? 127) / 127,
              },
              tickStart: tick,
              tickEnd: tick,
            };
            pending.push(rec);
            const key = channel * 128 + note;
            const stack = active.get(key);
            if (stack) stack.push(rec);
            else active.set(key, [rec]);
          } else {
            release(active, channel, note, tick);
          }
          break;
        }
        case 0xa0: // poly aftertouch
        case 0xe0: // pitch bend
          pos += 2;
          break;
        case 0xb0: {
          const controller = data[pos];
          const value = data[pos + 1];
          pos += 2;
          if (controller === 7) volumes.set(channel, value);
          else if (controller === 10) pans.set(channel, (value / 127 - 0.5) * 2);
          break;
        }
        case 0xc0: // program change
          programs.set(channel, data[pos]);
          pos += 1;
          break;
        case 0xd0: // channel aftertouch
          pos += 1;
          break;
        case 0xf0: {
          if (status !== 0xff) {
            const len = readVlq(data, pos);
            pos = len.next + len.value; // sysex 整段跳过
            break;
          }
          const meta = data[pos];
          pos += 1;
          const len = readVlq(data, pos);
          pos = len.next;
          if (meta === 0x51 && len.value === 3 && pos + 3 <= data.length) {
            const usPerQuarter = (data[pos] << 16) | (data[pos + 1] << 8) | data[pos + 2];
            const last = tempos[tempos.length - 1];
            if (last.tick !== tick) tempos.push({ tick, usPerQuarter });
          }
          pos += len.value;
          if (meta === 0x2f) break; // end of track
          break;
        }
        default:
          pos = end;
          break;
      }
    }
    pos = end;
  }

  // 悬挂的 note（有些文件最后不写 note off）给个兜底长度，别让它响一整首。
  for (const stack of active.values()) {
    for (const rec of stack) if (rec.tickEnd <= rec.tickStart) rec.tickEnd = rec.tickStart + 1;
  }

  tempos.sort((a, b) => a.tick - b.tick);
  const toSeconds = smpte ? (tick: number): number => tick * secondsPerTick : makeTickConverter(tempos, Math.max(1, division));

  const notes: MidiNoteEvent[] = [];
  for (const rec of pending) {
    rec.ev.time = toSeconds(rec.tickStart);
    rec.ev.duration = Math.max(0.04, toSeconds(rec.tickEnd) - rec.ev.time);
    notes.push(rec.ev);
  }
  notes.sort((a, b) => a.time - b.time);

  if (!notes.length) throw new Error('MIDI 里没有音符事件');
  // 部分老文件虚报轨数/长度，静默接受实际解析结果。
  void declaredTracks;
  return { notes, duration: Math.max(1, toSeconds(maxTick) + TAIL_SECONDS), division, trackCount, format };
}

/** 建 tick→秒 的换算函数：分段线性，tempo 变化处换斜率。 */
function makeTickConverter(tempos: TempoPoint[], division: number): (tick: number) => number {
  const segs = tempos.map((tp) => ({ tick: tp.tick, seconds: 0, rate: tp.usPerQuarter / (division * 1e6) }));
  for (let i = 1; i < segs.length; i++) {
    segs[i].seconds = segs[i - 1].seconds + (segs[i].tick - segs[i - 1].tick) * segs[i - 1].rate;
  }
  const last = segs[segs.length - 1];
  return (tick: number): number => {
    if (tick <= last.tick) {
      let i = segs.length - 1;
      while (i > 0 && segs[i].tick > tick) i--;
      const seg = segs[i];
      return seg.seconds + (tick - seg.tick) * seg.rate;
    }
    // 最后一段 tempo 一直沿用到曲末。
    return last.seconds + (tick - last.tick) * last.rate;
  };
}

function release(active: Map<number, PendingNote[]>, channel: number, note: number, tick: number): void {
  const stack = active.get(channel * 128 + note);
  if (!stack || stack.length === 0) return;
  const rec = stack.pop()!;
  rec.tickEnd = tick;
  if (stack.length === 0) active.delete(channel * 128 + note);
}