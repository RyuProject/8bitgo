import { ACC_ABSTRACT, ACC_INTERFACE, ACC_SYNCHRONIZED, cpClassName } from './classfile';
import type { JMethod, Jvm, RuntimeClass, StaticFieldRef } from './jvm';
import { constructString } from './natives/lang';
import { Frame, type JThread, RUNNABLE } from './thread';
import { BLOCK, INVOKED, JArray, JavaThrow, JObject, type JRef, type JValue, TOP, UninitString, newArray } from './types';

const PRIMITIVE_ARRAY: Record<number, string> = { 4: '[Z', 5: '[C', 6: '[F', 7: '[D', 8: '[B', 9: '[S', 10: '[I', 11: '[J' };

const INT_MAX = 2147483647;
const INT_MIN = -2147483648;
const LONG_MAX = 9223372036854775807n;
const LONG_MIN = -9223372036854775808n;

function s4(code: Uint8Array, p: number): number {
  return (code[p] << 24) | (code[p + 1] << 16) | (code[p + 2] << 8) | code[p + 3];
}

function toInt(v: number): number {
  if (v !== v) return 0;
  if (v >= INT_MAX) return INT_MAX;
  if (v <= INT_MIN) return INT_MIN;
  return v | 0;
}

function toLong(v: number): bigint {
  if (v !== v) return 0n;
  if (v >= 9223372036854775807) return LONG_MAX;
  if (v <= -9223372036854775808) return LONG_MIN;
  return BigInt(Math.trunc(v));
}

function fcmp(a: number, b: number, nanResult: number): number {
  if (a > b) return 1;
  if (a < b) return -1;
  if (a === b) return 0;
  return nanResult;
}

function arrayCheck(jvm: Jvm, arr: JArray | null, index: number): JArray {
  if (arr === null) throw jvm.npe('array is null');
  if (index >>> 0 >= arr.d.length) {
    throw jvm.throwable('java/lang/ArrayIndexOutOfBoundsException', String(index));
  }
  return arr;
}

function multiArray(jvm: Jvm, type: string, counts: number[], depth: number): JArray {
  const len = counts[depth];
  if (len < 0) throw jvm.throwable('java/lang/NegativeArraySizeException', String(len));
  const arr = newArray(type, len);
  if (depth + 1 < counts.length) {
    const sub = type.slice(1);
    const data = arr.d as JRef[];
    for (let i = 0; i < len; i++) data[i] = multiArray(jvm, sub, counts, depth + 1);
  }
  return arr;
}

const CONTINUE = 0;
const LEAVE = 1;
const RETRY = 2;

/**
 * Calls `m` with arguments taken from `frame.stack[base..]`.
 * CONTINUE: keep running this frame. LEAVE: a frame was pushed or the thread parked (resume after the call).
 * RETRY: the call could not start yet (monitor busy); re-execute the invoke instruction later.
 */
function invoke(t: JThread, jvm: Jvm, frame: Frame, m: JMethod, base: number, pc: number, opPc: number): number {
  const stack = frame.stack;
  frame.pc = pc;
  frame.opPc = opPc;

  if (m.impl !== null) {
    const args: JValue[] = [];
    for (let i = base; i < stack.length; i++) {
      const v = stack[i];
      if (v !== TOP) args.push(v);
    }
    stack.length = base;
    const r = m.impl(t, args);
    if (r === BLOCK || r === INVOKED) return LEAVE;
    if (m.retSlots !== 0) {
      let v: JValue;
      if (r === undefined) v = m.ret[0] === 'L' || m.ret[0] === '[' ? null : m.ret === 'J' ? 0n : 0;
      else if (typeof r === 'boolean') v = r ? 1 : 0;
      else v = r as JValue;
      stack.push(v);
      if (m.retSlots === 2) stack.push(TOP);
    }
    return t.state !== RUNNABLE || t.frames[t.frames.length - 1] !== frame ? LEAVE : CONTINUE;
  }

  if (m.code === null) {
    throw jvm.throwable('java/lang/AbstractMethodError', `${m.cls.name}.${m.key}`);
  }

  let lock = null;
  if (m.flags & ACC_SYNCHRONIZED) {
    lock = jvm.monitorOf(m.isStatic ? jvm.classObject(m.cls) : (stack[base] as JRef));
    if (!jvm.tryEnter(t, lock)) return RETRY;
  }

  const callee = new Frame(m);
  callee.lock = lock;
  const locals = callee.locals;
  for (let i = base, j = 0; i < stack.length; i++, j++) locals[j] = stack[i];
  stack.length = base;
  t.frames.push(callee);
  return LEAVE;
}

/** Special case for `new String(...)`: strings are immutable JS values, so we swap the placeholder. */
function initString(t: JThread, frame: Frame, desc: string, base: number): void {
  const stack = frame.stack;
  const placeholder = stack[base];
  const args: JValue[] = [];
  for (let i = base + 1; i < stack.length; i++) if (stack[i] !== TOP) args.push(stack[i]);
  stack.length = base;
  const value = constructString(t, desc, args);
  for (let i = 0; i < stack.length; i++) if (stack[i] === placeholder) stack[i] = value;
  const locals = frame.locals;
  for (let i = 0; i < locals.length; i++) if (locals[i] === placeholder) locals[i] = value;
}

export function execute(t: JThread, budget: number): void {
  const jvm = t.jvm;

  while (budget > 0 && t.state === RUNNABLE && t.frames.length > 0) {
    const frame = t.frames[t.frames.length - 1];
    const method = frame.method;
    const code = method.code!.code;
    const cls: RuntimeClass = method.cls;
    const cp = cls.cf!.cp;
    const cache = cls.cpCache;
    const stack = frame.stack;
    const locals = frame.locals;
    let pc = frame.pc;
    let opPc = pc;

    try {
      run: while (budget-- > 0) {
        opPc = pc;
        const op = code[pc++];
        switch (op) {
          case 0x00: // nop
            break;
          case 0x01: // aconst_null
            stack.push(null);
            break;
          case 0x02: case 0x03: case 0x04: case 0x05: case 0x06: case 0x07: case 0x08: // iconst_m1..5
            stack.push(op - 3);
            break;
          case 0x09: // lconst_0
            stack.push(0n, TOP);
            break;
          case 0x0a: // lconst_1
            stack.push(1n, TOP);
            break;
          case 0x0b: case 0x0c: case 0x0d: // fconst_0..2
            stack.push(op - 0x0b);
            break;
          case 0x0e: case 0x0f: // dconst_0..1
            stack.push(op - 0x0e, TOP);
            break;
          case 0x10: // bipush
            stack.push((code[pc++] << 24) >> 24);
            break;
          case 0x11: // sipush
            stack.push(((code[pc] << 24) >> 16) | code[pc + 1]);
            pc += 2;
            break;
          case 0x12: // ldc
            stack.push(jvm.loadConstant(cls, code[pc++]));
            break;
          case 0x13: // ldc_w
            stack.push(jvm.loadConstant(cls, (code[pc] << 8) | code[pc + 1]));
            pc += 2;
            break;
          case 0x14: // ldc2_w
            stack.push(cp.values[(code[pc] << 8) | code[pc + 1]] as number | bigint, TOP);
            pc += 2;
            break;

          case 0x15: case 0x17: case 0x19: // iload, fload, aload
            stack.push(locals[code[pc++]]);
            break;
          case 0x16: case 0x18: // lload, dload
            stack.push(locals[code[pc++]], TOP);
            break;
          case 0x1a: case 0x1b: case 0x1c: case 0x1d:
            stack.push(locals[op - 0x1a]);
            break;
          case 0x1e: case 0x1f: case 0x20: case 0x21:
            stack.push(locals[op - 0x1e], TOP);
            break;
          case 0x22: case 0x23: case 0x24: case 0x25:
            stack.push(locals[op - 0x22]);
            break;
          case 0x26: case 0x27: case 0x28: case 0x29:
            stack.push(locals[op - 0x26], TOP);
            break;
          case 0x2a: case 0x2b: case 0x2c: case 0x2d:
            stack.push(locals[op - 0x2a]);
            break;

          case 0x2e: case 0x30: case 0x32: case 0x33: case 0x34: case 0x35: { // iaload faload aaload baload caload saload
            const i = stack.pop() as number;
            const a = arrayCheck(jvm, stack.pop() as JArray, i);
            stack.push(a.d[i] as JValue);
            break;
          }
          case 0x2f: case 0x31: { // laload daload
            const i = stack.pop() as number;
            const a = arrayCheck(jvm, stack.pop() as JArray, i);
            stack.push(a.d[i] as JValue, TOP);
            break;
          }

          case 0x36: case 0x38: case 0x3a: // istore fstore astore
            locals[code[pc++]] = stack.pop()!;
            break;
          case 0x37: case 0x39: { // lstore dstore
            stack.pop();
            const idx = code[pc++];
            locals[idx] = stack.pop()!;
            locals[idx + 1] = TOP;
            break;
          }
          case 0x3b: case 0x3c: case 0x3d: case 0x3e:
            locals[op - 0x3b] = stack.pop()!;
            break;
          case 0x3f: case 0x40: case 0x41: case 0x42:
            stack.pop();
            locals[op - 0x3f] = stack.pop()!;
            locals[op - 0x3f + 1] = TOP;
            break;
          case 0x43: case 0x44: case 0x45: case 0x46:
            locals[op - 0x43] = stack.pop()!;
            break;
          case 0x47: case 0x48: case 0x49: case 0x4a:
            stack.pop();
            locals[op - 0x47] = stack.pop()!;
            locals[op - 0x47 + 1] = TOP;
            break;
          case 0x4b: case 0x4c: case 0x4d: case 0x4e:
            locals[op - 0x4b] = stack.pop()!;
            break;

          case 0x4f: case 0x51: case 0x53: case 0x54: case 0x55: case 0x56: { // iastore fastore aastore bastore castore sastore
            const v = stack.pop();
            const i = stack.pop() as number;
            const a = arrayCheck(jvm, stack.pop() as JArray, i);
            (a.d as any)[i] = v;
            break;
          }
          case 0x50: case 0x52: { // lastore dastore
            stack.pop();
            const v = stack.pop();
            const i = stack.pop() as number;
            const a = arrayCheck(jvm, stack.pop() as JArray, i);
            (a.d as any)[i] = v;
            break;
          }

          case 0x57: // pop
            stack.pop();
            break;
          case 0x58: // pop2
            stack.length -= 2;
            break;
          case 0x59: // dup
            stack.push(stack[stack.length - 1]);
            break;
          case 0x5a: { // dup_x1
            const v1 = stack.pop()!;
            const v2 = stack.pop()!;
            stack.push(v1, v2, v1);
            break;
          }
          case 0x5b: { // dup_x2
            const v1 = stack.pop()!;
            const v2 = stack.pop()!;
            const v3 = stack.pop()!;
            stack.push(v1, v3, v2, v1);
            break;
          }
          case 0x5c: { // dup2
            const n = stack.length;
            stack.push(stack[n - 2], stack[n - 1]);
            break;
          }
          case 0x5d: { // dup2_x1
            const v1 = stack.pop()!;
            const v2 = stack.pop()!;
            const v3 = stack.pop()!;
            stack.push(v2, v1, v3, v2, v1);
            break;
          }
          case 0x5e: { // dup2_x2
            const v1 = stack.pop()!;
            const v2 = stack.pop()!;
            const v3 = stack.pop()!;
            const v4 = stack.pop()!;
            stack.push(v2, v1, v4, v3, v2, v1);
            break;
          }
          case 0x5f: { // swap
            const v1 = stack.pop()!;
            const v2 = stack.pop()!;
            stack.push(v1, v2);
            break;
          }

          // ---- int arithmetic
          case 0x60: { const b = stack.pop() as number; const n = stack.length - 1; stack[n] = ((stack[n] as number) + b) | 0; break; }
          case 0x64: { const b = stack.pop() as number; const n = stack.length - 1; stack[n] = ((stack[n] as number) - b) | 0; break; }
          case 0x68: { const b = stack.pop() as number; const n = stack.length - 1; stack[n] = Math.imul(stack[n] as number, b); break; }
          case 0x6c: {
            const b = stack.pop() as number;
            if (b === 0) throw jvm.throwable('java/lang/ArithmeticException', '/ by zero');
            const n = stack.length - 1;
            stack[n] = ((stack[n] as number) / b) | 0;
            break;
          }
          case 0x70: {
            const b = stack.pop() as number;
            if (b === 0) throw jvm.throwable('java/lang/ArithmeticException', '/ by zero');
            const n = stack.length - 1;
            stack[n] = ((stack[n] as number) % b) | 0;
            break;
          }
          case 0x74: { const n = stack.length - 1; stack[n] = -(stack[n] as number) | 0; break; }
          case 0x78: { const b = stack.pop() as number; const n = stack.length - 1; stack[n] = (stack[n] as number) << b; break; }
          case 0x7a: { const b = stack.pop() as number; const n = stack.length - 1; stack[n] = (stack[n] as number) >> b; break; }
          case 0x7c: { const b = stack.pop() as number; const n = stack.length - 1; stack[n] = ((stack[n] as number) >>> b) | 0; break; }
          case 0x7e: { const b = stack.pop() as number; const n = stack.length - 1; stack[n] = (stack[n] as number) & b; break; }
          case 0x80: { const b = stack.pop() as number; const n = stack.length - 1; stack[n] = (stack[n] as number) | b; break; }
          case 0x82: { const b = stack.pop() as number; const n = stack.length - 1; stack[n] = (stack[n] as number) ^ b; break; }

          // ---- long arithmetic (value, TOP pairs)
          case 0x61: case 0x65: case 0x69: case 0x6d: case 0x71: case 0x7f: case 0x81: case 0x83: {
            stack.pop();
            const b = stack.pop() as bigint;
            const n = stack.length - 2;
            const a = stack[n] as bigint;
            let r: bigint;
            switch (op) {
              case 0x61: r = a + b; break;
              case 0x65: r = a - b; break;
              case 0x69: r = a * b; break;
              case 0x6d:
                if (b === 0n) throw jvm.throwable('java/lang/ArithmeticException', '/ by zero');
                r = a / b;
                break;
              case 0x71:
                if (b === 0n) throw jvm.throwable('java/lang/ArithmeticException', '/ by zero');
                r = a % b;
                break;
              case 0x7f: r = a & b; break;
              case 0x81: r = a | b; break;
              default: r = a ^ b; break;
            }
            stack[n] = BigInt.asIntN(64, r);
            break;
          }
          case 0x75: { const n = stack.length - 2; stack[n] = BigInt.asIntN(64, -(stack[n] as bigint)); break; }
          case 0x79: case 0x7b: case 0x7d: { // lshl lshr lushr
            const s = BigInt((stack.pop() as number) & 63);
            const n = stack.length - 2;
            const a = stack[n] as bigint;
            stack[n] = op === 0x79 ? BigInt.asIntN(64, a << s) : op === 0x7b ? a >> s : BigInt.asIntN(64, BigInt.asUintN(64, a) >> s);
            break;
          }

          // ---- float arithmetic
          case 0x62: { const b = stack.pop() as number; const n = stack.length - 1; stack[n] = Math.fround((stack[n] as number) + b); break; }
          case 0x66: { const b = stack.pop() as number; const n = stack.length - 1; stack[n] = Math.fround((stack[n] as number) - b); break; }
          case 0x6a: { const b = stack.pop() as number; const n = stack.length - 1; stack[n] = Math.fround((stack[n] as number) * b); break; }
          case 0x6e: { const b = stack.pop() as number; const n = stack.length - 1; stack[n] = Math.fround((stack[n] as number) / b); break; }
          case 0x72: { const b = stack.pop() as number; const n = stack.length - 1; stack[n] = Math.fround((stack[n] as number) % b); break; }
          case 0x76: { const n = stack.length - 1; stack[n] = -(stack[n] as number); break; }

          // ---- double arithmetic
          case 0x63: case 0x67: case 0x6b: case 0x6f: case 0x73: {
            stack.pop();
            const b = stack.pop() as number;
            const n = stack.length - 2;
            const a = stack[n] as number;
            stack[n] = op === 0x63 ? a + b : op === 0x67 ? a - b : op === 0x6b ? a * b : op === 0x6f ? a / b : a % b;
            break;
          }
          case 0x77: { const n = stack.length - 2; stack[n] = -(stack[n] as number); break; }

          case 0x84: { // iinc
            const idx = code[pc];
            locals[idx] = ((locals[idx] as number) + ((code[pc + 1] << 24) >> 24)) | 0;
            pc += 2;
            break;
          }

          // ---- conversions
          case 0x85: { const n = stack.length - 1; stack[n] = BigInt(stack[n] as number); stack.push(TOP); break; } // i2l
          case 0x86: { const n = stack.length - 1; stack[n] = Math.fround(stack[n] as number); break; } // i2f
          case 0x87: stack.push(TOP); break; // i2d
          case 0x88: { stack.pop(); const n = stack.length - 1; stack[n] = Number(BigInt.asIntN(32, stack[n] as bigint)); break; } // l2i
          case 0x89: { stack.pop(); const n = stack.length - 1; stack[n] = Math.fround(Number(stack[n] as bigint)); break; } // l2f
          case 0x8a: { const n = stack.length - 2; stack[n] = Number(stack[n] as bigint); break; } // l2d
          case 0x8b: { const n = stack.length - 1; stack[n] = toInt(stack[n] as number); break; } // f2i
          case 0x8c: { const n = stack.length - 1; stack[n] = toLong(stack[n] as number); stack.push(TOP); break; } // f2l
          case 0x8d: stack.push(TOP); break; // f2d
          case 0x8e: { stack.pop(); const n = stack.length - 1; stack[n] = toInt(stack[n] as number); break; } // d2i
          case 0x8f: { const n = stack.length - 2; stack[n] = toLong(stack[n] as number); break; } // d2l
          case 0x90: { stack.pop(); const n = stack.length - 1; stack[n] = Math.fround(stack[n] as number); break; } // d2f
          case 0x91: { const n = stack.length - 1; stack[n] = ((stack[n] as number) << 24) >> 24; break; } // i2b
          case 0x92: { const n = stack.length - 1; stack[n] = (stack[n] as number) & 0xffff; break; } // i2c
          case 0x93: { const n = stack.length - 1; stack[n] = ((stack[n] as number) << 16) >> 16; break; } // i2s

          // ---- comparisons
          case 0x94: { // lcmp
            stack.pop();
            const b = stack.pop() as bigint;
            stack.pop();
            const a = stack.pop() as bigint;
            stack.push(a < b ? -1 : a > b ? 1 : 0);
            break;
          }
          case 0x95: case 0x96: { // fcmpl fcmpg
            const b = stack.pop() as number;
            const a = stack.pop() as number;
            stack.push(fcmp(a, b, op === 0x95 ? -1 : 1));
            break;
          }
          case 0x97: case 0x98: { // dcmpl dcmpg
            stack.pop();
            const b = stack.pop() as number;
            stack.pop();
            const a = stack.pop() as number;
            stack.push(fcmp(a, b, op === 0x97 ? -1 : 1));
            break;
          }

          // ---- branches
          case 0x99: case 0x9a: case 0x9b: case 0x9c: case 0x9d: case 0x9e: {
            const v = stack.pop() as number;
            const taken =
              op === 0x99 ? v === 0 : op === 0x9a ? v !== 0 : op === 0x9b ? v < 0 : op === 0x9c ? v >= 0 : op === 0x9d ? v > 0 : v <= 0;
            pc = taken ? opPc + (((code[pc] << 24) >> 16) | code[pc + 1]) : pc + 2;
            break;
          }
          case 0x9f: case 0xa0: case 0xa1: case 0xa2: case 0xa3: case 0xa4: {
            const b = stack.pop() as number;
            const a = stack.pop() as number;
            const taken =
              op === 0x9f ? a === b : op === 0xa0 ? a !== b : op === 0xa1 ? a < b : op === 0xa2 ? a >= b : op === 0xa3 ? a > b : a <= b;
            pc = taken ? opPc + (((code[pc] << 24) >> 16) | code[pc + 1]) : pc + 2;
            break;
          }
          case 0xa5: case 0xa6: {
            const b = stack.pop();
            const a = stack.pop();
            const taken = op === 0xa5 ? a === b : a !== b;
            pc = taken ? opPc + (((code[pc] << 24) >> 16) | code[pc + 1]) : pc + 2;
            break;
          }
          case 0xc6: case 0xc7: { // ifnull ifnonnull
            const v = stack.pop();
            const taken = op === 0xc6 ? v === null : v !== null;
            pc = taken ? opPc + (((code[pc] << 24) >> 16) | code[pc + 1]) : pc + 2;
            break;
          }
          case 0xa7: // goto
            pc = opPc + (((code[pc] << 24) >> 16) | code[pc + 1]);
            break;
          case 0xa8: // jsr
            stack.push(opPc + 3);
            pc = opPc + (((code[pc] << 24) >> 16) | code[pc + 1]);
            break;
          case 0xa9: // ret
            pc = locals[code[pc]] as number;
            break;
          case 0xc8: // goto_w
            pc = opPc + s4(code, pc);
            break;
          case 0xc9: // jsr_w
            stack.push(opPc + 5);
            pc = opPc + s4(code, pc);
            break;
          case 0xaa: { // tableswitch
            const p = (opPc + 4) & ~3;
            const key = stack.pop() as number;
            const low = s4(code, p + 4);
            const high = s4(code, p + 8);
            pc = opPc + (key < low || key > high ? s4(code, p) : s4(code, p + 12 + (key - low) * 4));
            break;
          }
          case 0xab: { // lookupswitch
            const p = (opPc + 4) & ~3;
            const key = stack.pop() as number;
            let target = s4(code, p);
            let lo = 0;
            let hi = s4(code, p + 4) - 1;
            while (lo <= hi) {
              const mid = (lo + hi) >> 1;
              const match = s4(code, p + 8 + mid * 8);
              if (key === match) {
                target = s4(code, p + 12 + mid * 8);
                break;
              }
              if (key < match) hi = mid - 1;
              else lo = mid + 1;
            }
            pc = opPc + target;
            break;
          }

          // ---- returns
          case 0xac: case 0xad: case 0xae: case 0xaf: case 0xb0: case 0xb1: {
            let value: JValue = null;
            const wide = op === 0xad || op === 0xaf;
            if (op !== 0xb1) {
              if (wide) stack.pop();
              value = stack.pop()!;
            }
            t.frames.pop();
            if (frame.lock) jvm.monitorExit(t, frame.lock);
            if (frame.onReturn) frame.onReturn(value);
            if (frame.syncBoundary) {
              t.syncResult = value;
              return;
            }
            if (op !== 0xb1 && t.frames.length > 0) {
              const caller = t.frames[t.frames.length - 1].stack;
              caller.push(value);
              if (wide) caller.push(TOP);
            }
            break run;
          }

          // ---- fields
          case 0xb2: case 0xb3: { // getstatic putstatic
            const idx = (code[pc] << 8) | code[pc + 1];
            pc += 2;
            let ref = cache[idx] as StaticFieldRef | undefined;
            if (ref === undefined) cache[idx] = ref = jvm.resolveStaticField(cls, idx);
            const decl = ref.cls;
            if (decl.initState !== 2 && !jvm.ensureInit(t, decl)) {
              pc = opPc;
              break run;
            }
            if (op === 0xb2) {
              stack.push(decl.statics[ref.slot]);
              if (ref.wide) stack.push(TOP);
            } else {
              if (ref.wide) stack.pop();
              decl.statics[ref.slot] = stack.pop()!;
            }
            break;
          }
          case 0xb4: { // getfield
            const idx = (code[pc] << 8) | code[pc + 1];
            pc += 2;
            let slot = cache[idx] as number | undefined;
            if (slot === undefined) cache[idx] = slot = jvm.resolveInstanceField(cls, idx);
            const n = stack.length - 1;
            const obj = stack[n] as JObject | null;
            if (obj === null) throw jvm.npe('getfield on null');
            stack[n] = obj.f[slot >> 1];
            if (slot & 1) stack.push(TOP);
            break;
          }
          case 0xb5: { // putfield
            const idx = (code[pc] << 8) | code[pc + 1];
            pc += 2;
            let slot = cache[idx] as number | undefined;
            if (slot === undefined) cache[idx] = slot = jvm.resolveInstanceField(cls, idx);
            if (slot & 1) stack.pop();
            const value = stack.pop()!;
            const obj = stack.pop() as JObject | null;
            if (obj === null) throw jvm.npe('putfield on null');
            obj.f[slot >> 1] = value;
            break;
          }

          // ---- invocations
          case 0xb6: case 0xb9: { // invokevirtual invokeinterface
            const idx = (code[pc] << 8) | code[pc + 1];
            pc += op === 0xb9 ? 4 : 2;
            const ref = jvm.resolveMethodRef(cls, idx);
            const base = stack.length - ref.argSlots - 1;
            const receiver = stack[base] as JRef;
            if (receiver === null) throw jvm.npe(`${ref.name}() on null`);
            const target = jvm.findVirtual(jvm.classOf(receiver), ref.key);
            if (target === null) throw jvm.throwable('java/lang/AbstractMethodError', `${jvm.classOf(receiver).name}.${ref.key}`);
            const r = invoke(t, jvm, frame, target, base, pc, opPc);
            if (r !== CONTINUE) {
              if (r === RETRY) pc = opPc;
              break run;
            }
            break;
          }
          case 0xb7: { // invokespecial
            const idx = (code[pc] << 8) | code[pc + 1];
            pc += 2;
            const ref = jvm.resolveMethodRef(cls, idx);
            if (ref.name === '<init>' && ref.className === 'java/lang/String') {
              initString(t, frame, ref.key.slice(6), stack.length - ref.argSlots - 1);
              break;
            }
            const m = jvm.resolveDirect(ref);
            const base = stack.length - m.argSlots - 1;
            if (stack[base] === null) throw jvm.npe(`${m.name}() on null`);
            const r = invoke(t, jvm, frame, m, base, pc, opPc);
            if (r !== CONTINUE) {
              if (r === RETRY) pc = opPc;
              break run;
            }
            break;
          }
          case 0xb8: { // invokestatic
            const idx = (code[pc] << 8) | code[pc + 1];
            pc += 2;
            const m = jvm.resolveDirect(jvm.resolveMethodRef(cls, idx));
            if (m.cls.initState !== 2 && !jvm.ensureInit(t, m.cls)) {
              pc = opPc;
              break run;
            }
            const r = invoke(t, jvm, frame, m, stack.length - m.argSlots, pc, opPc);
            if (r !== CONTINUE) {
              if (r === RETRY) pc = opPc;
              break run;
            }
            break;
          }
          case 0xba:
            throw jvm.throwable('java/lang/VerifyError', 'invokedynamic is not supported');

          // ---- objects and arrays
          case 0xbb: { // new
            const idx = (code[pc] << 8) | code[pc + 1];
            pc += 2;
            let c = cache[idx] as RuntimeClass | undefined;
            if (c === undefined) cache[idx] = c = jvm.loadClass(cpClassName(cp, idx));
            if (c.initState !== 2 && !jvm.ensureInit(t, c)) {
              pc = opPc;
              break run;
            }
            if (c === jvm.stringClass) {
              stack.push(new UninitString() as unknown as JValue);
            } else {
              if (c.flags & (ACC_ABSTRACT | ACC_INTERFACE)) throw jvm.throwable('java/lang/InstantiationError', c.name);
              stack.push(new JObject(c));
            }
            break;
          }
          case 0xbc: { // newarray
            const type = PRIMITIVE_ARRAY[code[pc++]];
            const len = stack.pop() as number;
            if (len < 0) throw jvm.throwable('java/lang/NegativeArraySizeException', String(len));
            stack.push(newArray(type, len));
            break;
          }
          case 0xbd: { // anewarray
            const name = cpClassName(cp, (code[pc] << 8) | code[pc + 1]);
            pc += 2;
            const len = stack.pop() as number;
            if (len < 0) throw jvm.throwable('java/lang/NegativeArraySizeException', String(len));
            stack.push(newArray(name[0] === '[' ? '[' + name : `[L${name};`, len));
            break;
          }
          case 0xc5: { // multianewarray
            const type = cpClassName(cp, (code[pc] << 8) | code[pc + 1]);
            const dims = code[pc + 2];
            pc += 3;
            const counts = stack.splice(stack.length - dims, dims) as number[];
            stack.push(multiArray(jvm, type, counts, 0));
            break;
          }
          case 0xbe: { // arraylength
            const a = stack.pop() as JArray | null;
            if (a === null) throw jvm.npe('arraylength on null');
            stack.push(a.d.length);
            break;
          }
          case 0xbf: { // athrow
            const ex = stack.pop() as JObject | null;
            if (ex === null) throw jvm.npe('throw null');
            throw new JavaThrow(ex);
          }
          case 0xc0: { // checkcast
            const v = stack[stack.length - 1] as JRef;
            const name = cpClassName(cp, (code[pc] << 8) | code[pc + 1]);
            pc += 2;
            if (v !== null && !jvm.isInstance(v, name)) {
              throw jvm.throwable('java/lang/ClassCastException', `${jvm.classOf(v).name} cannot be cast to ${name}`);
            }
            break;
          }
          case 0xc1: { // instanceof
            const v = stack.pop() as JRef;
            const name = cpClassName(cp, (code[pc] << 8) | code[pc + 1]);
            pc += 2;
            stack.push(jvm.isInstance(v, name) ? 1 : 0);
            break;
          }
          case 0xc2: { // monitorenter
            const v = stack[stack.length - 1] as JRef;
            if (!jvm.tryEnter(t, jvm.monitorOf(v))) {
              pc = opPc;
              break run;
            }
            stack.pop();
            break;
          }
          case 0xc3: // monitorexit
            jvm.monitorExit(t, jvm.monitorOf(stack.pop() as JRef));
            break;

          case 0xc4: { // wide
            const op2 = code[pc];
            const idx = (code[pc + 1] << 8) | code[pc + 2];
            if (op2 === 0x84) {
              locals[idx] = ((locals[idx] as number) + (((code[pc + 3] << 24) >> 16) | code[pc + 4])) | 0;
              pc += 5;
              break;
            }
            pc += 3;
            switch (op2) {
              case 0x15: case 0x17: case 0x19:
                stack.push(locals[idx]);
                break;
              case 0x16: case 0x18:
                stack.push(locals[idx], TOP);
                break;
              case 0x36: case 0x38: case 0x3a:
                locals[idx] = stack.pop()!;
                break;
              case 0x37: case 0x39:
                stack.pop();
                locals[idx] = stack.pop()!;
                locals[idx + 1] = TOP;
                break;
              case 0xa9:
                pc = locals[idx] as number;
                break;
              default:
                throw jvm.throwable('java/lang/VerifyError', `Bad wide opcode 0x${op2.toString(16)}`);
            }
            break;
          }

          default:
            throw jvm.throwable('java/lang/VerifyError', `Unknown opcode 0x${op.toString(16)} in ${cls.name}.${method.key}`);
        }
      }
      frame.pc = pc;
    } catch (e) {
      if (!(e instanceof JavaThrow)) throw e;
      frame.pc = pc;
      frame.opPc = opPc;
      jvm.throwInThread(t, e.obj);
    }
  }
}
