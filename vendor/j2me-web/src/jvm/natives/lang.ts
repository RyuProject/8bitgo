import { ACC_ABSTRACT, ACC_INTERFACE } from '../classfile';
import { javaName } from '../descriptor';
import type { JThread, Jvm, NativeClassDef, RuntimeClass } from '../jvm';
import { DEAD, SLEEPING, WAITING } from '../thread';
import { BLOCK, INVOKED, JArray, JObject, type JRef, type NativeImpl } from '../types';
import {
  INT_MAX,
  INT_MIN,
  charsToString,
  checkArrayRange,
  decodeBytes,
  encodeString,
  floatToString,
  isSupportedEncoding,
  javaEquals,
  newNativeObject,
  stringHash,
  stringToChars,
} from './helpers';
import { newByteArrayInputStream } from './io';

const DEFAULT_ENCODING = 'ISO-8859-1';

function sioobe(jvm: Jvm, msg: string) {
  return jvm.throwable('java/lang/StringIndexOutOfBoundsException', msg);
}

// ---------------------------------------------------------------------------------------------------
// Object / monitors

function waitOn(t: JThread, target: JRef, ms: number): typeof BLOCK {
  const jvm = t.jvm;
  const m = jvm.monitorOf(target);
  if (m.owner !== t) throw jvm.throwable('java/lang/IllegalMonitorStateException');
  if (ms < 0) throw jvm.throwable('java/lang/IllegalArgumentException', 'timeout value is negative');
  t.reacquire = m.count;
  m.owner = null;
  m.count = 0;
  m.waitSet.push(t);
  t.waitingOn = m;
  t.notified = false;
  t.condition = null;
  t.state = WAITING;
  t.wakeAt = ms > 0 ? performance.now() + ms : 0;
  jvm.wake();
  return BLOCK;
}

function notifyOn(t: JThread, target: JRef, all: boolean) {
  const jvm = t.jvm;
  const m = jvm.monitorOf(target);
  if (m.owner !== t) throw jvm.throwable('java/lang/IllegalMonitorStateException');
  const woken = all ? m.waitSet.splice(0) : m.waitSet.splice(0, 1);
  for (const w of woken) w.notified = true;
  if (woken.length) jvm.wake();
}

/** Runs <clinit> for `cls` (and superclasses) synchronously; used by reflection-style natives. */
export function initClassSync(t: JThread, cls: RuntimeClass): void {
  if (cls.initState !== 0) return;
  if (cls.superClass) initClassSync(t, cls.superClass);
  cls.initState = 1;
  cls.initThread = t;
  try {
    const clinit = cls.methods.get('<clinit>()V');
    if (clinit?.code) t.jvm.invokeSync(t, clinit, []);
  } finally {
    cls.initState = 2;
    cls.initThread = null;
  }
}

const objectClass: NativeClassDef = {
  name: 'java/lang/Object',
  super: null,
  methods: {
    '<init>()V': () => {},
    'getClass()Ljava/lang/Class;': (t, [self]) => t.jvm.classObject(t.jvm.classOf(self)),
    'hashCode()I': (t, [self]) => (typeof self === 'string' ? stringHash(self) : t.jvm.identityHash(self)),
    'equals(Ljava/lang/Object;)Z': (_t, [self, other]) => self === other,
    'toString()Ljava/lang/String;': (t, [self]) =>
      `${javaName(t.jvm.classOf(self).name)}@${(typeof self === 'string' ? stringHash(self) >>> 0 : t.jvm.identityHash(self)).toString(16)}`,
    'notify()V': (t, [self]) => notifyOn(t, self, false),
    'notifyAll()V': (t, [self]) => notifyOn(t, self, true),
    'wait()V': (t, [self]) => waitOn(t, self, 0),
    'wait(J)V': (t, [self, ms]) => waitOn(t, self, Number(ms)),
    'wait(JI)V': (t, [self, ms]) => waitOn(t, self, Number(ms)),
  },
};

// ---------------------------------------------------------------------------------------------------
// Class

function openResource(t: JThread, cls: RuntimeClass, name: string | null): JObject | null {
  const jvm = t.jvm;
  if (name === null) throw jvm.npe();
  let path = name;
  if (path.startsWith('/')) path = path.slice(1);
  else {
    const slash = cls.name.lastIndexOf('/');
    if (slash >= 0) path = cls.name.slice(0, slash + 1) + path;
  }
  const data = jvm.platform?.getResource(path) ?? null;
  return data ? newByteArrayInputStream(jvm, data) : null;
}

const classClass: NativeClassDef = {
  name: 'java/lang/Class',
  methods: {
    'getName()Ljava/lang/String;': (_t, [self]) => javaName((self.n as RuntimeClass).name),
    'toString()Ljava/lang/String;': (_t, [self]) => {
      const c = self.n as RuntimeClass;
      return `${c.isInterface ? 'interface' : 'class'} ${javaName(c.name)}`;
    },
    'getResourceAsStream(Ljava/lang/String;)Ljava/io/InputStream;': (t, [self, name]) => openResource(t, self.n, name),
    'isInstance(Ljava/lang/Object;)Z': (t, [self, obj]) => t.jvm.isInstance(obj, (self.n as RuntimeClass).name),
    'isAssignableFrom(Ljava/lang/Class;)Z': (t, [self, other]) => {
      if (other === null) throw t.jvm.npe();
      return t.jvm.isSubclass(other.n, self.n);
    },
    'isArray()Z': (_t, [self]) => (self.n as RuntimeClass).name[0] === '[',
    'isInterface()Z': (_t, [self]) => (self.n as RuntimeClass).isInterface,
    'newInstance()Ljava/lang/Object;': (t, [self]) => {
      const jvm = t.jvm;
      const cls = self.n as RuntimeClass;
      if (cls.flags & (ACC_ABSTRACT | ACC_INTERFACE) || cls.name[0] === '[') {
        throw jvm.throwable('java/lang/InstantiationException', javaName(cls.name));
      }
      const init = cls.methods.get('<init>()V');
      if (!init) throw jvm.throwable('java/lang/InstantiationException', javaName(cls.name));
      initClassSync(t, cls);
      const obj = new JObject(cls);
      jvm.invokeSync(t, init, [obj]);
      return obj;
    },
  },
  statics: {
    'forName(Ljava/lang/String;)Ljava/lang/Class;': (t, [name]) => {
      const jvm = t.jvm;
      if (name === null) throw jvm.npe();
      const internal = (name as string).replace(/\./g, '/');
      if (!jvm.hasClass(internal)) throw jvm.throwable('java/lang/ClassNotFoundException', name);
      const cls = jvm.loadClass(internal);
      initClassSync(t, cls);
      return jvm.classObject(cls);
    },
  },
};

// ---------------------------------------------------------------------------------------------------
// String

/** Implements the java.lang.String constructors (strings are immutable JS values). */
export function constructString(t: JThread, desc: string, args: any[]): string {
  const jvm = t.jvm;
  switch (desc) {
    case '()V':
      return '';
    case '(Ljava/lang/String;)V':
      if (args[0] === null) throw jvm.npe();
      return args[0];
    case '([C)V':
      if (args[0] === null) throw jvm.npe();
      return charsToString(args[0]);
    case '([CII)V':
      checkArrayRange(jvm, args[0], args[1], args[2]);
      return charsToString(args[0], args[1], args[2]);
    case '([B)V':
      if (args[0] === null) throw jvm.npe();
      return decodeBytes(args[0].d, DEFAULT_ENCODING);
    case '([BII)V':
      checkArrayRange(jvm, args[0], args[1], args[2]);
      return decodeBytes((args[0].d as Int8Array).subarray(args[1], args[1] + args[2]), DEFAULT_ENCODING);
    case '([BLjava/lang/String;)V':
    case '([BIILjava/lang/String;)V': {
      const arr = args[0] as JArray;
      const enc = args[args.length - 1] as string;
      if (arr === null || enc === null) throw jvm.npe();
      if (!isSupportedEncoding(enc)) throw jvm.throwable('java/io/UnsupportedEncodingException', enc);
      const bytes = args.length === 4 ? (checkArrayRange(jvm, arr, args[1], args[2]).d as Int8Array).subarray(args[1], args[1] + args[2]) : (arr.d as Int8Array);
      return decodeBytes(bytes, enc);
    }
    case '(Ljava/lang/StringBuffer;)V':
    case '(Ljava/lang/StringBuilder;)V':
      if (args[0] === null) throw jvm.npe();
      return args[0].n.s;
    default:
      throw jvm.throwable('java/lang/NoSuchMethodError', `java.lang.String.<init>${desc}`);
  }
}

function compareStrings(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

function javaTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 32) start++;
  while (end > start && s.charCodeAt(end - 1) <= 32) end--;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}

const stringClass: NativeClassDef = {
  name: 'java/lang/String',
  methods: {
    'length()I': (_t, [s]) => s.length,
    'charAt(I)C': (t, [s, i]) => {
      if (i < 0 || i >= s.length) throw sioobe(t.jvm, String(i));
      return s.charCodeAt(i);
    },
    'equals(Ljava/lang/Object;)Z': (_t, [s, o]) => s === o,
    'equalsIgnoreCase(Ljava/lang/String;)Z': (_t, [s, o]) => o !== null && s.length === o.length && s.toUpperCase() === o.toUpperCase(),
    'hashCode()I': (_t, [s]) => stringHash(s),
    'toString()Ljava/lang/String;': (_t, [s]) => s,
    'intern()Ljava/lang/String;': (_t, [s]) => s,
    'compareTo(Ljava/lang/String;)I': (t, [s, o]) => {
      if (o === null) throw t.jvm.npe();
      return compareStrings(s, o);
    },
    'compareTo(Ljava/lang/Object;)I': (t, [s, o]) => {
      if (o === null) throw t.jvm.npe();
      if (typeof o !== 'string') throw t.jvm.throwable('java/lang/ClassCastException');
      return compareStrings(s, o);
    },
    'indexOf(I)I': (_t, [s, ch]) => s.indexOf(String.fromCharCode(ch)),
    'indexOf(II)I': (_t, [s, ch, from]) => s.indexOf(String.fromCharCode(ch), Math.max(0, from)),
    'indexOf(Ljava/lang/String;)I': (t, [s, sub]) => {
      if (sub === null) throw t.jvm.npe();
      return s.indexOf(sub);
    },
    'indexOf(Ljava/lang/String;I)I': (t, [s, sub, from]) => {
      if (sub === null) throw t.jvm.npe();
      return s.indexOf(sub, Math.max(0, from));
    },
    'lastIndexOf(I)I': (_t, [s, ch]) => s.lastIndexOf(String.fromCharCode(ch)),
    'lastIndexOf(II)I': (_t, [s, ch, from]) => (from < 0 ? -1 : s.lastIndexOf(String.fromCharCode(ch), from)),
    'lastIndexOf(Ljava/lang/String;)I': (t, [s, sub]) => {
      if (sub === null) throw t.jvm.npe();
      return s.lastIndexOf(sub);
    },
    'lastIndexOf(Ljava/lang/String;I)I': (t, [s, sub, from]) => {
      if (sub === null) throw t.jvm.npe();
      return from < 0 ? -1 : s.lastIndexOf(sub, from);
    },
    'substring(I)Ljava/lang/String;': (t, [s, b]) => {
      if (b < 0 || b > s.length) throw sioobe(t.jvm, String(b));
      return s.substring(b);
    },
    'substring(II)Ljava/lang/String;': (t, [s, b, e]) => {
      if (b < 0 || e > s.length || b > e) throw sioobe(t.jvm, `${b}..${e}`);
      return s.substring(b, e);
    },
    'toCharArray()[C': (_t, [s]) => stringToChars(s),
    'getChars(II[CI)V': (t, [s, begin, end, dst, dstBegin]) => {
      const jvm = t.jvm;
      if (begin < 0 || end > s.length || begin > end) throw sioobe(jvm, `${begin}..${end}`);
      checkArrayRange(jvm, dst, dstBegin, end - begin);
      const d = dst.d as Uint16Array;
      for (let i = begin; i < end; i++) d[dstBegin + i - begin] = s.charCodeAt(i);
    },
    'getBytes()[B': (_t, [s]) => new JArray('[B', encodeString(s, DEFAULT_ENCODING)),
    'getBytes(Ljava/lang/String;)[B': (t, [s, enc]) => {
      if (enc === null) throw t.jvm.npe();
      if (!isSupportedEncoding(enc)) throw t.jvm.throwable('java/io/UnsupportedEncodingException', enc);
      return new JArray('[B', encodeString(s, enc));
    },
    'startsWith(Ljava/lang/String;)Z': (t, [s, p]) => {
      if (p === null) throw t.jvm.npe();
      return s.startsWith(p);
    },
    'startsWith(Ljava/lang/String;I)Z': (t, [s, p, off]) => {
      if (p === null) throw t.jvm.npe();
      return off >= 0 && s.startsWith(p, off);
    },
    'endsWith(Ljava/lang/String;)Z': (t, [s, p]) => {
      if (p === null) throw t.jvm.npe();
      return s.endsWith(p);
    },
    'trim()Ljava/lang/String;': (_t, [s]) => javaTrim(s),
    'toLowerCase()Ljava/lang/String;': (_t, [s]) => s.toLowerCase(),
    'toUpperCase()Ljava/lang/String;': (_t, [s]) => s.toUpperCase(),
    'replace(CC)Ljava/lang/String;': (_t, [s, a, b]) => s.split(String.fromCharCode(a)).join(String.fromCharCode(b)),
    'concat(Ljava/lang/String;)Ljava/lang/String;': (t, [s, o]) => {
      if (o === null) throw t.jvm.npe();
      return s + o;
    },
    'regionMatches(ZILjava/lang/String;II)Z': (t, [s, ignoreCase, off, other, ooff, len]) => {
      if (other === null) throw t.jvm.npe();
      if (off < 0 || ooff < 0 || off + len > s.length || ooff + len > other.length) return false;
      const a = s.substr(off, len);
      const b = other.substr(ooff, len);
      return ignoreCase ? a.toUpperCase() === b.toUpperCase() : a === b;
    },
    'regionMatches(ILjava/lang/String;II)Z': (t, [s, off, other, ooff, len]) => {
      if (other === null) throw t.jvm.npe();
      return off >= 0 && ooff >= 0 && off + len <= s.length && ooff + len <= other.length && s.substr(off, len) === other.substr(ooff, len);
    },
  },
  statics: {
    'valueOf(I)Ljava/lang/String;': (_t, [v]) => String(v),
    'valueOf(J)Ljava/lang/String;': (_t, [v]) => String(v),
    'valueOf(C)Ljava/lang/String;': (_t, [v]) => String.fromCharCode(v),
    'valueOf(Z)Ljava/lang/String;': (_t, [v]) => (v ? 'true' : 'false'),
    'valueOf(F)Ljava/lang/String;': (_t, [v]) => floatToString(v, true),
    'valueOf(D)Ljava/lang/String;': (_t, [v]) => floatToString(v, false),
    'valueOf(Ljava/lang/Object;)Ljava/lang/String;': (t, [v]) => t.jvm.stringValueOf(t, v),
    'valueOf([C)Ljava/lang/String;': (t, [a]) => {
      if (a === null) throw t.jvm.npe();
      return charsToString(a);
    },
    'valueOf([CII)Ljava/lang/String;': (t, [a, off, count]) => charsToString(checkArrayRange(t.jvm, a, off, count), off, count),
    'copyValueOf([C)Ljava/lang/String;': (t, [a]) => {
      if (a === null) throw t.jvm.npe();
      return charsToString(a);
    },
    'copyValueOf([CII)Ljava/lang/String;': (t, [a, off, count]) => charsToString(checkArrayRange(t.jvm, a, off, count), off, count),
  },
};

// ---------------------------------------------------------------------------------------------------
// StringBuffer / StringBuilder

function stringBufferClass(name: string): NativeClassDef {
  const T = `L${name};`;
  const sb = (self: JObject) => self.n as { s: string };
  const append = (fn: (t: JThread, v: any) => string): NativeImpl => (t, [self, v]) => {
    sb(self).s += fn(t, v);
    return self;
  };
  const insert = (fn: (t: JThread, v: any) => string): NativeImpl => (t, [self, at, v]) => {
    const state = sb(self);
    if (at < 0 || at > state.s.length) throw sioobe(t.jvm, String(at));
    state.s = state.s.slice(0, at) + fn(t, v) + state.s.slice(at);
    return self;
  };
  const init: NativeImpl = (_t, [self]) => {
    self.n = { s: '' };
  };

  return {
    name,
    methods: {
      '<init>()V': init,
      '<init>(I)V': (t, [self, cap]) => {
        if (cap < 0) throw t.jvm.throwable('java/lang/NegativeArraySizeException');
        self.n = { s: '' };
      },
      '<init>(Ljava/lang/String;)V': (t, [self, s]) => {
        if (s === null) throw t.jvm.npe();
        self.n = { s };
      },
      [`append(Ljava/lang/String;)${T}`]: append((_t, v) => (v === null ? 'null' : v)),
      [`append(Ljava/lang/Object;)${T}`]: append((t, v) => t.jvm.stringValueOf(t, v)),
      [`append(I)${T}`]: append((_t, v) => String(v)),
      [`append(J)${T}`]: append((_t, v) => String(v)),
      [`append(C)${T}`]: append((_t, v) => String.fromCharCode(v)),
      [`append(Z)${T}`]: append((_t, v) => (v ? 'true' : 'false')),
      [`append(F)${T}`]: append((_t, v) => floatToString(v, true)),
      [`append(D)${T}`]: append((_t, v) => floatToString(v, false)),
      [`append([C)${T}`]: append((t, v) => {
        if (v === null) throw t.jvm.npe();
        return charsToString(v);
      }),
      [`append([CII)${T}`]: (t, [self, arr, off, len]) => {
        sb(self).s += charsToString(checkArrayRange(t.jvm, arr, off, len), off, len);
        return self;
      },
      [`insert(ILjava/lang/String;)${T}`]: insert((_t, v) => (v === null ? 'null' : v)),
      [`insert(ILjava/lang/Object;)${T}`]: insert((t, v) => t.jvm.stringValueOf(t, v)),
      [`insert(II)${T}`]: insert((_t, v) => String(v)),
      [`insert(IJ)${T}`]: insert((_t, v) => String(v)),
      [`insert(IC)${T}`]: insert((_t, v) => String.fromCharCode(v)),
      [`insert(IZ)${T}`]: insert((_t, v) => (v ? 'true' : 'false')),
      [`insert(I[C)${T}`]: insert((_t, v) => charsToString(v)),
      [`delete(II)${T}`]: (t, [self, start, end]) => {
        const state = sb(self);
        if (start < 0 || start > state.s.length || start > end) throw sioobe(t.jvm, `${start}..${end}`);
        state.s = state.s.slice(0, start) + state.s.slice(Math.min(end, state.s.length));
        return self;
      },
      [`deleteCharAt(I)${T}`]: (t, [self, i]) => {
        const state = sb(self);
        if (i < 0 || i >= state.s.length) throw sioobe(t.jvm, String(i));
        state.s = state.s.slice(0, i) + state.s.slice(i + 1);
        return self;
      },
      [`reverse()${T}`]: (_t, [self]) => {
        sb(self).s = [...sb(self).s].reverse().join('');
        return self;
      },
      'toString()Ljava/lang/String;': (_t, [self]) => sb(self).s,
      'length()I': (_t, [self]) => sb(self).s.length,
      'capacity()I': (_t, [self]) => Math.max(16, sb(self).s.length),
      'ensureCapacity(I)V': () => {},
      'charAt(I)C': (t, [self, i]) => {
        const s = sb(self).s;
        if (i < 0 || i >= s.length) throw sioobe(t.jvm, String(i));
        return s.charCodeAt(i);
      },
      'setCharAt(IC)V': (t, [self, i, c]) => {
        const state = sb(self);
        if (i < 0 || i >= state.s.length) throw sioobe(t.jvm, String(i));
        state.s = state.s.slice(0, i) + String.fromCharCode(c) + state.s.slice(i + 1);
      },
      'setLength(I)V': (t, [self, len]) => {
        const state = sb(self);
        if (len < 0) throw sioobe(t.jvm, String(len));
        state.s = len <= state.s.length ? state.s.slice(0, len) : state.s + '\0'.repeat(len - state.s.length);
      },
      'getChars(II[CI)V': (t, [self, begin, end, dst, dstBegin]) => {
        const s = sb(self).s;
        if (begin < 0 || end > s.length || begin > end) throw sioobe(t.jvm, `${begin}..${end}`);
        checkArrayRange(t.jvm, dst, dstBegin, end - begin);
        for (let i = begin; i < end; i++) (dst.d as Uint16Array)[dstBegin + i - begin] = s.charCodeAt(i);
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Boxed primitives, Math, System, Runtime

function parseJavaInt(t: JThread, s: string | null, radix: number, min: number, max: number): number {
  const jvm = t.jvm;
  if (s === null) throw jvm.throwable('java/lang/NumberFormatException', 'null');
  const valid = radix === 10 ? /^[-+]?\d+$/ : new RegExp(`^[-+]?[0-9a-z]+$`, 'i');
  const v = parseInt(s, radix);
  if (!valid.test(s) || Number.isNaN(v) || v < min || v > max || [...s.replace(/^[-+]/, '')].some((c) => isNaN(parseInt(c, radix)))) {
    throw jvm.throwable('java/lang/NumberFormatException', s);
  }
  return v;
}

function boxClass(name: string, prim: string, fromValue: (v: any) => any = (v) => v): NativeClassDef {
  const value = (self: JObject) => self.n;
  return {
    name,
    methods: {
      [`<init>(${prim})V`]: (_t, [self, v]) => {
        self.n = fromValue(v);
      },
      'equals(Ljava/lang/Object;)Z': (_t, [self, o]) => o instanceof JObject && o.cls === self.cls && o.n === self.n,
      'hashCode()I': (_t, [self]) => {
        const v = value(self);
        return typeof v === 'bigint' ? Number(BigInt.asIntN(32, v ^ (v >> 32n))) : prim === 'Z' ? (v ? 1231 : 1237) : v | 0;
      },
      'toString()Ljava/lang/String;': (_t, [self]) =>
        prim === 'C' ? String.fromCharCode(value(self)) : prim === 'Z' ? (value(self) ? 'true' : 'false') : String(value(self)),
    },
  };
}

function withMethods(def: NativeClassDef, methods: Record<string, NativeImpl>, statics: Record<string, NativeImpl> = {}, fields = {}) {
  def.methods = { ...def.methods, ...methods };
  def.statics = { ...def.statics, ...statics };
  def.fields = { ...def.fields, ...fields };
  return def;
}

function newBox(t: JThread, className: string, value: unknown): JObject {
  return newNativeObject(t.jvm, className, value);
}

const integerClass = withMethods(
  boxClass('java/lang/Integer', 'I'),
  {
    'intValue()I': (_t, [self]) => self.n,
    'longValue()J': (_t, [self]) => BigInt(self.n),
    'shortValue()S': (_t, [self]) => (self.n << 16) >> 16,
    'byteValue()B': (_t, [self]) => (self.n << 24) >> 24,
    'floatValue()F': (_t, [self]) => Math.fround(self.n),
    'doubleValue()D': (_t, [self]) => self.n,
  },
  {
    'parseInt(Ljava/lang/String;)I': (t, [s]) => parseJavaInt(t, s, 10, INT_MIN, INT_MAX),
    'parseInt(Ljava/lang/String;I)I': (t, [s, radix]) => parseJavaInt(t, s, radix, INT_MIN, INT_MAX),
    'valueOf(Ljava/lang/String;)Ljava/lang/Integer;': (t, [s]) => newBox(t, 'java/lang/Integer', parseJavaInt(t, s, 10, INT_MIN, INT_MAX)),
    'valueOf(Ljava/lang/String;I)Ljava/lang/Integer;': (t, [s, r]) => newBox(t, 'java/lang/Integer', parseJavaInt(t, s, r, INT_MIN, INT_MAX)),
    'valueOf(I)Ljava/lang/Integer;': (t, [v]) => newBox(t, 'java/lang/Integer', v),
    'toString(I)Ljava/lang/String;': (_t, [v]) => String(v),
    'toString(II)Ljava/lang/String;': (_t, [v, radix]) => v.toString(radix >= 2 && radix <= 36 ? radix : 10),
    'toHexString(I)Ljava/lang/String;': (_t, [v]) => (v >>> 0).toString(16),
    'toOctalString(I)Ljava/lang/String;': (_t, [v]) => (v >>> 0).toString(8),
    'toBinaryString(I)Ljava/lang/String;': (_t, [v]) => (v >>> 0).toString(2),
  },
  { 'MIN_VALUE:I': INT_MIN, 'MAX_VALUE:I': INT_MAX },
);

const longClass = withMethods(
  boxClass('java/lang/Long', 'J'),
  {
    'longValue()J': (_t, [self]) => self.n,
    'intValue()I': (_t, [self]) => Number(BigInt.asIntN(32, self.n)),
    'floatValue()F': (_t, [self]) => Math.fround(Number(self.n)),
    'doubleValue()D': (_t, [self]) => Number(self.n),
  },
  {
    'parseLong(Ljava/lang/String;)J': (t, [s]) => {
      if (s === null || !/^[-+]?\d+$/.test(s)) throw t.jvm.throwable('java/lang/NumberFormatException', String(s));
      const v = BigInt(s);
      if (BigInt.asIntN(64, v) !== v) throw t.jvm.throwable('java/lang/NumberFormatException', s);
      return v;
    },
    'toString(J)Ljava/lang/String;': (_t, [v]) => String(v),
  },
  { 'MIN_VALUE:J': -9223372036854775808n, 'MAX_VALUE:J': 9223372036854775807n },
);

const shortClass = withMethods(boxClass('java/lang/Short', 'S'), { 'shortValue()S': (_t, [self]) => self.n }, {
  'parseShort(Ljava/lang/String;)S': (t, [s]) => parseJavaInt(t, s, 10, -32768, 32767),
}, { 'MIN_VALUE:S': -32768, 'MAX_VALUE:S': 32767 });

const byteClass = withMethods(boxClass('java/lang/Byte', 'B'), { 'byteValue()B': (_t, [self]) => self.n }, {
  'parseByte(Ljava/lang/String;)B': (t, [s]) => parseJavaInt(t, s, 10, -128, 127),
}, { 'MIN_VALUE:B': -128, 'MAX_VALUE:B': 127 });

const booleanClass: NativeClassDef = withMethods(
  boxClass('java/lang/Boolean', 'Z'),
  { 'booleanValue()Z': (_t, [self]) => self.n },
  {},
  { 'TRUE:Ljava/lang/Boolean;': null, 'FALSE:Ljava/lang/Boolean;': null },
);
booleanClass.onLoad = (jvm, cls) => {
  jvm.setStatic(cls, 'TRUE:Ljava/lang/Boolean;', Object.assign(new JObject(cls), { n: 1 }));
  jvm.setStatic(cls, 'FALSE:Ljava/lang/Boolean;', Object.assign(new JObject(cls), { n: 0 }));
};

const isDigit = (c: number) => c >= 48 && c <= 57;
const characterClass = withMethods(
  boxClass('java/lang/Character', 'C'),
  { 'charValue()C': (_t, [self]) => self.n },
  {
    'isDigit(C)Z': (_t, [c]) => isDigit(c),
    'isLowerCase(C)Z': (_t, [c]) => String.fromCharCode(c) !== String.fromCharCode(c).toUpperCase(),
    'isUpperCase(C)Z': (_t, [c]) => String.fromCharCode(c) !== String.fromCharCode(c).toLowerCase(),
    'isLetter(C)Z': (_t, [c]) => /\p{L}/u.test(String.fromCharCode(c)),
    'isLetterOrDigit(C)Z': (_t, [c]) => /[\p{L}\p{Nd}]/u.test(String.fromCharCode(c)),
    'isSpaceChar(C)Z': (_t, [c]) => c === 32 || c === 160,
    'isWhitespace(C)Z': (_t, [c]) => /\s/.test(String.fromCharCode(c)),
    'toLowerCase(C)C': (_t, [c]) => String.fromCharCode(c).toLowerCase().charCodeAt(0),
    'toUpperCase(C)C': (_t, [c]) => String.fromCharCode(c).toUpperCase().charCodeAt(0),
    'digit(CI)I': (_t, [c, radix]) => {
      const v = parseInt(String.fromCharCode(c), radix);
      return Number.isNaN(v) ? -1 : v;
    },
    'forDigit(II)C': (_t, [d, radix]) => (d >= 0 && d < radix ? d.toString(radix).charCodeAt(0) : 0),
  },
  { 'MIN_RADIX:I': 2, 'MAX_RADIX:I': 36, 'MIN_VALUE:C': 0, 'MAX_VALUE:C': 0xffff },
);

const float32 = new Float32Array(1);
const int32View = new Int32Array(float32.buffer);
const float64 = new Float64Array(1);
const int64View = new BigInt64Array(float64.buffer);

const floatClass = withMethods(
  boxClass('java/lang/Float', 'F'),
  {
    'floatValue()F': (_t, [self]) => self.n,
    'doubleValue()D': (_t, [self]) => self.n,
    'intValue()I': (_t, [self]) => (Number.isNaN(self.n) ? 0 : Math.max(INT_MIN, Math.min(INT_MAX, Math.trunc(self.n)))),
    'isNaN()Z': (_t, [self]) => Number.isNaN(self.n),
    'toString()Ljava/lang/String;': (_t, [self]) => floatToString(self.n, true),
  },
  {
    'parseFloat(Ljava/lang/String;)F': (t, [s]) => {
      const v = Number(String(s).trim().replace(/[fFdD]$/, ''));
      if (s === null || Number.isNaN(v) && String(s).trim() !== 'NaN') throw t.jvm.throwable('java/lang/NumberFormatException', String(s));
      return Math.fround(v);
    },
    'toString(F)Ljava/lang/String;': (_t, [v]) => floatToString(v, true),
    'isNaN(F)Z': (_t, [v]) => Number.isNaN(v),
    'isInfinite(F)Z': (_t, [v]) => v === Infinity || v === -Infinity,
    'floatToIntBits(F)I': (_t, [v]) => {
      float32[0] = v;
      return int32View[0];
    },
    'intBitsToFloat(I)F': (_t, [v]) => {
      int32View[0] = v;
      return float32[0];
    },
  },
  { 'NaN:F': NaN, 'POSITIVE_INFINITY:F': Infinity, 'NEGATIVE_INFINITY:F': -Infinity, 'MAX_VALUE:F': 3.4028234663852886e38, 'MIN_VALUE:F': 1.401298464324817e-45 },
);

const doubleClass = withMethods(
  boxClass('java/lang/Double', 'D'),
  {
    'doubleValue()D': (_t, [self]) => self.n,
    'floatValue()F': (_t, [self]) => Math.fround(self.n),
    'intValue()I': (_t, [self]) => (Number.isNaN(self.n) ? 0 : Math.max(INT_MIN, Math.min(INT_MAX, Math.trunc(self.n)))),
    'isNaN()Z': (_t, [self]) => Number.isNaN(self.n),
    'toString()Ljava/lang/String;': (_t, [self]) => floatToString(self.n, false),
  },
  {
    'parseDouble(Ljava/lang/String;)D': (t, [s]) => {
      const v = Number(String(s).trim().replace(/[fFdD]$/, ''));
      if (s === null || Number.isNaN(v) && String(s).trim() !== 'NaN') throw t.jvm.throwable('java/lang/NumberFormatException', String(s));
      return v;
    },
    'toString(D)Ljava/lang/String;': (_t, [v]) => floatToString(v, false),
    'isNaN(D)Z': (_t, [v]) => Number.isNaN(v),
    'isInfinite(D)Z': (_t, [v]) => v === Infinity || v === -Infinity,
    'doubleToLongBits(D)J': (_t, [v]) => {
      float64[0] = v;
      return int64View[0];
    },
    'longBitsToDouble(J)D': (_t, [v]) => {
      int64View[0] = v;
      return float64[0];
    },
  },
  { 'NaN:D': NaN, 'POSITIVE_INFINITY:D': Infinity, 'NEGATIVE_INFINITY:D': -Infinity, 'MAX_VALUE:D': Number.MAX_VALUE, 'MIN_VALUE:D': Number.MIN_VALUE },
);

const mathClass: NativeClassDef = {
  name: 'java/lang/Math',
  statics: {
    'abs(I)I': (_t, [a]) => (a < 0 ? -a | 0 : a),
    'abs(J)J': (_t, [a]) => (a < 0n ? BigInt.asIntN(64, -(a as bigint)) : a),
    'abs(F)F': (_t, [a]) => Math.abs(a),
    'abs(D)D': (_t, [a]) => Math.abs(a),
    'max(II)I': (_t, [a, b]) => (a > b ? a : b),
    'min(II)I': (_t, [a, b]) => (a < b ? a : b),
    'max(JJ)J': (_t, [a, b]) => (a > b ? a : b),
    'min(JJ)J': (_t, [a, b]) => (a < b ? a : b),
    'max(FF)F': (_t, [a, b]) => Math.max(a, b),
    'min(FF)F': (_t, [a, b]) => Math.min(a, b),
    'max(DD)D': (_t, [a, b]) => Math.max(a, b),
    'min(DD)D': (_t, [a, b]) => Math.min(a, b),
    'sqrt(D)D': (_t, [a]) => Math.sqrt(a),
    'sin(D)D': (_t, [a]) => Math.sin(a),
    'cos(D)D': (_t, [a]) => Math.cos(a),
    'tan(D)D': (_t, [a]) => Math.tan(a),
    'asin(D)D': (_t, [a]) => Math.asin(a),
    'acos(D)D': (_t, [a]) => Math.acos(a),
    'atan(D)D': (_t, [a]) => Math.atan(a),
    'atan2(DD)D': (_t, [a, b]) => Math.atan2(a, b),
    'exp(D)D': (_t, [a]) => Math.exp(a),
    'log(D)D': (_t, [a]) => Math.log(a),
    'pow(DD)D': (_t, [a, b]) => Math.pow(a, b),
    'ceil(D)D': (_t, [a]) => Math.ceil(a),
    'floor(D)D': (_t, [a]) => Math.floor(a),
    'rint(D)D': (_t, [a]) => {
      const r = Math.round(a);
      return Math.abs(a % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
    },
    'round(F)I': (_t, [a]) => (Number.isNaN(a) ? 0 : Math.max(INT_MIN, Math.min(INT_MAX, Math.floor(a + 0.5)))),
    'round(D)J': (_t, [a]) => (Number.isNaN(a) ? 0n : BigInt(Math.floor(a + 0.5))),
    'toRadians(D)D': (_t, [a]) => (a / 180) * Math.PI,
    'toDegrees(D)D': (_t, [a]) => (a * 180) / Math.PI,
    'random()D': () => Math.random(),
  },
  fields: { 'PI:D': Math.PI, 'E:D': Math.E },
};

function arraycopy(t: JThread, [src, srcPos, dst, dstPos, len]: any[]) {
  const jvm = t.jvm;
  if (src === null || dst === null) throw jvm.npe();
  if (!(src instanceof JArray) || !(dst instanceof JArray)) throw jvm.throwable('java/lang/ArrayStoreException');
  const srcPrim = src.type.length === 2;
  const dstPrim = dst.type.length === 2;
  if ((srcPrim || dstPrim) && src.type !== dst.type) throw jvm.throwable('java/lang/ArrayStoreException');
  if (len < 0 || srcPos < 0 || dstPos < 0 || srcPos + len > src.d.length || dstPos + len > dst.d.length) {
    throw jvm.throwable('java/lang/ArrayIndexOutOfBoundsException', 'arraycopy');
  }
  if (len === 0) return;
  if (src.d === dst.d) {
    (dst.d as any).copyWithin(dstPos, srcPos, srcPos + len);
  } else if (srcPrim) {
    (dst.d as any).set((src.d as any).subarray(srcPos, srcPos + len), dstPos);
  } else {
    const s = src.d as JRef[];
    const d = dst.d as JRef[];
    for (let i = 0; i < len; i++) d[dstPos + i] = s[srcPos + i];
  }
}

const systemClass: NativeClassDef = {
  name: 'java/lang/System',
  statics: {
    'currentTimeMillis()J': () => BigInt(Date.now()),
    'arraycopy(Ljava/lang/Object;ILjava/lang/Object;II)V': arraycopy,
    'gc()V': () => {},
    'exit(I)V': (t) => {
      t.jvm.halt('exit');
      t.state = DEAD;
      return BLOCK;
    },
    'getProperty(Ljava/lang/String;)Ljava/lang/String;': (t, [key]) => {
      if (key === null) throw t.jvm.npe();
      return t.jvm.platform?.systemProperty(key) ?? null;
    },
    'identityHashCode(Ljava/lang/Object;)I': (t, [o]) => (o === null ? 0 : typeof o === 'string' ? stringHash(o) : t.jvm.identityHash(o)),
  },
  fields: { 'out:Ljava/io/PrintStream;': null, 'err:Ljava/io/PrintStream;': null },
  onLoad: (jvm, cls) => {
    jvm.setStatic(cls, 'out:Ljava/io/PrintStream;', newNativeObject(jvm, 'java/io/PrintStream', { err: false, line: '' }));
    jvm.setStatic(cls, 'err:Ljava/io/PrintStream;', newNativeObject(jvm, 'java/io/PrintStream', { err: true, line: '' }));
  },
};

const runtimeClass: NativeClassDef = {
  name: 'java/lang/Runtime',
  statics: {
    'getRuntime()Ljava/lang/Runtime;': (t) => (t.jvm.platform.runtimeObject ??= newNativeObject(t.jvm, 'java/lang/Runtime', {})),
  },
  methods: {
    'freeMemory()J': () => 6n * 1024n * 1024n,
    'totalMemory()J': () => 8n * 1024n * 1024n,
    'gc()V': () => {},
    'exit(I)V': (t) => {
      t.jvm.halt('exit');
      t.state = DEAD;
      return BLOCK;
    },
  },
};

// ---------------------------------------------------------------------------------------------------
// Thread

let threadCounter = 0;

function threadPeer(self: JObject, target: JRef, name: string | null) {
  self.n = { target, name: name ?? `Thread-${threadCounter++}`, started: false, jthread: null as JThread | null, priority: 5 };
}

const threadClass: NativeClassDef = {
  name: 'java/lang/Thread',
  interfaces: ['java/lang/Runnable'],
  fields: { 'MIN_PRIORITY:I': 1, 'NORM_PRIORITY:I': 5, 'MAX_PRIORITY:I': 10 },
  methods: {
    '<init>()V': (_t, [self]) => threadPeer(self, null, null),
    '<init>(Ljava/lang/Runnable;)V': (_t, [self, r]) => threadPeer(self, r, null),
    '<init>(Ljava/lang/String;)V': (_t, [self, name]) => threadPeer(self, null, name),
    '<init>(Ljava/lang/Runnable;Ljava/lang/String;)V': (_t, [self, r, name]) => threadPeer(self, r, name),
    'run()V': (t, [self]) => {
      const target = self.n?.target;
      if (!target) return;
      const m = t.jvm.findVirtual(t.jvm.classOf(target), 'run()V');
      if (!m) return;
      t.jvm.pushCall(t, m, [target]);
      return INVOKED;
    },
    'start()V': (t, [self]) => {
      const jvm = t.jvm;
      if (!self.n) threadPeer(self, null, null);
      if (self.n.started) throw jvm.throwable('java/lang/IllegalThreadStateException');
      self.n.started = true;
      jvm.startThread(self.n.name, (jt) => {
        jt.javaThread = self;
        self.n.jthread = jt;
        const run = jvm.findVirtual(self.cls, 'run()V')!;
        if (run.impl) {
          const target = self.n.target;
          const m = target ? jvm.findVirtual(jvm.classOf(target), 'run()V') : null;
          if (m) jvm.pushCall(jt, m, [target]);
        } else {
          jvm.pushCall(jt, run, [self]);
        }
      });
    },
    'isAlive()Z': (_t, [self]) => !!self.n?.jthread && self.n.jthread.state !== DEAD,
    'join()V': (t, [self]) => {
      const other: JThread | null = self.n?.jthread ?? null;
      if (!other || other.state === DEAD) return;
      t.state = WAITING;
      t.condition = () => other.state === DEAD;
      return BLOCK;
    },
    'setPriority(I)V': (t, [self, p]) => {
      if (p < 1 || p > 10) throw t.jvm.throwable('java/lang/IllegalArgumentException');
      self.n.priority = p;
    },
    'getPriority()I': (_t, [self]) => self.n?.priority ?? 5,
    'getName()Ljava/lang/String;': (_t, [self]) => self.n?.name ?? 'Thread',
    'interrupt()V': (_t, [self]) => {
      const jt: JThread | null = self.n?.jthread ?? null;
      if (jt) {
        jt.interrupted = true;
        if (jt.state === SLEEPING) jt.wakeAt = 0;
      }
    },
    'toString()Ljava/lang/String;': (_t, [self]) => `Thread[${self.n?.name},${self.n?.priority}]`,
  },
  statics: {
    'sleep(J)V': (t, [ms]) => {
      if (ms < 0n) throw t.jvm.throwable('java/lang/IllegalArgumentException', 'timeout value is negative');
      t.state = SLEEPING;
      t.wakeAt = performance.now() + Number(ms);
      return BLOCK;
    },
    'yield()V': (t) => {
      t.state = SLEEPING;
      t.wakeAt = 0;
      return BLOCK;
    },
    'currentThread()Ljava/lang/Thread;': (t) => {
      if (!t.javaThread) {
        const obj = new JObject(t.jvm.loadClass('java/lang/Thread'));
        threadPeer(obj, null, t.name);
        obj.n.started = true;
        obj.n.jthread = t;
        t.javaThread = obj;
      }
      return t.javaThread;
    },
    'activeCount()I': (t) => t.jvm.threads.filter((x) => x.state !== DEAD).length,
  },
};

// ---------------------------------------------------------------------------------------------------
// Throwables

const throwableClass: NativeClassDef = {
  name: 'java/lang/Throwable',
  methods: {
    '<init>()V': (t, [self]) => {
      self.n = { message: null, trace: t.jvm.captureTrace(t) };
    },
    '<init>(Ljava/lang/String;)V': (t, [self, message]) => {
      self.n = { message, trace: t.jvm.captureTrace(t) };
    },
    'getMessage()Ljava/lang/String;': (_t, [self]) => self.n?.message ?? null,
    'toString()Ljava/lang/String;': (t, [self]) => {
      const m = t.jvm.findVirtual(self.cls, 'getMessage()Ljava/lang/String;');
      const message = m ? t.jvm.invokeSync(t, m, [self]) : null;
      return `${javaName(self.cls.name)}${message !== null ? `: ${String(message)}` : ''}`;
    },
    'printStackTrace()V': (t, [self]) => {
      t.jvm.host.log('warn', t.jvm.describeThrowable(self));
    },
  },
};

const THROWABLES: Array<[string, string]> = [
  ['java/lang/Exception', 'java/lang/Throwable'],
  ['java/lang/Error', 'java/lang/Throwable'],
  ['java/lang/RuntimeException', 'java/lang/Exception'],
  ['java/lang/ArithmeticException', 'java/lang/RuntimeException'],
  ['java/lang/ArrayStoreException', 'java/lang/RuntimeException'],
  ['java/lang/ClassCastException', 'java/lang/RuntimeException'],
  ['java/lang/IllegalArgumentException', 'java/lang/RuntimeException'],
  ['java/lang/IllegalThreadStateException', 'java/lang/IllegalArgumentException'],
  ['java/lang/NumberFormatException', 'java/lang/IllegalArgumentException'],
  ['java/lang/IllegalMonitorStateException', 'java/lang/RuntimeException'],
  ['java/lang/IllegalStateException', 'java/lang/RuntimeException'],
  ['java/lang/IndexOutOfBoundsException', 'java/lang/RuntimeException'],
  ['java/lang/ArrayIndexOutOfBoundsException', 'java/lang/IndexOutOfBoundsException'],
  ['java/lang/StringIndexOutOfBoundsException', 'java/lang/IndexOutOfBoundsException'],
  ['java/lang/NegativeArraySizeException', 'java/lang/RuntimeException'],
  ['java/lang/NullPointerException', 'java/lang/RuntimeException'],
  ['java/lang/SecurityException', 'java/lang/RuntimeException'],
  ['java/lang/UnsupportedOperationException', 'java/lang/RuntimeException'],
  ['java/lang/ClassNotFoundException', 'java/lang/Exception'],
  ['java/lang/InstantiationException', 'java/lang/Exception'],
  ['java/lang/IllegalAccessException', 'java/lang/Exception'],
  ['java/lang/InterruptedException', 'java/lang/Exception'],
  ['java/lang/CloneNotSupportedException', 'java/lang/Exception'],
  ['java/lang/VirtualMachineError', 'java/lang/Error'],
  ['java/lang/OutOfMemoryError', 'java/lang/VirtualMachineError'],
  ['java/lang/StackOverflowError', 'java/lang/VirtualMachineError'],
  ['java/lang/InternalError', 'java/lang/VirtualMachineError'],
  ['java/lang/LinkageError', 'java/lang/Error'],
  ['java/lang/NoClassDefFoundError', 'java/lang/LinkageError'],
  ['java/lang/ExceptionInInitializerError', 'java/lang/LinkageError'],
  ['java/lang/UnsatisfiedLinkError', 'java/lang/LinkageError'],
  ['java/lang/VerifyError', 'java/lang/LinkageError'],
  ['java/lang/IncompatibleClassChangeError', 'java/lang/LinkageError'],
  ['java/lang/NoSuchFieldError', 'java/lang/IncompatibleClassChangeError'],
  ['java/lang/NoSuchMethodError', 'java/lang/IncompatibleClassChangeError'],
  ['java/lang/AbstractMethodError', 'java/lang/IncompatibleClassChangeError'],
  ['java/lang/InstantiationError', 'java/lang/IncompatibleClassChangeError'],
  ['java/util/NoSuchElementException', 'java/lang/RuntimeException'],
  ['java/util/EmptyStackException', 'java/lang/RuntimeException'],
  ['java/io/IOException', 'java/lang/Exception'],
  ['java/io/EOFException', 'java/io/IOException'],
  ['java/io/InterruptedIOException', 'java/io/IOException'],
  ['java/io/UnsupportedEncodingException', 'java/io/IOException'],
  ['java/io/UTFDataFormatException', 'java/io/IOException'],
  ['javax/microedition/midlet/MIDletStateChangeException', 'java/lang/Exception'],
  ['javax/microedition/rms/RecordStoreException', 'java/lang/Exception'],
  ['javax/microedition/rms/RecordStoreNotFoundException', 'javax/microedition/rms/RecordStoreException'],
  ['javax/microedition/rms/RecordStoreFullException', 'javax/microedition/rms/RecordStoreException'],
  ['javax/microedition/rms/RecordStoreNotOpenException', 'javax/microedition/rms/RecordStoreException'],
  ['javax/microedition/rms/InvalidRecordIDException', 'javax/microedition/rms/RecordStoreException'],
  ['javax/microedition/media/MediaException', 'java/lang/Exception'],
];

export const langNatives: NativeClassDef[] = [
  objectClass,
  classClass,
  stringClass,
  stringBufferClass('java/lang/StringBuffer'),
  stringBufferClass('java/lang/StringBuilder'),
  integerClass,
  longClass,
  shortClass,
  byteClass,
  booleanClass,
  characterClass,
  floatClass,
  doubleClass,
  mathClass,
  systemClass,
  runtimeClass,
  threadClass,
  { name: 'java/lang/Runnable', flags: ACC_INTERFACE | ACC_ABSTRACT },
  throwableClass,
  ...THROWABLES.map(([name, sup]): NativeClassDef => ({ name, super: sup })),
];

export { javaEquals };
