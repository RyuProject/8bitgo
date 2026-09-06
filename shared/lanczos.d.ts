/**
 * lanczos.js 的类型声明。
 *
 * 本体必须是 .js（server/ 与 scripts/ 都不过 TypeScript 编译，import 不了 .ts），
 * 按 age / roles 的同一套做法手写一份给前端用。改了 lanczos.js 的导出记得同步这里。
 */

export const LANCZOS_RADIUS: number

export function lanczos(x: number, radius?: number): number

export function buildWeights(
  srcLen: number,
  dstLen: number,
  radius: number,
  offset?: number,
  span?: number,
): { starts: Int32Array; counts: Int32Array; weights: Float32Array; ksize: number }

export function resampleRGBA(
  src: Uint8ClampedArray | Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  opts?: { radius?: number; sx?: number; sy?: number; sw?: number; sh?: number },
): Uint8ClampedArray

export function centerSquare(w: number, h: number): { sx: number; sy: number; size: number }
