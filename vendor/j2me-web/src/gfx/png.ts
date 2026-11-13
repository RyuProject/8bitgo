import { inflateSync, unzlibSync } from 'fflate';

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel. */
  data: Uint8ClampedArray;
}

export class ImageDecodeError extends Error {}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && SIGNATURE.every((b, i) => bytes[i] === b);
}

/** Synchronous PNG decoder (all color types, bit depths, tRNS and Adam7 interlacing). */
export function decodePng(bytes: Uint8Array): DecodedImage {
  if (!isPng(bytes)) throw new ImageDecodeError('Not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];

  for (let pos = 8; pos + 8 <= bytes.length; ) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, Math.min(pos + 8 + len, bytes.length));
    pos += 12 + len;
    if (type === 'IHDR') {
      width = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
      height = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  const channels = CHANNELS[colorType];
  if (!width || !height || !channels) throw new ImageDecodeError('Bad PNG header');

  const compressed = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of idat) {
    compressed.set(chunk, offset);
    offset += chunk.length;
  }

  let raw: Uint8Array;
  try {
    raw = unzlibSync(compressed);
  } catch {
    try {
      raw = inflateSync(compressed.subarray(2));
    } catch {
      throw new ImageDecodeError('Corrupt PNG data');
    }
  }

  const out = new Uint8ClampedArray(width * height * 4);
  const bitsPerPixel = channels * bitDepth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const maxSample = (1 << bitDepth) - 1;

  const trnsGray = trns && colorType === 0 && trns.length >= 2 ? (trns[0] << 8) | trns[1] : -1;
  const trnsRgb =
    trns && colorType === 2 && trns.length >= 6 ? [(trns[0] << 8) | trns[1], (trns[2] << 8) | trns[3], (trns[4] << 8) | trns[5]] : null;

  let rawPos = 0;
  const decodePass = (xStart: number, yStart: number, xStep: number, yStep: number) => {
    const passWidth = Math.ceil((width - xStart) / xStep);
    const passHeight = Math.ceil((height - yStart) / yStep);
    if (passWidth <= 0 || passHeight <= 0) return;
    const stride = Math.ceil((passWidth * bitsPerPixel) / 8);
    let prev = new Uint8Array(stride);
    let line = new Uint8Array(stride);

    for (let py = 0; py < passHeight; py++) {
      if (rawPos + 1 + stride > raw.length) return;
      const filter = raw[rawPos++];
      line.set(raw.subarray(rawPos, rawPos + stride));
      rawPos += stride;
      unfilter(filter, line, prev, bpp);

      const y = yStart + py * yStep;
      for (let px = 0; px < passWidth; px++) {
        const x = xStart + px * xStep;
        const o = (y * width + x) * 4;
        const sample = (index: number): number => {
          if (bitDepth === 8) return line[index];
          if (bitDepth === 16) return (line[index * 2] << 8) | line[index * 2 + 1];
          const bit = index * bitDepth;
          return (line[bit >> 3] >> (8 - bitDepth - (bit & 7))) & maxSample;
        };
        const base = px * channels;
        const to8 = (v: number) => (bitDepth === 16 ? v >> 8 : bitDepth === 8 ? v : Math.round((v * 255) / maxSample));

        switch (colorType) {
          case 0: {
            const g = sample(base);
            const g8 = to8(g);
            out[o] = out[o + 1] = out[o + 2] = g8;
            out[o + 3] = g === trnsGray ? 0 : 255;
            break;
          }
          case 2: {
            const r = sample(base);
            const g = sample(base + 1);
            const b = sample(base + 2);
            out[o] = to8(r);
            out[o + 1] = to8(g);
            out[o + 2] = to8(b);
            out[o + 3] = trnsRgb && r === trnsRgb[0] && g === trnsRgb[1] && b === trnsRgb[2] ? 0 : 255;
            break;
          }
          case 3: {
            const idx = sample(base);
            if (palette && idx * 3 + 2 < palette.length) {
              out[o] = palette[idx * 3];
              out[o + 1] = palette[idx * 3 + 1];
              out[o + 2] = palette[idx * 3 + 2];
            }
            out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
            break;
          }
          case 4: {
            const g8 = to8(sample(base));
            out[o] = out[o + 1] = out[o + 2] = g8;
            out[o + 3] = to8(sample(base + 1));
            break;
          }
          case 6:
            out[o] = to8(sample(base));
            out[o + 1] = to8(sample(base + 1));
            out[o + 2] = to8(sample(base + 2));
            out[o + 3] = to8(sample(base + 3));
            break;
        }
      }
      [prev, line] = [line, prev];
    }
  };

  if (interlace === 1) for (const [xs, ys, xst, yst] of ADAM7) decodePass(xs, ys, xst, yst);
  else decodePass(0, 0, 1, 1);

  return { width, height, data: out };
}

function unfilter(filter: number, line: Uint8Array, prev: Uint8Array, bpp: number): void {
  const n = line.length;
  switch (filter) {
    case 1:
      for (let i = bpp; i < n; i++) line[i] = (line[i] + line[i - bpp]) & 0xff;
      break;
    case 2:
      for (let i = 0; i < n; i++) line[i] = (line[i] + prev[i]) & 0xff;
      break;
    case 3:
      for (let i = 0; i < n; i++) {
        const left = i >= bpp ? line[i - bpp] : 0;
        line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xff;
      }
      break;
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      break;
  }
}
