import type { AudioClipHandle } from '../../platform/audio';
import type { Platform } from '../../platform/platform';
import type { JThread, NativeClassDef } from '../jvm';
import { checkArrayRange } from './helpers';

const platform = (t: JThread) => t.jvm.platform as Platform;

const STATUS_STOP = 0;
const STATUS_PLAY = 1;
const STATUS_PAUSE = 2;

interface ClipPeer {
  handle: AudioClipHandle;
  status: number;
}

function createClip(t: JThread, type: number, data: Uint8Array): ClipPeer {
  return { handle: platform(t).audio.createClip(type, data), status: STATUS_STOP };
}

const samsungAudioClip: NativeClassDef = {
  name: 'com/samsung/util/AudioClip',
  fields: { 'TYPE_MMF:I': 1, 'TYPE_MP3:I': 2, 'TYPE_MIDI:I': 3 },
  statics: { 'isSupported()Z': () => true },
  methods: {
    '<init>(ILjava/lang/String;)V': (t, [self, type, path]) => {
      if (path === null) throw t.jvm.npe();
      const data = platform(t).getResource(path);
      if (!data) throw t.jvm.throwable('java/io/IOException', `Audio resource not found: ${path}`);
      self.n = createClip(t, type, data);
    },
    '<init>(I[BII)V': (t, [self, type, bytes, off, len]) => {
      checkArrayRange(t.jvm, bytes, off, len);
      const d = bytes.d as Int8Array;
      self.n = createClip(t, type, new Uint8Array(d.buffer, d.byteOffset + off, len).slice());
    },
    'play(II)V': (t, [self, loops, volume]) => {
      if (loops < -1 || loops > 255) throw t.jvm.throwable('java/lang/IllegalArgumentException', `loop ${loops}`);
      if (volume < 0 || volume > 5) throw t.jvm.throwable('java/lang/IllegalArgumentException', `volume ${volume}`);
      const p = self.n as ClipPeer;
      p.handle.play(loops, volume);
      p.status = STATUS_PLAY;
    },
    'pause()V': (_t, [self]) => {
      const p = self.n as ClipPeer;
      p.handle.pause();
      p.status = STATUS_PAUSE;
    },
    'resume()V': (_t, [self]) => {
      const p = self.n as ClipPeer;
      p.handle.resume();
      p.status = STATUS_PLAY;
    },
    'stop()V': (_t, [self]) => {
      const p = self.n as ClipPeer;
      p.handle.stop();
      p.status = STATUS_STOP;
    },
    'getStatus()I': (_t, [self]) => (self.n as ClipPeer).status,
  },
};

const samsungVibration: NativeClassDef = {
  name: 'com/samsung/util/Vibration',
  statics: {
    'start(II)V': (t, [duration]) => platform(t).config.vibrate(Math.min(2000, Math.max(0, duration) * 1000)),
    'stop()V': (t) => platform(t).config.vibrate(0),
    'isSupported()Z': () => true,
  },
};

const samsungLight: NativeClassDef = {
  name: 'com/samsung/util/LCDLight',
  statics: {
    'on(I)V': () => {},
    'off()V': () => {},
    'isSupported()Z': () => false,
  },
};

export const vendorNatives: NativeClassDef[] = [samsungAudioClip, samsungVibration, samsungLight];
