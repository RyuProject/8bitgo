// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

export const WGPU_RENDERER_WORKER_CONTROL_MAGIC = 0x57524331; // WRC1
export const WGPU_RENDERER_WORKER_CONTROL_VERSION = 1;
export const WGPU_RENDERER_WORKER_CONTROL_WORDS = 9;

export const WGPU_RENDERER_WORKER_CONTROL_INDEX = Object.freeze({
  MAGIC: 0,
  VERSION: 1,
  WORDS: 2,
  STATE: 3,
  OWNER: 4,
  SESSION: 5,
  EPOCH: 6,
  GENERATION: 7,
  ERROR: 8,
});

export const WGPU_RENDERER_WORKER_STATE = Object.freeze({
  BOOTING: 0,
  BOOT_READY: 1,
  RING_ATTACHED: 2,
  QUIESCE_REQUESTED: 3,
  QUIESCENT: 4,
  FAILED: 5,
});

export const WGPU_RENDERER_WORKER_OWNER = Object.freeze({
  NONE: 0,
  COORDINATOR: 1,
  RENDERER: 2,
});

export const WGPU_RENDERER_WORKER_ERROR = Object.freeze({
  NONE: 0,
  INVALID_TRANSITION: 1,
  STALE_GENERATION: 2,
  WRONG_OWNER: 3,
  INVALID_SEQUENCE: 4,
  REMOTE_FAILURE: 5,
});

const I = WGPU_RENDERER_WORKER_CONTROL_INDEX;
const STATE = WGPU_RENDERER_WORKER_STATE;
const OWNER = WGPU_RENDERER_WORKER_OWNER;
const ERROR = WGPU_RENDERER_WORKER_ERROR;
const CONTROL_BYTES = WGPU_RENDERER_WORKER_CONTROL_WORDS * Int32Array.BYTES_PER_ELEMENT;

export function createWgpuRendererWorkerControl({
  owner = OWNER.NONE,
  session = 1,
  epoch = 1,
  generation = 1,
} = {}) {
  requireOwner(owner, "owner");
  requireCounter(session, "session");
  requireCounter(epoch, "epoch");
  requireCounter(generation, "generation");

  const buffer = new SharedArrayBuffer(CONTROL_BYTES);
  const control = new Int32Array(buffer);
  Atomics.store(control, I.STATE, STATE.BOOTING);
  Atomics.store(control, I.OWNER, owner);
  Atomics.store(control, I.SESSION, session);
  Atomics.store(control, I.EPOCH, epoch);
  Atomics.store(control, I.GENERATION, generation);
  Atomics.store(control, I.ERROR, ERROR.NONE);
  Atomics.store(control, I.WORDS, WGPU_RENDERER_WORKER_CONTROL_WORDS);
  Atomics.store(control, I.VERSION, WGPU_RENDERER_WORKER_CONTROL_VERSION);
  Atomics.store(control, I.MAGIC, WGPU_RENDERER_WORKER_CONTROL_MAGIC);
  return control;
}

export function attachWgpuRendererWorkerControl(
  buffer,
  { session, epoch, generation } = {}
) {
  if (!(buffer instanceof SharedArrayBuffer)) {
    throw new TypeError("WGPU renderer-worker control requires a SharedArrayBuffer");
  }
  if (buffer.byteLength !== CONTROL_BYTES) {
    throw new RangeError(
      `WGPU renderer-worker control requires exactly ${CONTROL_BYTES} bytes`
    );
  }
  const control = new Int32Array(buffer);
  validateControl(control);
  requireExpectedCounter(control, I.SESSION, session, "session");
  requireExpectedCounter(control, I.EPOCH, epoch, "epoch");
  requireExpectedCounter(control, I.GENERATION, generation, "generation");
  return control;
}

export function tryTransferWgpuRendererWorkerOwnership(
  control,
  expectedOwner,
  nextOwner,
  expectedGeneration
) {
  requireControl(control);
  requireOwner(expectedOwner, "expectedOwner");
  requireOwner(nextOwner, "nextOwner");
  if (expectedOwner === nextOwner) {
    return failClosed(
      control,
      ERROR.INVALID_SEQUENCE,
      "renderer-worker ownership transfer must change owner"
    );
  }
  requireLive(control);
  requireGeneration(control, expectedGeneration);
  const previous = Atomics.compareExchange(control, I.OWNER, expectedOwner, nextOwner);
  if (previous !== expectedOwner) return false;
  Atomics.notify(control, I.OWNER);
  return true;
}

export function markWgpuRendererWorkerBootReady(control, owner, generation) {
  return transition(control, owner, generation, STATE.BOOTING, STATE.BOOT_READY);
}

export function markWgpuRendererWorkerRingAttached(control, owner, generation) {
  return transition(control, owner, generation, STATE.BOOT_READY, STATE.RING_ATTACHED);
}

export function requestWgpuRendererWorkerQuiesce(control, owner, generation) {
  return transition(
    control,
    owner,
    generation,
    STATE.RING_ATTACHED,
    STATE.QUIESCE_REQUESTED
  );
}

export function markWgpuRendererWorkerQuiescent(control, owner, generation) {
  return transition(
    control,
    owner,
    generation,
    STATE.QUIESCE_REQUESTED,
    STATE.QUIESCENT
  );
}

export function beginNextWgpuRendererWorkerGeneration(
  control,
  owner,
  expectedGeneration,
  { session, epoch, generation } = {}
) {
  requireControl(control);
  requireOwner(owner, "owner");
  requireCounter(session, "session");
  requireCounter(epoch, "epoch");
  requireCounter(generation, "generation");
  requireLive(control);
  requireGeneration(control, expectedGeneration);
  requireCurrentOwner(control, owner);

  const currentSession = Atomics.load(control, I.SESSION);
  const currentEpoch = Atomics.load(control, I.EPOCH);
  const currentGeneration = Atomics.load(control, I.GENERATION);
  const sessionIsCurrentOrNext =
    session === currentSession || session === currentSession + 1;
  if (
    !sessionIsCurrentOrNext ||
    epoch !== currentEpoch + 1 ||
    generation !== currentGeneration + 1
  ) {
    return failClosed(
      control,
      ERROR.INVALID_SEQUENCE,
      "renderer-worker session, epoch, or generation is not the next monotonic value"
    );
  }

  const previous = Atomics.compareExchange(
    control,
    I.STATE,
    STATE.QUIESCENT,
    STATE.BOOTING
  );
  if (previous !== STATE.QUIESCENT) {
    return failClosed(
      control,
      ERROR.INVALID_TRANSITION,
      "renderer-worker generation advance requires quiescent state"
    );
  }

  // BOOTING is the publication barrier: readers must not consume the new
  // identity until the owner subsequently publishes BOOT_READY.
  Atomics.store(control, I.SESSION, session);
  Atomics.store(control, I.EPOCH, epoch);
  Atomics.store(control, I.GENERATION, generation);
  Atomics.notify(control, I.STATE);
  return true;
}

export function failWgpuRendererWorkerControl(
  control,
  errorCode = ERROR.REMOTE_FAILURE
) {
  requireControl(control);
  const normalizedError = requireError(errorCode);
  Atomics.compareExchange(control, I.ERROR, ERROR.NONE, normalizedError);
  const previous = Atomics.exchange(control, I.STATE, STATE.FAILED);
  Atomics.notify(control, I.STATE);
  Atomics.notify(control, I.OWNER);
  return previous !== STATE.FAILED;
}

// Allocation-free reads used by polling loops.
export function readWgpuRendererWorkerState(control) {
  requireControl(control);
  return Atomics.load(control, I.STATE);
}

export function readWgpuRendererWorkerOwner(control) {
  requireControl(control);
  return Atomics.load(control, I.OWNER);
}

export function readWgpuRendererWorkerGeneration(control) {
  requireControl(control);
  return Atomics.load(control, I.GENERATION);
}

export function readWgpuRendererWorkerError(control) {
  requireControl(control);
  return Atomics.load(control, I.ERROR);
}

export function snapshotWgpuRendererWorkerControl(control) {
  requireControl(control);
  return Object.freeze({
    state: Atomics.load(control, I.STATE),
    owner: Atomics.load(control, I.OWNER),
    session: Atomics.load(control, I.SESSION),
    epoch: Atomics.load(control, I.EPOCH),
    generation: Atomics.load(control, I.GENERATION),
    error: Atomics.load(control, I.ERROR),
  });
}

function transition(control, owner, generation, from, to) {
  requireControl(control);
  requireOwner(owner, "owner");
  requireLive(control);
  requireGeneration(control, generation);
  requireCurrentOwner(control, owner);
  const previous = Atomics.compareExchange(control, I.STATE, from, to);
  if (previous !== from) {
    return failClosed(
      control,
      ERROR.INVALID_TRANSITION,
      `renderer-worker transition ${from}->${to} observed state ${previous}`
    );
  }
  Atomics.notify(control, I.STATE);
  return true;
}

function validateControl(control) {
  if (Atomics.load(control, I.MAGIC) !== WGPU_RENDERER_WORKER_CONTROL_MAGIC) {
    throw new Error("WGPU renderer-worker control magic is invalid");
  }
  if (Atomics.load(control, I.VERSION) !== WGPU_RENDERER_WORKER_CONTROL_VERSION) {
    throw new Error("WGPU renderer-worker control version is unsupported");
  }
  if (Atomics.load(control, I.WORDS) !== WGPU_RENDERER_WORKER_CONTROL_WORDS) {
    throw new Error("WGPU renderer-worker control word count is invalid");
  }
  const state = Atomics.load(control, I.STATE);
  if (state < STATE.BOOTING || state > STATE.FAILED) {
    throw new Error(`WGPU renderer-worker control state is invalid: ${state}`);
  }
  requireOwner(Atomics.load(control, I.OWNER), "stored owner");
  requireCounter(Atomics.load(control, I.SESSION), "stored session");
  requireCounter(Atomics.load(control, I.EPOCH), "stored epoch");
  requireCounter(Atomics.load(control, I.GENERATION), "stored generation");
  const error = Atomics.load(control, I.ERROR);
  if (!Number.isInteger(error) || error < ERROR.NONE) {
    throw new Error(`WGPU renderer-worker control error is invalid: ${error}`);
  }
  return control;
}

function requireControl(control) {
  if (
    !(control instanceof Int32Array) ||
    !(control.buffer instanceof SharedArrayBuffer) ||
    control.byteOffset !== 0 ||
    control.length !== WGPU_RENDERER_WORKER_CONTROL_WORDS ||
    control.buffer.byteLength !== CONTROL_BYTES
  ) {
    throw new TypeError("WGPU renderer-worker control view has an invalid exact schema");
  }
  return validateControl(control);
}

function requireExpectedCounter(control, index, expected, name) {
  if (expected == null) return;
  requireCounter(expected, `expected ${name}`);
  const actual = Atomics.load(control, index);
  if (actual !== expected) {
    throw new Error(`WGPU renderer-worker control ${name} mismatch: ${actual} != ${expected}`);
  }
}

function requireCounter(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0x7fff_ffff) {
    throw new RangeError(`WGPU renderer-worker ${name} must be a positive int31`);
  }
  return value;
}

function requireOwner(value, name) {
  if (value !== OWNER.NONE && value !== OWNER.COORDINATOR && value !== OWNER.RENDERER) {
    throw new RangeError(`WGPU renderer-worker ${name} is invalid: ${value}`);
  }
  return value;
}

function requireError(value) {
  if (!Number.isSafeInteger(value) || value <= ERROR.NONE || value > 0x7fff_ffff) {
    throw new RangeError("WGPU renderer-worker failure requires a positive int31 error code");
  }
  return value;
}

function requireLive(control) {
  if (Atomics.load(control, I.STATE) === STATE.FAILED) {
    throw new Error("WGPU renderer-worker control is failed");
  }
}

function requireGeneration(control, expectedGeneration) {
  requireCounter(expectedGeneration, "expected generation");
  const actual = Atomics.load(control, I.GENERATION);
  if (actual !== expectedGeneration) {
    return failClosed(
      control,
      ERROR.STALE_GENERATION,
      `renderer-worker generation mismatch: ${actual} != ${expectedGeneration}`
    );
  }
}

function requireCurrentOwner(control, owner) {
  const actual = Atomics.load(control, I.OWNER);
  if (actual !== owner) {
    return failClosed(
      control,
      ERROR.WRONG_OWNER,
      `renderer-worker owner mismatch: ${actual} != ${owner}`
    );
  }
}

function failClosed(control, errorCode, message) {
  failWgpuRendererWorkerControl(control, errorCode);
  throw new Error(message);
}
