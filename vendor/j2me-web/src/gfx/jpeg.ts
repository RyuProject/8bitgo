import type { DecodedImage } from './png';

/**
 * JPEG 支持：尺寸同步解析 + 像素异步预解码。
 *
 * ## 为什么要分成两半
 *
 * MIDP 的 `Image.createImage(InputStream)` 是**同步**方法，但浏览器解码 JPEG
 * 只能靠 `createImageBitmap`，那是**异步**的（返回 Promise）。JS 没有「同步等
 * Promise」的合法办法（`Atomics.wait` 会阻塞事件循环，连带 createImageBitmap
 * 的解码线程一起卡死）。所以只能拆开：
 *
 * - **尺寸**（`getWidth`/`getHeight`，游戏用来算布局）→ 扫 SOF 标记，**同步**拿到。
 * - **像素**（`drawImage`）→ 在 MIDlet 启动**之前**把 jar 里的 jpg 全部
 *   `await createImageBitmap` 解好放进缓存；运行时 `createImage` 只是查表。
 *
 * ## 为什么用浏览器解码器而不是自己写 jpeg 解码器
 *
 * 基线 JPEG 解码器（Huffman + IDCT + 上采样）最少 500~800 行；算上渐进式、
 * 各种色度采样、CMYK/YCCK 色彩空间，能做到正确的要上千行。而浏览器里本来就
 * 躺着一个工业级 JPEG 解码器（libjpeg-turbo），`createImageBitmap` 一行就能
 * 拿到像素。这正是本项目的核心思路——**缺的让浏览器补，别自己重造**：
 * 约 120 行代码换来完整 JPEG 支持，0 KB 额外体积。
 *
 * 同理不做 GIF（`createImageBitmap` 只解第一帧）和 BMP（J2ME 里 BMP 极少，
 * 真遇到再说），这两个在 `unsupportedImageFormat` 里给出明确提示。
 */

/** JPEG 起始标记 FFD8 + 下一字节（FF D8 FF 是 SOI+标记前缀）。 */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export function isGif(bytes: Uint8Array): boolean {
  return bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46;
}

/**
 * 同步从 SOF 标记读出尺寸。JPEG 里尺寸就明文写在文件头附近（几百字节内），
 * 所以不解码也能瞬间拿到——这正是 MIDP 同步 API 需要的东西。
 *
 * 支持的 SOF：SOF0/1/2/3/5/6/7/9/10/11/13/14/15。
 * 排除：DHT(C4)/JPG(C8)/DAC(CC)，这几个是 C4/C8/CC 不是 SOF，容易混。
 */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (!isJpeg(bytes)) return null;
  let p = 2;
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff) {
      p++;
      continue;
    }
    let marker = bytes[p + 1];
    // 跳过填充字节：FF FF D8 里连续的 FF 都只是个填充
    while (marker === 0xff && p + 2 < bytes.length) {
      p++;
      marker = bytes[p + 1];
    }
    p += 2;
    // 无长度字段的标记
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) break; // EOI
    if (p + 2 > bytes.length) break;
    const len = (bytes[p] << 8) | bytes[p + 1];
    if (len < 2 || p + len > bytes.length) break;
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      // 段结构：FF Cn(2) 长度(2) 精度(1) 高(2) 宽(2) 组件数(1) ...
      if (p + 7 <= bytes.length) {
        const height = (bytes[p + 3] << 8) | bytes[p + 4];
        const width = (bytes[p + 5] << 8) | bytes[p + 6];
        if (width > 0 && height > 0) return { width, height };
      }
      return null;
    }
    p += len;
  }
  return null;
}

/**
 * 异步解码 JPEG 像素。走浏览器原生解码器（libjpeg-turbo），
 * 所以基线/渐进式、4:4:4/4:2:2/4:2:0、灰度、CMYK 全都支持。
 */
export async function decodeJpeg(bytes: Uint8Array): Promise<DecodedImage> {
  const info = jpegSize(bytes);
  // 用 Blob 而不是 dataURL：省掉 base64 编解码（十几 KB 图片能省一半时间），
  // 也避免超大图片（某些游戏资源 1024x1024）在 dataURL 里爆字符串。
  const blob = new Blob([bytes as BlobPart], { type: 'image/jpeg' });
  const bitmap = await createImageBitmap(blob);
  try {
    const width = bitmap.width;
    const height = bitmap.height;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D context unavailable');
    ctx.drawImage(bitmap, 0, 0);
    const img = ctx.getImageData(0, 0, width, height);
    // getImageData 给的是 Uint8ClampedArray，正是 DecodedImage 要的类型
    return { width, height, data: new Uint8ClampedArray(img.data) };
  } finally {
    bitmap.close();
    void info;
  }
}

/**
 * 已解码 JPEG 的缓存。key 用文件内容的 FNV-1a 哈希 + 长度，
 * 这样「同一个 jpg 从不同路径/不同流读进来」也能命中缓存——
 * 老游戏经常把同一张图塞进多个资源条目。
 */
const cache = new Map<string, DecodedImage>();

/** 内容指纹：长度 + FNV-1a 32 位。够用且极快（不用为了一致性去 crypto）。 */
export function fingerprint(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return `${bytes.length}:${(h >>> 0).toString(36)}`;
}

export function cachedJpeg(bytes: Uint8Array): DecodedImage | undefined {
  return cache.get(fingerprint(bytes));
}

export function cacheJpeg(bytes: Uint8Array, img: DecodedImage): void {
  cache.set(fingerprint(bytes), img);
}

/** 测试/重载用：清空缓存。 */
export function clearJpegCache(): void {
  cache.clear();
}

/**
 * 启动预热：把 jar 里所有 jpeg 资源解好。
 * 必须在 MIDlet 启动前 await 完，否则运行时的同步 createImage 拿不到像素。
 *
 * 返回统计用于日志：解成功几张、失败几张（失败不阻断游戏，只记日志）。
 */
export async function prewarmImages(
  entries: Iterable<[string, Uint8Array]>,
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<{ decoded: number; failed: number; total: number }> {
  const jobs: [string, Uint8Array][] = [];
  for (const [name, bytes] of entries) {
    if (isJpeg(bytes)) jobs.push([name, bytes]);
  }
  let decoded = 0;
  let failed = 0;
  // 串行解码：并行 createImageBitmap 反而容易让主线程解码排队超时，
  // 而且串行的耗时可预期（每张 1~3ms）。
  for (let i = 0; i < jobs.length; i++) {
    const [name, bytes] = jobs[i];
    try {
      cacheJpeg(bytes, await decodeJpeg(bytes));
      decoded++;
    } catch {
      failed++;
    }
    onProgress?.(i + 1, jobs.length, name);
  }
  return { decoded, failed, total: jobs.length };
}
