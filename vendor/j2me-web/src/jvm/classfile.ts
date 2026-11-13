// Java class file parser (JVM spec §4), enough for CLDC/MIDP bytecode (class versions 45-50).

export const CP_UTF8 = 1;
export const CP_INTEGER = 3;
export const CP_FLOAT = 4;
export const CP_LONG = 5;
export const CP_DOUBLE = 6;
export const CP_CLASS = 7;
export const CP_STRING = 8;
export const CP_FIELDREF = 9;
export const CP_METHODREF = 10;
export const CP_INTERFACE_METHODREF = 11;
export const CP_NAME_AND_TYPE = 12;
export const CP_METHOD_HANDLE = 15;
export const CP_METHOD_TYPE = 16;
export const CP_INVOKE_DYNAMIC = 18;

export const ACC_PUBLIC = 0x0001;
export const ACC_PRIVATE = 0x0002;
export const ACC_STATIC = 0x0008;
export const ACC_FINAL = 0x0010;
export const ACC_SYNCHRONIZED = 0x0020;
export const ACC_NATIVE = 0x0100;
export const ACC_INTERFACE = 0x0200;
export const ACC_ABSTRACT = 0x0400;

export interface ConstantPool {
  tags: Uint8Array;
  /**
   * Utf8 → string, Integer/Float/Double → number, Long → bigint,
   * Class → name index, String → utf8 index, *ref / NameAndType → [a, b].
   */
  values: unknown[];
}

export interface ExceptionHandler {
  startPc: number;
  endPc: number;
  handlerPc: number;
  catchType: string | null;
}

export interface CodeAttribute {
  maxStack: number;
  maxLocals: number;
  code: Uint8Array;
  handlers: ExceptionHandler[];
}

export interface FieldInfo {
  access: number;
  name: string;
  desc: string;
  /** Constant pool index of the ConstantValue attribute, 0 if none. */
  constantValue: number;
}

export interface MethodInfo {
  access: number;
  name: string;
  desc: string;
  code: CodeAttribute | null;
}

export interface ClassFile {
  major: number;
  minor: number;
  cp: ConstantPool;
  access: number;
  name: string;
  superName: string | null;
  interfaces: string[];
  fields: FieldInfo[];
  methods: MethodInfo[];
}

export class ClassFormatError extends Error {}

class Reader {
  private readonly view: DataView;
  pos = 0;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u1(): number {
    return this.view.getUint8(this.pos++);
  }

  u2(): number {
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }

  u4(): number {
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }

  i4(): number {
    const v = this.view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }

  f4(): number {
    const v = this.view.getFloat32(this.pos);
    this.pos += 4;
    return v;
  }

  i8(): bigint {
    const v = this.view.getBigInt64(this.pos);
    this.pos += 8;
    return v;
  }

  f8(): number {
    const v = this.view.getFloat64(this.pos);
    this.pos += 8;
    return v;
  }

  slice(len: number): Uint8Array {
    const out = this.bytes.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
}

/** Decodes "modified UTF-8" as used in class files. */
export function decodeModifiedUtf8(bytes: Uint8Array): string {
  let out = '';
  let chunk: number[] = [];
  for (let i = 0; i < bytes.length; ) {
    const a = bytes[i++];
    let c: number;
    if (a < 0x80) {
      c = a;
    } else if ((a & 0xe0) === 0xc0) {
      c = ((a & 0x1f) << 6) | (bytes[i++] & 0x3f);
    } else {
      const b = bytes[i++];
      c = ((a & 0x0f) << 12) | ((b & 0x3f) << 6) | (bytes[i++] & 0x3f);
    }
    chunk.push(c);
    if (chunk.length >= 4096) {
      out += String.fromCharCode(...chunk);
      chunk = [];
    }
  }
  return out + String.fromCharCode(...chunk);
}

export function parseClassFile(bytes: Uint8Array): ClassFile {
  const r = new Reader(bytes);
  if (r.u4() !== 0xcafebabe) throw new ClassFormatError('Bad class file magic');
  const minor = r.u2();
  const major = r.u2();

  const cpCount = r.u2();
  const tags = new Uint8Array(cpCount);
  const values: unknown[] = new Array(cpCount);
  for (let i = 1; i < cpCount; i++) {
    const tag = r.u1();
    tags[i] = tag;
    switch (tag) {
      case CP_UTF8:
        values[i] = decodeModifiedUtf8(r.slice(r.u2()));
        break;
      case CP_INTEGER:
        values[i] = r.i4();
        break;
      case CP_FLOAT:
        values[i] = r.f4();
        break;
      case CP_LONG:
        values[i] = r.i8();
        i++;
        break;
      case CP_DOUBLE:
        values[i] = r.f8();
        i++;
        break;
      case CP_CLASS:
      case CP_STRING:
      case CP_METHOD_TYPE:
        values[i] = r.u2();
        break;
      case CP_FIELDREF:
      case CP_METHODREF:
      case CP_INTERFACE_METHODREF:
      case CP_NAME_AND_TYPE:
      case CP_INVOKE_DYNAMIC:
        values[i] = [r.u2(), r.u2()];
        break;
      case CP_METHOD_HANDLE:
        values[i] = [r.u1(), r.u2()];
        break;
      default:
        throw new ClassFormatError(`Unknown constant pool tag ${tag} at #${i}`);
    }
  }
  const cp: ConstantPool = { tags, values };

  const access = r.u2();
  const name = cpClassName(cp, r.u2());
  const superIndex = r.u2();
  const superName = superIndex ? cpClassName(cp, superIndex) : null;
  const interfaces: string[] = [];
  for (let n = r.u2(); n > 0; n--) interfaces.push(cpClassName(cp, r.u2()));

  const fields: FieldInfo[] = [];
  for (let n = r.u2(); n > 0; n--) {
    const field: FieldInfo = { access: r.u2(), name: cpUtf8(cp, r.u2()), desc: cpUtf8(cp, r.u2()), constantValue: 0 };
    for (let a = r.u2(); a > 0; a--) {
      const attrName = cpUtf8(cp, r.u2());
      const len = r.u4();
      const end = r.pos + len;
      if (attrName === 'ConstantValue') field.constantValue = r.u2();
      r.pos = end;
    }
    fields.push(field);
  }

  const methods: MethodInfo[] = [];
  for (let n = r.u2(); n > 0; n--) {
    const method: MethodInfo = { access: r.u2(), name: cpUtf8(cp, r.u2()), desc: cpUtf8(cp, r.u2()), code: null };
    for (let a = r.u2(); a > 0; a--) {
      const attrName = cpUtf8(cp, r.u2());
      const len = r.u4();
      const end = r.pos + len;
      if (attrName === 'Code') {
        const maxStack = r.u2();
        const maxLocals = r.u2();
        const code = r.slice(r.u4());
        const handlers: ExceptionHandler[] = [];
        for (let h = r.u2(); h > 0; h--) {
          const startPc = r.u2();
          const endPc = r.u2();
          const handlerPc = r.u2();
          const typeIndex = r.u2();
          handlers.push({ startPc, endPc, handlerPc, catchType: typeIndex ? cpClassName(cp, typeIndex) : null });
        }
        method.code = { maxStack, maxLocals, code, handlers };
      }
      r.pos = end;
    }
    methods.push(method);
  }

  return { major, minor, cp, access, name, superName, interfaces, fields, methods };
}

export function cpUtf8(cp: ConstantPool, index: number): string {
  if (cp.tags[index] !== CP_UTF8) throw new ClassFormatError(`#${index} is not Utf8`);
  return cp.values[index] as string;
}

export function cpClassName(cp: ConstantPool, index: number): string {
  if (cp.tags[index] !== CP_CLASS) throw new ClassFormatError(`#${index} is not a Class`);
  return cpUtf8(cp, cp.values[index] as number);
}

export function cpNameAndType(cp: ConstantPool, index: number): { name: string; desc: string } {
  const [nameIndex, descIndex] = cp.values[index] as [number, number];
  return { name: cpUtf8(cp, nameIndex), desc: cpUtf8(cp, descIndex) };
}

export interface MemberRef {
  className: string;
  name: string;
  desc: string;
}

export function cpMemberRef(cp: ConstantPool, index: number): MemberRef {
  const tag = cp.tags[index];
  if (tag !== CP_FIELDREF && tag !== CP_METHODREF && tag !== CP_INTERFACE_METHODREF) {
    throw new ClassFormatError(`#${index} is not a member ref`);
  }
  const [classIndex, natIndex] = cp.values[index] as [number, number];
  return { className: cpClassName(cp, classIndex), ...cpNameAndType(cp, natIndex) };
}

export function cpString(cp: ConstantPool, index: number): string {
  return cpUtf8(cp, cp.values[index] as number);
}
