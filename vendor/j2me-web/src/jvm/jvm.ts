import {
  ACC_ABSTRACT,
  ACC_INTERFACE,
  ACC_NATIVE,
  ACC_STATIC,
  CP_CLASS,
  CP_DOUBLE,
  CP_FLOAT,
  CP_INTEGER,
  CP_LONG,
  CP_STRING,
  type ClassFile,
  type CodeAttribute,
  cpClassName,
  cpMemberRef,
  cpString,
  parseClassFile,
} from './classfile';
import { javaName, parseMethodDescriptor, slotSize } from './descriptor';
import { execute } from './interpreter';
import { BLOCKED, DEAD, Frame, IDLE, JThread, RUNNABLE, SLEEPING, SyncBoundaryThrow, WAITING } from './thread';
import {
  BLOCK,
  INVOKED,
  JArray,
  JavaThrow,
  JObject,
  type JRef,
  type JValue,
  Monitor,
  type NativeImpl,
  TOP,
  defaultValue,
} from './types';

export { JThread } from './thread';

export interface NativeClassDef {
  name: string;
  /** Defaults to java/lang/Object. */
  super?: string | null;
  interfaces?: string[];
  flags?: number;
  /** Instance methods keyed by name + descriptor; args[0] is `this`. */
  methods?: Record<string, NativeImpl>;
  /** Static methods keyed by name + descriptor. */
  statics?: Record<string, NativeImpl>;
  /** Static fields keyed by "name:descriptor". */
  fields?: Record<string, JValue>;
  /** Runs once when the class is loaded (e.g. to create static singleton objects). */
  onLoad?: (jvm: Jvm, cls: RuntimeClass) => void;
}

export interface JMethod {
  cls: RuntimeClass;
  name: string;
  desc: string;
  key: string;
  flags: number;
  isStatic: boolean;
  argSlots: number;
  params: string[];
  ret: string;
  retSlots: 0 | 1 | 2;
  code: CodeAttribute | null;
  impl: NativeImpl | null;
}

export interface MethodRef {
  className: string;
  name: string;
  key: string;
  argSlots: number;
  resolved: JMethod | null;
}

export interface StaticFieldRef {
  cls: RuntimeClass;
  slot: number;
  wide: boolean;
}

export class RuntimeClass {
  superClass: RuntimeClass | null = null;
  interfaces: RuntimeClass[] = [];
  flags = 0;
  cf: ClassFile | null = null;
  readonly methods = new Map<string, JMethod>();
  readonly vcache = new Map<string, JMethod | null>();
  readonly fieldSlots = new Map<string, number>();
  fieldDefaults: JValue[] = [];
  readonly staticSlots = new Map<string, number>();
  statics: JValue[] = [];
  /** 0 = not initialized, 1 = <clinit> running, 2 = initialized. */
  initState = 0;
  initThread: JThread | null = null;
  cpCache: unknown[] = [];
  classObject: JObject | null = null;
  readonly assignable = new Map<RuntimeClass, boolean>();

  constructor(readonly name: string) {}

  get isInterface(): boolean {
    return (this.flags & ACC_INTERFACE) !== 0;
  }
}

export interface JvmHost {
  log(level: 'info' | 'warn' | 'error', message: string): void;
  /** Called when every non-daemon activity stopped (MIDlet destroyed or fatal error). */
  onHalt(reason: 'exit' | 'error', message?: string): void;
}

type EventHandler = (t: JThread) => boolean;

export class Jvm {
  readonly classes = new Map<string, RuntimeClass>();
  private readonly nativeDefs = new Map<string, NativeClassDef>();
  threads: JThread[] = [];
  readonly eventThread: JThread;
  private readonly events: EventHandler[] = [];
  private readonly stringMonitors = new Map<string, Monitor>();
  private nextHash = 0x2f5e1;
  halted = false;
  /** Platform services attached by the player (display, storage, audio...). */
  platform: any = null;
  stringClass!: RuntimeClass;
  objectClass!: RuntimeClass;

  private immediatePending = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly channel = new MessageChannel();

  constructor(
    readonly host: JvmHost,
    readonly resources: Map<string, Uint8Array>,
    natives: NativeClassDef[],
  ) {
    for (const def of natives) this.nativeDefs.set(def.name, def);
    this.objectClass = this.loadClass('java/lang/Object');
    this.stringClass = this.loadClass('java/lang/String');
    this.eventThread = new JThread(this, 'event', true);
    this.eventThread.state = IDLE;
    this.threads.push(this.eventThread);
    this.channel.port1.onmessage = () => {
      this.immediatePending = false;
      this.tick();
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Class loading

  loadClass(name: string): RuntimeClass {
    const existing = this.classes.get(name);
    if (existing) return existing;
    if (name[0] === '[') return this.defineArrayClass(name);
    const def = this.nativeDefs.get(name);
    if (def) return this.defineNativeClass(def);
    const bytes = this.resources.get(name + '.class');
    if (bytes) return this.defineClass(parseClassFile(bytes));
    throw this.throwable('java/lang/NoClassDefFoundError', javaName(name));
  }

  hasClass(name: string): boolean {
    return this.classes.has(name) || this.nativeDefs.has(name) || this.resources.has(name + '.class');
  }

  private defineArrayClass(name: string): RuntimeClass {
    const cls = new RuntimeClass(name);
    cls.superClass = this.objectClass;
    cls.initState = 2;
    this.classes.set(name, cls);
    return cls;
  }

  private defineNativeClass(def: NativeClassDef): RuntimeClass {
    const cls = new RuntimeClass(def.name);
    const superName = def.super === undefined ? (def.name === 'java/lang/Object' ? null : 'java/lang/Object') : def.super;
    cls.superClass = superName ? this.loadClass(superName) : null;
    cls.interfaces = (def.interfaces ?? []).map((i) => this.loadClass(i));
    cls.flags = def.flags ?? 0;
    cls.fieldDefaults = cls.superClass ? cls.superClass.fieldDefaults.slice() : [];
    const add = (key: string, impl: NativeImpl, isStatic: boolean) => {
      const paren = key.indexOf('(');
      const name = key.slice(0, paren);
      const desc = key.slice(paren);
      const sig = parseMethodDescriptor(desc);
      cls.methods.set(key, {
        cls,
        name,
        desc,
        key,
        flags: isStatic ? ACC_STATIC : 0,
        isStatic,
        argSlots: sig.argSlots,
        params: sig.params,
        ret: sig.ret,
        retSlots: sig.retSlots,
        code: null,
        impl,
      });
    };
    for (const [key, impl] of Object.entries(def.methods ?? {})) add(key, impl, false);
    for (const [key, impl] of Object.entries(def.statics ?? {})) add(key, impl, true);
    for (const [key, value] of Object.entries(def.fields ?? {})) {
      cls.staticSlots.set(key, cls.statics.length);
      cls.statics.push(value);
    }
    cls.initState = 2;
    this.classes.set(def.name, cls);
    def.onLoad?.(this, cls);
    return cls;
  }

  setStatic(cls: RuntimeClass, key: string, value: JValue): void {
    const slot = cls.staticSlots.get(key);
    if (slot === undefined) throw new Error(`No static field ${cls.name}.${key}`);
    cls.statics[slot] = value;
  }

  private defineClass(cf: ClassFile): RuntimeClass {
    const cls = new RuntimeClass(cf.name);
    cls.cf = cf;
    cls.flags = cf.access;
    cls.superClass = cf.superName ? this.loadClass(cf.superName) : null;
    cls.interfaces = cf.interfaces.map((i) => this.loadClass(i));
    cls.fieldDefaults = cls.superClass ? cls.superClass.fieldDefaults.slice() : [];

    for (const field of cf.fields) {
      const key = `${field.name}:${field.desc}`;
      if (field.access & ACC_STATIC) {
        cls.staticSlots.set(key, cls.statics.length);
        cls.statics.push(field.constantValue ? this.constantValue(cf, field.constantValue) : defaultValue(field.desc));
      } else {
        cls.fieldSlots.set(key, cls.fieldDefaults.length);
        cls.fieldDefaults.push(defaultValue(field.desc));
      }
    }

    for (const m of cf.methods) {
      const sig = parseMethodDescriptor(m.desc);
      const method: JMethod = {
        cls,
        name: m.name,
        desc: m.desc,
        key: m.name + m.desc,
        flags: m.access,
        isStatic: (m.access & ACC_STATIC) !== 0,
        argSlots: sig.argSlots,
        params: sig.params,
        ret: sig.ret,
        retSlots: sig.retSlots,
        code: m.code,
        impl: null,
      };
      if (m.access & ACC_NATIVE) {
        method.impl = () => {
          throw this.throwable('java/lang/UnsatisfiedLinkError', `${javaName(cf.name)}.${m.name}${m.desc}`);
        };
      }
      cls.methods.set(method.key, method);
    }

    cls.cpCache = new Array(cf.cp.tags.length);
    this.classes.set(cf.name, cls);
    return cls;
  }

  private constantValue(cf: ClassFile, index: number): JValue {
    switch (cf.cp.tags[index]) {
      case CP_INTEGER:
      case CP_FLOAT:
      case CP_DOUBLE:
      case CP_LONG:
        return cf.cp.values[index] as number | bigint;
      case CP_STRING:
        return cpString(cf.cp, index);
      default:
        return null;
    }
  }

  /** ldc / ldc_w constant (int, float, String or Class). */
  loadConstant(cls: RuntimeClass, index: number): JValue {
    const cp = cls.cf!.cp;
    switch (cp.tags[index]) {
      case CP_INTEGER:
      case CP_FLOAT:
        return cp.values[index] as number;
      case CP_STRING:
        return cpString(cp, index);
      case CP_CLASS:
        return this.classObject(this.loadClass(cpClassName(cp, index)));
      default:
        throw this.throwable('java/lang/VerifyError', `Bad ldc constant #${index}`);
    }
  }

  /** Makes sure `cls` is initialized. Returns false if <clinit> frames were pushed (retry the instruction). */
  ensureInit(t: JThread, cls: RuntimeClass): boolean {
    if (cls.initState === 2) return true;
    if (cls.initState === 1) {
      if (cls.initThread === t) return true;
      t.state = WAITING;
      t.condition = () => cls.initState === 2;
      return false;
    }
    if (cls.superClass && cls.superClass.initState !== 2 && !this.ensureInit(t, cls.superClass)) return false;
    const clinit = cls.methods.get('<clinit>()V');
    if (!clinit || !clinit.code) {
      cls.initState = 2;
      return true;
    }
    cls.initState = 1;
    cls.initThread = t;
    const frame = new Frame(clinit);
    const done = () => {
      cls.initState = 2;
      cls.initThread = null;
      this.wake();
    };
    frame.onReturn = done;
    frame.onUnwind = done;
    t.frames.push(frame);
    return false;
  }

  // ---------------------------------------------------------------------------------------------
  // Resolution

  resolveMethodRef(cls: RuntimeClass, index: number): MethodRef {
    let ref = cls.cpCache[index] as MethodRef | undefined;
    if (ref) return ref;
    const member = cpMemberRef(cls.cf!.cp, index);
    const sig = parseMethodDescriptor(member.desc);
    ref = { className: member.className, name: member.name, key: member.name + member.desc, argSlots: sig.argSlots, resolved: null };
    cls.cpCache[index] = ref;
    return ref;
  }

  /** For invokestatic / invokespecial: method looked up from the referenced class upwards. */
  resolveDirect(ref: MethodRef): JMethod {
    if (ref.resolved) return ref.resolved;
    const owner = this.loadClass(ref.className);
    const method = this.findMethod(owner, ref.key);
    if (!method) throw this.throwable('java/lang/NoSuchMethodError', `${javaName(ref.className)}.${ref.key}`);
    ref.resolved = method;
    return method;
  }

  findMethod(cls: RuntimeClass, key: string): JMethod | null {
    for (let c: RuntimeClass | null = cls; c; c = c.superClass) {
      const m = c.methods.get(key);
      if (m) return m;
    }
    return null;
  }

  findVirtual(cls: RuntimeClass, key: string): JMethod | null {
    const cached = cls.vcache.get(key);
    if (cached !== undefined) return cached;
    let found: JMethod | null = null;
    for (let c: RuntimeClass | null = cls; c; c = c.superClass) {
      const m = c.methods.get(key);
      if (m && !m.isStatic && (m.code || m.impl) && !(m.flags & ACC_ABSTRACT && !m.impl)) {
        found = m;
        break;
      }
    }
    cls.vcache.set(key, found);
    return found;
  }

  resolveStaticField(cls: RuntimeClass, index: number): StaticFieldRef {
    const member = cpMemberRef(cls.cf!.cp, index);
    const key = `${member.name}:${member.desc}`;
    const owner = this.loadClass(member.className);
    const decl = this.findStaticDecl(owner, key);
    if (!decl) throw this.throwable('java/lang/NoSuchFieldError', `${javaName(member.className)}.${member.name}`);
    return { cls: decl, slot: decl.staticSlots.get(key)!, wide: slotSize(member.desc) === 2 };
  }

  private findStaticDecl(cls: RuntimeClass, key: string): RuntimeClass | null {
    if (cls.staticSlots.has(key)) return cls;
    for (const i of cls.interfaces) {
      const d = this.findStaticDecl(i, key);
      if (d) return d;
    }
    return cls.superClass ? this.findStaticDecl(cls.superClass, key) : null;
  }

  /** Returns slot * 2 + (wide ? 1 : 0). */
  resolveInstanceField(cls: RuntimeClass, index: number): number {
    const member = cpMemberRef(cls.cf!.cp, index);
    const key = `${member.name}:${member.desc}`;
    for (let c: RuntimeClass | null = this.loadClass(member.className); c; c = c.superClass) {
      const slot = c.fieldSlots.get(key);
      if (slot !== undefined) return slot * 2 + (slotSize(member.desc) === 2 ? 1 : 0);
    }
    throw this.throwable('java/lang/NoSuchFieldError', `${javaName(member.className)}.${member.name}`);
  }

  // ---------------------------------------------------------------------------------------------
  // Types

  classOf(value: JRef): RuntimeClass {
    if (typeof value === 'string') return this.stringClass;
    if (value instanceof JObject) return value.cls;
    if (value instanceof JArray) return this.loadClass(value.type);
    throw this.throwable('java/lang/NullPointerException');
  }

  classObject(cls: RuntimeClass): JObject {
    if (!cls.classObject) {
      cls.classObject = new JObject(this.loadClass('java/lang/Class'));
      cls.classObject.n = cls;
    }
    return cls.classObject;
  }

  isInstance(value: JRef, typeName: string): boolean {
    if (value === null) return false;
    if (typeof value === 'string') return typeName === 'java/lang/String' || typeName === 'java/lang/Object';
    if (value instanceof JArray) return this.isArrayAssignable(value.type, typeName);
    if (value instanceof JObject) {
      if (typeName === 'java/lang/Object') return true;
      if (!this.hasClass(typeName)) return false;
      return this.isSubclass(value.cls, this.loadClass(typeName));
    }
    return false;
  }

  isSubclass(cls: RuntimeClass, target: RuntimeClass): boolean {
    if (cls === target) return true;
    const cached = cls.assignable.get(target);
    if (cached !== undefined) return cached;
    let result = false;
    if (cls.superClass && this.isSubclass(cls.superClass, target)) result = true;
    else for (const i of cls.interfaces) if (this.isSubclass(i, target)) { result = true; break; }
    cls.assignable.set(target, result);
    return result;
  }

  private isArrayAssignable(src: string, dst: string): boolean {
    if (src === dst || dst === 'java/lang/Object') return true;
    if (dst[0] !== '[') return false;
    const s = src.slice(1);
    const d = dst.slice(1);
    if (d[0] === '[') return s[0] === '[' && this.isArrayAssignable(s, d);
    if (d[0] !== 'L') return false;
    const dName = d.slice(1, -1);
    if (dName === 'java/lang/Object') return s[0] === 'L' || s[0] === '[';
    if (s[0] !== 'L') return false;
    const sName = s.slice(1, -1);
    return this.hasClass(sName) && this.hasClass(dName) && this.isSubclass(this.loadClass(sName), this.loadClass(dName));
  }

  identityHash(value: JObject | JArray): number {
    if (!value.hash) {
      this.nextHash = (Math.imul(this.nextHash, 1103515245) + 12345) & 0x7fffffff;
      value.hash = this.nextHash || 1;
    }
    return value.hash;
  }

  // ---------------------------------------------------------------------------------------------
  // Exceptions

  throwable(className: string, message: string | null = null): JavaThrow {
    const obj = new JObject(this.loadClass(className));
    obj.n = { message, trace: this.captureTrace(this.currentThread) };
    return new JavaThrow(obj);
  }

  npe(what?: string): JavaThrow {
    return this.throwable('java/lang/NullPointerException', what ?? null);
  }

  currentThread: JThread | null = null;

  captureTrace(t: JThread | null): string[] {
    if (!t) return [];
    const lines: string[] = [];
    for (let i = t.frames.length - 1; i >= 0 && lines.length < 12; i--) {
      const f = t.frames[i];
      lines.push(`${javaName(f.method.cls.name)}.${f.method.name} (pc ${f.opPc})`);
    }
    return lines;
  }

  /** Unwinds `t` to a matching handler. Throws SyncBoundaryThrow when crossing a native→Java call. */
  throwInThread(t: JThread, ex: JObject): void {
    while (t.frames.length > 0) {
      const f = t.frames[t.frames.length - 1];
      const code = f.method.code;
      if (code) {
        for (const h of code.handlers) {
          if (f.opPc >= h.startPc && f.opPc < h.endPc && (h.catchType === null || this.isInstance(ex, h.catchType))) {
            f.stack.length = 0;
            f.stack.push(ex);
            f.pc = h.handlerPc;
            return;
          }
        }
      }
      t.frames.pop();
      if (f.lock) this.monitorExit(t, f.lock);
      f.onUnwind?.(ex);
      if (f.syncBoundary) throw new SyncBoundaryThrow(ex);
    }
    this.uncaught(t, ex);
  }

  describeThrowable(ex: JObject): string {
    const message = ex.n?.message;
    const trace: string[] = ex.n?.trace ?? [];
    return `${javaName(ex.cls.name)}${message ? `: ${message}` : ''}${trace.length ? '\n  at ' + trace.join('\n  at ') : ''}`;
  }

  private uncaught(t: JThread, ex: JObject): void {
    this.host.log('error', `Uncaught exception in thread "${t.name}": ${this.describeThrowable(ex)}`);
    if (!t.isEventThread) t.state = DEAD;
  }

  // ---------------------------------------------------------------------------------------------
  // Monitors

  monitorOf(value: JRef): Monitor {
    if (value === null) throw this.npe();
    if (typeof value === 'string') {
      let m = this.stringMonitors.get(value);
      if (!m) this.stringMonitors.set(value, (m = new Monitor()));
      return m;
    }
    return (value.mon ??= new Monitor());
  }

  tryEnter(t: JThread, m: Monitor): boolean {
    if (m.owner === null) {
      m.owner = t;
      m.count = 1;
      return true;
    }
    if (m.owner === t) {
      m.count++;
      return true;
    }
    t.state = BLOCKED;
    t.blockedOn = m;
    return false;
  }

  monitorExit(t: JThread, m: Monitor): void {
    if (m.owner !== t) throw this.throwable('java/lang/IllegalMonitorStateException');
    if (--m.count === 0) {
      m.owner = null;
      this.wake();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Invocation helpers for natives

  /** Pushes a call frame for a bytecode method (or runs a native one directly). */
  pushCall(t: JThread, method: JMethod, args: JValue[], onDone?: () => void): void {
    if (method.impl) {
      method.impl(t, args);
      onDone?.();
      return;
    }
    const frame = new Frame(method);
    let slot = 0;
    const params = method.isStatic ? method.params : ['L', ...method.params];
    for (let i = 0; i < args.length; i++) {
      frame.locals[slot++] = args[i];
      if (slotSize(params[i]) === 2) frame.locals[slot++] = TOP;
    }
    if (onDone) {
      frame.onReturn = onDone;
      frame.onUnwind = onDone;
    }
    t.frames.push(frame);
  }

  /** Runs Java code to completion from inside a native. The callee must not block. */
  invokeSync(t: JThread, method: JMethod, args: JValue[]): JValue {
    if (method.impl) {
      const r = method.impl(t, args);
      if (r === BLOCK || r === INVOKED) throw new Error(`Native ${method.name} cannot block in a synchronous call`);
      return typeof r === 'boolean' ? (r ? 1 : 0) : r === undefined ? null : r;
    }
    const depth = t.frames.length;
    this.pushCall(t, method, args);
    t.frames[depth].syncBoundary = true;
    const savedState = t.state;
    t.state = RUNNABLE;
    try {
      while (t.frames.length > depth) {
        execute(t, 1_000_000);
        if (t.frames.length > depth && t.state !== RUNNABLE) {
          throw new Error(`${javaName(method.cls.name)}.${method.name} blocked inside a synchronous call`);
        }
      }
    } catch (e) {
      if (e instanceof SyncBoundaryThrow) throw new JavaThrow(e.obj);
      throw e;
    } finally {
      if (t.state === RUNNABLE) t.state = savedState;
    }
    return t.syncResult;
  }

  /** Calls a virtual method by name+descriptor synchronously. */
  callVirtualSync(t: JThread, receiver: JObject, key: string, args: JValue[] = []): JValue {
    const m = this.findVirtual(receiver.cls, key);
    if (!m) throw this.throwable('java/lang/AbstractMethodError', key);
    return this.invokeSync(t, m, [receiver, ...args]);
  }

  /** Java's String.valueOf(Object). */
  stringValueOf(t: JThread, value: JRef): string {
    if (value === null) return 'null';
    if (typeof value === 'string') return value;
    const m = this.findVirtual(this.classOf(value), 'toString()Ljava/lang/String;');
    const s = m ? this.invokeSync(t, m, [value]) : null;
    return typeof s === 'string' ? s : 'null';
  }

  // ---------------------------------------------------------------------------------------------
  // Threads and scheduling

  startThread(name: string, setup: (t: JThread) => void): JThread {
    const t = new JThread(this, name);
    setup(t);
    this.threads.push(t);
    this.wake();
    return t;
  }

  postEvent(handler: EventHandler): void {
    this.events.push(handler);
    this.wake();
  }

  /** Starts the MIDlet: <clinit>, <init>() then startApp() on the event thread. */
  startMidlet(className: string): void {
    this.postEvent((t) => {
      const cls = this.loadClass(className.replace(/\./g, '/'));
      const midlet = new JObject(cls);
      this.platform?.onMidletCreated?.(midlet);
      const startApp = this.findVirtual(cls, 'startApp()V');
      if (startApp) this.pushCall(t, startApp, [midlet]);
      const init = this.findMethod(cls, '<init>()V');
      if (!init) throw new Error(`${className} has no public no-arg constructor`);
      this.pushCall(t, init, [midlet]);
      // Initialize the class chain before the constructor runs (superclasses on top).
      const chain: RuntimeClass[] = [];
      for (let c: RuntimeClass | null = cls; c && c.initState === 0; c = c.superClass) chain.push(c);
      for (const c of chain) {
        const clinit = c.methods.get('<clinit>()V');
        if (!clinit?.code) {
          c.initState = 2;
          continue;
        }
        c.initState = 1;
        c.initThread = t;
        this.pushCall(t, clinit, [], () => {
          c.initState = 2;
          c.initThread = null;
        });
      }
      return true;
    });
  }

  halt(reason: 'exit' | 'error', message?: string): void {
    if (this.halted) return;
    this.halted = true;
    if (this.timer) clearTimeout(this.timer);
    this.channel.port1.onmessage = null;
    this.host.onHalt(reason, message);
  }

  wake(): void {
    if (this.halted || this.immediatePending) return;
    this.immediatePending = true;
    this.channel.port2.postMessage(null);
  }

  private tick(): void {
    if (this.halted) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const sliceEnd = performance.now() + 10;
    let ranSomething = true;
    try {
      while (ranSomething && !this.halted) {
        ranSomething = false;
        const now = performance.now();
        for (const t of this.threads) {
          this.refreshState(t, now);
          if (t.isEventThread && t.frames.length === 0) {
            t.state = IDLE;
            while (this.events.length > 0) {
              const handler = this.events.shift()!;
              if (handler(t)) {
                t.state = RUNNABLE;
                break;
              }
            }
          }
          if (t.state !== RUNNABLE) continue;
          this.runThread(t);
          ranSomething = true;
          if (t.frames.length === 0 && !t.isEventThread && t.state === RUNNABLE) t.state = DEAD;
          if (this.halted) return;
        }
        if (this.threads.some((t) => t.state === DEAD)) this.threads = this.threads.filter((t) => t.state !== DEAD);
        if (performance.now() >= sliceEnd) break;
      }
    } catch (e) {
      this.host.log('error', `JVM crashed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      this.halt('error', e instanceof Error ? e.message : String(e));
      return;
    }
    this.scheduleNext();
  }

  private runThread(t: JThread): void {
    this.currentThread = t;
    try {
      execute(t, 200_000);
    } catch (e) {
      if (e instanceof SyncBoundaryThrow) {
        this.uncaught(t, e.obj);
        return;
      }
      const where = this.captureTrace(t).join('\n  at ');
      throw new Error(`${e instanceof Error ? e.message : String(e)}\n  at ${where}`, { cause: e });
    } finally {
      this.currentThread = null;
    }
  }

  private refreshState(t: JThread, now: number): void {
    switch (t.state) {
      case SLEEPING:
        if (t.wakeAt <= now) t.state = RUNNABLE;
        break;
      case WAITING:
        if (t.condition) {
          if (t.condition()) {
            t.condition = null;
            t.state = RUNNABLE;
          }
        } else if (t.waitingOn && (t.notified || t.interrupted || (t.wakeAt > 0 && t.wakeAt <= now))) {
          const m = t.waitingOn;
          m.waitSet = m.waitSet.filter((w) => w !== t);
          t.waitingOn = null;
          t.notified = false;
          t.state = BLOCKED;
          t.blockedOn = m;
          this.refreshState(t, now);
        }
        break;
      case BLOCKED: {
        const m = t.blockedOn!;
        if (m.owner === null) {
          if (t.reacquire > 0) {
            m.owner = t;
            m.count = t.reacquire;
            t.reacquire = 0;
          }
          t.blockedOn = null;
          t.state = RUNNABLE;
        }
        break;
      }
    }
  }

  private scheduleNext(): void {
    if (this.halted) return;
    let nextWake = Infinity;
    for (const t of this.threads) {
      if (t.state === RUNNABLE) return this.wake();
      if (t.state === BLOCKED && t.blockedOn?.owner === null) return this.wake();
      if (t.state === WAITING && t.condition?.()) return this.wake();
      if (t.state === IDLE && this.events.length > 0) return this.wake();
      if ((t.state === SLEEPING || (t.state === WAITING && t.waitingOn)) && t.wakeAt > 0) nextWake = Math.min(nextWake, t.wakeAt);
    }
    if (nextWake !== Infinity) {
      const delay = Math.max(0, nextWake - performance.now());
      this.timer = setTimeout(() => {
        this.timer = null;
        this.tick();
      }, delay);
    }
  }
}
