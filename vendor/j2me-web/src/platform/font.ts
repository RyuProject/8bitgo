import { createSurface } from './surface';

export const FACE_SYSTEM = 0;
export const FACE_MONOSPACE = 32;
export const FACE_PROPORTIONAL = 64;
export const STYLE_PLAIN = 0;
export const STYLE_BOLD = 1;
export const STYLE_ITALIC = 2;
export const STYLE_UNDERLINED = 4;
export const SIZE_SMALL = 8;
export const SIZE_MEDIUM = 0;
export const SIZE_LARGE = 16;

const measureCtx = createSurface(1, 1).ctx;

export class FontPeer {
  readonly px: number;
  readonly css: string;
  readonly height: number;
  readonly baseline: number;
  private readonly widths = new Map<number, number>();

  constructor(
    readonly face: number,
    readonly style: number,
    readonly size: number,
    sizes: { small: number; medium: number; large: number },
  ) {
    this.px = size === SIZE_SMALL ? sizes.small : size === SIZE_LARGE ? sizes.large : sizes.medium;
    const family = face === FACE_MONOSPACE ? '"Courier New", monospace' : 'Arial, Helvetica, sans-serif';
    this.css = `${style & STYLE_ITALIC ? 'italic ' : ''}${style & STYLE_BOLD ? 'bold ' : ''}${this.px}px ${family}`;
    this.baseline = Math.round(this.px * 0.82);
    this.height = this.px + 2;
  }

  charWidth(code: number): number {
    let w = this.widths.get(code);
    if (w === undefined) {
      measureCtx.font = this.css;
      w = Math.round(measureCtx.measureText(String.fromCharCode(code)).width);
      this.widths.set(code, w);
    }
    return w;
  }

  stringWidth(s: string): number {
    measureCtx.font = this.css;
    return Math.round(measureCtx.measureText(s).width);
  }
}
