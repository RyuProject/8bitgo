import { decodePng, isPng } from '../../gfx/png';
import { cachedJpeg, fingerprint, isGif, isJpeg, jpegSize } from '../../gfx/jpeg';
import type { DisplayService } from '../../platform/display';
import { FontPeer } from '../../platform/font';
import { GraphicsPeer, ImagePeer } from '../../platform/graphics';
import { KEY_SOFT_LEFT, KEY_SOFT_RIGHT, gameActionOf, keyCodeOf, keyName } from '../../platform/keys';
import type { Platform } from '../../platform/platform';
import { createSurface, surfaceFromPixels } from '../../platform/surface';
import { ACC_ABSTRACT, ACC_INTERFACE } from '../classfile';
import type { JThread, Jvm, NativeClassDef } from '../jvm';
import { JArray, JObject, type NativeImpl } from '../types';
import { checkArrayRange } from './helpers';
import { readAllBytes } from './io';

const platformOf = (t: JThread) => t.jvm.platform as Platform;
const display = (t: JThread): DisplayService => platformOf(t).display;
const gp = (g: JObject) => g.n as GraphicsPeer;
const ip = (t: JThread, img: JObject | null): ImagePeer => {
  if (img === null) throw t.jvm.npe('image is null');
  return img.n as ImagePeer;
};

export const COMMAND_SCREEN = 1;
export const COMMAND_BACK = 2;
export const COMMAND_CANCEL = 3;
export const COMMAND_OK = 4;
export const COMMAND_HELP = 5;
export const COMMAND_STOP = 6;
export const COMMAND_EXIT = 7;
export const COMMAND_ITEM = 8;

export interface DisplayablePeer {
  commands: JObject[];
  listener: JObject | null;
  title: string | null;
  fullScreen: boolean;
}

function peer(obj: JObject): DisplayablePeer {
  return (obj.n ??= { commands: [], listener: null, title: null, fullScreen: false } satisfies DisplayablePeer);
}

/** Maps a soft key to one of the displayable's commands (negative commands go right). */
export function commandForSoftKey(obj: JObject, key: number): JObject | null {
  const { commands, listener } = peer(obj);
  if (!listener || commands.length === 0) return null;
  const isNegative = (c: JObject) => [COMMAND_BACK, COMMAND_CANCEL, COMMAND_EXIT, COMMAND_STOP].includes(c.n.type);
  const sorted = [...commands].sort((a, b) => a.n.priority - b.n.priority);
  const right = sorted.find(isNegative) ?? (sorted.length > 1 ? sorted[sorted.length - 1] : null);
  const left = sorted.find((c) => c !== right) ?? null;
  return key === KEY_SOFT_LEFT ? left : key === KEY_SOFT_RIGHT ? right : null;
}

// ---------------------------------------------------------------------------------------------------
// Display / Displayable / Canvas

const displayClass: NativeClassDef = {
  name: 'javax/microedition/lcdui/Display',
  statics: {
    'getDisplay(Ljavax/microedition/midlet/MIDlet;)Ljavax/microedition/lcdui/Display;': (t) => display(t).displayFor(),
  },
  methods: {
    'setCurrent(Ljavax/microedition/lcdui/Displayable;)V': (t, [, d]) => display(t).setCurrent(d),
    'setCurrent(Ljavax/microedition/lcdui/Alert;Ljavax/microedition/lcdui/Displayable;)V': (t, [, , d]) => display(t).setCurrent(d),
    'getCurrent()Ljavax/microedition/lcdui/Displayable;': (t) => display(t).current,
    'isColor()Z': () => true,
    'numColors()I': () => 65536,
    'numAlphaLevels()I': () => 256,
    'vibrate(I)Z': (t, [, ms]) => {
      platformOf(t).config.vibrate(ms);
      return true;
    },
    'flashBacklight(I)Z': () => true,
    'callSerially(Ljava/lang/Runnable;)V': (t, [, r]) => {
      const jvm = t.jvm;
      if (r === null) return;
      jvm.postEvent((et) => {
        const run = jvm.findVirtual(jvm.classOf(r), 'run()V');
        if (!run) return false;
        jvm.pushCall(et, run, [r]);
        return run.impl === null;
      });
    },
  },
};

const displayableMethods: Record<string, NativeImpl> = {
  'getWidth()I': (t) => display(t).width,
  'getHeight()I': (t) => display(t).height,
  'isShown()Z': (t, [self]) => display(t).current === self,
  'addCommand(Ljavax/microedition/lcdui/Command;)V': (t, [self, cmd]) => {
    if (cmd === null) throw t.jvm.npe();
    const p = peer(self);
    if (!p.commands.includes(cmd)) p.commands.push(cmd);
  },
  'removeCommand(Ljavax/microedition/lcdui/Command;)V': (_t, [self, cmd]) => {
    const p = peer(self);
    p.commands = p.commands.filter((c) => c !== cmd);
  },
  'setCommandListener(Ljavax/microedition/lcdui/CommandListener;)V': (_t, [self, listener]) => {
    peer(self).listener = listener;
  },
  'setTitle(Ljava/lang/String;)V': (_t, [self, title]) => {
    peer(self).title = title;
  },
  'getTitle()Ljava/lang/String;': (_t, [self]) => peer(self).title,
  'setTicker(Ljavax/microedition/lcdui/Ticker;)V': () => {},
  'getTicker()Ljavax/microedition/lcdui/Ticker;': () => null,
  'sizeChanged(II)V': () => {},
};

const displayableClass: NativeClassDef = {
  name: 'javax/microedition/lcdui/Displayable',
  flags: ACC_ABSTRACT,
  methods: {
    '<init>()V': (_t, [self]) => void peer(self),
    ...displayableMethods,
  },
};

const noop: NativeImpl = () => {};

const canvasMethods: Record<string, NativeImpl> = {
  '<init>()V': (_t, [self]) => void peer(self),
  'repaint()V': (t) => display(t).requestRepaint(),
  'repaint(IIII)V': (t) => display(t).requestRepaint(),
  'serviceRepaints()V': (t) => display(t).serviceRepaints(t),
  'setFullScreenMode(Z)V': (_t, [self, full]) => {
    peer(self).fullScreen = !!full;
  },
  'isDoubleBuffered()Z': () => true,
  'hasPointerEvents()Z': (t) => !!platformOf(t).config.hasPointerEvents,
  'hasPointerMotionEvents()Z': (t) => !!platformOf(t).config.hasPointerEvents,
  'hasRepeatEvents()Z': () => true,
  'getGameAction(I)I': (_t, [, code]) => gameActionOf(code),
  'getKeyCode(I)I': (t, [, action]) => {
    const code = keyCodeOf(action);
    if (!code) throw t.jvm.throwable('java/lang/IllegalArgumentException', `game action ${action}`);
    return code;
  },
  'getKeyName(I)Ljava/lang/String;': (_t, [, code]) => keyName(code),
  'keyPressed(I)V': noop,
  'keyReleased(I)V': noop,
  'keyRepeated(I)V': noop,
  'pointerPressed(II)V': noop,
  'pointerReleased(II)V': noop,
  'pointerDragged(II)V': noop,
  'showNotify()V': noop,
  'hideNotify()V': noop,
};

const canvasClass: NativeClassDef = {
  name: 'javax/microedition/lcdui/Canvas',
  super: 'javax/microedition/lcdui/Displayable',
  flags: ACC_ABSTRACT,
  methods: canvasMethods,
  fields: {
    'UP:I': 1, 'DOWN:I': 6, 'LEFT:I': 2, 'RIGHT:I': 5, 'FIRE:I': 8,
    'GAME_A:I': 9, 'GAME_B:I': 10, 'GAME_C:I': 11, 'GAME_D:I': 12,
    'KEY_NUM0:I': 48, 'KEY_NUM1:I': 49, 'KEY_NUM2:I': 50, 'KEY_NUM3:I': 51, 'KEY_NUM4:I': 52,
    'KEY_NUM5:I': 53, 'KEY_NUM6:I': 54, 'KEY_NUM7:I': 55, 'KEY_NUM8:I': 56, 'KEY_NUM9:I': 57,
    'KEY_STAR:I': 42, 'KEY_POUND:I': 35,
  },
};

interface GameCanvasPeer extends DisplayablePeer {
  buffer: import('../../platform/surface').Surface;
  graphics: JObject | null;
  suppressKeys: boolean;
}

const gameCanvasClass: NativeClassDef = {
  name: 'javax/microedition/lcdui/game/GameCanvas',
  super: 'javax/microedition/lcdui/Canvas',
  flags: ACC_ABSTRACT,
  fields: {
    'UP_PRESSED:I': 1 << 1, 'DOWN_PRESSED:I': 1 << 6, 'LEFT_PRESSED:I': 1 << 2, 'RIGHT_PRESSED:I': 1 << 5, 'FIRE_PRESSED:I': 1 << 8,
    'GAME_A_PRESSED:I': 1 << 9, 'GAME_B_PRESSED:I': 1 << 10, 'GAME_C_PRESSED:I': 1 << 11, 'GAME_D_PRESSED:I': 1 << 12,
  },
  methods: {
    '<init>(Z)V': (t, [self, suppress]) => {
      const d = display(t);
      self.n = {
        commands: [],
        listener: null,
        title: null,
        fullScreen: false,
        buffer: createSurface(d.width, d.height, '#ffffff'),
        graphics: null,
        suppressKeys: !!suppress,
      } satisfies GameCanvasPeer;
    },
    'getGraphics()Ljavax/microedition/lcdui/Graphics;': (t, [self]) => {
      const p = self.n as GameCanvasPeer;
      return (p.graphics ??= platformOf(t).newGraphics(p.buffer));
    },
    'flushGraphics()V': (t, [self]) => {
      const d = display(t);
      if (d.current !== self) return;
      d.back.ctx.drawImage((self.n as GameCanvasPeer).buffer.canvas, 0, 0);
      d.present();
    },
    'flushGraphics(IIII)V': (t, [self, x, y, w, h]) => {
      const d = display(t);
      if (d.current !== self || w <= 0 || h <= 0) return;
      d.back.ctx.drawImage((self.n as GameCanvasPeer).buffer.canvas, x, y, w, h, x, y, w, h);
      d.present();
    },
    'getKeyStates()I': (t) => display(t).consumeKeyStates(),
    'paint(Ljavax/microedition/lcdui/Graphics;)V': (_t, [self, g]) => {
      gp(g).blit((self.n as GameCanvasPeer).buffer.canvas, 0, 0, gp(g).surface.width, gp(g).surface.height, gp(g).tx, gp(g).ty);
    },
  },
};

const commandClass: NativeClassDef = {
  name: 'javax/microedition/lcdui/Command',
  fields: {
    'SCREEN:I': COMMAND_SCREEN, 'BACK:I': COMMAND_BACK, 'CANCEL:I': COMMAND_CANCEL, 'OK:I': COMMAND_OK,
    'HELP:I': COMMAND_HELP, 'STOP:I': COMMAND_STOP, 'EXIT:I': COMMAND_EXIT, 'ITEM:I': COMMAND_ITEM,
  },
  methods: {
    '<init>(Ljava/lang/String;II)V': (_t, [self, label, type, priority]) => {
      self.n = { label, longLabel: null, type, priority };
    },
    '<init>(Ljava/lang/String;Ljava/lang/String;II)V': (_t, [self, label, longLabel, type, priority]) => {
      self.n = { label, longLabel, type, priority };
    },
    'getLabel()Ljava/lang/String;': (_t, [self]) => self.n.label,
    'getLongLabel()Ljava/lang/String;': (_t, [self]) => self.n.longLabel,
    'getCommandType()I': (_t, [self]) => self.n.type,
    'getPriority()I': (_t, [self]) => self.n.priority,
  },
};

// ---------------------------------------------------------------------------------------------------
// Graphics

const graphicsClass: NativeClassDef = {
  name: 'javax/microedition/lcdui/Graphics',
  fields: {
    'HCENTER:I': 1, 'VCENTER:I': 2, 'LEFT:I': 4, 'RIGHT:I': 8, 'TOP:I': 16, 'BOTTOM:I': 32, 'BASELINE:I': 64,
    'SOLID:I': 0, 'DOTTED:I': 1,
  },
  methods: {
    'setColor(I)V': (_t, [g, rgb]) => gp(g).setColor(rgb),
    'setColor(III)V': (t, [g, r, gr, b]) => {
      if (r < 0 || r > 255 || gr < 0 || gr > 255 || b < 0 || b > 255) throw t.jvm.throwable('java/lang/IllegalArgumentException');
      gp(g).setColor((r << 16) | (gr << 8) | b);
    },
    'getColor()I': (_t, [g]) => gp(g).color,
    'getRedComponent()I': (_t, [g]) => (gp(g).color >> 16) & 0xff,
    'getGreenComponent()I': (_t, [g]) => (gp(g).color >> 8) & 0xff,
    'getBlueComponent()I': (_t, [g]) => gp(g).color & 0xff,
    'setGrayScale(I)V': (_t, [g, v]) => gp(g).setColor((v << 16) | (v << 8) | v),
    'getGrayScale()I': (_t, [g]) => {
      const c = gp(g).color;
      return Math.round((((c >> 16) & 0xff) + ((c >> 8) & 0xff) + (c & 0xff)) / 3);
    },
    'getDisplayColor(I)I': (_t, [, c]) => c & 0xffffff,
    'fillRect(IIII)V': (_t, [g, x, y, w, h]) => gp(g).fillRect(x, y, w, h),
    'drawRect(IIII)V': (_t, [g, x, y, w, h]) => gp(g).drawRect(x, y, w, h),
    'drawLine(IIII)V': (_t, [g, x1, y1, x2, y2]) => gp(g).drawLine(x1, y1, x2, y2),
    'fillRoundRect(IIIIII)V': (_t, [g, x, y, w, h, aw, ah]) => gp(g).fillRoundRect(x, y, w, h, aw, ah),
    'drawRoundRect(IIIIII)V': (_t, [g, x, y, w, h, aw, ah]) => gp(g).drawRoundRect(x, y, w, h, aw, ah),
    'fillArc(IIIIII)V': (_t, [g, x, y, w, h, s, a]) => gp(g).fillArc(x, y, w, h, s, a),
    'drawArc(IIIIII)V': (_t, [g, x, y, w, h, s, a]) => gp(g).drawArc(x, y, w, h, s, a),
    'fillTriangle(IIIIII)V': (_t, [g, x1, y1, x2, y2, x3, y3]) => gp(g).fillTriangle(x1, y1, x2, y2, x3, y3),
    'drawImage(Ljavax/microedition/lcdui/Image;III)V': (t, [g, img, x, y, anchor]) => gp(g).drawImage(ip(t, img), x, y, anchor),
    'drawRegion(Ljavax/microedition/lcdui/Image;IIIIIIII)V': (t, [g, img, sx, sy, sw, sh, tr, x, y, anchor]) =>
      gp(g).drawRegion(ip(t, img), sx, sy, sw, sh, tr, x, y, anchor),
    'drawRGB([IIIIIIIZ)V': (t, [g, rgb, offset, scan, x, y, w, h, alpha]) => {
      if (rgb === null) throw t.jvm.npe();
      gp(g).drawRGB(rgb.d as Int32Array, offset, scan, x, y, w, h, !!alpha);
    },
    'copyArea(IIIIIII)V': (_t, [g, sx, sy, w, h, dx, dy, anchor]) => gp(g).copyArea(sx, sy, w, h, dx, dy, anchor),
    'drawString(Ljava/lang/String;III)V': (t, [g, s, x, y, anchor]) => {
      if (s === null) throw t.jvm.npe();
      gp(g).drawString(s, x, y, anchor);
    },
    'drawSubstring(Ljava/lang/String;IIIII)V': (t, [g, s, off, len, x, y, anchor]) => {
      if (s === null) throw t.jvm.npe();
      if (off < 0 || len < 0 || off + len > s.length) throw t.jvm.throwable('java/lang/StringIndexOutOfBoundsException');
      gp(g).drawString(s.substr(off, len), x, y, anchor);
    },
    'drawChar(CIII)V': (_t, [g, c, x, y, anchor]) => gp(g).drawString(String.fromCharCode(c), x, y, anchor),
    'drawChars([CIIIII)V': (t, [g, chars, off, len, x, y, anchor]) => {
      checkArrayRange(t.jvm, chars, off, len);
      gp(g).drawString(String.fromCharCode(...(chars.d as Uint16Array).subarray(off, off + len)), x, y, anchor);
    },
    'setClip(IIII)V': (_t, [g, x, y, w, h]) => gp(g).setClip(x, y, w, h),
    'clipRect(IIII)V': (_t, [g, x, y, w, h]) => gp(g).clipRect(x, y, w, h),
    'getClipX()I': (_t, [g]) => gp(g).clipX - gp(g).tx,
    'getClipY()I': (_t, [g]) => gp(g).clipY - gp(g).ty,
    'getClipWidth()I': (_t, [g]) => gp(g).clipW,
    'getClipHeight()I': (_t, [g]) => gp(g).clipH,
    'translate(II)V': (_t, [g, x, y]) => gp(g).translate(x, y),
    'getTranslateX()I': (_t, [g]) => gp(g).tx,
    'getTranslateY()I': (_t, [g]) => gp(g).ty,
    'setFont(Ljavax/microedition/lcdui/Font;)V': (t, [g, font]) => {
      const f = font ?? platformOf(t).defaultFont().obj;
      gp(g).font = f.n as FontPeer;
      gp(g).fontObject = f;
    },
    'getFont()Ljavax/microedition/lcdui/Font;': (_t, [g]) => gp(g).fontObject,
    'setStrokeStyle(I)V': (_t, [g, s]) => {
      gp(g).stroke = s;
    },
    'getStrokeStyle()I': (_t, [g]) => gp(g).stroke,
  },
};

// ---------------------------------------------------------------------------------------------------
// Image

function decodeImage(jvm: Jvm, bytes: Uint8Array): ImagePeer {
  if (isPng(bytes)) {
    try {
      const img = decodePng(bytes);
      return new ImagePeer(surfaceFromPixels(img.width, img.height, img.data), false);
    } catch (e) {
      throw jvm.throwable('java/lang/IllegalArgumentException', `Bad image data: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (isJpeg(bytes)) {
    // 像素必须来自启动时的预解码缓存（浏览器解码 JPEG 是异步的，
    // 而 createImage 是同步 API，见 gfx/jpeg.ts 的说明）。
    const cached = cachedJpeg(bytes);
    if (cached) return new ImagePeer(surfaceFromPixels(cached.width, cached.height, cached.data), false);
    const size = jpegSize(bytes);
    const note = size ? `${size.width}x${size.height}` : 'unknown size';
    // 尺寸拿得到但像素没解出来：给一张同尺寸的空白图，让游戏继续跑
    // （否则 createImage 抛异常，游戏直接进不去，比白图更糟）。
    jvm.host.log('warn', `JPEG 未预解码（${note}），先给空白图：${fingerprint(bytes)}`);
    if (size) return new ImagePeer(createSurface(size.width, size.height, '#ffffff'), false);
    throw jvm.throwable('java/lang/IllegalArgumentException', 'Cannot decode JPEG');
  }
  throw jvm.throwable('java/lang/IllegalArgumentException', unsupportedImageFormat(bytes));
}

/** 明确告诉开发者是哪种格式不支持，而不是笼统说「只支持 PNG」。 */
function unsupportedImageFormat(bytes: Uint8Array): string {
  if (isGif(bytes)) return 'Unsupported image format: GIF (only PNG and JPEG)';
  return 'Unsupported image format (only PNG and JPEG)';
}

function newImage(jvm: Jvm, peer: ImagePeer): JObject {
  const obj = new JObject(jvm.loadClass('javax/microedition/lcdui/Image'));
  obj.n = peer;
  return obj;
}

const imageClass: NativeClassDef = {
  name: 'javax/microedition/lcdui/Image',
  statics: {
    'createImage(II)Ljavax/microedition/lcdui/Image;': (t, [w, h]) => {
      if (w <= 0 || h <= 0) throw t.jvm.throwable('java/lang/IllegalArgumentException', `${w}x${h}`);
      return newImage(t.jvm, new ImagePeer(createSurface(w, h, '#ffffff'), true));
    },
    'createImage(Ljava/lang/String;)Ljavax/microedition/lcdui/Image;': (t, [name]) => {
      const jvm = t.jvm;
      if (name === null) throw jvm.npe();
      const bytes = platformOf(t).getResource(name);
      if (!bytes) throw jvm.throwable('java/io/IOException', `Resource not found: ${name}`);
      try {
        return newImage(jvm, decodeImage(jvm, bytes));
      } catch {
        throw jvm.throwable('java/io/IOException', `Cannot decode image ${name}`);
      }
    },
    'createImage([BII)Ljavax/microedition/lcdui/Image;': (t, [data, off, len]) => {
      checkArrayRange(t.jvm, data, off, len);
      const d = data.d as Int8Array;
      return newImage(t.jvm, decodeImage(t.jvm, new Uint8Array(d.buffer, d.byteOffset + off, len)));
    },
    'createImage(Ljava/io/InputStream;)Ljavax/microedition/lcdui/Image;': (t, [stream]) => {
      if (stream === null) throw t.jvm.npe();
      const bytes = readAllBytes(t, stream);
      try {
        return newImage(t.jvm, decodeImage(t.jvm, bytes));
      } catch {
        throw t.jvm.throwable('java/io/IOException', 'Cannot decode image stream');
      }
    },
    'createImage(Ljavax/microedition/lcdui/Image;)Ljavax/microedition/lcdui/Image;': (t, [src]) => {
      const s = ip(t, src);
      if (!s.mutable) return src;
      const copy = createSurface(s.width, s.height);
      copy.ctx.drawImage(s.surface.canvas, 0, 0);
      return newImage(t.jvm, new ImagePeer(copy, false));
    },
    'createImage(Ljavax/microedition/lcdui/Image;IIIII)Ljavax/microedition/lcdui/Image;': (t, [src, x, y, w, h, transform]) => {
      const s = ip(t, src);
      if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > s.width || y + h > s.height) {
        throw t.jvm.throwable('java/lang/IllegalArgumentException', 'region out of bounds');
      }
      const rotated = transform >= 4;
      const out = createSurface(rotated ? h : w, rotated ? w : h);
      const g = new GraphicsPeer(out, () => platformOf(t).defaultFont());
      g.drawRegion(s, x, y, w, h, transform, 0, 0, 20);
      return newImage(t.jvm, new ImagePeer(out, false));
    },
    'createRGBImage([IIIZ)Ljavax/microedition/lcdui/Image;': (t, [rgb, w, h, alpha]) => {
      if (rgb === null) throw t.jvm.npe();
      if (w <= 0 || h <= 0 || rgb.d.length < w * h) throw t.jvm.throwable('java/lang/IllegalArgumentException');
      const out = createSurface(w, h);
      const g = new GraphicsPeer(out, () => platformOf(t).defaultFont());
      g.drawRGB(rgb.d as Int32Array, 0, w, 0, 0, w, h, !!alpha);
      return newImage(t.jvm, new ImagePeer(out, false));
    },
  },
  methods: {
    'getGraphics()Ljavax/microedition/lcdui/Graphics;': (t, [self]) => {
      const peer = ip(t, self);
      if (!peer.mutable) throw t.jvm.throwable('java/lang/IllegalStateException', 'Image is immutable');
      return platformOf(t).newGraphics(peer.surface);
    },
    'getWidth()I': (t, [self]) => ip(t, self).width,
    'getHeight()I': (t, [self]) => ip(t, self).height,
    'isMutable()Z': (t, [self]) => ip(t, self).mutable,
    'getRGB([IIIIIII)V': (t, [self, rgb, offset, scan, x, y, w, h]) => {
      const peer = ip(t, self);
      if (rgb === null) throw t.jvm.npe();
      if (w <= 0 || h <= 0) return;
      if (x < 0 || y < 0 || x + w > peer.width || y + h > peer.height) throw t.jvm.throwable('java/lang/IllegalArgumentException');
      const px = peer.surface.ctx.getImageData(x, y, w, h).data;
      const out = rgb.d as Int32Array;
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const o = (row * w + col) * 4;
          const idx = offset + row * scan + col;
          if (idx < 0 || idx >= out.length) throw t.jvm.throwable('java/lang/ArrayIndexOutOfBoundsException');
          out[idx] = (px[o + 3] << 24) | (px[o] << 16) | (px[o + 1] << 8) | px[o + 2];
        }
      }
    },
  },
};

// ---------------------------------------------------------------------------------------------------
// Font

const fp = (f: JObject) => f.n as FontPeer;

/**
 * AlertType —— 规范里的 5 个常量，只有 INFO/ERROR/警告 有图标，
 * CONFIRMATION/NONE 什么都不显示。
 */
const alertTypeClass: NativeClassDef = {
  name: 'javax/microedition/lcdui/AlertType',
  fields: { 'INFO:I': 0, 'ERROR:I': 1, 'WARNING:I': 2, 'CONFIRMATION:I': 3, 'NONE:I': 4 },
};

interface AlertPeer extends DisplayablePeer {
  title: string;
  text: string;
  image: JObject | null;
  icon: string | null;
  imageText: string | null;
  type: JObject | null;
  timeout: number;
  /** 显示时 setCurrent 进来的那个被覆盖的 Displayable。 */
  prev: JObject | null;
  timer: ReturnType<typeof setTimeout> | null;
}

function alertPeer(self: JObject): AlertPeer {
  return (self.n ??= {
    ...peer(self),
    title: '',
    text: '',
    image: null,
    icon: null,
    imageText: null,
    type: null,
    timeout: -1,
    prev: null,
    timer: null,
  } satisfies AlertPeer);
}

/** 画一个简易对话框：标题 + 正文，没有图片和图标（真机上那些是小图标，模拟器略）。 */
function paintAlert(alert: AlertPeer, g: JObject): void {
  const p = gp(g);
  const w = p.surface.width;
  const h = p.surface.height;
  p.setColor(0xffffff);
  p.fillRect(0, 0, w, h);
  p.setColor(0x000000);
  // 粗边框，视觉上区分对话框和游戏画面
  p.fillRect(4, 4, w - 8, 1);
  p.fillRect(4, h - 5, w - 8, 1);
  p.fillRect(4, 4, 1, h - 8);
  p.fillRect(w - 5, 4, 1, h - 8);
  const boxW = w - 24;
  const boxH = Math.min(80, h - 24);
  const boxX = 12;
  const boxY = 12;
  drawAlertText(alert, g, boxX, boxY, boxW, boxH);
}

/** 用平台默认字体把标题和正文画进对话框区域（居中、溢出截断）。 */
function drawAlertText(alert: AlertPeer, g: JObject, x: number, y: number, w: number, h: number): void {
  const p = gp(g);
  drawTextWithDefaultFont(p, alert.title, x + 4, y + 4, w - 8, true);
  drawTextWithDefaultFont(p, alert.text, x + 4, y + 20, w - 8, false);
  void h;
}

/**
 * 用当前 Graphics 绑定的字体绘制一段文本，自动换行。
 * 不改 font.style（FontPeer 的 style/css 是只读的，改了缓存就对不上了），
 * 标题的加粗效果直接交给 canvas 用默认字体画。
 */
function drawTextWithDefaultFont(p: GraphicsPeer, text: string, x: number, y: number, maxWidth: number, _bold: boolean): void {
  if (!text) return;
  const font = p.font;
  const lineHeight = font.height + 2;
  let cx = x;
  let cy = y + font.height;
  const limit = y + 400;
  for (const ch of text) {
    const cw = font.charWidth(ch.charCodeAt(0));
    if (cx + cw > x + maxWidth) {
      cx = x;
      cy += lineHeight;
      if (cy > limit) return; // 兜底，别把对话框画穿
    }
    p.drawString(ch, cx, cy, 0 /* TOP_LEFT */);
    cx += cw;
  }
}

/**
 * Alert —— 仙剑在存档成功后会 `new Alert(...)` 再 `setTimeout(ALERT_TIMEOUT)`，
 * 类缺失时存档流程会抛 NoClassDefFoundError。
 *
 * 这里给出能真正显示的实现：setCurrent(alert) 直接画对话框，
 * 任何按键或命令都关掉并恢复上一个 Displayable；timeout 到点自动关。
 */
const alertClass: NativeClassDef = {
  name: 'javax/microedition/lcdui/Alert',
  super: 'javax/microedition/lcdui/Displayable',
  fields: { 'FORCE:I': 0 },
  methods: {
    '<init>(Ljava/lang/String;)V': (_t, [self]) => void alertPeer(self),
    '<init>(Ljava/lang/String;Ljava/lang/String;Ljavax/microedition/lcdui/Image;)V': (_t, [self, title, text, img]) => {
      const a = alertPeer(self);
      a.title = title ?? '';
      a.text = text ?? '';
      a.image = img;
    },
    '<init>(Ljava/lang/String;Ljava/lang/String;Ljavax/microedition/lcdui/Image;Ljavax/microedition/lcdui/AlertType;)V': (
      _t,
      [self, title, text, img, type],
    ) => {
      const a = alertPeer(self);
      a.title = title ?? '';
      a.text = text ?? '';
      a.image = img;
      a.type = type;
    },
    '<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V': (_t, [self, title, text]) => {
      const a = alertPeer(self);
      a.title = title ?? '';
      a.text = text ?? '';
    },
    '<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljavax/microedition/lcdui/Image;)V': (
      _t,
      [self, title, text, icon, img],
    ) => {
      const a = alertPeer(self);
      a.title = title ?? '';
      a.text = text ?? '';
      a.image = img;
      a.icon = icon;
    },
    // 这个签名是 (title, text, imageIconPath, imageURL)：两个字符串都不是 Image
    '<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V': (_t, [self, title, text, icon, url]) => {
      const a = alertPeer(self);
      a.title = title ?? '';
      a.text = text ?? '';
      a.icon = icon;
      a.imageText = url;
    },
    'getTitle()Ljava/lang/String;': (_t, [self]) => alertPeer(self).title,
    'setTitle(Ljava/lang/String;)V': (_t, [self, s]) => {
      alertPeer(self).title = s ?? '';
    },
    'getString()Ljava/lang/String;': (_t, [self]) => alertPeer(self).text,
    'setString(Ljava/lang/String;)V': (_t, [self, s]) => {
      alertPeer(self).text = s ?? '';
    },
    'getImage()Ljavax/microedition/lcdui/Image;': (_t, [self]) => alertPeer(self).image,
    'setImage(Ljavax/microedition/lcdui/Image;)V': (_t, [self, img]) => {
      alertPeer(self).image = img;
    },
    'getImageType()I': () => 1 /* IMAGE_MEDIA */,
    'getTimeout()I': (_t, [self]) => alertPeer(self).timeout,
    'setTimeout(I)V': (t, [self, ms]) => {
      const a = alertPeer(self);
      a.timeout = ms;
      if (a.timer !== null) {
        clearTimeout(a.timer);
        a.timer = null;
      }
      // FOREVER 不自动关
      if (ms === 0 || ms < 0) return;
      a.timer = setTimeout(() => {
        a.timer = null;
        display(t).dismissAlert(self, true);
      }, ms);
    },
    'getType()Ljavax/microedition/lcdui/AlertType;': (_t, [self]) => alertPeer(self).type,
    'setType(Ljavax/microedition/lcdui/AlertType;)V': (_t, [self, type]) => {
      alertPeer(self).type = type;
    },
    // ---- 以下是让它变成一个能显示、能被按键/命令关掉的 Displayable ----
    'showNotify()V': (t, [self]) => {
      const d = display(t);
      const g = d.screenGraphics();
      paintAlert(alertPeer(self), g);
      d.present();
    },
    'paint(Ljavax/microedition/lcdui/Graphics;)V': (_t, [self, g]) => paintAlert(alertPeer(self), g),
    'keyPressed(I)V': (t, [self]) => display(t).dismissAlert(self, false),
    'keyReleased(I)V': noop,
    'keyRepeated(I)V': noop,
    'pointerPressed(II)V': (t, [self, _x, _y]) => display(t).dismissAlert(self, false),
    'pointerReleased(II)V': noop,
    'pointerDragged(II)V': noop,
  },
};

const fontClass: NativeClassDef = {
  name: 'javax/microedition/lcdui/Font',
  fields: {
    'FACE_SYSTEM:I': 0, 'FACE_MONOSPACE:I': 32, 'FACE_PROPORTIONAL:I': 64,
    'STYLE_PLAIN:I': 0, 'STYLE_BOLD:I': 1, 'STYLE_ITALIC:I': 2, 'STYLE_UNDERLINED:I': 4,
    'SIZE_SMALL:I': 8, 'SIZE_MEDIUM:I': 0, 'SIZE_LARGE:I': 16,
    'FONT_STATIC_TEXT:I': 0, 'FONT_INPUT_TEXT:I': 1,
  },
  statics: {
    'getFont(III)Ljavax/microedition/lcdui/Font;': (t, [face, style, size]) => platformOf(t).font(face, style, size),
    'getDefaultFont()Ljavax/microedition/lcdui/Font;': (t) => platformOf(t).defaultFont().obj,
    'getFont(I)Ljavax/microedition/lcdui/Font;': (t) => platformOf(t).defaultFont().obj,
  },
  methods: {
    'getFace()I': (_t, [f]) => fp(f).face,
    'getStyle()I': (_t, [f]) => fp(f).style,
    'getSize()I': (_t, [f]) => fp(f).size,
    'isPlain()Z': (_t, [f]) => fp(f).style === 0,
    'isBold()Z': (_t, [f]) => (fp(f).style & 1) !== 0,
    'isItalic()Z': (_t, [f]) => (fp(f).style & 2) !== 0,
    'isUnderlined()Z': (_t, [f]) => (fp(f).style & 4) !== 0,
    'getHeight()I': (_t, [f]) => fp(f).height,
    'getBaselinePosition()I': (_t, [f]) => fp(f).baseline,
    'charWidth(C)I': (_t, [f, c]) => fp(f).charWidth(c),
    'charsWidth([CII)I': (t, [f, chars, off, len]) => {
      checkArrayRange(t.jvm, chars, off, len);
      return fp(f).stringWidth(String.fromCharCode(...(chars.d as Uint16Array).subarray(off, off + len)));
    },
    'stringWidth(Ljava/lang/String;)I': (t, [f, s]) => {
      if (s === null) throw t.jvm.npe();
      return fp(f).stringWidth(s);
    },
    'substringWidth(Ljava/lang/String;II)I': (t, [f, s, off, len]) => {
      if (s === null) throw t.jvm.npe();
      return fp(f).stringWidth(s.substr(off, len));
    },
  },
};

export const lcduiNatives: NativeClassDef[] = [
  displayClass,
  displayableClass,
  canvasClass,
  gameCanvasClass,
  commandClass,
  { name: 'javax/microedition/lcdui/CommandListener', flags: ACC_INTERFACE | ACC_ABSTRACT },
  { name: 'javax/microedition/lcdui/Screen', super: 'javax/microedition/lcdui/Displayable', flags: ACC_ABSTRACT },
  graphicsClass,
  imageClass,
  fontClass,
  alertTypeClass,
  alertClass,
];

export { JArray };
