import type { JMethod, Jvm } from './jvm';
import type { JObject, JValue, Monitor } from './types';

export const RUNNABLE = 0;
export const SLEEPING = 1;
/** Parked until `condition` holds, a monitor notify, or `wakeAt` passes. */
export const WAITING = 2;
/** Waiting to (re)acquire a monitor. */
export const BLOCKED = 3;
/** Event thread with nothing to do. */
export const IDLE = 4;
export const DEAD = 5;

export class Frame {
  /** Next instruction to execute when this frame resumes. */
  pc = 0;
  /** Start of the instruction that invoked the current callee (used for exception handler lookup). */
  opPc = 0;
  readonly stack: JValue[] = [];
  readonly locals: JValue[];
  /** Set when a native runs Java code synchronously: returning from this frame ends that nested run. */
  syncBoundary = false;
  /** Monitor held because the method is synchronized. */
  lock: Monitor | null = null;
  onReturn: ((value: JValue) => void) | null = null;
  onUnwind: ((exception: JObject) => void) | null = null;

  constructor(readonly method: JMethod) {
    this.locals = new Array(method.code ? method.code.maxLocals : 0);
  }
}

export class JThread {
  frames: Frame[] = [];
  state = RUNNABLE;
  /** performance.now() deadline for SLEEPING, or timed WAITING (0 = no timeout). */
  wakeAt = 0;
  condition: (() => boolean) | null = null;
  blockedOn: Monitor | null = null;
  waitingOn: Monitor | null = null;
  /** Monitor recursion count to restore after Object.wait() returns. */
  reacquire = 0;
  notified = false;
  interrupted = false;
  javaThread: JObject | null = null;
  syncResult: JValue = null;

  constructor(
    readonly jvm: Jvm,
    readonly name: string,
    readonly isEventThread = false,
  ) {}
}

/** Thrown out of the interpreter when an exception unwinds past a synchronous native→Java call. */
export class SyncBoundaryThrow {
  constructor(readonly obj: JObject) {}
}
