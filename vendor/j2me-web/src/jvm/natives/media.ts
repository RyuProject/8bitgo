import type { Jvm, JThread, NativeClassDef } from '../jvm';
import { ACC_ABSTRACT, ACC_INTERFACE } from '../classfile';
import { JArray, JObject } from '../types';
import { newNativeObject } from './helpers';
import { readAllBytes } from './io';
import { MidiPlayer } from '../../midi/synth';

/**
 * javax.microedition.media 桩实现 + **真 MIDI 播放**。
 *
 * 上游 0.0.x 完全没有这个包：整个 src 里 media 只在 lang.ts 的异常类映射里出现过
 * 一次。任何调用 Manager/Player 的游戏都会拿到 NoClassDefFoundError（jvm.ts:162），
 * 如果游戏在 repaint 里重试就会变成异常风暴——这就是「勾选声音就卡死」的根因。
 *
 * 类与方法的**签名**按 CLDC/MIDP 2.0 补齐，并且描述符必须和 jar 常量池逐字一致
 * （见 playerClass 里 getControl 那行注释）。
 *
 * 播放本身走真 WebAudio 合成：jar 里的音乐资源是标准 .mid（实测 11 个，
 * format 0/1、最多 19 轨、含打击乐声道），createPlayer(InputStream,"audio/midi")
 * 会把字节流读出来解析，然后由 src/midi/synth.ts 的合成器实时发声。
 * 非 MIDI 数据（wav/amr 等）目前仍走静音分支。
 *
 * 状态常量（javax.microedition.media.Player，JSR-135 规范值）：
 *   UNREALIZED 100 / REALIZED 200 / PREFETCHED 300 / STARTED 400 / CLOSED 0
 */

/**
 * 8BitGo：上游写成 4 / 8 / 16 / 32，与规范不符。这些是 static final 编译期常量，javac 会直接内联进
 * 游戏字节码，游戏拿 getState() 和字面量 300 比 —— 《仙剑奇侠传 2004》prefetch 后见状态不是 300，
 * 弹「has not prefecthed」卡死（2026-11-15）。
 */
const UNREALIZED = 100;
const REALIZED = 200;
const PREFETCHED = 300;
const STARTED = 400;
const CLOSED = 0;

const LOOP_INDEFINITE = -1;

/** VolumeControl 的内部状态：绑到具体 Player 上，setLevel 才作用得到那首歌。 */
interface VolumePeer {
  owner: MidiPlayer | null;
  level: number;
  muted: boolean;
}

/** 每个实例的播放状态；不落到 self.n 上的整数状态用 peer 对象存。 */
interface PlayerPeer {
  state: number;
  loopMode: number;
  loopCount: number;
  /** 真 MIDI 播放器；解析失败或非 MIDI 时为 null（静默）。 */
  midi: MidiPlayer | null;
  /** 每个 Player 一个 VolumeControl 实例，getControl 每次返回同一个（真实语义）。 */
  volume: JObject | null;
  /** 供 VolumeControl 反查 Player 用。 */
  self: JObject | null;
  /** 8BitGo：PlayerListener 与「播完」定时器（见 notifyPlayer） */
  listeners?: JObject[];
  endTimer?: ReturnType<typeof setTimeout> | null;
}

/** 非 MIDI（静音）片段假装的长度：够「等开场音效播完」的游戏往下走，又不会让玩家多等 */
const SILENT_CLIP_MS = 500;

/**
 * 8BitGo：给 PlayerListener 投递事件。上游的 addPlayerListener 是空实现，
 * 不少游戏（《模拟人生 3》等）开场放一段音效、收到 endOfMedia 才进菜单 —— 永远等不到，卡在 logo。
 * 回调在事件线程上跑（和真机一样）；data 按规范该是 Long，这里给 null，游戏极少读它。
 */
function notifyPlayer(jvm: Jvm, p: PlayerPeer, event: string): void {
  const player = p.self;
  if (!player || !p.listeners?.length) return;
  for (const listener of p.listeners) {
    jvm.postEvent((t) => {
      const m = jvm.findVirtual(jvm.classOf(listener), 'playerUpdate(Ljavax/microedition/media/Player;Ljava/lang/String;Ljava/lang/Object;)V');
      if (!m) return false;
      jvm.pushCall(t, m, [listener, player, event, null]);
      return true;
    });
  }
}

function clearEndTimer(p: PlayerPeer): void {
  if (p.endTimer) clearTimeout(p.endTimer);
  p.endTimer = null;
}

/** start 之后按时长排一个 endOfMedia；无限循环不排 */
function scheduleEnd(jvm: Jvm, p: PlayerPeer): void {
  clearEndTimer(p);
  if (p.loopCount < 0) return;
  const once = p.midi && !p.midi.error && p.midi.durationMs > 0 ? p.midi.durationMs : SILENT_CLIP_MS;
  p.endTimer = setTimeout(() => {
    p.endTimer = null;
    if (p.state !== STARTED) return;
    p.midi?.stop();
    p.state = PREFETCHED;
    notifyPlayer(jvm, p, 'endOfMedia');
  }, once * Math.max(1, p.loopCount));
}

function newVolumePeer(owner: MidiPlayer | null): VolumePeer {
  return { owner, level: 100, muted: false };
}

/** 新建 Player 对象；有 MIDI 就真解析并挂上合成器。 */
function newPlayer(jvm: Jvm, data: Uint8Array | null): JObject {
  let midi: MidiPlayer | null = null;
  if (data && data.length >= 4) {
    midi = new MidiPlayer(data, { onLog: (message) => jvm.host.log('info', message) });
  }
  const self = newNativeObject(jvm, 'javax/microedition/media/Player', null);
  const peer: PlayerPeer = {
    state: midi && !midi.error ? REALIZED : STARTED,
    loopMode: LOOP_INDEFINITE,
    // 8BitGo：JSR-135 规定默认播 1 遍；上游默认无限循环，开场音效永远播不完、等 END_OF_MEDIA 的游戏卡死
    loopCount: 1,
    midi,
    volume: null,
    self,
  };
  self.n = peer;
  if (midi && !midi.error) peer.volume = newNativeObject(jvm, 'j2me/VolumeControlImpl', newVolumePeer(midi));
  return self;
}

/** 旧的「假装在播」路径：没有字节流时（URL / 系统音）保持兼容。 */
function newStartedPlayer(jvm: Jvm): JObject {
  return newPlayer(jvm, null);
}

function peerOf(self: JObject): PlayerPeer {
  if (self.n === undefined || self.n === null) {
    self.n = { state: UNREALIZED, loopMode: LOOP_INDEFINITE, loopCount: 1, midi: null, volume: null, self } satisfies PlayerPeer;
  }
  return self.n as PlayerPeer;
}

function volumePeer(self: JObject): VolumePeer {
  if (typeof self.n !== 'object' || self.n === null) self.n = newVolumePeer(null);
  return self.n as VolumePeer;
}

/** Player.getVolume() 走的是它自己那个 VolumeControl 实例。 */
function volumePeerOf(p: PlayerPeer): VolumePeer {
  return volumePeer(p.volume as JObject);
}

/** 统一的状态迁移：CLOSED 之后任何播放调用都要抛 MediaException（符合 MIDP 语义）。 */
function enter(t: JThread, self: JObject, next: number): void {
  const p = peerOf(self);
  if (p.state === CLOSED) throw t.jvm.throwable('javax/microedition/media/MediaException', 'player is closed');
  p.state = next;
}

const mediaException: NativeClassDef = {
  name: 'javax/microedition/media/MediaException',
  super: 'java/lang/Exception',
};

const playerListener: NativeClassDef = {
  name: 'javax/microedition/media/PlayerListener',
  flags: ACC_ABSTRACT | ACC_INTERFACE,
};

/** javax.microedition.media.Control：所有控制器的基类（MIDP 2.0 里在 media 包下）。 */
const controlClass: NativeClassDef = {
  name: 'javax/microedition/media/Control',
  super: 'java/lang/Object',
};

/** Controllable：Player 实现的接口，暴露 getControl/getControls。 */
const controllableClass: NativeClassDef = {
  name: 'javax/microedition/media/Controllable',
  flags: ACC_ABSTRACT | ACC_INTERFACE,
  methods: {
    'getControl(Ljava/lang/String;)Ljavax/microedition/media/Control;': () => null,
    'getControls()[Ljavax/microedition/media/Control;': () => new JArray('[Ljavax/microedition/media/Control;', []),
  },
};

const volumeControlInterface: NativeClassDef = {
  name: 'javax/microedition/media/control/VolumeControl',
  interfaces: ['javax/microedition/media/Control'],
  flags: ACC_ABSTRACT | ACC_INTERFACE,
};

/**
 * 音量控制器的具体实现。游戏拿到 Player 后通常做
 *   player.getControl("VolumeControl") -> checkcast VolumeControl -> setLevel(x)
 * 三步，所以 getControl 必须返回一个真的 instanceof VolumeControl 的对象，
 * 而且必须绑到这个 Player 的 MIDI 合成器上，setLevel 才真的改变那首歌的音量。
 */
const volumeControlImpl: NativeClassDef = {
  name: 'j2me/VolumeControlImpl',
  interfaces: ['javax/microedition/media/control/VolumeControl'],
  methods: {
    '<init>()V': (_t, [self]) => {
      self.n = newVolumePeer(null);
    },
    'getLevel()I': (_t, [self]) => volumePeer(self).level,
    'setLevel(I)I': (t, [self, level]) => {
      if (level < 0 || level > 100) throw t.jvm.throwable('java/lang/IllegalArgumentException', `level ${level}`);
      const peer = volumePeer(self);
      peer.level = level;
      peer.owner?.setVolume(level / 100);
      return level;
    },
    'isMute()Z': (_t, [self]) => volumePeer(self).muted,
    'setMute(Z)V': (_t, [self, mute]) => {
      const peer = volumePeer(self);
      peer.muted = mute !== false;
      peer.owner?.setMuted(peer.muted);
    },
  },
};

const playerClass: NativeClassDef = {
  name: 'javax/microedition/media/Player',
  interfaces: ['javax/microedition/media/Controllable'],
  // 静态字段键必须是「名字:描述符」，和其它类一致，否则 getstatic 解析不到
  fields: {
    'UNREALIZED:I': UNREALIZED,
    'REALIZED:I': REALIZED,
    'PREFETCHED:I': PREFETCHED,
    'STARTED:I': STARTED,
    'CLOSED:I': CLOSED,
    'TIME_UNKNOWN:J': -1n,
  },
  methods: {
    '<init>()V': (_t, [self]) => {
      self.n = { state: UNREALIZED, loopMode: LOOP_INDEFINITE, loopCount: 1, midi: null, volume: null, self } satisfies PlayerPeer;
    },
    // ---- 生命周期：realize/prefetch 不做实际预读，start 才开始发声 ----
    'realize()V': (t, [self]) => enter(t, self, REALIZED),
    'prefetch()V': (t, [self]) => enter(t, self, PREFETCHED),
    'prepare()V': (t, [self]) => enter(t, self, PREFETCHED),
    'start()V': (t, [self]) => {
      const p = peerOf(self);
      enter(t, self, STARTED);
      p.midi?.setLoopCount(p.loopCount);
      p.midi?.start();
      (p as PlayerPeer & { startedAt?: number }).startedAt = performance.now();
      notifyPlayer(t.jvm, p, 'started');
      scheduleEnd(t.jvm, p);
    },
    'stop()V': (t, [self]) => {
      const p = peerOf(self);
      const wasStarted = p.state === STARTED;
      enter(t, self, PREFETCHED);
      p.midi?.stop();
      clearEndTimer(p);
      if (wasStarted) notifyPlayer(t.jvm, p, 'stopped');
    },
    'close()V': (t, [self]) => {
      const p = peerOf(self);
      if (p.state === CLOSED) throw t.jvm.throwable('javax/microedition/media/MediaException', 'player already closed');
      p.midi?.close();
      clearEndTimer(p);
      notifyPlayer(t.jvm, p, 'closed');
      p.state = CLOSED;
      p.volume = null;
      p.self = null;
    },
    'release()V': (t, [self]) => {
      peerOf(self).midi?.close();
      peerOf(self).state = CLOSED;
    },
    'reset()V': (t, [self]) => {
      const p = peerOf(self);
      p.midi?.stop();
      p.state = UNREALIZED;
    },
    'deallocate()V': () => {},

    // ---- 状态查询 ----
    'getState()I': (_t, [self]) => peerOf(self).state,
    'getLoopMode()I': (_t, [self]) => peerOf(self).loopMode,
    'getLoopCount()I': (_t, [self]) => peerOf(self).loopCount,
    'getDuration()I': (_t, [self]) => Math.round((peerOf(self).midi?.durationMs ?? -1) * 1000),
    'getMediaType()Ljava/lang/String;': () => 'audio/midi',
    'getContentType(Ljava/lang/String;)Ljava/lang/String;': (_t, [, type]) => type,
    'getLongDuration()J': (_t, [self]) => BigInt(peerOf(self).midi?.durationMs ?? -1),
    /*
      8BitGo：MIDP 2.0 Player 规范里的几个方法上游没实现，游戏一调就 AbstractMethodError、事件线程挂掉
      （2026-11-15《仙剑奇侠传 2004》开局 4 秒后 setMediaTime）。时间单位都是微秒，未知时 -1（TIME_UNKNOWN）。
    */
    'getDuration()J': (_t, [self]) => {
      const ms = peerOf(self).midi?.durationMs;
      return ms === undefined || ms < 0 ? -1n : BigInt(Math.round(ms * 1000));
    },
    'getMediaTime()J': (_t, [self]) => {
      const p = peerOf(self) as PlayerPeer & { startedAt?: number };
      if (p.state !== STARTED || p.startedAt === undefined) return 0n;
      const elapsedMs = performance.now() - p.startedAt;
      const duration = p.midi?.durationMs ?? -1;
      return BigInt(Math.round((duration > 0 ? Math.min(elapsedMs, duration) : elapsedMs) * 1000));
    },
    'setMediaTime(J)J': (_t, [self, time]) => {
      const p = peerOf(self) as PlayerPeer & { startedAt?: number };
      const micros = Math.max(0, Number(time));
      // 游戏几乎只用 setMediaTime(0) 倒回开头：正在播就从头再播，否则下次 start 自然从头
      if (micros === 0 && p.state === STARTED && p.midi) {
        p.midi.stop();
        p.midi.start();
        p.startedAt = performance.now();
      }
      return BigInt(micros);
    },
    'getContentType()Ljava/lang/String;': () => 'audio/midi',

    // ---- 参数设置 ----
    'setLoopMode(I)V': (t, [self, mode]) => {
      const p = peerOf(self);
      p.loopMode = mode;
      p.loopCount = mode === 0 ? 1 : LOOP_INDEFINITE;
      p.midi?.setLoopCount(p.loopCount);
    },
    'setLoopCount(I)V': (t, [self, count]) => {
      const p = peerOf(self);
      p.loopCount = count;
      p.midi?.setLoopCount(count);
    },
    'setPriority(I)V': () => {},
    'setMediaLocator(Ljavax/microedition/media/MediaLocator;)V': () => {},
    'getMediaLocator()Ljavax/microedition/media/MediaLocator;': () => null,
    // ★ 描述符必须和 jar 里的常量池逐字一致，否则 invokevirtual 找不到实现 → AbstractMethodError
    'getControl(Ljava/lang/String;)Ljavax/microedition/media/Control;': (t, [self, name]) => {
      if (name !== 'VolumeControl') return null;
      const p = peerOf(self);
      if (!p.volume) p.volume = newNativeObject(t.jvm, 'j2me/VolumeControlImpl', newVolumePeer(p.midi));
      return p.volume;
    },
    'getControls()[Ljavax/microedition/media/Control;': (t, [self]) => {
      const p = peerOf(self);
      return new JArray('[Ljavax/microedition/media/Control;', p.volume ? [p.volume] : []);
    },

    // ---- 监听器：只保留注册，事件不派发 ----
    'addPlayerListener(Ljavax/microedition/media/PlayerListener;)V': (_t, [self, listener]) => {
      if (listener === null) return;
      const p = peerOf(self);
      const listeners = (p.listeners ??= []);
      if (!listeners.includes(listener)) listeners.push(listener);
    },
    'removePlayerListener(Ljavax/microedition/media/PlayerListener;)V': (_t, [self, listener]) => {
      const p = peerOf(self);
      p.listeners = (p.listeners ?? []).filter((l) => l !== listener);
    },

    // ---- 音量：真实 API 在控制器上，这里也转发一份给老代码 ----
    'setVolume(I)V': (t, [self, level]) => {
      const p = peerOf(self);
      if (level < 0 || level > 100) throw t.jvm.throwable('java/lang/IllegalArgumentException', `level ${level}`);
      p.midi?.setVolume(level / 100);
    },
    'getVolume()I': (_t, [self]) => volumePeerOf(peerOf(self)).level,

    // ---- 常见扩展方法，部分老游戏会直接调 ----
    'setDataSource(Ljava/lang/String;)V': () => {},
    'getVideoCodecInfo()Ljava/lang/String;': () => null,
    'getVideoWidth()I': () => -1,
    'getVideoHeight()I': () => -1,
  },
};

const managerClass: NativeClassDef = {
  name: 'javax/microedition/media/Manager',
  statics: {
    // ★ 注意：静态方法的实参直接就是栈上的实参，没有 receiver 占位，
    //   写成 (t, [, stream]) 会把第 2 个参数（类型字符串）当成流，
    //   然后 readAllBytes 对一个字符串读 .cls → undefined.vcache。
    // 无字节流的路径（URL / 系统音）：保持「已在播放」语义但不发声
    'createPlayer(Ljava/lang/String;)Ljavax/microedition/media/Player;': (t, [url]) => {
      if (url === null) throw t.jvm.npe('url');
      return newStartedPlayer(t.jvm);
    },
    // ★ 真播放路径：把流里的字节读出来交给 MIDI 合成器
    'createPlayer(Ljava/io/InputStream;Ljava/lang/String;)Ljavax/microedition/media/Player;': (t, [stream]) => {
      if (stream === null) throw t.jvm.npe('stream');
      return newPlayer(t.jvm, slurp(t, stream));
    },
    'createPlayer(Ljava/io/InputStream;)Ljavax/microedition/media/Player;': (t, [stream]) => {
      if (stream === null) throw t.jvm.npe('stream');
      return newPlayer(t.jvm, slurp(t, stream));
    },
    // MIDI 设备：老游戏常先问有没有 MIDI
    'getMidiSystem()Ljavax/microedition/media/spi/MidiSystem;': () => null,
    'getSupportedContentTypes(Ljava/lang/String;)[Ljava/lang/String;': () => new JArray('[Ljava/lang/String;', []),
    'getAudioInfo(Ljavax/microedition/media/AudioInfo;)V': () => {},
    'getSystemSound(Ljava/lang/String;)Ljavax/microedition/media/Player;': (t) => newStartedPlayer(t.jvm),
    'playTone(IILjava/io/InputStream;)V': () => {},
    'playTone(I)V': () => {},
    'playTone(III)V': () => {},
    'getPlyBtnOrder()I': () => 0,
    'setPlyBtnOrder(I)V': () => {},
  },
};

const toneSequence: NativeClassDef = {
  name: 'javax/microedition/media/control/ToneSequence',
  methods: {
    '<init>([B)V': () => {},
    'getSequence()[B': () => null,
  },
};

const tonePlayerClass: NativeClassDef = {
  name: 'javax/microedition/media/TonePlayer',
  methods: {
    '<init>(Ljavax/microedition/media/control/ToneSequence;)V': () => {},
    'play()V': () => {},
    'stop()V': () => {},
  },
};

const midiDevice: NativeClassDef = {
  name: 'javax/microedition/media/spi/MidiDevice',
  methods: {
    'getChannels()I': () => 0,
    'isOpen()Z': () => false,
    'open()V': () => {},
    'close()V': () => {},
  },
};

/** 读完流里的全部字节；读失败就退回静音（不让一个坏流把整个游戏带崩）。 */
function slurp(t: JThread, stream: JObject): Uint8Array | null {
  try {
    return readAllBytes(t, stream);
  } catch (err) {
    t.jvm.host.log('warn', `读取媒体流失败（静音）：${String(err)}`);
    return null;
  }
}

/** javax.microedition.io.Connection：只补 close()，够「连接用完就关」的老代码。 */
const connectionClass: NativeClassDef = {
  name: 'javax/microedition/io/Connection',
  flags: ACC_ABSTRACT | ACC_INTERFACE,
  methods: {
    'close()V': () => {},
  },
};

/** InputConnection extends Connection（MIDP 1.0 的继承方向，别搞反成循环）。 */
const inputConnectionClass: NativeClassDef = {
  name: 'javax/microedition/io/InputConnection',
  interfaces: ['javax/microedition/io/Connection'],
  flags: ACC_ABSTRACT | ACC_INTERFACE,
};

/** 8BitGo：RateControl / TempoControl 只需类存在（getControl 对它们返回 null），否则引用它们的游戏一加载就崩 */
const rateControlInterface: NativeClassDef = {
  name: 'javax/microedition/media/control/RateControl',
  interfaces: ['javax/microedition/media/Control'],
  flags: ACC_ABSTRACT | ACC_INTERFACE,
};
const tempoControlInterface: NativeClassDef = {
  name: 'javax/microedition/media/control/TempoControl',
  interfaces: ['javax/microedition/media/control/RateControl'],
  flags: ACC_ABSTRACT | ACC_INTERFACE,
};

export const mediaNatives: NativeClassDef[] = [
  rateControlInterface,
  tempoControlInterface,
  mediaException,
  playerListener,
  controlClass,
  controllableClass,
  volumeControlInterface,
  volumeControlImpl,
  inputConnectionClass,
  connectionClass,
  playerClass,
  managerClass,
  toneSequence,
  tonePlayerClass,
  midiDevice,
];
