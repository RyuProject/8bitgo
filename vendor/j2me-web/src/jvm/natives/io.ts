import { ACC_ABSTRACT } from '../classfile';
import type { JThread, Jvm, NativeClassDef } from '../jvm';
import { JArray, JObject, type NativeImpl } from '../types';
import { checkArrayRange, decodeBytes, floatToString, newNativeObject } from './helpers';

interface BaisPeer {
  buf: Int8Array;
  pos: number;
  count: number;
  mark: number;
}

export function newByteArrayInputStream(jvm: Jvm, data: Uint8Array | Int8Array): JObject {
  const buf = new Int8Array(data.buffer, data.byteOffset, data.byteLength);
  return newNativeObject(jvm, 'java/io/ByteArrayInputStream', { buf, pos: 0, count: buf.length, mark: 0 } satisfies BaisPeer);
}

function eof(jvm: Jvm) {
  return jvm.throwable('java/io/EOFException');
}

/** Calls stream.read() (fast path for native streams). */
function readByte(t: JThread, stream: JObject | null): number {
  const jvm = t.jvm;
  if (stream === null) throw jvm.throwable('java/io/IOException', 'stream closed');
  const m = jvm.findVirtual(stream.cls, 'read()I');
  if (!m) throw jvm.throwable('java/lang/AbstractMethodError', 'read()I');
  return m.impl ? (m.impl(t, [stream]) as number) : (jvm.invokeSync(t, m, [stream]) as number);
}

function readInto(t: JThread, stream: JObject, b: JArray, off: number, len: number): number {
  return t.jvm.callVirtualSync(t, stream, 'read([BII)I', [b, off, len]) as number;
}

/** Reads all remaining bytes of a stream. */
export function readAllBytes(t: JThread, stream: JObject): Uint8Array {
  const peer = stream.n as BaisPeer | null;
  if (peer && peer.buf instanceof Int8Array && stream.cls.name === 'java/io/ByteArrayInputStream') {
    const out = new Uint8Array(peer.buf.buffer, peer.buf.byteOffset + peer.pos, Math.max(0, peer.count - peer.pos)).slice();
    peer.pos = peer.count;
    return out;
  }
  const chunks: number[] = [];
  const buffer = new JArray('[B', new Int8Array(4096));
  for (;;) {
    const n = readInto(t, stream, buffer, 0, 4096);
    if (n < 0) break;
    for (let i = 0; i < n; i++) chunks.push((buffer.d as Int8Array)[i] & 0xff);
  }
  return Uint8Array.from(chunks);
}

function writeByte(t: JThread, stream: JObject | null, b: number): void {
  const jvm = t.jvm;
  if (stream === null) throw jvm.throwable('java/io/IOException', 'stream closed');
  const m = jvm.findVirtual(stream.cls, 'write(I)V');
  if (!m) throw jvm.throwable('java/lang/AbstractMethodError', 'write(I)V');
  if (m.impl) m.impl(t, [stream, b]);
  else jvm.invokeSync(t, m, [stream, b]);
}

const inputStream: NativeClassDef = {
  name: 'java/io/InputStream',
  flags: ACC_ABSTRACT,
  methods: {
    '<init>()V': () => {},
    'read([B)I': (t, [self, b]) => {
      if (b === null) throw t.jvm.npe();
      return readInto(t, self, b, 0, b.d.length);
    },
    'read([BII)I': (t, [self, b, off, len]) => {
      checkArrayRange(t.jvm, b, off, len);
      if (len === 0) return 0;
      const first = readByte(t, self);
      if (first < 0) return -1;
      const d = b.d as Int8Array;
      d[off] = first;
      let n = 1;
      while (n < len) {
        const c = readByte(t, self);
        if (c < 0) break;
        d[off + n++] = c;
      }
      return n;
    },
    'skip(J)J': (t, [self, count]) => {
      let skipped = 0n;
      while (skipped < count && readByte(t, self) >= 0) skipped++;
      return skipped;
    },
    'available()I': () => 0,
    'close()V': () => {},
    'mark(I)V': () => {},
    'reset()V': (t) => {
      throw t.jvm.throwable('java/io/IOException', 'mark/reset not supported');
    },
    'markSupported()Z': () => false,
  },
};

const bais = (self: JObject) => self.n as BaisPeer;

const byteArrayInputStream: NativeClassDef = {
  name: 'java/io/ByteArrayInputStream',
  super: 'java/io/InputStream',
  methods: {
    '<init>([B)V': (t, [self, buf]) => {
      if (buf === null) throw t.jvm.npe();
      self.n = { buf: buf.d, pos: 0, count: buf.d.length, mark: 0 } satisfies BaisPeer;
    },
    '<init>([BII)V': (t, [self, buf, off, len]) => {
      if (buf === null) throw t.jvm.npe();
      self.n = { buf: buf.d, pos: off, count: Math.min(off + len, buf.d.length), mark: off } satisfies BaisPeer;
    },
    'read()I': (_t, [self]) => {
      const s = bais(self);
      return s.pos < s.count ? s.buf[s.pos++] & 0xff : -1;
    },
    'read([BII)I': (t, [self, b, off, len]) => {
      checkArrayRange(t.jvm, b, off, len);
      const s = bais(self);
      if (s.pos >= s.count) return -1;
      const n = Math.min(len, s.count - s.pos);
      if (n <= 0) return 0;
      (b.d as Int8Array).set(s.buf.subarray(s.pos, s.pos + n), off);
      s.pos += n;
      return n;
    },
    'skip(J)J': (_t, [self, count]) => {
      const s = bais(self);
      const n = Math.max(0, Math.min(Number(count), s.count - s.pos));
      s.pos += n;
      return BigInt(n);
    },
    'available()I': (_t, [self]) => bais(self).count - bais(self).pos,
    'mark(I)V': (_t, [self]) => {
      bais(self).mark = bais(self).pos;
    },
    'reset()V': (_t, [self]) => {
      bais(self).pos = bais(self).mark;
    },
    'markSupported()Z': () => true,
    'close()V': () => {},
  },
};

const dis = (self: JObject) => (self.n as { in: JObject }).in;

function readN(t: JThread, self: JObject, n: number): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const b = readByte(t, dis(self));
    if (b < 0) throw eof(t.jvm);
    out[i] = b;
  }
  return out;
}

function readFully(t: JThread, self: JObject, b: JArray, off: number, len: number): void {
  checkArrayRange(t.jvm, b, off, len);
  let n = 0;
  while (n < len) {
    const r = readInto(t, dis(self), b, off + n, len - n);
    if (r < 0) throw eof(t.jvm);
    n += r;
  }
}

function decodeUtf(t: JThread, bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const a = bytes[i++];
    if (a < 0x80) out += String.fromCharCode(a);
    else if ((a & 0xe0) === 0xc0) out += String.fromCharCode(((a & 0x1f) << 6) | (bytes[i++] & 0x3f));
    else if ((a & 0xf0) === 0xe0) out += String.fromCharCode(((a & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    else throw t.jvm.throwable('java/io/UTFDataFormatException');
  }
  return out;
}

const dataInputStream: NativeClassDef = {
  name: 'java/io/DataInputStream',
  super: 'java/io/InputStream',
  methods: {
    '<init>(Ljava/io/InputStream;)V': (_t, [self, input]) => {
      self.n = { in: input };
    },
    'read()I': (t, [self]) => readByte(t, dis(self)),
    'read([B)I': (t, [self, b]) => {
      if (b === null) throw t.jvm.npe();
      return readInto(t, dis(self), b, 0, b.d.length);
    },
    'read([BII)I': (t, [self, b, off, len]) => readInto(t, dis(self), b, off, len),
    'readFully([B)V': (t, [self, b]) => {
      if (b === null) throw t.jvm.npe();
      readFully(t, self, b, 0, b.d.length);
    },
    'readFully([BII)V': (t, [self, b, off, len]) => readFully(t, self, b, off, len),
    'readBoolean()Z': (t, [self]) => readN(t, self, 1)[0] !== 0,
    'readByte()B': (t, [self]) => (readN(t, self, 1)[0] << 24) >> 24,
    'readUnsignedByte()I': (t, [self]) => readN(t, self, 1)[0],
    'readShort()S': (t, [self]) => {
      const [a, b] = readN(t, self, 2);
      return (((a << 8) | b) << 16) >> 16;
    },
    'readUnsignedShort()I': (t, [self]) => {
      const [a, b] = readN(t, self, 2);
      return (a << 8) | b;
    },
    'readChar()C': (t, [self]) => {
      const [a, b] = readN(t, self, 2);
      return (a << 8) | b;
    },
    'readInt()I': (t, [self]) => {
      const [a, b, c, d] = readN(t, self, 4);
      return (a << 24) | (b << 16) | (c << 8) | d;
    },
    'readLong()J': (t, [self]) => {
      const bytes = readN(t, self, 8);
      let v = 0n;
      for (const b of bytes) v = (v << 8n) | BigInt(b);
      return BigInt.asIntN(64, v);
    },
    'readFloat()F': (t, [self]) => new DataView(Uint8Array.from(readN(t, self, 4)).buffer).getFloat32(0),
    'readDouble()D': (t, [self]) => new DataView(Uint8Array.from(readN(t, self, 8)).buffer).getFloat64(0),
    'readUTF()Ljava/lang/String;': (t, [self]) => {
      const [a, b] = readN(t, self, 2);
      return decodeUtf(t, readN(t, self, (a << 8) | b));
    },
    'skipBytes(I)I': (t, [self, n]) => {
      let i = 0;
      while (i < n && readByte(t, dis(self)) >= 0) i++;
      return i;
    },
    'available()I': (t, [self]) => t.jvm.callVirtualSync(t, dis(self), 'available()I'),
    'close()V': (t, [self]) => {
      t.jvm.callVirtualSync(t, dis(self), 'close()V');
    },
  },
};

const outputStream: NativeClassDef = {
  name: 'java/io/OutputStream',
  flags: ACC_ABSTRACT,
  methods: {
    '<init>()V': () => {},
    'write([B)V': (t, [self, b]) => {
      if (b === null) throw t.jvm.npe();
      t.jvm.callVirtualSync(t, self, 'write([BII)V', [b, 0, b.d.length]);
    },
    'write([BII)V': (t, [self, b, off, len]) => {
      checkArrayRange(t.jvm, b, off, len);
      const d = b.d as Int8Array;
      for (let i = 0; i < len; i++) writeByte(t, self, d[off + i]);
    },
    'flush()V': () => {},
    'close()V': () => {},
  },
};

interface BaosPeer {
  buf: Uint8Array;
  count: number;
}

function ensure(peer: BaosPeer, extra: number) {
  if (peer.count + extra <= peer.buf.length) return;
  const next = new Uint8Array(Math.max(peer.buf.length * 2, peer.count + extra));
  next.set(peer.buf.subarray(0, peer.count));
  peer.buf = next;
}

const baos = (self: JObject) => self.n as BaosPeer;
const baosInit: NativeImpl = (_t, [self]) => {
  self.n = { buf: new Uint8Array(64), count: 0 } satisfies BaosPeer;
};

const byteArrayOutputStream: NativeClassDef = {
  name: 'java/io/ByteArrayOutputStream',
  super: 'java/io/OutputStream',
  methods: {
    '<init>()V': baosInit,
    '<init>(I)V': baosInit,
    'write(I)V': (_t, [self, b]) => {
      const p = baos(self);
      ensure(p, 1);
      p.buf[p.count++] = b;
    },
    'write([BII)V': (t, [self, b, off, len]) => {
      checkArrayRange(t.jvm, b, off, len);
      const p = baos(self);
      ensure(p, len);
      const src = b.d as Int8Array;
      p.buf.set(new Uint8Array(src.buffer, src.byteOffset + off, len), p.count);
      p.count += len;
    },
    'toByteArray()[B': (_t, [self]) => {
      const p = baos(self);
      return new JArray('[B', new Int8Array(p.buf.slice(0, p.count).buffer));
    },
    'size()I': (_t, [self]) => baos(self).count,
    'reset()V': (_t, [self]) => {
      baos(self).count = 0;
    },
    'toString()Ljava/lang/String;': (_t, [self]) => decodeBytes(baos(self).buf.subarray(0, baos(self).count), 'ISO-8859-1'),
    'close()V': () => {},
    'flush()V': () => {},
  },
};

const dos = (self: JObject) => self.n as { out: JObject; written: number };

function writeBytes(t: JThread, self: JObject, bytes: number[]) {
  for (const b of bytes) writeByte(t, dos(self).out, b);
  dos(self).written += bytes.length;
}

const dataOutputStream: NativeClassDef = {
  name: 'java/io/DataOutputStream',
  super: 'java/io/OutputStream',
  methods: {
    '<init>(Ljava/io/OutputStream;)V': (_t, [self, out]) => {
      self.n = { out, written: 0 };
    },
    'write(I)V': (t, [self, b]) => writeBytes(t, self, [b & 0xff]),
    'write([BII)V': (t, [self, b, off, len]) => {
      t.jvm.callVirtualSync(t, dos(self).out, 'write([BII)V', [b, off, len]);
      dos(self).written += len;
    },
    'writeBoolean(Z)V': (t, [self, v]) => writeBytes(t, self, [v ? 1 : 0]),
    'writeByte(I)V': (t, [self, v]) => writeBytes(t, self, [v & 0xff]),
    'writeShort(I)V': (t, [self, v]) => writeBytes(t, self, [(v >> 8) & 0xff, v & 0xff]),
    'writeChar(I)V': (t, [self, v]) => writeBytes(t, self, [(v >> 8) & 0xff, v & 0xff]),
    'writeInt(I)V': (t, [self, v]) => writeBytes(t, self, [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]),
    'writeLong(J)V': (t, [self, v]) => {
      const bytes: number[] = [];
      for (let i = 7; i >= 0; i--) bytes.push(Number((BigInt.asUintN(64, v) >> BigInt(i * 8)) & 0xffn));
      writeBytes(t, self, bytes);
    },
    'writeFloat(F)V': (t, [self, v]) => {
      const view = new DataView(new ArrayBuffer(4));
      view.setFloat32(0, v);
      writeBytes(t, self, [...new Uint8Array(view.buffer)]);
    },
    'writeDouble(D)V': (t, [self, v]) => {
      const view = new DataView(new ArrayBuffer(8));
      view.setFloat64(0, v);
      writeBytes(t, self, [...new Uint8Array(view.buffer)]);
    },
    'writeChars(Ljava/lang/String;)V': (t, [self, s]) => {
      const bytes: number[] = [];
      for (let i = 0; i < s.length; i++) bytes.push((s.charCodeAt(i) >> 8) & 0xff, s.charCodeAt(i) & 0xff);
      writeBytes(t, self, bytes);
    },
    'writeUTF(Ljava/lang/String;)V': (t, [self, s]) => {
      if (s === null) throw t.jvm.npe();
      const body: number[] = [];
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 1 && c <= 0x7f) body.push(c);
        else if (c <= 0x7ff) body.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        else body.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
      if (body.length > 65535) throw t.jvm.throwable('java/io/UTFDataFormatException');
      writeBytes(t, self, [(body.length >> 8) & 0xff, body.length & 0xff, ...body]);
    },
    'size()I': (_t, [self]) => dos(self).written,
    'flush()V': (t, [self]) => {
      t.jvm.callVirtualSync(t, dos(self).out, 'flush()V');
    },
    'close()V': (t, [self]) => {
      t.jvm.callVirtualSync(t, dos(self).out, 'close()V');
    },
  },
};

function printer(fn: (t: JThread, v: any) => string, newline: boolean): NativeImpl {
  return (t, [self, v]) => {
    const peer = self.n as { err: boolean; line: string };
    peer.line += fn(t, v);
    if (newline) {
      t.jvm.host.log(peer.err ? 'warn' : 'info', peer.line);
      peer.line = '';
    }
  };
}

const printKinds: Array<[string, (t: JThread, v: any) => string]> = [
  ['Ljava/lang/String;', (_t, v) => (v === null ? 'null' : v)],
  ['Ljava/lang/Object;', (t, v) => t.jvm.stringValueOf(t, v)],
  ['I', (_t, v) => String(v)],
  ['J', (_t, v) => String(v)],
  ['C', (_t, v) => String.fromCharCode(v)],
  ['Z', (_t, v) => (v ? 'true' : 'false')],
  ['F', (_t, v) => floatToString(v, true)],
  ['D', (_t, v) => floatToString(v, false)],
  ['[C', (_t, v) => String.fromCharCode(...(v.d as Uint16Array))],
];

const printStream: NativeClassDef = {
  name: 'java/io/PrintStream',
  super: 'java/io/OutputStream',
  methods: {
    'println()V': printer(() => '', true),
    ...Object.fromEntries(printKinds.flatMap(([d, fn]) => [
      [`print(${d})V`, printer(fn, false)],
      [`println(${d})V`, printer(fn, true)],
    ])),
    'write(I)V': printer((_t, v) => String.fromCharCode(v & 0xff), false),
    'flush()V': () => {},
    'close()V': () => {},
  },
};

interface ReaderPeer {
  stream: JObject;
  encoding: string;
  text: string | null;
  pos: number;
}

function readerText(t: JThread, self: JObject): ReaderPeer {
  const p = self.n as ReaderPeer;
  if (p.text === null) {
    p.text = decodeBytes(readAllBytes(t, p.stream), p.encoding);
    p.pos = 0;
  }
  return p;
}

const reader: NativeClassDef = {
  name: 'java/io/Reader',
  flags: ACC_ABSTRACT,
  methods: {
    '<init>()V': () => {},
    'read([C)I': (t, [self, cbuf]) => t.jvm.callVirtualSync(t, self, 'read([CII)I', [cbuf, 0, cbuf.d.length]),
    'close()V': () => {},
  },
};

const inputStreamReader: NativeClassDef = {
  name: 'java/io/InputStreamReader',
  super: 'java/io/Reader',
  methods: {
    '<init>(Ljava/io/InputStream;)V': (t, [self, stream]) => {
      if (stream === null) throw t.jvm.npe();
      self.n = { stream, encoding: 'ISO-8859-1', text: null, pos: 0 } satisfies ReaderPeer;
    },
    '<init>(Ljava/io/InputStream;Ljava/lang/String;)V': (t, [self, stream, enc]) => {
      if (stream === null) throw t.jvm.npe();
      self.n = { stream, encoding: enc ?? 'ISO-8859-1', text: null, pos: 0 } satisfies ReaderPeer;
    },
    'read()I': (t, [self]) => {
      const p = readerText(t, self);
      return p.pos < p.text!.length ? p.text!.charCodeAt(p.pos++) : -1;
    },
    'read([CII)I': (t, [self, cbuf, off, len]) => {
      checkArrayRange(t.jvm, cbuf, off, len);
      const p = readerText(t, self);
      if (p.pos >= p.text!.length) return -1;
      const n = Math.min(len, p.text!.length - p.pos);
      for (let i = 0; i < n; i++) (cbuf.d as Uint16Array)[off + i] = p.text!.charCodeAt(p.pos + i);
      p.pos += n;
      return n;
    },
    'ready()Z': (t, [self]) => {
      const p = readerText(t, self);
      return p.pos < p.text!.length;
    },
    'close()V': () => {},
  },
};

export const ioNatives: NativeClassDef[] = [
  inputStream,
  byteArrayInputStream,
  dataInputStream,
  outputStream,
  byteArrayOutputStream,
  dataOutputStream,
  printStream,
  reader,
  inputStreamReader,
];
