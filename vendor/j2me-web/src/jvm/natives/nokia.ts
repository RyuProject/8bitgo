/**
 * 8BitGo 补的 Nokia UI API（com.nokia.mid.ui / com.nokia.mid.sound）。
 *
 * 为什么要补：j2me-web 上游只有几个 Samsung 类，而国内与 Gameloft 时代的 J2ME 游戏大量继承
 * `com.nokia.mid.ui.FullCanvas`、用 `DirectUtils` / `DirectGraphics` 画翻转贴图。缺这些类时
 * startApp 里直接 NoClassDefFoundError —— 2026-11-15 实测站内《帝国时代 2》《Anarchy 2087》
 * 《仙剑奇侠传 2004》在备用运行时里都是这样黑屏，CheerpJ 挂掉时的兜底等于没有。
 *
 * 范围按 Nokia UI API 1.1 的常用部分：全屏画布、带翻转 / 旋转的 drawImage、ARGB 颜色、
 * 多边形 / 三角形、drawPixels / getPixels（int / short / byte 三种像素数组）、设备灯光与振动。
 * Sound 跟 Samsung AudioClip 一样先接成静音占位（本运行时的音频片段本身就是占位），
 * 只保证游戏不因声音调用崩溃。
 */
import type { GraphicsPeer } from '../../platform/graphics';
import {
  ImagePeer,
  TRANS_MIRROR,
  TRANS_MIRROR_ROT180,
  TRANS_MIRROR_ROT270,
  TRANS_MIRROR_ROT90,
  TRANS_NONE,
  TRANS_ROT180,
  TRANS_ROT270,
  TRANS_ROT90,
} from '../../platform/graphics';
import type { Platform } from '../../platform/platform';
import { createSurface } from '../../platform/surface';
import { ACC_ABSTRACT, ACC_INTERFACE } from '../classfile';
import type { JThread, NativeClassDef } from '../jvm';
import { JArray, JObject } from '../types';
import { decodeImage, newImage } from './lcdui';
import { checkArrayRange } from './helpers';

const platformOf = (t: JThread) => t.jvm.platform as Platform;

export const FLIP_HORIZONTAL = 0x2000;
export const FLIP_VERTICAL = 0x4000;

const TYPE_BYTE_1_GRAY = 1;
const TYPE_BYTE_1_GRAY_VERTICAL = -1;
const TYPE_BYTE_2_GRAY = 2;
const TYPE_BYTE_4_GRAY = 4;
const TYPE_BYTE_8_GRAY = 8;
const TYPE_BYTE_332_RGB = 332;
const TYPE_USHORT_4444_ARGB = 4444;
const TYPE_USHORT_444_RGB = 444;
const TYPE_USHORT_555_RGB = 555;
const TYPE_USHORT_1555_ARGB = 1555;
const TYPE_USHORT_565_RGB = 565;
const TYPE_INT_888_RGB = 888;
const TYPE_INT_8888_ARGB = 8888;

/** 2x2 线性部分：x' = a*x + c*y，y' = b*x + d*y（与 Canvas setTransform 同序） */
type Linear = readonly [number, number, number, number];

const MIDP_LINEAR: readonly [number, Linear][] = [
  [TRANS_NONE, [1, 0, 0, 1]],
  [TRANS_MIRROR_ROT180, [1, 0, 0, -1]],
  [TRANS_MIRROR, [-1, 0, 0, 1]],
  [TRANS_ROT180, [-1, 0, 0, -1]],
  [TRANS_MIRROR_ROT270, [0, 1, 1, 0]],
  [TRANS_ROT90, [0, 1, -1, 0]],
  [TRANS_ROT270, [0, -1, 1, 0]],
  [TRANS_MIRROR_ROT90, [0, -1, -1, 0]],
];

/** m2 ∘ m1：先 m1 再 m2 */
function compose(m2: Linear, m1: Linear): Linear {
  const [a2, b2, c2, d2] = m2;
  const [a1, b1, c1, d1] = m1;
  return [a2 * a1 + c2 * b1, b2 * a1 + d2 * b1, a2 * c1 + c2 * d1, b2 * c1 + d2 * d1];
}

/**
 * Nokia 的 manipulation（FLIP_* 位 + ROTATE_90/180/270，旋转为**逆时针**，先翻转后旋转）
 * 换成 MIDP 2.0 Sprite 的 TRANS_* 常量。MIDP 的 ROT90 是顺时针，所以 Nokia ROTATE_90 = TRANS_ROT270。
 */
export function nokiaToMidpTransform(manipulation: number): number {
  let m: Linear = [1, 0, 0, 1];
  if (manipulation & FLIP_HORIZONTAL) m = compose([-1, 0, 0, 1], m);
  if (manipulation & FLIP_VERTICAL) m = compose([1, 0, 0, -1], m);
  const degrees = (((manipulation & 0x0fff) % 360) + 360) % 360;
  // 逆时针 90°（y 轴向下）：(1,0) -> (0,-1)，(0,1) -> (1,0)
  const ccw90: Linear = [0, -1, 1, 0];
  for (let i = 0; i < Math.round(degrees / 90) % 4; i++) m = compose(ccw90, m);
  for (const [trans, lin] of MIDP_LINEAR) {
    if (lin[0] === m[0] && lin[1] === m[1] && lin[2] === m[2] && lin[3] === m[3]) return trans;
  }
  return TRANS_NONE;
}

// ---------------------------------------------------------------------------------------------------
// 像素格式换算（全部转成 0xAARRGGBB）

function argbFromShort(v: number, format: number, transparency: boolean): number {
  v &= 0xffff;
  let a = 0xff;
  let r = 0;
  let g = 0;
  let b = 0;
  switch (format) {
    case TYPE_USHORT_4444_ARGB:
      a = ((v >> 12) & 0xf) * 17;
      r = ((v >> 8) & 0xf) * 17;
      g = ((v >> 4) & 0xf) * 17;
      b = (v & 0xf) * 17;
      break;
    case TYPE_USHORT_444_RGB:
      r = ((v >> 8) & 0xf) * 17;
      g = ((v >> 4) & 0xf) * 17;
      b = (v & 0xf) * 17;
      break;
    case TYPE_USHORT_1555_ARGB:
      a = v & 0x8000 ? 0xff : 0;
      r = ((v >> 10) & 0x1f) << 3;
      g = ((v >> 5) & 0x1f) << 3;
      b = (v & 0x1f) << 3;
      break;
    case TYPE_USHORT_555_RGB:
      r = ((v >> 10) & 0x1f) << 3;
      g = ((v >> 5) & 0x1f) << 3;
      b = (v & 0x1f) << 3;
      break;
    default: // 565
      r = ((v >> 11) & 0x1f) << 3;
      g = ((v >> 5) & 0x3f) << 2;
      b = (v & 0x1f) << 3;
  }
  if (!transparency) a = 0xff;
  return ((a << 24) | (r << 16) | (g << 8) | b) | 0;
}

function shortFromArgb(p: number, format: number): number {
  const a = (p >>> 24) & 0xff;
  const r = (p >> 16) & 0xff;
  const g = (p >> 8) & 0xff;
  const b = p & 0xff;
  switch (format) {
    case TYPE_USHORT_4444_ARGB:
      return ((a >> 4) << 12) | ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    case TYPE_USHORT_444_RGB:
      return ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    case TYPE_USHORT_1555_ARGB:
      return (a >= 0x80 ? 0x8000 : 0) | ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    case TYPE_USHORT_555_RGB:
      return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    default:
      return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
  }
}

/** byte 格式：灰度 / 332。transparencyMask 与像素同排布，位为 1 表示不透明。 */
function argbFromBytes(
  pixels: Int8Array,
  mask: Int8Array | null,
  offset: number,
  scan: number,
  w: number,
  h: number,
  format: number,
): Int32Array {
  const out = new Int32Array(w * h);
  const bitsPerPixel = format === TYPE_BYTE_332_RGB || format === TYPE_BYTE_8_GRAY ? 8 : Math.abs(format) || 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let value: number;
      let opaque = true;
      if (format === TYPE_BYTE_1_GRAY_VERTICAL) {
        // 竖排：每字节 8 个竖向像素，低位在上
        const byte = pixels[offset + (y >> 3) * scan + x] ?? 0;
        value = (byte >> (y & 7)) & 1;
        if (mask) opaque = (((mask[offset + (y >> 3) * scan + x] ?? 0) >> (y & 7)) & 1) === 1;
      } else {
        const bitIndex = x * bitsPerPixel;
        const index = offset + y * scan + (bitIndex >> 3);
        const shift = 8 - bitsPerPixel - (bitIndex & 7);
        const byte = pixels[index] ?? 0;
        value = (byte >> shift) & ((1 << bitsPerPixel) - 1);
        if (mask) {
          const maskBits = format === TYPE_BYTE_332_RGB || format === TYPE_BYTE_8_GRAY ? 8 : 1;
          const mi = offset + y * scan + ((x * maskBits) >> 3);
          opaque = maskBits === 8 ? (mask[mi] ?? 0) !== 0 : (((mask[mi] ?? 0) >> (7 - ((x * maskBits) & 7))) & 1) === 1;
        }
      }
      let rgb: number;
      if (format === TYPE_BYTE_332_RGB) {
        rgb = (((value >> 5) & 7) * 36 << 16) | (((value >> 2) & 7) * 36 << 8) | ((value & 3) * 85);
      } else {
        const max = (1 << bitsPerPixel) - 1;
        // 1 位灰度里 1 = 黑（Nokia 约定），多位灰度 0 = 黑
        const level = bitsPerPixel === 1 ? (value ? 0 : 255) : Math.round((value / max) * 255);
        rgb = (level << 16) | (level << 8) | level;
      }
      out[y * w + x] = ((opaque ? 0xff000000 : 0) | rgb) | 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// DirectGraphics

interface DirectGraphicsPeer {
  g: GraphicsPeer;
  alpha: number;
}

const dgp = (self: JObject) => self.n as DirectGraphicsPeer;

/** 画一块 ARGB 像素（已按 manipulation 变换），坐标受 Graphics 的平移与裁剪 */
function drawArgb(peer: DirectGraphicsPeer, argb: Int32Array, w: number, h: number, x: number, y: number, manipulation: number): void {
  if (w <= 0 || h <= 0) return;
  const surface = createSurface(w, h);
  const image = surface.ctx.createImageData(w, h);
  const px = image.data;
  for (let i = 0; i < w * h; i++) {
    const p = argb[i];
    px[i * 4] = (p >> 16) & 0xff;
    px[i * 4 + 1] = (p >> 8) & 0xff;
    px[i * 4 + 2] = p & 0xff;
    px[i * 4 + 3] = (p >>> 24) & 0xff;
  }
  surface.ctx.putImageData(image, 0, 0);
  // Nokia drawPixels 的 (x, y) 是左上角（anchor = TOP|LEFT）
  peer.g.drawRegion(new ImagePeer(surface, false), 0, 0, w, h, nokiaToMidpTransform(manipulation), x, y, 0x14);
}

function withArgbColor(peer: DirectGraphicsPeer, argb: number, draw: (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => void): void {
  const g = peer.g;
  if (g.clipW <= 0 || g.clipH <= 0) return;
  const ctx = g.ctx as CanvasRenderingContext2D;
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.clipX, g.clipY, g.clipW, g.clipH);
  ctx.clip();
  const a = ((argb >>> 24) & 0xff) / 255;
  const style = `rgba(${(argb >> 16) & 0xff},${(argb >> 8) & 0xff},${argb & 0xff},${a})`;
  ctx.fillStyle = style;
  ctx.strokeStyle = style;
  ctx.lineWidth = 1;
  draw(ctx);
  ctx.restore();
}

function polygonPath(
  t: JThread,
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  g: GraphicsPeer,
  xs: JArray | null,
  xOff: number,
  ys: JArray | null,
  yOff: number,
  n: number,
  stroke: boolean,
): void {
  if (xs === null || ys === null) throw t.jvm.npe();
  checkArrayRange(t.jvm, xs, xOff, n);
  checkArrayRange(t.jvm, ys, yOff, n);
  const dx = xs.d as Int32Array;
  const dy = ys.d as Int32Array;
  const half = stroke ? 0.5 : 0;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const px = dx[xOff + i] + g.tx + half;
    const py = dy[yOff + i] + g.ty + half;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

const directGraphicsInterface: NativeClassDef = {
  name: 'com/nokia/mid/ui/DirectGraphics',
  flags: ACC_ABSTRACT | ACC_INTERFACE,
  fields: {
    'FLIP_HORIZONTAL:I': FLIP_HORIZONTAL,
    'FLIP_VERTICAL:I': FLIP_VERTICAL,
    'ROTATE_90:I': 90,
    'ROTATE_180:I': 180,
    'ROTATE_270:I': 270,
    'TYPE_BYTE_1_GRAY:I': TYPE_BYTE_1_GRAY,
    'TYPE_BYTE_1_GRAY_VERTICAL:I': TYPE_BYTE_1_GRAY_VERTICAL,
    'TYPE_BYTE_2_GRAY:I': TYPE_BYTE_2_GRAY,
    'TYPE_BYTE_4_GRAY:I': TYPE_BYTE_4_GRAY,
    'TYPE_BYTE_8_GRAY:I': TYPE_BYTE_8_GRAY,
    'TYPE_BYTE_332_RGB:I': TYPE_BYTE_332_RGB,
    'TYPE_USHORT_4444_ARGB:I': TYPE_USHORT_4444_ARGB,
    'TYPE_USHORT_444_RGB:I': TYPE_USHORT_444_RGB,
    'TYPE_USHORT_555_RGB:I': TYPE_USHORT_555_RGB,
    'TYPE_USHORT_1555_ARGB:I': TYPE_USHORT_1555_ARGB,
    'TYPE_USHORT_565_RGB:I': TYPE_USHORT_565_RGB,
    'TYPE_INT_888_RGB:I': TYPE_INT_888_RGB,
    'TYPE_INT_8888_ARGB:I': TYPE_INT_8888_ARGB,
  },
};

const directGraphicsImpl: NativeClassDef = {
  name: 'j2me/NokiaDirectGraphicsImpl',
  interfaces: ['com/nokia/mid/ui/DirectGraphics'],
  methods: {
    'drawImage(Ljavax/microedition/lcdui/Image;IIII)V': (t, [self, img, x, y, anchor, manipulation]) => {
      if (img === null) throw t.jvm.npe('image is null');
      const peer = img.n as ImagePeer;
      dgp(self).g.drawRegion(peer, 0, 0, peer.width, peer.height, nokiaToMidpTransform(manipulation), x, y, anchor || 0x14);
    },
    'drawPixels([IZIIIIIIII)V': (t, [self, pixels, transparency, offset, scan, x, y, w, h, manipulation, format]) => {
      if (pixels === null) throw t.jvm.npe();
      if (w <= 0 || h <= 0) return;
      const src = pixels.d as Int32Array;
      const out = new Int32Array(w * h);
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const p = src[offset + row * scan + col] ?? 0;
          out[row * w + col] = format === TYPE_INT_8888_ARGB && transparency ? p : (p | 0xff000000) | 0;
        }
      }
      drawArgb(dgp(self), out, w, h, x, y, manipulation);
    },
    'drawPixels([SZIIIIIIII)V': (t, [self, pixels, transparency, offset, scan, x, y, w, h, manipulation, format]) => {
      if (pixels === null) throw t.jvm.npe();
      if (w <= 0 || h <= 0) return;
      const src = pixels.d as Int16Array;
      const out = new Int32Array(w * h);
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          out[row * w + col] = argbFromShort(src[offset + row * scan + col] ?? 0, format, !!transparency);
        }
      }
      drawArgb(dgp(self), out, w, h, x, y, manipulation);
    },
    'drawPixels([B[BIIIIIIII)V': (t, [self, pixels, mask, offset, scan, x, y, w, h, manipulation, format]) => {
      if (pixels === null) throw t.jvm.npe();
      if (w <= 0 || h <= 0) return;
      const out = argbFromBytes(pixels.d as Int8Array, mask ? (mask.d as Int8Array) : null, offset, scan, w, h, format);
      drawArgb(dgp(self), out, w, h, x, y, manipulation);
    },
    'getPixels([IIIIIIII)V': (t, [self, pixels, offset, scan, x, y, w, h, _format]) => {
      if (pixels === null) throw t.jvm.npe();
      const g = dgp(self).g;
      if (w <= 0 || h <= 0) return;
      const data = g.ctx.getImageData(x + g.tx, y + g.ty, w, h).data;
      const out = pixels.d as Int32Array;
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const o = (row * w + col) * 4;
          out[offset + row * scan + col] = (data[o + 3] << 24) | (data[o] << 16) | (data[o + 1] << 8) | data[o + 2];
        }
      }
    },
    'getPixels([SIIIIIII)V': (t, [self, pixels, offset, scan, x, y, w, h, format]) => {
      if (pixels === null) throw t.jvm.npe();
      const g = dgp(self).g;
      if (w <= 0 || h <= 0) return;
      const data = g.ctx.getImageData(x + g.tx, y + g.ty, w, h).data;
      const out = pixels.d as Int16Array;
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const o = (row * w + col) * 4;
          const argb = (data[o + 3] << 24) | (data[o] << 16) | (data[o + 1] << 8) | data[o + 2];
          out[offset + row * scan + col] = shortFromArgb(argb, format);
        }
      }
    },
    'getPixels([B[BIIIIIII)V': () => {
      // 字节格式回读极少见；保持数组原样，不抛异常
    },
    'drawPolygon([II[IIII)V': (t, [self, xs, xOff, ys, yOff, n, argb]) => {
      const peer = dgp(self);
      withArgbColor(peer, argb, (ctx) => {
        polygonPath(t, ctx, peer.g, xs, xOff, ys, yOff, n, true);
        ctx.stroke();
      });
    },
    'fillPolygon([II[IIII)V': (t, [self, xs, xOff, ys, yOff, n, argb]) => {
      const peer = dgp(self);
      withArgbColor(peer, argb, (ctx) => {
        polygonPath(t, ctx, peer.g, xs, xOff, ys, yOff, n, false);
        ctx.fill();
      });
    },
    'drawTriangle(IIIIIII)V': (_t, [self, x1, y1, x2, y2, x3, y3, argb]) => {
      const peer = dgp(self);
      const g = peer.g;
      withArgbColor(peer, argb, (ctx) => {
        ctx.beginPath();
        ctx.moveTo(x1 + g.tx + 0.5, y1 + g.ty + 0.5);
        ctx.lineTo(x2 + g.tx + 0.5, y2 + g.ty + 0.5);
        ctx.lineTo(x3 + g.tx + 0.5, y3 + g.ty + 0.5);
        ctx.closePath();
        ctx.stroke();
      });
    },
    'fillTriangle(IIIIIII)V': (_t, [self, x1, y1, x2, y2, x3, y3, argb]) => {
      const peer = dgp(self);
      const g = peer.g;
      withArgbColor(peer, argb, (ctx) => {
        ctx.beginPath();
        ctx.moveTo(x1 + g.tx, y1 + g.ty);
        ctx.lineTo(x2 + g.tx, y2 + g.ty);
        ctx.lineTo(x3 + g.tx, y3 + g.ty);
        ctx.closePath();
        ctx.fill();
      });
    },
    'setARGBColor(I)V': (_t, [self, argb]) => {
      const peer = dgp(self);
      peer.alpha = (argb >>> 24) & 0xff;
      peer.g.setColor(argb & 0xffffff);
    },
    'getAlphaComponent()I': (_t, [self]) => dgp(self).alpha,
    'getNativePixelFormat()I': () => TYPE_USHORT_4444_ARGB,
  },
};

const directUtilsClass: NativeClassDef = {
  name: 'com/nokia/mid/ui/DirectUtils',
  statics: {
    'getDirectGraphics(Ljavax/microedition/lcdui/Graphics;)Lcom/nokia/mid/ui/DirectGraphics;': (t, [g]) => {
      if (g === null) throw t.jvm.npe();
      // 同一个 Graphics 每次都返回同一个对象：有的游戏每帧都调一次 getDirectGraphics
      const cached = (g as JObject & { nokiaDg?: JObject }).nokiaDg;
      if (cached) return cached;
      const obj = new JObject(t.jvm.loadClass('j2me/NokiaDirectGraphicsImpl'));
      obj.n = { g: g.n as GraphicsPeer, alpha: 0xff } satisfies DirectGraphicsPeer;
      (g as JObject & { nokiaDg?: JObject }).nokiaDg = obj;
      return obj;
    },
    'createImage(III)Ljavax/microedition/lcdui/Image;': (t, [w, h, argb]) => {
      if (w <= 0 || h <= 0) throw t.jvm.throwable('java/lang/IllegalArgumentException', `${w}x${h}`);
      const surface = createSurface(w, h);
      const a = ((argb >>> 24) & 0xff) / 255;
      surface.ctx.fillStyle = `rgba(${(argb >> 16) & 0xff},${(argb >> 8) & 0xff},${argb & 0xff},${a})`;
      surface.ctx.fillRect(0, 0, w, h);
      return newImage(t.jvm, new ImagePeer(surface, true));
    },
    'createImage([BII)Ljavax/microedition/lcdui/Image;': (t, [data, off, len]) => {
      if (data === null) throw t.jvm.npe();
      checkArrayRange(t.jvm, data, off, len);
      const d = data.d as Int8Array;
      return newImage(t.jvm, decodeImage(t.jvm, new Uint8Array(d.buffer, d.byteOffset + off, len)));
    },
  },
};

const fullCanvasClass: NativeClassDef = {
  name: 'com/nokia/mid/ui/FullCanvas',
  super: 'javax/microedition/lcdui/Canvas',
  flags: ACC_ABSTRACT,
  fields: {
    'KEY_SOFTKEY1:I': -6,
    'KEY_SOFTKEY2:I': -7,
    'KEY_SOFTKEY3:I': -5,
    'KEY_SEND:I': -10,
    'KEY_END:I': -11,
    'KEY_UP_ARROW:I': -1,
    'KEY_DOWN_ARROW:I': -2,
    'KEY_LEFT_ARROW:I': -3,
    'KEY_RIGHT_ARROW:I': -4,
  },
  methods: {
    '<init>()V': (_t, [self]) => {
      self.n = { commands: [], listener: null, title: null, fullScreen: true };
    },
    // FullCanvas 规范上不允许命令；真机抛 IllegalStateException，这里静默忽略更稳
    'addCommand(Ljavax/microedition/lcdui/Command;)V': () => {},
    'setCommandListener(Ljavax/microedition/lcdui/CommandListener;)V': () => {},
  },
};

const deviceControlClass: NativeClassDef = {
  name: 'com/nokia/mid/ui/DeviceControl',
  statics: {
    'setLights(II)V': () => {},
    'flashLights(J)V': () => {},
    'startVibra(IJ)V': (t, [, duration]) => platformOf(t).config.vibrate(Math.min(2000, Math.max(0, Number(duration)))),
    'stopVibra()V': (t) => platformOf(t).config.vibrate(0),
  },
};

interface SoundPeer {
  state: number;
  gain: number;
}
const SOUND_PLAYING = 0;
const SOUND_STOPPED = 1;
const SOUND_UNINITIALIZED = 3;

const soundClass: NativeClassDef = {
  name: 'com/nokia/mid/sound/Sound',
  fields: {
    'FORMAT_TONE:I': 1,
    'FORMAT_WAV:I': 5,
    'SOUND_PLAYING:I': SOUND_PLAYING,
    'SOUND_STOPPED:I': SOUND_STOPPED,
    'SOUND_UNINITIALIZED:I': SOUND_UNINITIALIZED,
  },
  statics: {
    'getSupportedFormats()[I': () => new JArray('[I', new Int32Array([1, 5])),
    'getConcurrentSoundCount(I)I': () => 1,
  },
  methods: {
    '<init>([BI)V': (_t, [self]) => {
      self.n = { state: SOUND_STOPPED, gain: 255 } satisfies SoundPeer;
    },
    '<init>(IJ)V': (_t, [self]) => {
      self.n = { state: SOUND_STOPPED, gain: 255 } satisfies SoundPeer;
    },
    'init([BI)V': (_t, [self]) => {
      (self.n as SoundPeer).state = SOUND_STOPPED;
    },
    'init(IJ)V': (_t, [self]) => {
      (self.n as SoundPeer).state = SOUND_STOPPED;
    },
    // 静音占位：play 后立刻视为已停，免得游戏等「播放结束」等到天荒地老
    'play(I)V': (_t, [self]) => {
      (self.n as SoundPeer).state = SOUND_STOPPED;
    },
    'resume()V': () => {},
    'stop()V': (_t, [self]) => {
      (self.n as SoundPeer).state = SOUND_STOPPED;
    },
    'release()V': (_t, [self]) => {
      (self.n as SoundPeer).state = SOUND_UNINITIALIZED;
    },
    'getState()I': (_t, [self]) => (self.n as SoundPeer).state,
    'setGain(I)V': (_t, [self, gain]) => {
      (self.n as SoundPeer).gain = Math.max(0, Math.min(255, gain));
    },
    'getGain()I': (_t, [self]) => (self.n as SoundPeer).gain,
    'setSoundListener(Lcom/nokia/mid/sound/SoundListener;)V': () => {},
  },
};

const soundListenerInterface: NativeClassDef = {
  name: 'com/nokia/mid/sound/SoundListener',
  flags: ACC_ABSTRACT | ACC_INTERFACE,
};

export const nokiaNatives: NativeClassDef[] = [
  directGraphicsInterface,
  directGraphicsImpl,
  directUtilsClass,
  fullCanvasClass,
  deviceControlClass,
  soundClass,
  soundListenerInterface,
];
