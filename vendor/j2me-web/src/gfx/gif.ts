/**
 * 8BitGo：同步 GIF 解码（只解第一帧）。
 *
 * MIDP 的 Image.createImage 是同步 API，浏览器原生解码却是异步的；JPEG 靠启动时预解码 JAR 条目兜住，
 * 但很多国产游戏把 GIF 打进自己的资源包（如《仙剑奇侠传 2004》的 image.pak），运行时才用
 * createImage(byte[]) 读出来，预解码根本看不到 —— 以前全变成空白图。GIF 是 LZW + 调色板，
 * 体积小、规则简单，直接在这里同步解掉。
 *
 * 只取第一帧：真机的 MIDP Image 也不播 GIF 动画。支持全局 / 局部调色板、透明色（Graphic Control
 * Extension）、交错存储；损坏数据抛异常，由调用方转成 IllegalArgumentException。
 */
import type { DecodedImage } from './png';

export function decodeGif(bytes: Uint8Array): DecodedImage {
  if (bytes.length < 13 || bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) throw new Error('not a GIF');
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  if (width <= 0 || height <= 0 || width * height > 4096 * 4096) throw new Error(`bad GIF size ${width}x${height}`);
  const flags = bytes[10];
  let pos = 13;
  let globalTable: Uint8Array | null = null;
  if (flags & 0x80) {
    const size = 3 * (1 << ((flags & 7) + 1));
    globalTable = bytes.subarray(pos, pos + size);
    pos += size;
  }
  let transparent = -1;
  const out = new Uint8ClampedArray(width * height * 4); // 帧外区域保持透明

  while (pos < bytes.length) {
    const block = bytes[pos++];
    if (block === 0x21) {
      // 扩展块：只关心 Graphic Control（透明色），其余跳过
      const label = bytes[pos++];
      if (label === 0xf9 && bytes[pos] >= 4) {
        const packed = bytes[pos + 1];
        if (packed & 1) transparent = bytes[pos + 4];
      }
      while (pos < bytes.length && bytes[pos] !== 0) pos += bytes[pos] + 1;
      pos++;
      continue;
    }
    if (block !== 0x2c) break; // 0x3b 结束或数据损坏

    const left = bytes[pos] | (bytes[pos + 1] << 8);
    const top = bytes[pos + 2] | (bytes[pos + 3] << 8);
    const fw = bytes[pos + 4] | (bytes[pos + 5] << 8);
    const fh = bytes[pos + 6] | (bytes[pos + 7] << 8);
    const imageFlags = bytes[pos + 8];
    pos += 9;
    let table = globalTable;
    if (imageFlags & 0x80) {
      const size = 3 * (1 << ((imageFlags & 7) + 1));
      table = bytes.subarray(pos, pos + size);
      pos += size;
    }
    if (!table) throw new Error('GIF has no color table');
    const interlaced = (imageFlags & 0x40) !== 0;

    const minCodeSize = bytes[pos++];
    if (minCodeSize < 2 || minCodeSize > 11) throw new Error('bad GIF LZW code size');
    // 把子块拼成连续数据
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (pos < bytes.length) {
      const n = bytes[pos++];
      if (n === 0) break;
      chunks.push(bytes.subarray(pos, pos + n));
      total += n;
      pos += n;
    }
    const data = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      data.set(c, off);
      off += c.length;
    }

    const indices = lzwDecode(data, minCodeSize, fw * fh);
    const rows = interlacedRows(fh, interlaced);
    for (let i = 0; i < fh; i++) {
      const y = top + rows[i];
      if (y < 0 || y >= height) continue;
      for (let x = 0; x < fw; x++) {
        const dx = left + x;
        if (dx < 0 || dx >= width) continue;
        const idx = indices[i * fw + x];
        if (idx === transparent) continue;
        const o = (y * width + dx) * 4;
        out[o] = table[idx * 3] ?? 0;
        out[o + 1] = table[idx * 3 + 1] ?? 0;
        out[o + 2] = table[idx * 3 + 2] ?? 0;
        out[o + 3] = 0xff;
      }
    }
    return { width, height, data: out };
  }
  throw new Error('GIF has no image');
}

/** 交错 GIF 的第 i 条存储行对应的实际行号 */
function interlacedRows(h: number, interlaced: boolean): Int32Array {
  const rows = new Int32Array(h);
  if (!interlaced) {
    for (let i = 0; i < h; i++) rows[i] = i;
    return rows;
  }
  let i = 0;
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let y = start; y < h; y += step) rows[i++] = y;
  }
  return rows;
}

function lzwDecode(data: Uint8Array, minCodeSize: number, pixelCount: number): Uint8Array {
  const out = new Uint8Array(pixelCount);
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const prefix = new Int16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  let codeSize = minCodeSize + 1;
  let next = clear + 2;
  let old = -1;
  let first = 0;
  let bits = 0;
  let acc = 0;
  let op = 0;
  for (let i = 0; i < clear; i++) suffix[i] = i;

  for (let p = 0; p < data.length && op < pixelCount; ) {
    while (bits < codeSize && p < data.length) {
      acc |= data[p++] << bits;
      bits += 8;
    }
    if (bits < codeSize) break;
    const code = acc & ((1 << codeSize) - 1);
    acc >>>= codeSize;
    bits -= codeSize;

    if (code === clear) {
      codeSize = minCodeSize + 1;
      next = clear + 2;
      old = -1;
      continue;
    }
    if (code === end) break;
    if (old === -1) {
      if (code >= clear) break;
      out[op++] = code;
      old = code;
      first = code;
      continue;
    }
    let cur = code;
    let sp = 0;
    if (code >= next) {
      // KwKwK：新码 = 旧串 + 旧串首字符
      stack[sp++] = first;
      cur = old;
    }
    while (cur >= clear) {
      if (sp >= stack.length - 1) throw new Error('bad GIF LZW data');
      stack[sp++] = suffix[cur];
      cur = prefix[cur];
    }
    first = cur;
    stack[sp++] = cur;
    while (sp > 0 && op < pixelCount) out[op++] = stack[--sp];
    if (next < 4096) {
      prefix[next] = old;
      suffix[next] = first;
      next++;
      if (next === 1 << codeSize && codeSize < 12) codeSize++;
    }
    old = code;
  }
  return out;
}
