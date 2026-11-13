import type { JObject } from '../jvm/types';
import type { FontPeer } from './font';
import { STYLE_UNDERLINED } from './font';
import { type CanvasLike, type Surface, createSurface } from './surface';

export const HCENTER = 1;
export const VCENTER = 2;
export const LEFT = 4;
export const RIGHT = 8;
export const TOP = 16;
export const BOTTOM = 32;
export const BASELINE = 64;

export const TRANS_NONE = 0;
export const TRANS_MIRROR_ROT180 = 1;
export const TRANS_MIRROR = 2;
export const TRANS_ROT180 = 3;
export const TRANS_MIRROR_ROT270 = 4;
export const TRANS_ROT90 = 5;
export const TRANS_ROT270 = 6;
export const TRANS_MIRROR_ROT90 = 7;

export class ImagePeer {
  constructor(
    readonly surface: Surface,
    readonly mutable: boolean,
  ) {}

  get width(): number {
    return this.surface.width;
  }

  get height(): number {
    return this.surface.height;
  }
}

let scratch: Surface | null = null;
function scratchSurface(w: number, h: number): Surface {
  if (!scratch || scratch.width < w || scratch.height < h) {
    scratch = createSurface(Math.max(w, scratch?.width ?? 0), Math.max(h, scratch?.height ?? 0));
  }
  return scratch;
}

/** Returns [a, b, c, d, e, f] mapping source region coordinates to destination coordinates. */
function transformMatrix(transform: number, sw: number, sh: number): [number, number, number, number, number, number] {
  switch (transform) {
    case TRANS_MIRROR_ROT180:
      return [1, 0, 0, -1, 0, sh];
    case TRANS_MIRROR:
      return [-1, 0, 0, 1, sw, 0];
    case TRANS_ROT180:
      return [-1, 0, 0, -1, sw, sh];
    case TRANS_MIRROR_ROT270:
      return [0, 1, 1, 0, 0, 0];
    case TRANS_ROT90:
      return [0, 1, -1, 0, sh, 0];
    case TRANS_ROT270:
      return [0, -1, 1, 0, 0, sw];
    case TRANS_MIRROR_ROT90:
      return [0, -1, -1, 0, sh, sw];
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

export class GraphicsPeer {
  tx = 0;
  ty = 0;
  clipX = 0;
  clipY = 0;
  clipW = 0;
  clipH = 0;
  color = 0;
  stroke = 0;
  font!: FontPeer;
  fontObject: JObject | null = null;
  private style = '#000000';

  constructor(
    readonly surface: Surface,
    private readonly defaultFont: () => { peer: FontPeer; obj: JObject },
  ) {
    this.reset();
  }

  reset(): void {
    this.tx = 0;
    this.ty = 0;
    this.clipX = 0;
    this.clipY = 0;
    this.clipW = this.surface.width;
    this.clipH = this.surface.height;
    this.setColor(0);
    this.stroke = 0;
    const f = this.defaultFont();
    this.font = f.peer;
    this.fontObject = f.obj;
  }

  get ctx() {
    return this.surface.ctx;
  }

  setColor(rgb: number): void {
    rgb &= 0xffffff;
    if (rgb === this.color && this.style) return;
    this.color = rgb;
    this.style = `#${rgb.toString(16).padStart(6, '0')}`;
  }

  translate(x: number, y: number): void {
    this.tx += x;
    this.ty += y;
  }

  setClip(x: number, y: number, w: number, h: number): void {
    this.clipX = x + this.tx;
    this.clipY = y + this.ty;
    this.clipW = Math.max(0, w);
    this.clipH = Math.max(0, h);
  }

  clipRect(x: number, y: number, w: number, h: number): void {
    const x0 = Math.max(this.clipX, x + this.tx);
    const y0 = Math.max(this.clipY, y + this.ty);
    const x1 = Math.min(this.clipX + this.clipW, x + this.tx + w);
    const y1 = Math.min(this.clipY + this.clipH, y + this.ty + h);
    this.clipX = x0;
    this.clipY = y0;
    this.clipW = Math.max(0, x1 - x0);
    this.clipH = Math.max(0, y1 - y0);
  }

  /** Fills an absolute-coordinate rectangle, clipped. */
  private fillAbs(x0: number, y0: number, x1: number, y1: number): void {
    if (x0 < this.clipX) x0 = this.clipX;
    if (y0 < this.clipY) y0 = this.clipY;
    const cx1 = this.clipX + this.clipW;
    const cy1 = this.clipY + this.clipH;
    if (x1 > cx1) x1 = cx1;
    if (y1 > cy1) y1 = cy1;
    if (x1 <= x0 || y1 <= y0) return;
    const ctx = this.ctx;
    ctx.fillStyle = this.style;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    const ax = x + this.tx;
    const ay = y + this.ty;
    this.fillAbs(ax, ay, ax + w, ay + h);
  }

  drawRect(x: number, y: number, w: number, h: number): void {
    if (w < 0 || h < 0) return;
    if (w === 0 || h === 0) {
      this.fillRect(x, y, w + 1, h + 1);
      return;
    }
    this.fillRect(x, y, w + 1, 1);
    this.fillRect(x, y + h, w + 1, 1);
    this.fillRect(x, y + 1, 1, h - 1);
    this.fillRect(x + w, y + 1, 1, h - 1);
  }

  drawLine(x1: number, y1: number, x2: number, y2: number): void {
    if (y1 === y2) {
      this.fillRect(Math.min(x1, x2), y1, Math.abs(x2 - x1) + 1, 1);
      return;
    }
    if (x1 === x2) {
      this.fillRect(x1, Math.min(y1, y2), 1, Math.abs(y2 - y1) + 1);
      return;
    }
    const dx = Math.abs(x2 - x1);
    const dy = -Math.abs(y2 - y1);
    const sx = x1 < x2 ? 1 : -1;
    const sy = y1 < y2 ? 1 : -1;
    let err = dx + dy;
    let x = x1;
    let y = y1;
    for (;;) {
      this.fillRect(x, y, 1, 1);
      if (x === x2 && y === y2) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  /** Draws `src[sx, sy, sw, sh]` at absolute (dx, dy) without scaling, clipped. */
  blit(src: CanvasLike, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number): void {
    let x0 = dx;
    let y0 = dy;
    let x1 = dx + sw;
    let y1 = dy + sh;
    if (x0 < this.clipX) {
      sx += this.clipX - x0;
      x0 = this.clipX;
    }
    if (y0 < this.clipY) {
      sy += this.clipY - y0;
      y0 = this.clipY;
    }
    x1 = Math.min(x1, this.clipX + this.clipW);
    y1 = Math.min(y1, this.clipY + this.clipH);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) return;
    this.ctx.drawImage(src, sx, sy, w, h, x0, y0, w, h);
  }

  drawImage(img: ImagePeer, x: number, y: number, anchor: number): void {
    let dx = x + this.tx;
    let dy = y + this.ty;
    if (anchor & HCENTER) dx -= img.width >> 1;
    else if (anchor & RIGHT) dx -= img.width;
    if (anchor & VCENTER) dy -= img.height >> 1;
    else if (anchor & BOTTOM) dy -= img.height;
    this.blit(img.surface.canvas, 0, 0, img.width, img.height, dx, dy);
  }

  drawRegion(img: ImagePeer, sx: number, sy: number, sw: number, sh: number, transform: number, x: number, y: number, anchor: number): void {
    if (sw <= 0 || sh <= 0) return;
    const rotated = transform >= TRANS_MIRROR_ROT270;
    const dw = rotated ? sh : sw;
    const dh = rotated ? sw : sh;
    let dx = x + this.tx;
    let dy = y + this.ty;
    if (anchor & HCENTER) dx -= dw >> 1;
    else if (anchor & RIGHT) dx -= dw;
    if (anchor & VCENTER) dy -= dh >> 1;
    else if (anchor & BOTTOM) dy -= dh;

    if (transform === TRANS_NONE) {
      this.blit(img.surface.canvas, sx, sy, sw, sh, dx, dy);
      return;
    }
    const ctx = this.ctx;
    const [a, b, c, d, e, f] = transformMatrix(transform, sw, sh);
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.clipX, this.clipY, this.clipW, this.clipH);
    ctx.clip();
    ctx.setTransform(a, b, c, d, e + dx, f + dy);
    ctx.drawImage(img.surface.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    ctx.restore();
  }

  drawRGB(data: Int32Array, offset: number, scan: number, x: number, y: number, w: number, h: number, alpha: boolean): void {
    if (w <= 0 || h <= 0) return;
    const tmp = scratchSurface(w, h);
    const image = tmp.ctx.createImageData(w, h);
    const px = image.data;
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const p = data[offset + row * scan + col] ?? 0;
        const o = (row * w + col) * 4;
        px[o] = (p >> 16) & 0xff;
        px[o + 1] = (p >> 8) & 0xff;
        px[o + 2] = p & 0xff;
        px[o + 3] = alpha ? (p >>> 24) & 0xff : 0xff;
      }
    }
    tmp.ctx.clearRect(0, 0, w, h);
    tmp.ctx.putImageData(image, 0, 0);
    this.blit(tmp.canvas, 0, 0, w, h, x + this.tx, y + this.ty);
  }

  private withClip(draw: (ctx: Surface['ctx']) => void): void {
    if (this.clipW <= 0 || this.clipH <= 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.clipX, this.clipY, this.clipW, this.clipH);
    ctx.clip();
    ctx.fillStyle = this.style;
    ctx.strokeStyle = this.style;
    ctx.lineWidth = 1;
    draw(ctx);
    ctx.restore();
  }

  drawString(s: string, x: number, y: number, anchor: number): void {
    if (!s) return;
    const font = this.font;
    const width = font.stringWidth(s);
    let dx = x + this.tx;
    if (anchor & HCENTER) dx -= width >> 1;
    else if (anchor & RIGHT) dx -= width;
    let baseline = y + this.ty;
    if (anchor & BOTTOM) baseline -= font.height - font.baseline;
    else if (!(anchor & BASELINE)) baseline += font.baseline;
    this.withClip((ctx) => {
      ctx.font = font.css;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(s, dx, baseline);
      if (font.style & STYLE_UNDERLINED) ctx.fillRect(dx, baseline + 1, width, 1);
    });
  }

  fillArc(x: number, y: number, w: number, h: number, start: number, arc: number): void {
    if (w <= 0 || h <= 0) return;
    const cx = x + this.tx + w / 2;
    const cy = y + this.ty + h / 2;
    this.withClip((ctx) => {
      ctx.beginPath();
      if (Math.abs(arc) >= 360) ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
      else {
        ctx.moveTo(cx, cy);
        ctx.ellipse(cx, cy, w / 2, h / 2, 0, (-start * Math.PI) / 180, (-(start + arc) * Math.PI) / 180, arc > 0);
        ctx.closePath();
      }
      ctx.fill();
    });
  }

  drawArc(x: number, y: number, w: number, h: number, start: number, arc: number): void {
    if (w < 0 || h < 0) return;
    const cx = x + this.tx + w / 2 + 0.5;
    const cy = y + this.ty + h / 2 + 0.5;
    this.withClip((ctx) => {
      ctx.beginPath();
      ctx.ellipse(cx, cy, w / 2, h / 2, 0, (-start * Math.PI) / 180, (-(start + arc) * Math.PI) / 180, arc > 0);
      ctx.stroke();
    });
  }

  fillRoundRect(x: number, y: number, w: number, h: number, aw: number, ah: number): void {
    if (w <= 0 || h <= 0) return;
    this.withClip((ctx) => {
      ctx.beginPath();
      ctx.roundRect(x + this.tx, y + this.ty, w, h, [Math.min(aw, w) / 2]);
      ctx.fill();
    });
  }

  drawRoundRect(x: number, y: number, w: number, h: number, aw: number, ah: number): void {
    if (w < 0 || h < 0) return;
    this.withClip((ctx) => {
      ctx.beginPath();
      ctx.roundRect(x + this.tx + 0.5, y + this.ty + 0.5, w, h, [Math.min(aw, w) / 2]);
      ctx.stroke();
    });
  }

  fillTriangle(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void {
    this.withClip((ctx) => {
      ctx.beginPath();
      ctx.moveTo(x1 + this.tx, y1 + this.ty);
      ctx.lineTo(x2 + this.tx, y2 + this.ty);
      ctx.lineTo(x3 + this.tx, y3 + this.ty);
      ctx.closePath();
      ctx.fill();
    });
  }

  copyArea(sx: number, sy: number, w: number, h: number, dx: number, dy: number, anchor: number): void {
    let x = dx + this.tx;
    let y = dy + this.ty;
    if (anchor & HCENTER) x -= w >> 1;
    else if (anchor & RIGHT) x -= w;
    if (anchor & VCENTER) y -= h >> 1;
    else if (anchor & BOTTOM) y -= h;
    const tmp = scratchSurface(w, h);
    tmp.ctx.clearRect(0, 0, w, h);
    tmp.ctx.drawImage(this.surface.canvas, sx + this.tx, sy + this.ty, w, h, 0, 0, w, h);
    this.blit(tmp.canvas, 0, 0, w, h, x, y);
  }
}
