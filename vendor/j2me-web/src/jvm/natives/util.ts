import { ACC_ABSTRACT, ACC_INTERFACE } from '../classfile';
import type { JThread, NativeClassDef } from '../jvm';
import { JArray, JObject, type JRef, type NativeImpl } from '../types';
import { INT_MAX, javaEquals, javaHashCode, newNativeObject } from './helpers';

// ---------------------------------------------------------------------------------------------------
// Random: same LCG as java.util.Random so seeded sequences match the original platform.

const MULTIPLIER = 0x5deece66dn;
const MASK = (1n << 48n) - 1n;
let seedUniquifier = 8682522807148012n;

interface RandomPeer {
  seed: bigint;
}

function setSeed(peer: RandomPeer, seed: bigint) {
  peer.seed = (seed ^ MULTIPLIER) & MASK;
}

function nextBits(peer: RandomPeer, bits: number): number {
  peer.seed = (peer.seed * MULTIPLIER + 0xbn) & MASK;
  return Number(BigInt.asIntN(32, peer.seed >> BigInt(48 - bits)));
}

const rnd = (self: JObject) => self.n as RandomPeer;

const randomClass: NativeClassDef = {
  name: 'java/util/Random',
  methods: {
    '<init>()V': (_t, [self]) => {
      seedUniquifier = BigInt.asIntN(64, seedUniquifier * 181783497276652981n);
      self.n = { seed: 0n };
      setSeed(self.n, BigInt.asIntN(64, seedUniquifier ^ BigInt(Date.now()) ^ BigInt(Math.floor(performance.now() * 1000))));
    },
    '<init>(J)V': (_t, [self, seed]) => {
      self.n = { seed: 0n };
      setSeed(self.n, seed);
    },
    'setSeed(J)V': (_t, [self, seed]) => setSeed(rnd(self), seed),
    'nextInt()I': (_t, [self]) => nextBits(rnd(self), 32),
    'nextInt(I)I': (t, [self, bound]) => {
      if (bound <= 0) throw t.jvm.throwable('java/lang/IllegalArgumentException', 'n must be positive');
      const peer = rnd(self);
      if ((bound & -bound) === bound) return Number((BigInt(bound) * BigInt(nextBits(peer, 31))) >> 31n);
      let bits: number;
      let val: number;
      do {
        bits = nextBits(peer, 31);
        val = bits % bound;
      } while (bits - val + (bound - 1) > INT_MAX);
      return val;
    },
    'nextLong()J': (_t, [self]) => {
      const peer = rnd(self);
      const hi = BigInt(nextBits(peer, 32));
      const lo = BigInt(nextBits(peer, 32));
      return BigInt.asIntN(64, (hi << 32n) + lo);
    },
    'nextFloat()F': (_t, [self]) => nextBits(rnd(self), 24) / (1 << 24),
    'nextDouble()D': (_t, [self]) => {
      const peer = rnd(self);
      return (nextBits(peer, 26) * 2 ** 27 + nextBits(peer, 27)) / 2 ** 53;
    },
    'nextBoolean()Z': (_t, [self]) => nextBits(rnd(self), 1) !== 0,
  },
};

// ---------------------------------------------------------------------------------------------------
// Vector / Stack / Enumeration

const vec = (self: JObject) => (self.n as { a: JRef[] }).a;
const vectorInit: NativeImpl = (_t, [self]) => {
  self.n = { a: [] };
};

function aioobe(t: JThread, index: number) {
  return t.jvm.throwable('java/lang/ArrayIndexOutOfBoundsException', String(index));
}

function indexOf(t: JThread, items: JRef[], value: JRef, from: number): number {
  for (let i = Math.max(0, from); i < items.length; i++) {
    if (value === null ? items[i] === null : javaEquals(t, value, items[i])) return i;
  }
  return -1;
}

export function newEnumeration(t: JThread, items: JRef[]): JObject {
  return newNativeObject(t.jvm, 'j2me/NativeEnumeration', { items, i: 0 });
}

const vectorClass: NativeClassDef = {
  name: 'java/util/Vector',
  methods: {
    '<init>()V': vectorInit,
    '<init>(I)V': vectorInit,
    '<init>(II)V': vectorInit,
    'size()I': (_t, [self]) => vec(self).length,
    'capacity()I': (_t, [self]) => Math.max(10, vec(self).length),
    'isEmpty()Z': (_t, [self]) => vec(self).length === 0,
    'addElement(Ljava/lang/Object;)V': (_t, [self, v]) => {
      vec(self).push(v);
    },
    'insertElementAt(Ljava/lang/Object;I)V': (t, [self, v, i]) => {
      const a = vec(self);
      if (i < 0 || i > a.length) throw aioobe(t, i);
      a.splice(i, 0, v);
    },
    'elementAt(I)Ljava/lang/Object;': (t, [self, i]) => {
      const a = vec(self);
      if (i < 0 || i >= a.length) throw aioobe(t, i);
      return a[i];
    },
    'setElementAt(Ljava/lang/Object;I)V': (t, [self, v, i]) => {
      const a = vec(self);
      if (i < 0 || i >= a.length) throw aioobe(t, i);
      a[i] = v;
    },
    'removeElementAt(I)V': (t, [self, i]) => {
      const a = vec(self);
      if (i < 0 || i >= a.length) throw aioobe(t, i);
      a.splice(i, 1);
    },
    'removeElement(Ljava/lang/Object;)Z': (t, [self, v]) => {
      const a = vec(self);
      const i = indexOf(t, a, v, 0);
      if (i < 0) return false;
      a.splice(i, 1);
      return true;
    },
    'removeAllElements()V': (_t, [self]) => {
      vec(self).length = 0;
    },
    'contains(Ljava/lang/Object;)Z': (t, [self, v]) => indexOf(t, vec(self), v, 0) >= 0,
    'indexOf(Ljava/lang/Object;)I': (t, [self, v]) => indexOf(t, vec(self), v, 0),
    'indexOf(Ljava/lang/Object;I)I': (t, [self, v, from]) => indexOf(t, vec(self), v, from),
    'lastIndexOf(Ljava/lang/Object;)I': (t, [self, v]) => {
      const a = vec(self);
      for (let i = a.length - 1; i >= 0; i--) if (v === null ? a[i] === null : javaEquals(t, v, a[i])) return i;
      return -1;
    },
    'firstElement()Ljava/lang/Object;': (t, [self]) => {
      const a = vec(self);
      if (!a.length) throw t.jvm.throwable('java/util/NoSuchElementException');
      return a[0];
    },
    'lastElement()Ljava/lang/Object;': (t, [self]) => {
      const a = vec(self);
      if (!a.length) throw t.jvm.throwable('java/util/NoSuchElementException');
      return a[a.length - 1];
    },
    'elements()Ljava/util/Enumeration;': (t, [self]) => newEnumeration(t, vec(self)),
    'copyInto([Ljava/lang/Object;)V': (t, [self, arr]) => {
      const a = vec(self);
      if (arr === null) throw t.jvm.npe();
      if (arr.d.length < a.length) throw aioobe(t, a.length);
      for (let i = 0; i < a.length; i++) (arr.d as JRef[])[i] = a[i];
    },
    'setSize(I)V': (t, [self, size]) => {
      if (size < 0) throw aioobe(t, size);
      const a = vec(self);
      const old = a.length;
      a.length = size;
      if (size > old) a.fill(null, old);
    },
    'ensureCapacity(I)V': () => {},
    'trimToSize()V': () => {},
    'toString()Ljava/lang/String;': (t, [self]) => `[${vec(self).map((v) => t.jvm.stringValueOf(t, v)).join(', ')}]`,
  },
};

const stackClass: NativeClassDef = {
  name: 'java/util/Stack',
  super: 'java/util/Vector',
  methods: {
    '<init>()V': vectorInit,
    'push(Ljava/lang/Object;)Ljava/lang/Object;': (_t, [self, v]) => {
      vec(self).push(v);
      return v;
    },
    'pop()Ljava/lang/Object;': (t, [self]) => {
      const a = vec(self);
      if (!a.length) throw t.jvm.throwable('java/util/EmptyStackException');
      return a.pop()!;
    },
    'peek()Ljava/lang/Object;': (t, [self]) => {
      const a = vec(self);
      if (!a.length) throw t.jvm.throwable('java/util/EmptyStackException');
      return a[a.length - 1];
    },
    'empty()Z': (_t, [self]) => vec(self).length === 0,
    'search(Ljava/lang/Object;)I': (t, [self, v]) => {
      const a = vec(self);
      for (let i = a.length - 1; i >= 0; i--) if (javaEquals(t, v, a[i])) return a.length - i;
      return -1;
    },
  },
};

const nativeEnumeration: NativeClassDef = {
  name: 'j2me/NativeEnumeration',
  interfaces: ['java/util/Enumeration'],
  methods: {
    'hasMoreElements()Z': (_t, [self]) => self.n.i < self.n.items.length,
    'nextElement()Ljava/lang/Object;': (t, [self]) => {
      if (self.n.i >= self.n.items.length) throw t.jvm.throwable('java/util/NoSuchElementException');
      return self.n.items[self.n.i++];
    },
  },
};

// ---------------------------------------------------------------------------------------------------
// Hashtable

interface Entry {
  key: JRef;
  value: JRef;
}

type Buckets = Map<number, Entry[]>;
const table = (self: JObject) => (self.n as { buckets: Buckets }).buckets;

function findEntry(t: JThread, buckets: Buckets, key: JRef): { bucket: Entry[] | undefined; index: number; hash: number } {
  if (key === null) throw t.jvm.npe();
  const hash = javaHashCode(t, key);
  const bucket = buckets.get(hash);
  const index = bucket ? bucket.findIndex((e) => e.key === key || javaEquals(t, key, e.key)) : -1;
  return { bucket, index, hash };
}

function allEntries(buckets: Buckets): Entry[] {
  return [...buckets.values()].flat();
}

const hashtableInit: NativeImpl = (_t, [self]) => {
  self.n = { buckets: new Map() };
};

const hashtableClass: NativeClassDef = {
  name: 'java/util/Hashtable',
  methods: {
    '<init>()V': hashtableInit,
    '<init>(I)V': hashtableInit,
    'put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;': (t, [self, key, value]) => {
      if (value === null) throw t.jvm.npe();
      const buckets = table(self);
      const { bucket, index, hash } = findEntry(t, buckets, key);
      if (bucket && index >= 0) {
        const old = bucket[index].value;
        bucket[index].value = value;
        return old;
      }
      if (bucket) bucket.push({ key, value });
      else buckets.set(hash, [{ key, value }]);
      return null;
    },
    'get(Ljava/lang/Object;)Ljava/lang/Object;': (t, [self, key]) => {
      const { bucket, index } = findEntry(t, table(self), key);
      return bucket && index >= 0 ? bucket[index].value : null;
    },
    'remove(Ljava/lang/Object;)Ljava/lang/Object;': (t, [self, key]) => {
      const buckets = table(self);
      const { bucket, index, hash } = findEntry(t, buckets, key);
      if (!bucket || index < 0) return null;
      const [removed] = bucket.splice(index, 1);
      if (!bucket.length) buckets.delete(hash);
      return removed.value;
    },
    'containsKey(Ljava/lang/Object;)Z': (t, [self, key]) => findEntry(t, table(self), key).index >= 0,
    'contains(Ljava/lang/Object;)Z': (t, [self, value]) => {
      if (value === null) throw t.jvm.npe();
      return allEntries(table(self)).some((e) => javaEquals(t, value, e.value));
    },
    'size()I': (_t, [self]) => allEntries(table(self)).length,
    'isEmpty()Z': (_t, [self]) => table(self).size === 0,
    'clear()V': (_t, [self]) => table(self).clear(),
    'keys()Ljava/util/Enumeration;': (t, [self]) => newEnumeration(t, allEntries(table(self)).map((e) => e.key)),
    'elements()Ljava/util/Enumeration;': (t, [self]) => newEnumeration(t, allEntries(table(self)).map((e) => e.value)),
    'rehash()V': () => {},
    'toString()Ljava/lang/String;': (t, [self]) =>
      `{${allEntries(table(self)).map((e) => `${t.jvm.stringValueOf(t, e.key)}=${t.jvm.stringValueOf(t, e.value)}`).join(', ')}}`,
  },
};

// ---------------------------------------------------------------------------------------------------
// Date, Timer

const dateClass: NativeClassDef = {
  name: 'java/util/Date',
  methods: {
    '<init>()V': (_t, [self]) => {
      self.n = BigInt(Date.now());
    },
    '<init>(J)V': (_t, [self, ms]) => {
      self.n = ms;
    },
    'getTime()J': (_t, [self]) => self.n,
    'setTime(J)V': (_t, [self, ms]) => {
      self.n = ms;
    },
    'equals(Ljava/lang/Object;)Z': (_t, [self, o]) => o instanceof JObject && o.cls === self.cls && o.n === self.n,
    'hashCode()I': (_t, [self]) => Number(BigInt.asIntN(32, self.n ^ (self.n >> 32n))),
    'toString()Ljava/lang/String;': (_t, [self]) => new Date(Number(self.n)).toString(),
  },
};

// Calendar
//
// 仙剑存档槽类 b 的构造函数（b.<init>(I,[I,J,String,String,String,String)V 第 40 字节码）
// 调 b.a(long) 把时间戳格式化成人读的日期：
//
//   Calendar.getInstance() → setTime(new Date(ms))
//   get(MONTH)+1, get(DAY_OF_MONTH), get(HOUR_OF_DAY), get(MINUTE)
//
// 缺 java/util/Calendar 时这里抛 NoClassDefFoundError，构造函数直接失败，
// 整个存档流程（在给存档槽标时间时）就崩了。所以这个类是存档的硬依赖。
//
// MIDP 2.0 / CLDC 1.1 只规定了 Calendar 抽象类和 GregorianCalendar，
// 字段常量也是规范里那几个，实现足够游戏用了。
const CAL_FIELD = {
  ERA: 0,
  YEAR: 1,
  MONTH: 2,
  WEEK_OF_YEAR: 3,
  WEEK_OF_MONTH: 4,
  DAY_OF_MONTH: 5,
  DAY_OF_YEAR: 6,
  DAY_OF_WEEK: 7,
  DAY_OF_WEEK_IN_MONTH: 8,
  AM_PM: 9,
  HOUR: 10,
  HOUR_OF_DAY: 11,
  MINUTE: 12,
  SECOND: 13,
  MILLISECOND: 14,
  ZONE_OFFSET: 15,
  DST_OFFSET: 16,
  AM: 0,
  PM: 1,
} as const;

/** 取 Calendar 的毫秒时间（peer 存在 .n，和 Date 一致）。 */
function calendarTime(self: JObject): Date {
  return new Date(Number(self.n));
}

const calendarClass: NativeClassDef = {
  name: 'java/util/Calendar',
  flags: ACC_ABSTRACT,
  fields: {
    'ERA:I': 0,
    'YEAR:I': 1,
    'MONTH:I': 2,
    'WEEK_OF_YEAR:I': 3,
    'WEEK_OF_MONTH:I': 4,
    'DAY_OF_MONTH:I': 5,
    'DAY_OF_YEAR:I': 6,
    'DAY_OF_WEEK:I': 7,
    'DAY_OF_WEEK_IN_MONTH:I': 8,
    'AM_PM:I': 9,
    'HOUR:I': 10,
    'HOUR_OF_DAY:I': 11,
    'MINUTE:I': 12,
    'SECOND:I': 13,
    'MILLISECOND:I': 14,
    'ZONE_OFFSET:I': 15,
    'DST_OFFSET:I': 16,
    'AM:I': 0,
    'PM:I': 1,
  },
  statics: {
    'getInstance()Ljava/util/Calendar;': (t) => newCalendar(t, 'java/util/GregorianCalendar', BigInt(Date.now())),
    'getInstance(Ljava/util/Locale;)Ljava/util/Calendar;': (t) => newCalendar(t, 'java/util/GregorianCalendar', BigInt(Date.now())),
    'getInstance(Ljava/lang/String;)Ljava/util/Calendar;': (t) => newCalendar(t, 'java/util/GregorianCalendar', BigInt(Date.now())),
    'getInstance(Ljava/util/TimeZone;)Ljava/util/Calendar;': (t) => newCalendar(t, 'java/util/GregorianCalendar', BigInt(Date.now())),
  },
  methods: {
    'get(I)I': (_t, [self, field]) => calendarField(calendarTime(self), field),
    'set(I I)V': (_t, [self, field, value]) => {
      // 规范里允许 set(field, value) 逐项改，这里直接按字段偏移回去
      const d = calendarTime(self);
      const next = applyField(d, field, value);
      self.n = BigInt(next.getTime());
    },
    'set(Ljava/util/Date;)V': (_t, [self, date]) => {
      self.n = date.n;
    },
    'getTime()J': (_t, [self]) => self.n,
    'setTimeInMillis(J)V': (_t, [self, ms]) => {
      self.n = ms;
    },
    'setTime(Ljava/util/Date;)V': (_t, [self, date]) => {
      if (date === null) throw _t.jvm.npe();
      self.n = date.n;
    },
    'getTimeZone()Ljava/util/TimeZone;': (t, [self]) => {
      const tz = new JObject(t.jvm.loadClass('java/util/TimeZone'));
      tz.n = 'Etc/GMT';
      return tz;
    },
    'setTimeZone(Ljava/util/TimeZone;)V': () => {},
    'getFirstDayOfWeek()I': () => 1,
    'setFirstDayOfWeek(I)V': () => {},
    'getMinimalDaysInFirstWeek()I': () => 1,
    'setMinimalDaysInFirstWeek(I)V': () => {},
    'getLenient()Z': () => true,
    'setLenient(Z)V': () => {},
    'clear()V': (_t, [self]) => {
      self.n = 0n;
    },
    'isSet(I)Z': () => true,
    'add(I I)V': (_t, [self, field, amount]) => {
      const d = calendarTime(self);
      self.n = BigInt(addField(d, field, amount).getTime());
    },
    'roll(I I)V': (_t, [self, field, amount]) => {
      const d = calendarTime(self);
      self.n = BigInt(rollField(d, field, amount).getTime());
    },
    'clone()Ljava/lang/Object;': (t, [self]) => {
      const c = new JObject(t.jvm.loadClass(self.cls.name));
      c.n = self.n;
      return c;
    },
    'toString()Ljava/lang/String;': (_t, [self]) => {
      const d = calendarTime(self);
      const p = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    },
  },
};

function newCalendar(t: JThread, clsName: string, ms: bigint): JObject {
  const c = new JObject(t.jvm.loadClass(clsName));
  c.n = ms;
  return c;
}

function calendarField(d: Date, field: number): number {
  switch (field) {
    case CAL_FIELD.ERA:
      return d.getFullYear() > 0 ? 1 : 0;
    case CAL_FIELD.YEAR:
      return d.getFullYear();
    case CAL_FIELD.MONTH:
      return d.getMonth();
    case CAL_FIELD.WEEK_OF_YEAR:
      return weekOfYear(d);
    case CAL_FIELD.WEEK_OF_MONTH:
      return Math.floor((d.getDate() - 1) / 7) + 1;
    case CAL_FIELD.DAY_OF_MONTH:
      return d.getDate();
    case CAL_FIELD.DAY_OF_YEAR:
      return dayOfYear(d);
    case CAL_FIELD.DAY_OF_WEEK:
      return d.getDay();
    case CAL_FIELD.DAY_OF_WEEK_IN_MONTH:
      return Math.ceil(d.getDate() / 7);
    case CAL_FIELD.AM_PM:
      return d.getHours() < 12 ? CAL_FIELD.AM : CAL_FIELD.PM;
    case CAL_FIELD.HOUR:
      return d.getHours() % 12;
    case CAL_FIELD.HOUR_OF_DAY:
      return d.getHours();
    case CAL_FIELD.MINUTE:
      return d.getMinutes();
    case CAL_FIELD.SECOND:
      return d.getSeconds();
    case CAL_FIELD.MILLISECOND:
      return d.getMilliseconds();
    case CAL_FIELD.ZONE_OFFSET:
    case CAL_FIELD.DST_OFFSET:
      return 0; // 一律当 UTC+0，浏览器本地时区会随用户改，模拟器固定更可复现
    default:
      return 0;
  }
}

/** 把某字段改成目标值，其余字段不动；溢出的字段按 Java 宽松模式进位。 */
function applyField(d: Date, field: number, value: number): Date {
  const y = d.getFullYear();
  const next = new Date(d.getTime());
  switch (field) {
    case CAL_FIELD.YEAR:
      next.setFullYear(value);
      break;
    case CAL_FIELD.MONTH:
      next.setFullYear(y, value);
      break;
    case CAL_FIELD.DAY_OF_MONTH:
      next.setDate(value);
      break;
    case CAL_FIELD.HOUR_OF_DAY:
      next.setHours(value);
      break;
    case CAL_FIELD.HOUR:
      next.setHours((value % 12) + (d.getHours() < 12 ? 0 : 12));
      break;
    case CAL_FIELD.MINUTE:
      next.setMinutes(value);
      break;
    case CAL_FIELD.SECOND:
      next.setSeconds(value);
      break;
    case CAL_FIELD.MILLISECOND:
      next.setMilliseconds(value);
      break;
    case CAL_FIELD.WEEK_OF_MONTH:
      next.setDate(d.getDate() - (d.getDate() - 1) % 7 + (value - 1) * 7);
      break;
    case CAL_FIELD.DAY_OF_YEAR:
      next.setFullYear(y, 0, value);
      break;
    case CAL_FIELD.DAY_OF_WEEK:
      next.setDate(d.getDate() + ((value - d.getDay() + 7) % 7));
      break;
    default:
      break;
  }
  return next;
}

/** add：按字段的自然长度进位（month 加 1 是一整月，不是加 1 天）。 */
function addField(d: Date, field: number, amount: number): Date {
  const next = new Date(d.getTime());
  switch (field) {
    case CAL_FIELD.YEAR:
      next.setFullYear(next.getFullYear() + amount);
      break;
    case CAL_FIELD.MONTH:
      next.setMonth(next.getMonth() + amount);
      break;
    case CAL_FIELD.WEEK_OF_YEAR:
    case CAL_FIELD.WEEK_OF_MONTH:
      next.setDate(next.getDate() + amount * 7);
      break;
    case CAL_FIELD.DAY_OF_YEAR:
    case CAL_FIELD.DAY_OF_MONTH:
    case CAL_FIELD.DAY_OF_WEEK:
    case CAL_FIELD.DAY_OF_WEEK_IN_MONTH:
      next.setDate(next.getDate() + amount);
      break;
    case CAL_FIELD.HOUR:
    case CAL_FIELD.HOUR_OF_DAY:
      next.setHours(next.getHours() + amount);
      break;
    case CAL_FIELD.MINUTE:
      next.setMinutes(next.getMinutes() + amount);
      break;
    case CAL_FIELD.SECOND:
      next.setSeconds(next.getSeconds() + amount);
      break;
    case CAL_FIELD.MILLISECOND:
      next.setMilliseconds(next.getMilliseconds() + amount);
      break;
    default:
      break;
  }
  return next;
}

/** roll：进位给上一级字段，但本字段自身回绕（add 和 roll 的区别）。 */
function rollField(d: Date, field: number, amount: number): Date {
  const next = new Date(d.getTime());
  switch (field) {
    case CAL_FIELD.MONTH: {
      // 回绕到 0-11，多出来的进位给年份
      const total = next.getMonth() + amount;
      const m = ((total % 12) + 12) % 12;
      next.setMonth(m);
      next.setFullYear(next.getFullYear() + Math.floor(total / 12));
      break;
    }
    case CAL_FIELD.HOUR_OF_DAY:
      next.setHours(((next.getHours() + amount) % 24 + 24) % 24);
      break;
    case CAL_FIELD.HOUR: {
      const h = next.getHours() % 12;
      const total = h + amount;
      next.setHours((((total % 12) + 12) % 12) + (next.getHours() < 12 ? 0 : 12));
      break;
    }
    case CAL_FIELD.MINUTE:
      next.setMinutes(((next.getMinutes() + amount) % 60 + 60) % 60);
      break;
    case CAL_FIELD.SECOND:
      next.setSeconds(((next.getSeconds() + amount) % 60 + 60) % 60);
      break;
    case CAL_FIELD.DAY_OF_MONTH:
      next.setDate((((next.getDate() - 1 + amount) % 31 + 31) % 31) + 1);
      break;
    default:
      return addField(d, field, amount);
  }
  return next;
}

function dayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 1);
  return Math.floor((d.getTime() - start.getTime()) / 86400000) + 1;
}

function weekOfYear(d: Date): number {
  return Math.floor((dayOfYear(d) + 6 - ((new Date(d.getFullYear(), 0, 1).getDay() + 6) % 7)) / 7) + 1;
}

const gregorianCalendarClass: NativeClassDef = {
  name: 'java/util/GregorianCalendar',
  super: 'java/util/Calendar',
  methods: {
    '<init>()V': (_t, [self]) => {
      self.n = BigInt(Date.now());
    },
    '<init>(III)V': (_t, [self, y, m, d]) => {
      self.n = BigInt(new Date(y, m, d, 0, 0, 0, 0).getTime());
    },
    '<init>(IIII)V': (_t, [self, y, m, d, h]) => {
      self.n = BigInt(new Date(y, m, d, h, 0, 0, 0).getTime());
    },
    '<init>(IIIII)V': (_t, [self, y, m, d, h, mi]) => {
      self.n = BigInt(new Date(y, m, d, h, mi, 0, 0).getTime());
    },
    '<init>(IIIIII)V': (_t, [self, y, m, d, h, mi, s]) => {
      self.n = BigInt(new Date(y, m, d, h, mi, s, 0).getTime());
    },
    '<init>(IIIIIII)V': (_t, [self, y, m, d, h, mi, s, ms]) => {
      self.n = BigInt(new Date(y, m, d, h, mi, s, ms).getTime());
    },
    '<init>(Ljava/util/TimeZone;)V': (_t, [self]) => {
      self.n = BigInt(Date.now());
    },
    '<init>(Ljava/util/Locale;)V': (_t, [self]) => {
      self.n = BigInt(Date.now());
    },
    'isLeapYear(I)Z': (_t, [_s, y]) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0,
    'getActualMaximum(I)I': (_t, [_s, field]) => maxFor(field, false),
    'getActualMinimum(I)I': (_t, [_s, field]) => minFor(field),
    'getMaximum(I)I': (_t, [_s, field]) => maxFor(field, false),
    'getMinimum(I)I': (_t, [_s, field]) => minFor(field),
  },
};

/** 各字段的自然取值范围（够用即可，时区固定 UTC+0 所以没有 DST 差异）。 */
function maxFor(field: number, _inDST: boolean): number {
  switch (field) {
    case CAL_FIELD.ERA:
      return 1;
    case CAL_FIELD.YEAR:
      return 292278994;
    case CAL_FIELD.MONTH:
      return 11;
    case CAL_FIELD.WEEK_OF_YEAR:
      return 53;
    case CAL_FIELD.WEEK_OF_MONTH:
      return 6;
    case CAL_FIELD.DAY_OF_MONTH:
      return 31;
    case CAL_FIELD.DAY_OF_YEAR:
      return 366;
    case CAL_FIELD.DAY_OF_WEEK:
      return 6;
    case CAL_FIELD.DAY_OF_WEEK_IN_MONTH:
      return 6;
    case CAL_FIELD.AM_PM:
      return 1;
    case CAL_FIELD.HOUR:
      return 11;
    case CAL_FIELD.HOUR_OF_DAY:
      return 23;
    case CAL_FIELD.MINUTE:
      return 59;
    case CAL_FIELD.SECOND:
      return 59;
    case CAL_FIELD.MILLISECOND:
      return 999;
    default:
      return 0;
  }
}

function minFor(field: number): number {
  switch (field) {
    case CAL_FIELD.DAY_OF_WEEK_IN_MONTH:
      return 1;
    default:
      return 0;
  }
}

/** 有些游戏会 new TimeZone()/getDefault()，给个固定 UTC 免得 NoClassDefFoundError。 */
const timeZoneClass: NativeClassDef = {
  name: 'java/util/TimeZone',
  statics: {
    'getDefault()Ljava/util/TimeZone;': (t) => {
      const tz = new JObject(t.jvm.loadClass('java/util/TimeZone'));
      tz.n = 'Etc/GMT';
      return tz;
    },
    'getTimeZone(Ljava/lang/String;)Ljava/util/TimeZone;': (t) => {
      const tz = new JObject(t.jvm.loadClass('java/util/TimeZone'));
      tz.n = 'Etc/GMT';
      return tz;
    },
  },
  methods: {
    'getID()Ljava/lang/String;': (_t, [self]) => (self.n as string) ?? 'Etc/GMT',
    'getOffset(I)I': () => 0,
    'getRawOffset()I': () => 0,
    'inDaylightTime()Z': () => false,
    'useDaylightTime()Z': () => false,
  },
};

interface TimerTaskPeer {
  cancelled: boolean;
  handle: ReturnType<typeof setTimeout> | null;
  running: boolean;
  lastRun: bigint;
}

function scheduleTask(t: JThread, timer: JObject, task: JObject, delay: number, period: number, fixedRate: boolean) {
  const jvm = t.jvm;
  if (task === null) throw jvm.npe();
  if (delay < 0 || period < 0) throw jvm.throwable('java/lang/IllegalArgumentException');
  if (timer.n.cancelled) throw jvm.throwable('java/lang/IllegalStateException', 'Timer already cancelled.');
  const peer = task.n as TimerTaskPeer;
  if (peer.handle !== null || peer.cancelled) throw jvm.throwable('java/lang/IllegalStateException', 'Task already scheduled or cancelled');
  timer.n.tasks.add(task);
  let next = performance.now() + delay;

  const fire = () => {
    if (peer.cancelled || timer.n.cancelled || jvm.halted) return;
    jvm.postEvent((et) => {
      if (peer.cancelled || peer.running) return false;
      const run = jvm.findVirtual(task.cls, 'run()V');
      if (!run) return false;
      peer.running = true;
      peer.lastRun = BigInt(Date.now());
      jvm.pushCall(et, run, [task], () => {
        peer.running = false;
      });
      return true;
    });
    if (period > 0) {
      next = fixedRate ? next + period : performance.now() + period;
      peer.handle = setTimeout(fire, Math.max(0, next - performance.now()));
    } else {
      peer.handle = null;
      timer.n.tasks.delete(task);
    }
  };
  peer.handle = setTimeout(fire, delay);
}

const timerClass: NativeClassDef = {
  name: 'java/util/Timer',
  methods: {
    '<init>()V': (_t, [self]) => {
      self.n = { cancelled: false, tasks: new Set<JObject>() };
    },
    'schedule(Ljava/util/TimerTask;J)V': (t, [self, task, delay]) => scheduleTask(t, self, task, Number(delay), 0, false),
    'schedule(Ljava/util/TimerTask;JJ)V': (t, [self, task, delay, period]) => {
      if (period <= 0n) throw t.jvm.throwable('java/lang/IllegalArgumentException');
      scheduleTask(t, self, task, Number(delay), Number(period), false);
    },
    'scheduleAtFixedRate(Ljava/util/TimerTask;JJ)V': (t, [self, task, delay, period]) => {
      if (period <= 0n) throw t.jvm.throwable('java/lang/IllegalArgumentException');
      scheduleTask(t, self, task, Number(delay), Number(period), true);
    },
    'schedule(Ljava/util/TimerTask;Ljava/util/Date;)V': (t, [self, task, date]) =>
      scheduleTask(t, self, task, Math.max(0, Number(date.n) - Date.now()), 0, false),
    'cancel()V': (_t, [self]) => {
      self.n.cancelled = true;
      for (const task of self.n.tasks as Set<JObject>) {
        const peer = task.n as TimerTaskPeer;
        if (peer.handle !== null) clearTimeout(peer.handle);
        peer.handle = null;
      }
      self.n.tasks.clear();
    },
  },
};

const timerTaskClass: NativeClassDef = {
  name: 'java/util/TimerTask',
  interfaces: ['java/lang/Runnable'],
  flags: ACC_ABSTRACT,
  methods: {
    '<init>()V': (_t, [self]) => {
      self.n = { cancelled: false, handle: null, running: false, lastRun: 0n } satisfies TimerTaskPeer;
    },
    'cancel()Z': (_t, [self]) => {
      const peer = self.n as TimerTaskPeer;
      const wasScheduled = peer.handle !== null && !peer.cancelled;
      peer.cancelled = true;
      if (peer.handle !== null) clearTimeout(peer.handle);
      peer.handle = null;
      return wasScheduled;
    },
    'scheduledExecutionTime()J': (_t, [self]) => (self.n as TimerTaskPeer).lastRun,
  },
};

export const utilNatives: NativeClassDef[] = [
  randomClass,
  vectorClass,
  stackClass,
  { name: 'java/util/Enumeration', flags: ACC_INTERFACE | ACC_ABSTRACT },
  nativeEnumeration,
  hashtableClass,
  dateClass,
  calendarClass,
  gregorianCalendarClass,
  timeZoneClass,
  timerClass,
  timerTaskClass,
];

export { JArray };
