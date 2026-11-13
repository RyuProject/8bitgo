import type { JarFile } from '../jar/jar';
import { isPng } from '../gfx/png';
import { isJpeg, jpegSize } from '../gfx/jpeg';

export interface ScreenSize {
  width: number;
  height: number;
}

const HINT_KEYS = ['MIDxlet-ScreenSize', 'Nokia-MIDlet-Original-Display-Size', 'SEMC-Screen-Size'];

function parseSize(value: string | undefined): ScreenSize | null {
  const m = value?.match(/(\d+)\s*[x,*]\s*(\d+)/i);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return width >= 64 && height >= 64 && width <= 1024 && height <= 1024 ? { width, height } : null;
}

/** Most common handset resolutions keyed by screen width. */
const HEIGHT_FOR_WIDTH: Record<number, number> = { 128: 128, 176: 220, 208: 208, 240: 320, 320: 240, 352: 416, 480: 800 };

/** Guesses the intended screen size from manifest hints, the file name and the graphics. */
export function detectScreenSize(jar: JarFile, fileName = ''): ScreenSize {
  for (const key of HINT_KEYS) {
    const size = parseSize(jar.manifest.get(key));
    if (size) return size;
  }
  const fromName = parseSize(fileName);
  if (fromName) return fromName;

  const widths = new Map<number, number>();
  for (const [path, bytes] of jar.entries) {
    const lower = path.toLowerCase();
    if (lower.endsWith('.png') && isPng(bytes) && bytes.length >= 24) {
      const w = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
      if (HEIGHT_FOR_WIDTH[w]) widths.set(w, (widths.get(w) ?? 0) + 1);
      continue;
    }
    // jpg 背景图也能反映屏幕分辨率：SOF 标记同步可读，不用解码像素。
    if ((lower.endsWith('.jpg') || lower.endsWith('.jpeg')) && isJpeg(bytes)) {
      const size = jpegSize(bytes);
      if (size && HEIGHT_FOR_WIDTH[size.width]) widths.set(size.width, (widths.get(size.width) ?? 0) + 1);
    }
  }
  const best = [...widths.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
  if (best) {
    const width = best[0];
    let height = HEIGHT_FOR_WIDTH[width];
    if (width === 176 && usesPackage(jar, 'com/nokia')) height = 208;
    return { width, height };
  }
  return { width: 240, height: 320 };
}

function usesPackage(jar: JarFile, prefix: string): boolean {
  const needle = new TextEncoder().encode(prefix);
  for (const [path, bytes] of jar.entries) {
    if (!path.endsWith('.class')) continue;
    outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
      for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
      return true;
    }
  }
  return false;
}
