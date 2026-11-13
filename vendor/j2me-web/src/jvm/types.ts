import type { JThread, RuntimeClass } from './jvm';

/** Second slot of a long/double on the operand stack or in locals (JVM "category 2" values). */
export const TOP: unique symbol = Symbol('TOP');

export type ArrayData =
  | Int8Array
  | Uint16Array
  | Int16Array
  | Int32Array
  | BigInt64Array
  | Float32Array
  | Float64Array
  | JRef[];

/** java.lang.String values are plain JS strings. */
export type JRef = JObject | JArray | string | null;
export type JValue = number | bigint | JRef | typeof TOP;

export class Monitor {
  owner: JThread | null = null;
  count = 0;
  waitSet: JThread[] = [];
}

export class JObject {
  f: JValue[];
  /** Native peer state for platform classes (Graphics, Image, Thread, ...). */
  n: any = null;
  mon: Monitor | null = null;
  hash = 0;

  constructor(readonly cls: RuntimeClass) {
    this.f = cls.fieldDefaults.length ? cls.fieldDefaults.slice() : [];
  }
}

export class JArray {
  mon: Monitor | null = null;
  hash = 0;

  /** @param type array descriptor, e.g. "[I" or "[Ljava/lang/String;" */
  constructor(
    readonly type: string,
    readonly d: ArrayData,
  ) {}
}

/** Placeholder pushed by `new java/lang/String`; replaced by a JS string when <init> runs. */
export class UninitString {}

/** A Java exception travelling through JS code. Deliberately not an Error (no costly stack capture). */
export class JavaThrow {
  constructor(readonly obj: JObject) {}
}

/** Returned by natives that parked the current thread (sleep, wait, serviceRepaints...). */
export const BLOCK: unique symbol = Symbol('BLOCK');
/** Returned by natives that already pushed a Java frame and arranged the caller's stack themselves. */
export const INVOKED: unique symbol = Symbol('INVOKED');

export type NativeResult = JValue | boolean | void | typeof BLOCK | typeof INVOKED;
export type NativeImpl = (t: JThread, args: any[]) => NativeResult;

export function newArray(type: string, length: number): JArray {
  switch (type) {
    case '[Z':
    case '[B':
      return new JArray(type, new Int8Array(length));
    case '[C':
      return new JArray(type, new Uint16Array(length));
    case '[S':
      return new JArray(type, new Int16Array(length));
    case '[I':
      return new JArray(type, new Int32Array(length));
    case '[J':
      return new JArray(type, new BigInt64Array(length));
    case '[F':
      return new JArray(type, new Float32Array(length));
    case '[D':
      return new JArray(type, new Float64Array(length));
    default:
      return new JArray(type, new Array<JRef>(length).fill(null));
  }
}

export function byteArray(bytes: Uint8Array | Int8Array | number[]): JArray {
  const arr = new Int8Array(bytes.length);
  arr.set(bytes as ArrayLike<number>);
  return new JArray('[B', arr);
}

export function defaultValue(desc: string): JValue {
  switch (desc[0]) {
    case 'J':
      return 0n;
    case 'L':
    case '[':
      return null;
    default:
      return 0;
  }
}
