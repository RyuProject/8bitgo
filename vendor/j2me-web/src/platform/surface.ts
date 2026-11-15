export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type CanvasLike = HTMLCanvasElement | OffscreenCanvas;

export interface Surface {
  canvas: CanvasLike;
  ctx: Ctx2D;
  width: number;
  height: number;
}

export function createSurface(width: number, height: number, fill: string | null = null): Surface {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const canvas: CanvasLike =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d', { willReadFrequently: false }) as Ctx2D;
  ctx.imageSmoothingEnabled = false;
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, w, h);
  }
  return { canvas, ctx, width, height };
}

export function surfaceFromPixels(width: number, height: number, rgba: Uint8ClampedArray): Surface {
  const surface = createSurface(width, height);
  if (width > 0 && height > 0) {
    surface.ctx.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
  }
  return surface;
}
