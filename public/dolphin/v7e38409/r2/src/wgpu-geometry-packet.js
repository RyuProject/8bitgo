// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

// This non-runtime module is the maintained conformance model for the C++
// geometry upload packet. Unit tests use it to lock layout and lifetime rules;
// it deliberately does not imply that production should allocate a temporary
// JS/C++ buffer.

export const WGPU_GEOMETRY_PACKET_MAX_OFFSET = 0xffffffff;
export const WGPU_GEOMETRY_COARSE_RANGE_MAX_BYTES = 16 * 1024 * 1024;
export const WGPU_GEOMETRY_COARSE_RANGE_MAX_GAP = 64;

export const WGPU_GEOMETRY_COARSE_RANGE_REASON = Object.freeze({
  EXPLICIT_BOUNDARY: "explicit-boundary",
  BUFFER_CHANGED: "buffer-changed",
  GENERATION_CHANGED: "generation-changed",
  PASS_CHANGED: "pass-changed",
  TRANSACTION_CHANGED: "transaction-changed",
  GAP_EXCEEDS_LIMIT: "gap-exceeds-limit",
  RANGE_EXCEEDS_CAP: "range-exceeds-cap",
  PADDING_NOT_AUTHORIZED: "padding-not-authorized",
  PADDING_MISMATCH: "padding-mismatch",
  INVALID_OPTIONS: "invalid-options",
  INVALID_SPAN: "invalid-span",
  INVALID_IDENTITY: "invalid-identity",
  ZERO_LENGTH_SPAN: "zero-length-span",
  MISALIGNED_SPAN: "misaligned-span",
  DESTINATION_REGRESSION: "destination-regression",
  OVERLAPPING_SPAN: "overlapping-span",
  UNSAFE_INTEGER_OVERFLOW: "unsafe-integer-overflow",
  LOGICAL_SPAN_EXCEEDS_CAP: "logical-span-exceeds-cap",
});

export function planWgpuGeometryCoarseRanges({
  spans,
  maxGapBytes = WGPU_GEOMETRY_COARSE_RANGE_MAX_GAP,
  maxRangeBytes = WGPU_GEOMETRY_COARSE_RANGE_MAX_BYTES,
  alignment = 4,
} = {}) {
  if (!Array.isArray(spans) || !isNonnegativeInteger(maxGapBytes) ||
      maxGapBytes > WGPU_GEOMETRY_COARSE_RANGE_MAX_GAP ||
      !isPositiveInteger(maxRangeBytes) ||
      maxRangeBytes > WGPU_GEOMETRY_COARSE_RANGE_MAX_BYTES ||
      !isPositiveInteger(alignment)) {
    return coarseRangeResult([], [], [{
      spanIndex: null,
      reason: WGPU_GEOMETRY_COARSE_RANGE_REASON.INVALID_OPTIONS,
    }]);
  }

  const ranges = [];
  const splits = [];
  const fallbacks = [];
  const acceptedSpans = [];
  let current = null;

  for (let spanIndex = 0; spanIndex < spans.length; spanIndex += 1) {
    const span = spans[spanIndex];
    const validationReason = validateCoarseRangeSpan(span, maxRangeBytes, alignment);
    if (validationReason) {
      fallbacks.push({ spanIndex, reason: validationReason });
      current = null;
      continue;
    }

    const length = span.bytes.byteLength;
    const end = span.destinationOffset + length;
    const previous = findPreviousCoarseSpan(acceptedSpans, span);
    if (previous && span.destinationOffset < previous.destinationOffset) {
      fallbacks.push({
        spanIndex,
        reason: WGPU_GEOMETRY_COARSE_RANGE_REASON.DESTINATION_REGRESSION,
      });
      current = null;
      continue;
    }
    if (previous && span.destinationOffset < previous.endOffset) {
      fallbacks.push({
        spanIndex,
        reason: WGPU_GEOMETRY_COARSE_RANGE_REASON.OVERLAPPING_SPAN,
      });
      current = null;
      continue;
    }
    acceptedSpans.push({
      buffer: span.buffer,
      generation: span.generation,
      passId: span.passId,
      transactionId: span.transactionId,
      destinationOffset: span.destinationOffset,
      endOffset: end,
    });

    if (!current) {
      current = newCoarseRange(span, spanIndex, end);
      ranges.push(current);
      continue;
    }

    let splitReason = null;
    if (span.boundaryBefore === true) {
      splitReason = WGPU_GEOMETRY_COARSE_RANGE_REASON.EXPLICIT_BOUNDARY;
    } else if (span.buffer !== current.buffer) {
      splitReason = WGPU_GEOMETRY_COARSE_RANGE_REASON.BUFFER_CHANGED;
    } else if (span.generation !== current.generation) {
      splitReason = WGPU_GEOMETRY_COARSE_RANGE_REASON.GENERATION_CHANGED;
    } else if (span.passId !== current.passId) {
      splitReason = WGPU_GEOMETRY_COARSE_RANGE_REASON.PASS_CHANGED;
    } else if (span.transactionId !== current.transactionId) {
      splitReason = WGPU_GEOMETRY_COARSE_RANGE_REASON.TRANSACTION_CHANGED;
    } else if (span.destinationOffset - current.endOffset > maxGapBytes) {
      splitReason = WGPU_GEOMETRY_COARSE_RANGE_REASON.GAP_EXCEEDS_LIMIT;
    } else if (end - current.startOffset > maxRangeBytes) {
      splitReason = WGPU_GEOMETRY_COARSE_RANGE_REASON.RANGE_EXCEEDS_CAP;
    } else if (span.paddingBeforeBytes === undefined) {
      splitReason = WGPU_GEOMETRY_COARSE_RANGE_REASON.PADDING_NOT_AUTHORIZED;
    } else if (!isNonnegativeInteger(span.paddingBeforeBytes) ||
               span.paddingBeforeBytes !== span.destinationOffset - current.endOffset) {
      fallbacks.push({
        spanIndex,
        reason: WGPU_GEOMETRY_COARSE_RANGE_REASON.PADDING_MISMATCH,
      });
      current = null;
      continue;
    }

    if (splitReason) {
      splits.push({ beforeSpanIndex: spanIndex, reason: splitReason });
      current = newCoarseRange(span, spanIndex, end);
      ranges.push(current);
      continue;
    }

    current.spanIndexes.push(spanIndex);
    current.gapBytes += span.destinationOffset - current.endOffset;
    current.endOffset = end;
  }

  return coarseRangeResult(ranges, splits, fallbacks);
}

export function packWgpuGeometryCoarseRanges(options = {}) {
  const plan = planWgpuGeometryCoarseRanges(options);
  if (!plan.ok) return { ...plan, packedRanges: [] };

  const packedRanges = plan.ranges.map((range) => {
    const bytes = new Uint8Array(range.byteLength);
    for (const spanIndex of range.spanIndexes) {
      const span = options.spans[spanIndex];
      const source = new Uint8Array(
        span.bytes.buffer,
        span.bytes.byteOffset,
        span.bytes.byteLength
      );
      bytes.set(source, span.destinationOffset - range.startOffset);
    }
    return Object.freeze({ ...range, bytes });
  });
  return { ...plan, packedRanges: Object.freeze(packedRanges) };
}

export function checkedAlignUp(
  value,
  alignment,
  limit = WGPU_GEOMETRY_PACKET_MAX_OFFSET
) {
  if (!isNonnegativeInteger(value) || !isPositiveInteger(alignment) ||
      !isNonnegativeInteger(limit) || value > limit) {
    return null;
  }
  const remainder = value % alignment;
  if (remainder === 0) return value;
  const increment = alignment - remainder;
  return increment <= limit - value ? value + increment : null;
}

export function planWgpuGeometryPacketLayout({
  baseOffset = 0,
  capacity,
  vertexLength,
  indexLength,
  vertexAlignment = 4,
  indexAlignment = 4,
} = {}) {
  if (!isNonnegativeInteger(capacity) ||
      capacity > WGPU_GEOMETRY_PACKET_MAX_OFFSET ||
      !isNonnegativeInteger(baseOffset) || baseOffset > capacity ||
      !isNonnegativeInteger(vertexLength) ||
      !isNonnegativeInteger(indexLength) ||
      !isPositiveInteger(vertexAlignment) ||
      !isPositiveInteger(indexAlignment)) {
    return null;
  }

  if (vertexLength === 0 && indexLength === 0) {
    return Object.freeze({
      packetOffset: baseOffset,
      packetLength: 0,
      vertexOffset: baseOffset,
      vertexLength: 0,
      indexOffset: baseOffset,
      indexLength: 0,
      indexPadding: 0,
      endOffset: baseOffset,
    });
  }

  const vertexOffset = checkedAlignUp(baseOffset, vertexAlignment, capacity);
  if (vertexOffset === null || vertexLength > capacity - vertexOffset) return null;
  const vertexEnd = vertexOffset + vertexLength;
  const indexOffset = checkedAlignUp(vertexEnd, indexAlignment, capacity);
  if (indexOffset === null || indexLength > capacity - indexOffset) return null;
  const endOffset = indexOffset + indexLength;

  return Object.freeze({
    packetOffset: vertexOffset,
    packetLength: endOffset - vertexOffset,
    vertexOffset,
    vertexLength,
    indexOffset,
    indexLength,
    indexPadding: indexOffset - vertexEnd,
    endOffset,
  });
}

export function packWgpuGeometryPacket({
  vertexBytes,
  indexBytes,
  baseOffset = 0,
  capacity,
  vertexAlignment = 4,
  indexAlignment = 4,
} = {}) {
  const vertex = copyBytes(vertexBytes);
  const index = copyBytes(indexBytes);
  if (vertex === null || index === null) return null;
  const layout = planWgpuGeometryPacketLayout({
    baseOffset,
    capacity,
    vertexLength: vertex.byteLength,
    indexLength: index.byteLength,
    vertexAlignment,
    indexAlignment,
  });
  if (!layout) return null;

  const bytes = new Uint8Array(layout.packetLength);
  bytes.set(vertex, layout.vertexOffset - layout.packetOffset);
  bytes.set(index, layout.indexOffset - layout.packetOffset);
  return { layout, bytes };
}

export function reconstructWgpuGeometryPacket(packet) {
  if (!packet?.layout || !(packet.bytes instanceof Uint8Array)) return null;
  const { layout, bytes } = packet;
  if (bytes.byteLength !== layout.packetLength) return null;
  const vertexStart = layout.vertexOffset - layout.packetOffset;
  const indexStart = layout.indexOffset - layout.packetOffset;
  if (vertexStart < 0 || indexStart < 0 ||
      vertexStart + layout.vertexLength > bytes.byteLength ||
      indexStart + layout.indexLength > bytes.byteLength) {
    return null;
  }
  return {
    vertexBytes: bytes.slice(vertexStart, vertexStart + layout.vertexLength),
    indexBytes: bytes.slice(indexStart, indexStart + layout.indexLength),
  };
}

export function createWgpuGeometryPacketArena({
  capacity,
  maxLiveGenerations = Number.POSITIVE_INFINITY,
  initialGeneration = 1,
} = {}) {
  if (!isPositiveInteger(capacity) || capacity > WGPU_GEOMETRY_PACKET_MAX_OFFSET) {
    throw new RangeError("capacity must be a positive uint32 byte count");
  }
  if (!(maxLiveGenerations === Number.POSITIVE_INFINITY ||
        isPositiveInteger(maxLiveGenerations))) {
    throw new RangeError("maxLiveGenerations must be positive or Infinity");
  }
  if (!isPositiveInteger(initialGeneration) ||
      initialGeneration > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("initialGeneration must be a positive safe integer");
  }

  const owner = Symbol("wgpu-geometry-packet-arena");
  const liveGenerations = new Set();
  let cursor = 0;
  let generation = initialGeneration;
  let pending = null;
  let nextTransactionId = 1;
  let successfulSubmitBarriers = 0;
  let failedSubmitBarriers = 0;
  let rotationsBeforeBarrier = 0;
  let invalidations = 0;

  function prepare(options = {}) {
    if (pending) return null;
    let packed = packWgpuGeometryPacket({ ...options, baseOffset: cursor, capacity });
    let targetGeneration = generation;
    let rotates = false;

    if (!packed) {
      packed = packWgpuGeometryPacket({ ...options, baseOffset: 0, capacity });
      if (!packed || liveGenerations.size >= maxLiveGenerations) return null;
      targetGeneration = nextGeneration(generation);
      rotates = true;
    }

    const transaction = Object.freeze({
      owner,
      id: nextTransactionId,
      generation: targetGeneration,
      rotates,
      layout: packed.layout,
      bytes: packed.bytes,
    });
    nextTransactionId += 1;
    pending = transaction;
    return transaction;
  }

  function commit(transaction) {
    if (!isPending(transaction)) return null;
    pending = null;
    generation = transaction.generation;
    cursor = transaction.layout.endOffset;
    if (transaction.layout.packetLength > 0) liveGenerations.add(generation);
    if (transaction.rotates) rotationsBeforeBarrier += 1;
    return Object.freeze({
      generation,
      layout: transaction.layout,
      bytes: transaction.bytes,
    });
  }

  function abort(transaction) {
    if (!isPending(transaction)) return false;
    pending = null;
    return true;
  }

  function recordSubmitPresent(success) {
    if (!success) {
      failedSubmitBarriers += 1;
      return false;
    }
    if (pending) return false;
    successfulSubmitBarriers += 1;
    liveGenerations.clear();
    cursor = 0;
    generation = nextGeneration(generation);
    return true;
  }

  function invalidate() {
    pending = null;
    liveGenerations.clear();
    cursor = 0;
    generation = nextGeneration(generation);
    invalidations += 1;
  }

  function snapshot() {
    return {
      capacity,
      cursor,
      generation,
      pending: pending !== null,
      liveGenerations: [...liveGenerations],
      successfulSubmitBarriers,
      failedSubmitBarriers,
      rotationsBeforeBarrier,
      invalidations,
    };
  }

  function isPending(transaction) {
    return transaction?.owner === owner && transaction === pending;
  }

  return { prepare, commit, abort, recordSubmitPresent, invalidate, snapshot };
}

function copyBytes(value) {
  if (value == null) return new Uint8Array(0);
  if (!ArrayBuffer.isView(value)) return null;
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
}

function validateCoarseRangeSpan(span, maxRangeBytes, alignment) {
  if (!span || !isNonnegativeInteger(span.generation) ||
      !ArrayBuffer.isView(span.bytes) ||
      !isNonnegativeInteger(span.destinationOffset) ||
      (span.boundaryBefore !== undefined && typeof span.boundaryBefore !== "boolean")) {
    return WGPU_GEOMETRY_COARSE_RANGE_REASON.INVALID_SPAN;
  }
  if (!isValidCoarseRangeIdentity(span.buffer) ||
      !isValidCoarseRangeIdentity(span.passId) ||
      !isValidCoarseRangeIdentity(span.transactionId)) {
    return WGPU_GEOMETRY_COARSE_RANGE_REASON.INVALID_IDENTITY;
  }
  const length = span.bytes.byteLength;
  if (length === 0) {
    return WGPU_GEOMETRY_COARSE_RANGE_REASON.ZERO_LENGTH_SPAN;
  }
  if (span.destinationOffset % alignment !== 0 || length % alignment !== 0) {
    return WGPU_GEOMETRY_COARSE_RANGE_REASON.MISALIGNED_SPAN;
  }
  if (length > maxRangeBytes) {
    return WGPU_GEOMETRY_COARSE_RANGE_REASON.LOGICAL_SPAN_EXCEEDS_CAP;
  }
  if (length > Number.MAX_SAFE_INTEGER - span.destinationOffset ||
      span.destinationOffset + length > WGPU_GEOMETRY_PACKET_MAX_OFFSET) {
    return WGPU_GEOMETRY_COARSE_RANGE_REASON.UNSAFE_INTEGER_OVERFLOW;
  }
  return null;
}

function newCoarseRange(span, spanIndex, endOffset) {
  return {
    buffer: span.buffer,
    generation: span.generation,
    passId: span.passId,
    transactionId: span.transactionId,
    startOffset: span.destinationOffset,
    endOffset,
    spanIndexes: [spanIndex],
    gapBytes: 0,
  };
}

function coarseRangeResult(ranges, splits, fallbacks) {
  const frozenRanges = ranges.map((range) => Object.freeze({
    buffer: range.buffer,
    generation: range.generation,
    passId: range.passId,
    transactionId: range.transactionId,
    startOffset: range.startOffset,
    endOffset: range.endOffset,
    byteLength: range.endOffset - range.startOffset,
    spanIndexes: Object.freeze([...range.spanIndexes]),
    gapBytes: range.gapBytes,
  }));
  return Object.freeze({
    ok: fallbacks.length === 0,
    ranges: Object.freeze(frozenRanges),
    splits: Object.freeze(splits.map((split) => Object.freeze({ ...split }))),
    fallbacks: Object.freeze(fallbacks.map((fallback) => Object.freeze({ ...fallback }))),
  });
}

function findPreviousCoarseSpan(acceptedSpans, span) {
  for (let index = acceptedSpans.length - 1; index >= 0; index -= 1) {
    const previous = acceptedSpans[index];
    if (previous.buffer === span.buffer &&
        previous.generation === span.generation &&
        previous.passId === span.passId &&
        previous.transactionId === span.transactionId) {
      return previous;
    }
  }
  return null;
}

function isValidCoarseRangeIdentity(value) {
  return value !== null && value !== undefined &&
    (typeof value !== "number" || Number.isFinite(value));
}

function isNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nextGeneration(generation) {
  if (generation >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("geometry packet generation overflow");
  }
  return generation + 1;
}
