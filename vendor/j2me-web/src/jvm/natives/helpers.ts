import type { JThread, Jvm } from '../jvm';
import { JArray, JObject, type JRef } from '../types';

export const INT_MIN = -2147483648;
export const INT_MAX = 2147483647;

export function stringHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

export function javaHashCode(t: JThread, value: JRef): number {
  if (value === null) return 0;
  if (typeof value === 'string') return stringHash(value);
  const jvm = t.jvm;
  const m = jvm.findVirtual(jvm.classOf(value), 'hashCode()I');
  return m ? (jvm.invokeSync(t, m, [value]) as number) : jvm.identityHash(value);
}

export function javaEquals(t: JThread, a: JRef, b: JRef): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a === 'string') return false;
  const jvm = t.jvm;
  const m = jvm.findVirtual(jvm.classOf(a), 'equals(Ljava/lang/Object;)Z');
  return m ? jvm.invokeSync(t, m, [a, b]) === 1 : false;
}

export function checkArrayRange(jvm: Jvm, arr: JArray | null, offset: number, length: number): JArray {
  if (arr === null) throw jvm.npe();
  if (offset < 0 || length < 0 || offset + length > arr.d.length) {
    throw jvm.throwable('java/lang/ArrayIndexOutOfBoundsException', `offset ${offset}, length ${length}, size ${arr.d.length}`);
  }
  return arr;
}

function normalizeEncoding(encoding: string): string {
  const e = encoding.toLowerCase().replace(/[_\s]/g, '-');
  if (e === 'iso-8859-1' || e === 'iso8859-1' || e === 'latin1' || e === 'us-ascii' || e === 'ascii') return 'latin1';
  if (e === 'utf8') return 'utf-8';
  if (e === 'ksc5601' || e === 'ks-c-5601-1987' || e === 'euc-kr' || e === 'cp949' || e === 'ms949') return 'euc-kr';
  if (e === 'sjis' || e === 'shift-jis' || e === 'shift_jis') return 'shift_jis';
  if (e === 'unicodebig' || e === 'utf-16') return 'utf-16be';
  return e;
}

export function isSupportedEncoding(encoding: string): boolean {
  const e = normalizeEncoding(encoding);
  if (e === 'latin1') return true;
  try {
    new TextDecoder(e);
    return true;
  } catch {
    return false;
  }
}

export function decodeBytes(bytes: Int8Array | Uint8Array, encoding: string): string {
  const e = normalizeEncoding(encoding);
  const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (e === 'latin1') {
    let out = '';
    for (let i = 0; i < u8.length; i += 4096) out += String.fromCharCode(...u8.subarray(i, i + 4096));
    return out;
  }
  return new TextDecoder(e).decode(u8);
}

export function encodeString(s: string, encoding: string): Int8Array {
  const e = normalizeEncoding(encoding);
  if (e === 'utf-8') {
    const u8 = new TextEncoder().encode(s);
    return new Int8Array(u8.buffer, u8.byteOffset, u8.byteLength);
  }
  const out = new Int8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i] = c < 256 ? c : 63;
  }
  return out;
}

/** Java's Float.toString / Double.toString formatting. */
export function floatToString(v: number, isFloat: boolean): string {
  if (v !== v) return 'NaN';
  if (v === Infinity) return 'Infinity';
  if (v === -Infinity) return '-Infinity';
  if (v === 0) return 1 / v < 0 ? '-0.0' : '0.0';
  let repr = String(v);
  if (isFloat) {
    for (let p = 1; p <= 9; p++) {
      const candidate = v.toPrecision(p);
      if (Math.fround(Number(candidate)) === v) {
        repr = String(Number(candidate));
        break;
      }
    }
  }
  const abs = Math.abs(v);
  if (abs >= 1e-3 && abs < 1e7) return repr.includes('.') || repr.includes('e') ? repr : `${repr}.0`;
  const [mantissa, exp] = Number(repr).toExponential().split('e');
  return `${mantissa.includes('.') ? mantissa : `${mantissa}.0`}E${Number(exp)}`;
}

export function charsToString(arr: JArray, offset = 0, count = arr.d.length - offset): string {
  const d = arr.d as Uint16Array;
  let out = '';
  for (let i = offset; i < offset + count; i += 4096) {
    out += String.fromCharCode(...d.subarray(i, Math.min(i + 4096, offset + count)));
  }
  return out;
}

export function stringToChars(s: string): JArray {
  const d = new Uint16Array(s.length);
  for (let i = 0; i < s.length; i++) d[i] = s.charCodeAt(i);
  return new JArray('[C', d);
}

/** Creates a native-backed object of a platform class and attaches its peer state. */
export function newNativeObject(jvm: Jvm, className: string, peer: unknown): JObject {
  const obj = new JObject(jvm.loadClass(className));
  obj.n = peer;
  return obj;
}

export function base64FromBytes(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 4096) bin += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return btoa(bin);
}

export function bytesFromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
