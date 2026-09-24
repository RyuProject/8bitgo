// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

export const WGPU_LEAF_OP_SET_VERTEX_BUFFER = 15;
export const WGPU_LEAF_OP_SET_INDEX_BUFFER = 16;
export const WGPU_LEAF_OP_SET_VIEWPORT = 17;
export const WGPU_LEAF_OP_SET_SCISSOR = 18;
export const WGPU_LEAF_OP_DRAW = 19;
export const WGPU_LEAF_OP_DRAW_INDEXED = 20;

export const WGPU_LEAF_EXEC_UNHANDLED = 0;
export const WGPU_LEAF_EXEC_APPLIED = 1;
export const WGPU_LEAF_EXEC_SKIPPED = 2;
export const WGPU_LEAF_EXEC_CAUGHT_ERROR = 3;

const NOOP_1 = () => {};
const NOOP_2 = () => {};
const NOOP_3 = () => {};
const NOOP_4 = () => {};
const NOOP_6 = () => {};

/**
 * Allocation-free executor for the draw-leaf subset of the hardware WebGPU
 * command stream. The caller owns the record views and all resource objects.
 *
 * Pipeline and bind-group records deliberately remain outside this class. The
 * owner publishes their validity through setPipelineState/setBindGroupValid,
 * which keeps this leaf independently testable without duplicating resource
 * creation or pipeline resolution.
 */
export class WgpuLeafReplayExecutor {
  constructor({
    buffers,
    stateCache = null,
    stateCacheEnabled = false,
    onStateOutsidePass = NOOP_2,
    onMissingResource = NOOP_2,
    onRendererError = NOOP_2,
    onVertexBufferState = NOOP_3,
    onIndexBufferState = NOOP_3,
    onViewportDepthState = NOOP_3,
    onViewport = NOOP_6,
    onScissor = NOOP_4,
    onDraw = NOOP_6,
    onDrawSkipped = NOOP_1
  }) {
    if (!buffers || typeof buffers.get !== "function") {
      throw new TypeError("buffers must provide get(id)");
    }

    this.buffers = buffers;
    this.stateCache = stateCache;
    this.stateCacheEnabled = Boolean(stateCacheEnabled);

    // Callbacks are injected once. execute() never creates wrapper closures or
    // diagnostic payload objects on the normal record path.
    this.onStateOutsidePass = onStateOutsidePass;
    this.onMissingResource = onMissingResource;
    this.onRendererError = onRendererError;
    this.onVertexBufferState = onVertexBufferState;
    this.onIndexBufferState = onIndexBufferState;
    this.onViewportDepthState = onViewportDepthState;
    this.onViewport = onViewport;
    this.onScissor = onScissor;
    this.onDraw = onDraw;
    this.onDrawSkipped = onDrawSkipped;

    this.pass = null;
    this.passWidth = 0;
    this.passHeight = 0;
    this.passHasPipeline = false;
    this.passNeedsVertexBuffer = false;
    this.bindGroup0Valid = false;
    this.bindGroup1Valid = false;
    this.bindGroup2Valid = false;
    this.vertexBufferValid = false;
    this.indexBufferValid = false;
    this.rasterDiagnosticOpen = false;
    this.reverseDepth = false;
  }

  beginPass(pass, width, height) {
    this.pass = pass;
    this.passWidth = width;
    this.passHeight = height;
    this.passHasPipeline = false;
    this.passNeedsVertexBuffer = false;
    this.bindGroup0Valid = false;
    this.bindGroup1Valid = false;
    this.bindGroup2Valid = false;
    this.vertexBufferValid = false;
    this.indexBufferValid = false;
  }

  endPass() {
    this.pass = null;
  }

  setPipelineState(valid, needsVertexBuffer) {
    this.passHasPipeline = Boolean(valid);
    this.passNeedsVertexBuffer = Boolean(valid && needsVertexBuffer);
  }

  setBindGroupValid(slot, valid) {
    if (slot === 0) this.bindGroup0Valid = Boolean(valid);
    else if (slot === 1) this.bindGroup1Valid = Boolean(valid);
    else if (slot === 2) this.bindGroup2Valid = Boolean(valid);
  }

  setRasterDiagnosticOpen(open) {
    this.rasterDiagnosticOpen = Boolean(open);
  }

  setStateCacheEnabled(enabled) {
    this.stateCacheEnabled = Boolean(enabled);
  }

  execute(op, u32, f32, recWord, recordIndex) {
    switch (op) {
      case WGPU_LEAF_OP_SET_VERTEX_BUFFER:
        return this.executeSetVertexBuffer(u32, recWord, recordIndex);
      case WGPU_LEAF_OP_SET_INDEX_BUFFER:
        return this.executeSetIndexBuffer(u32, recWord, recordIndex);
      case WGPU_LEAF_OP_SET_VIEWPORT:
        return this.executeSetViewport(f32, recWord);
      case WGPU_LEAF_OP_SET_SCISSOR:
        return this.executeSetScissor(u32, recWord);
      case WGPU_LEAF_OP_DRAW:
        return this.executeDraw(u32, recWord, recordIndex);
      case WGPU_LEAF_OP_DRAW_INDEXED:
        return this.executeDrawIndexed(u32, recWord, recordIndex);
      default:
        return WGPU_LEAF_EXEC_UNHANDLED;
    }
  }

  executeSetVertexBuffer(u32, recWord, recordIndex) {
    const bufferId = u32[recWord + 2];
    const buffer = this.buffers.get(bufferId);
    const slot = u32[recWord + 1];
    if (slot === 0) this.vertexBufferValid = false;
    if (!this.pass) {
      this.onStateOutsidePass("set-vertex-buffer", recordIndex);
    }
    if (!buffer) {
      this.onMissingResource("vertex-buffer", bufferId);
    }
    if (!this.pass || !buffer) return WGPU_LEAF_EXEC_SKIPPED;

    const offset = u32[recWord + 3];
    const needsApply = !this.stateCacheEnabled ||
      this.stateCache.vertexBufferNeedsApply(slot, buffer, offset);
    try {
      if (needsApply) {
        this.pass.setVertexBuffer(slot, buffer, offset);
        if (this.stateCacheEnabled) {
          this.stateCache.recordVertexBufferApplied(slot, buffer, offset);
        }
      }
      if (slot === 0) this.vertexBufferValid = true;
      this.onVertexBufferState(slot, bufferId, offset);
      return WGPU_LEAF_EXEC_APPLIED;
    } catch (error) {
      if (this.stateCacheEnabled) {
        this.stateCache.recordVertexBufferApplyFailed(slot);
      }
      this.onRendererError("set-vertex-buffer", error?.message || error);
      return WGPU_LEAF_EXEC_CAUGHT_ERROR;
    }
  }

  executeSetIndexBuffer(u32, recWord, recordIndex) {
    const bufferId = u32[recWord + 1];
    const buffer = this.buffers.get(bufferId);
    this.indexBufferValid = false;
    if (!this.pass) {
      this.onStateOutsidePass("set-index-buffer", recordIndex);
    }
    if (!buffer) {
      this.onMissingResource("index-buffer", bufferId);
    }
    if (!this.pass || !buffer) return WGPU_LEAF_EXEC_SKIPPED;

    const format = u32[recWord + 2] === 1 ? "uint32" : "uint16";
    const offset = u32[recWord + 3];
    const needsApply = !this.stateCacheEnabled ||
      this.stateCache.indexBufferNeedsApply(buffer, format, offset);
    try {
      if (needsApply) {
        this.pass.setIndexBuffer(buffer, format, offset);
        if (this.stateCacheEnabled) {
          this.stateCache.recordIndexBufferApplied(buffer, format, offset);
        }
      }
      this.indexBufferValid = true;
      this.onIndexBufferState(bufferId, format, offset);
      return WGPU_LEAF_EXEC_APPLIED;
    } catch (error) {
      if (this.stateCacheEnabled) {
        this.stateCache.recordIndexBufferApplyFailed();
      }
      this.onRendererError("set-index-buffer", error?.message || error);
      return WGPU_LEAF_EXEC_CAUGHT_ERROR;
    }
  }

  executeSetViewport(f32, recWord) {
    if (!this.pass || this.passWidth <= 0) return WGPU_LEAF_EXEC_SKIPPED;

    let x = f32[recWord + 1];
    let y = f32[recWord + 2];
    let width = f32[recWord + 3];
    let height = f32[recWord + 4];
    if (x < 0) {
      width += x;
      x = 0;
    }
    if (y < 0) {
      height += y;
      y = 0;
    }
    width = Math.max(1, Math.min(width, this.passWidth - x));
    height = Math.max(1, Math.min(height, this.passHeight - y));

    const rawMinDepth = f32[recWord + 5];
    const rawMaxDepth = f32[recWord + 6];
    this.reverseDepth = rawMinDepth > rawMaxDepth;
    // The inline executor publishes reverse-Z before calling WebGPU. Keep that
    // order so a rejected viewport still leaves the same diagnostic state.
    this.onViewportDepthState(this.reverseDepth, rawMinDepth, rawMaxDepth);
    let minDepth = Math.min(1, Math.max(0, rawMinDepth));
    let maxDepth = Math.min(1, Math.max(0, rawMaxDepth));
    if (minDepth > maxDepth) {
      const swap = minDepth;
      minDepth = maxDepth;
      maxDepth = swap;
    }

    // WebGPU failures intentionally propagate, matching the inline switch.
    this.pass.setViewport(x, y, width, height, minDepth, maxDepth);
    this.onViewport(x, y, width, height, minDepth, maxDepth);
    return WGPU_LEAF_EXEC_APPLIED;
  }

  executeSetScissor(u32, recWord) {
    if (!this.pass || this.passWidth <= 0 || this.rasterDiagnosticOpen) {
      return WGPU_LEAF_EXEC_SKIPPED;
    }

    let x = u32[recWord + 1];
    let y = u32[recWord + 2];
    let width = u32[recWord + 3];
    let height = u32[recWord + 4];
    if (x > this.passWidth) x = this.passWidth;
    if (y > this.passHeight) y = this.passHeight;
    width = Math.min(width, this.passWidth - x);
    height = Math.min(height, this.passHeight - y);

    this.pass.setScissorRect(x, y, width, height);
    this.onScissor(x, y, width, height);
    return WGPU_LEAF_EXEC_APPLIED;
  }

  drawStateValid(indexed) {
    return this.passHasPipeline &&
      this.bindGroup0Valid &&
      this.bindGroup1Valid &&
      this.bindGroup2Valid &&
      (!this.passNeedsVertexBuffer || this.vertexBufferValid) &&
      (!indexed || this.indexBufferValid);
  }

  executeDraw(u32, recWord, recordIndex) {
    if (!this.pass) {
      this.onStateOutsidePass("draw", recordIndex);
      return WGPU_LEAF_EXEC_SKIPPED;
    }
    if (!this.drawStateValid(false)) {
      this.onDrawSkipped(false);
      return WGPU_LEAF_EXEC_SKIPPED;
    }

    const vertexCount = u32[recWord + 1];
    const instanceCount = u32[recWord + 2];
    const firstVertex = u32[recWord + 3];
    this.pass.draw(vertexCount, instanceCount, firstVertex, 0);
    this.onDraw(false, vertexCount, instanceCount, firstVertex, 0, 0);
    return WGPU_LEAF_EXEC_APPLIED;
  }

  executeDrawIndexed(u32, recWord, recordIndex) {
    if (!this.pass) {
      this.onStateOutsidePass("draw-indexed", recordIndex);
      return WGPU_LEAF_EXEC_SKIPPED;
    }
    if (!this.drawStateValid(true)) {
      this.onDrawSkipped(true);
      return WGPU_LEAF_EXEC_SKIPPED;
    }

    const indexCount = u32[recWord + 1];
    const instanceCount = u32[recWord + 2];
    const firstIndex = u32[recWord + 3];
    const baseVertex = u32[recWord + 4];
    this.pass.drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, 0);
    this.onDraw(true, indexCount, instanceCount, firstIndex, baseVertex, 0);
    return WGPU_LEAF_EXEC_APPLIED;
  }
}
