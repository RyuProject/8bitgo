// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

export const WGPU_UBO_ALIGNMENT = 256;

function alignUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

export function planDenseUboPacket({
  cursor = 0,
  ringSize,
  payloads,
  changeMask,
  alignment = WGPU_UBO_ALIGNMENT,
}) {
  const classes = Array.from(payloads ?? [], (payload) =>
    payload instanceof Uint8Array ? payload : new Uint8Array(payload ?? 0)
  );
  if (classes.length !== 3) throw new RangeError("exactly three UBO classes are required");
  if (!Number.isInteger(ringSize) || ringSize <= 0) throw new RangeError("invalid UBO ring size");
  if (!Number.isInteger(alignment) || alignment <= 0 || (alignment & (alignment - 1)) !== 0) {
    throw new RangeError("UBO alignment must be a positive power of two");
  }

  const mask = Number(changeMask) & 7;
  const relativeOffsets = [null, null, null];
  let packetSize = 0;
  // Physical PS, GS, VS order minimizes padding for Dolphin's real block
  // sizes while returned offsets remain logically indexed VS, PS, GS.
  for (const index of [1, 2, 0]) {
    if ((mask & (1 << index)) === 0) continue;
    packetSize = alignUp(packetSize, alignment);
    relativeOffsets[index] = packetSize;
    packetSize += classes[index].byteLength;
  }
  packetSize = alignUp(packetSize, alignment);
  if (packetSize === 0) {
    return { changeMask: mask, start: cursor, end: cursor, packetSize: 0,
      relativeOffsets, destinationOffsets: [null, null, null] };
  }
  if (packetSize > ringSize) throw new RangeError("dense UBO packet exceeds the ring");

  let start = alignUp(cursor, alignment);
  if (start + packetSize > ringSize) start = 0;
  const destinationOffsets = relativeOffsets.map((offset) =>
    offset == null ? null : start + offset
  );
  return {
    changeMask: mask,
    start,
    end: start + packetSize,
    packetSize,
    relativeOffsets,
    destinationOffsets,
  };
}

export function buildDenseUboSourcePacket(plan, payloads) {
  const packet = new Uint8Array(plan.packetSize);
  for (let index = 0; index < 3; index += 1) {
    const offset = plan.relativeOffsets[index];
    if (offset == null) continue;
    packet.set(payloads[index], offset);
  }
  return packet;
}

export function replayDenseUboUpload(destination, plan, sourcePacket) {
  if (sourcePacket.byteLength !== plan.packetSize) {
    throw new RangeError("dense UBO source packet size mismatch");
  }
  destination.set(sourcePacket, plan.start);
}
