/**
 * 8BitGo：MIDP 2.0 的 javax.microedition.lcdui.game 图层 API（Layer / Sprite / TiledLayer / LayerManager）。
 *
 * j2me-web 上游只有 GameCanvas；站内《辐射》《模拟人生 3 冬季版》引用 Sprite / Layer，类不存在时一加载就
 * NoClassDefFoundError（2026-11-15 静态扫描）。行为按 MIDP 2.0 规范：帧按图片网格切、帧序列、参考像素、
 * 八种变换（与 Graphics.drawRegion 同一套 TRANS_*），变换时保持参考像素在屏幕上不动。
 * 碰撞检测只做包围盒（pixelLevel 参数被当成 false）：比逐像素粗一点，但不会让游戏因缺方法崩溃。
 */
import type { GraphicsPeer, ImagePeer } from '../../platform/graphics';
import { ACC_ABSTRACT } from '../classfile';
import type { JThread, NativeClassDef } from '../jvm';
import type { JObject } from '../types';

const TRANS_NONE = 0;
const TRANS_MIRROR_ROT180 = 1;
const TRANS_MIRROR = 2;
const TRANS_ROT180 = 3;
const TRANS_MIRROR_ROT270 = 4;
const TRANS_ROT90 = 5;
const TRANS_ROT270 = 6;
const TRANS_MIRROR_ROT90 = 7;
const TOP_LEFT = 0x14;

interface LayerPeer {
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
}

interface SpritePeer extends LayerPeer {
  image: ImagePeer;
  frameW: number;
  frameH: number;
  rawFrames: number;
  sequence: number[];
  seqIndex: number;
  refX: number;
  refY: number;
  transform: number;
  coll: { x: number; y: number; w: number; h: number };
}

interface TiledPeer extends LayerPeer {
  image: ImagePeer;
  cols: number;
  rows: number;
  tileW: number;
  tileH: number;
  cells: Int32Array;
  animated: number[];
}

const lp = (o: JObject) => o.n as LayerPeer;
const sp = (o: JObject) => o.n as SpritePeer;
const tp = (o: JObject) => o.n as TiledPeer;
const img = (t: JThread, o: JObject | null): ImagePeer => {
  if (o === null) throw t.jvm.npe('image is null');
  return o.n as ImagePeer;
};

// ---------------------------------------------------------------------------------------------------
// Layer

const layerClass: NativeClassDef = {
  name: 'javax/microedition/lcdui/game/Layer',
  flags: ACC_ABSTRACT,
  methods: {
    'getX()I': (_t, [self]) => lp(self).x,
    'getY()I': (_t, [self]) => lp(self).y,
    'getWidth()I': (_t, [self]) => lp(self).w,
    'getHeight()I': (_t, [self]) => lp(self).h,
    'isVisible()Z': (_t, [self]) => lp(self).visible,
    'setVisible(Z)V': (_t, [self, v]) => {
      lp(self).visible = !!v;
    },
    'setPosition(II)V': (_t, [self, x, y]) => {
      lp(self).x = x;
      lp(self).y = y;
    },
    'move(II)V': (_t, [self, dx, dy]) => {
      lp(self).x += dx;
      lp(self).y += dy;
    },
  },
};

// ---------------------------------------------------------------------------------------------------
// Sprite

/** 规范里 Sprite.getTransformedPtX / Y：帧内坐标 (x, y) 在变换后帧里的位置 */
function tPtX(p: SpritePeer, x: number, y: number, tr = p.transform): number {
  switch (tr) {
    case TRANS_MIRROR:
    case TRANS_ROT180:
      return p.frameW - x - 1;
    case TRANS_ROT90:
    case TRANS_MIRROR_ROT90:
      return p.frameH - y - 1;
    case TRANS_ROT270:
    case TRANS_MIRROR_ROT270:
      return y;
    default: // NONE / MIRROR_ROT180
      return x;
  }
}

function tPtY(p: SpritePeer, x: number, y: number, tr = p.transform): number {
  switch (tr) {
    case TRANS_MIRROR_ROT180:
    case TRANS_ROT180:
      return p.frameH - y - 1;
    case TRANS_ROT90:
    case TRANS_MIRROR_ROT270:
      return x;
    case TRANS_ROT270:
    case TRANS_MIRROR_ROT90:
      return p.frameW - x - 1;
    default: // NONE / MIRROR
      return y;
  }
}

const swapsAxes = (tr: number) => tr >= TRANS_MIRROR_ROT270;

function setupFrames(t: JThread, p: SpritePeer, image: ImagePeer, fw: number, fh: number): void {
  if (fw <= 0 || fh <= 0 || image.width % fw !== 0 || image.height % fh !== 0) {
    throw t.jvm.throwable('java/lang/IllegalArgumentException', `frame ${fw}x${fh} does not divide ${image.width}x${image.height}`);
  }
  p.image = image;
  p.frameW = fw;
  p.frameH = fh;
  p.rawFrames = (image.width / fw) * (image.height / fh);
  p.sequence = Array.from({ length: p.rawFrames }, (_, i) => i);
  p.seqIndex = 0;
  p.coll = { x: 0, y: 0, w: fw, h: fh };
  p.w = swapsAxes(p.transform) ? fh : fw;
  p.h = swapsAxes(p.transform) ? fw : fh;
}

function newSpritePeer(): SpritePeer {
  return {
    x: 0, y: 0, w: 0, h: 0, visible: true,
    image: null as unknown as ImagePeer, frameW: 0, frameH: 0, rawFrames: 0,
    sequence: [], seqIndex: 0, refX: 0, refY: 0, transform: TRANS_NONE, coll: { x: 0, y: 0, w: 0, h: 0 },
  };
}

/** 碰撞矩形在屏幕上的包围盒 */
function collisionBox(p: SpritePeer): [number, number, number, number] {
  const { x, y, w, h } = p.coll;
  const ax = tPtX(p, x, y);
  const ay = tPtY(p, x, y);
  const bx = tPtX(p, x + w - 1, y + h - 1);
  const by = tPtY(p, x + w - 1, y + h - 1);
  const x0 = Math.min(ax, bx);
  const y0 = Math.min(ay, by);
  return [p.x + x0, p.y + y0, p.x + Math.max(ax, bx) + 1, p.y + Math.max(ay, by) + 1];
}

const overlap = (a: number[], b: number[]) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

function paintSprite(t: JThread, self: JObject, g: JObject | null): void {
  if (g === null) throw t.jvm.npe();
  const p = sp(self);
  if (!p.visible || !p.image) return;
  const frame = p.sequence[p.seqIndex] ?? 0;
  const perRow = p.image.width / p.frameW;
  const sx = (frame % perRow) * p.frameW;
  const sy = Math.floor(frame / perRow) * p.frameH;
  (g.n as GraphicsPeer).drawRegion(p.image, sx, sy, p.frameW, p.frameH, p.transform, p.x, p.y, TOP_LEFT);
}

const spriteClass: NativeClassDef = {
  name: 'javax/microedition/lcdui/game/Sprite',
  super: 'javax/microedition/lcdui/game/Layer',
  fields: {
    'TRANS_NONE:I': TRANS_NONE, 'TRANS_MIRROR_ROT180:I': TRANS_MIRROR_ROT180, 'TRANS_MIRROR:I': TRANS_MIRROR,
    'TRANS_ROT180:I': TRANS_ROT180, 'TRANS_MIRROR_ROT270:I': TRANS_MIRROR_ROT270, 'TRANS_ROT90:I': TRANS_ROT90,
    'TRANS_ROT270:I': TRANS_ROT270, 'TRANS_MIRROR_ROT90:I': TRANS_MIRROR_ROT90,
  },
  methods: {
    '<init>(Ljavax/microedition/lcdui/Image;)V': (t, [self, image]) => {
      const i = img(t, image);
      const p = newSpritePeer();
      setupFrames(t, p, i, i.width, i.height);
      self.n = p;
    },
    '<init>(Ljavax/microedition/lcdui/Image;II)V': (t, [self, image, fw, fh]) => {
      const p = newSpritePeer();
      setupFrames(t, p, img(t, image), fw, fh);
      self.n = p;
    },
    '<init>(Ljavax/microedition/lcdui/game/Sprite;)V': (t, [self, other]) => {
      if (other === null) throw t.jvm.npe();
      const o = sp(other);
      self.n = { ...o, sequence: [...o.sequence], coll: { ...o.coll } } satisfies SpritePeer;
    },
    'setImage(Ljavax/microedition/lcdui/Image;II)V': (t, [self, image, fw, fh]) => {
      const p = sp(self);
      const keepSequence = p.rawFrames <= (img(t, image).width / fw) * (img(t, image).height / fh);
      const oldSeq = p.sequence;
      const oldIndex = p.seqIndex;
      setupFrames(t, p, img(t, image), fw, fh);
      if (keepSequence) {
        p.sequence = oldSeq;
        p.seqIndex = oldIndex;
      }
    },
    'paint(Ljavax/microedition/lcdui/Graphics;)V': (t, [self, g]) => paintSprite(t, self, g),
    'getRawFrameCount()I': (_t, [self]) => sp(self).rawFrames,
    'getFrameSequenceLength()I': (_t, [self]) => sp(self).sequence.length,
    'getFrame()I': (_t, [self]) => sp(self).seqIndex,
    'setFrame(I)V': (t, [self, i]) => {
      const p = sp(self);
      if (i < 0 || i >= p.sequence.length) throw t.jvm.throwable('java/lang/IndexOutOfBoundsException', String(i));
      p.seqIndex = i;
    },
    'nextFrame()V': (_t, [self]) => {
      const p = sp(self);
      p.seqIndex = (p.seqIndex + 1) % p.sequence.length;
    },
    'prevFrame()V': (_t, [self]) => {
      const p = sp(self);
      p.seqIndex = (p.seqIndex - 1 + p.sequence.length) % p.sequence.length;
    },
    'setFrameSequence([I)V': (t, [self, seq]) => {
      const p = sp(self);
      if (seq === null) {
        p.sequence = Array.from({ length: p.rawFrames }, (_, i) => i);
      } else {
        const arr = Array.from(seq.d as Int32Array);
        if (arr.length === 0 || arr.some((f) => f < 0 || f >= p.rawFrames)) {
          throw t.jvm.throwable('java/lang/ArrayIndexOutOfBoundsException', 'bad frame sequence');
        }
        p.sequence = arr;
      }
      p.seqIndex = 0;
    },
    'defineReferencePixel(II)V': (_t, [self, x, y]) => {
      const p = sp(self);
      p.refX = x;
      p.refY = y;
    },
    'setRefPixelPosition(II)V': (_t, [self, x, y]) => {
      const p = sp(self);
      p.x = x - tPtX(p, p.refX, p.refY);
      p.y = y - tPtY(p, p.refX, p.refY);
    },
    'getRefPixelX()I': (_t, [self]) => {
      const p = sp(self);
      return p.x + tPtX(p, p.refX, p.refY);
    },
    'getRefPixelY()I': (_t, [self]) => {
      const p = sp(self);
      return p.y + tPtY(p, p.refX, p.refY);
    },
    'setTransform(I)V': (t, [self, tr]) => {
      if (tr < 0 || tr > 7) throw t.jvm.throwable('java/lang/IllegalArgumentException', `transform ${tr}`);
      const p = sp(self);
      // 规范：变换前后参考像素在屏幕上的位置不变
      const rx = p.x + tPtX(p, p.refX, p.refY);
      const ry = p.y + tPtY(p, p.refX, p.refY);
      p.transform = tr;
      p.w = swapsAxes(tr) ? p.frameH : p.frameW;
      p.h = swapsAxes(tr) ? p.frameW : p.frameH;
      p.x = rx - tPtX(p, p.refX, p.refY);
      p.y = ry - tPtY(p, p.refX, p.refY);
    },
    'defineCollisionRectangle(IIII)V': (t, [self, x, y, w, h]) => {
      if (w < 0 || h < 0) throw t.jvm.throwable('java/lang/IllegalArgumentException');
      sp(self).coll = { x, y, w, h };
    },
    'collidesWith(Ljavax/microedition/lcdui/game/Sprite;Z)Z': (t, [self, other]) => {
      if (other === null) throw t.jvm.npe();
      const a = sp(self);
      const b = sp(other);
      if (!a.visible || !b.visible) return false;
      return overlap(collisionBox(a), collisionBox(b));
    },
    'collidesWith(Ljavax/microedition/lcdui/game/TiledLayer;Z)Z': (t, [self, layer]) => {
      if (layer === null) throw t.jvm.npe();
      const a = sp(self);
      const tl = tp(layer);
      if (!a.visible || !tl.visible) return false;
      const [x0, y0, x1, y1] = collisionBox(a);
      // 与任何非空格子相交即算碰撞
      const c0 = Math.max(0, Math.floor((x0 - tl.x) / tl.tileW));
      const r0 = Math.max(0, Math.floor((y0 - tl.y) / tl.tileH));
      const c1 = Math.min(tl.cols - 1, Math.floor((x1 - 1 - tl.x) / tl.tileW));
      const r1 = Math.min(tl.rows - 1, Math.floor((y1 - 1 - tl.y) / tl.tileH));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (tl.cells[r * tl.cols + c] !== 0) return true;
      return false;
    },
    'collidesWith(Ljavax/microedition/lcdui/Image;IIZ)Z': (t, [self, image, ix, iy]) => {
      const a = sp(self);
      if (!a.visible) return false;
      const i = img(t, image);
      return overlap(collisionBox(a), [ix, iy, ix + i.width, iy + i.height]);
    },
  },
};

// ---------------------------------------------------------------------------------------------------
// TiledLayer

function tileIndex(p: TiledPeer, cell: number): number {
  return cell < 0 ? (p.animated[-cell - 1] ?? 0) : cell;
}

const tiledLayerClass: NativeClassDef = {
  name: 'javax/microedition/lcdui/game/TiledLayer',
  super: 'javax/microedition/lcdui/game/Layer',
  methods: {
    '<init>(IILjavax/microedition/lcdui/Image;II)V': (t, [self, cols, rows, image, tw, th]) => {
      const i = img(t, image);
      if (cols <= 0 || rows <= 0 || tw <= 0 || th <= 0 || i.width % tw !== 0 || i.height % th !== 0) {
        throw t.jvm.throwable('java/lang/IllegalArgumentException');
      }
      self.n = {
        x: 0, y: 0, w: cols * tw, h: rows * th, visible: true,
        image: i, cols, rows, tileW: tw, tileH: th, cells: new Int32Array(cols * rows), animated: [],
      } satisfies TiledPeer;
    },
    'setStaticTileSet(Ljavax/microedition/lcdui/Image;II)V': (t, [self, image, tw, th]) => {
      const p = tp(self);
      p.image = img(t, image);
      p.tileW = tw;
      p.tileH = th;
      p.w = p.cols * tw;
      p.h = p.rows * th;
    },
    'createAnimatedTile(I)I': (_t, [self, staticIndex]) => {
      const p = tp(self);
      p.animated.push(staticIndex);
      return -p.animated.length;
    },
    'setAnimatedTile(II)V': (t, [self, index, staticIndex]) => {
      const p = tp(self);
      if (index >= 0 || -index > p.animated.length) throw t.jvm.throwable('java/lang/IndexOutOfBoundsException');
      p.animated[-index - 1] = staticIndex;
    },
    'getAnimatedTile(I)I': (_t, [self, index]) => tp(self).animated[-index - 1] ?? 0,
    'setCell(III)V': (t, [self, col, row, tile]) => {
      const p = tp(self);
      if (col < 0 || row < 0 || col >= p.cols || row >= p.rows) throw t.jvm.throwable('java/lang/IndexOutOfBoundsException');
      p.cells[row * p.cols + col] = tile;
    },
    'getCell(II)I': (t, [self, col, row]) => {
      const p = tp(self);
      if (col < 0 || row < 0 || col >= p.cols || row >= p.rows) throw t.jvm.throwable('java/lang/IndexOutOfBoundsException');
      return p.cells[row * p.cols + col];
    },
    'fillCells(IIIII)V': (t, [self, col, row, nc, nr, tile]) => {
      const p = tp(self);
      if (col < 0 || row < 0 || nc < 0 || nr < 0 || col + nc > p.cols || row + nr > p.rows) {
        throw t.jvm.throwable('java/lang/IndexOutOfBoundsException');
      }
      for (let r = row; r < row + nr; r++) for (let c = col; c < col + nc; c++) p.cells[r * p.cols + c] = tile;
    },
    'getCellWidth()I': (_t, [self]) => tp(self).tileW,
    'getCellHeight()I': (_t, [self]) => tp(self).tileH,
    'getColumns()I': (_t, [self]) => tp(self).cols,
    'getRows()I': (_t, [self]) => tp(self).rows,
    'paint(Ljavax/microedition/lcdui/Graphics;)V': (t, [self, g]) => {
      if (g === null) throw t.jvm.npe();
      const p = tp(self);
      if (!p.visible) return;
      const gp = g.n as GraphicsPeer;
      const perRow = p.image.width / p.tileW;
      for (let r = 0; r < p.rows; r++) {
        for (let c = 0; c < p.cols; c++) {
          const tile = tileIndex(p, p.cells[r * p.cols + c]);
          if (tile <= 0) continue; // 0 = 空格；静态瓦片从 1 开始编号
          const sx = ((tile - 1) % perRow) * p.tileW;
          const sy = Math.floor((tile - 1) / perRow) * p.tileH;
          gp.drawRegion(p.image, sx, sy, p.tileW, p.tileH, TRANS_NONE, p.x + c * p.tileW, p.y + r * p.tileH, TOP_LEFT);
        }
      }
    },
  },
};

// ---------------------------------------------------------------------------------------------------
// LayerManager

interface ManagerPeer {
  layers: JObject[];
  view: { x: number; y: number; w: number; h: number };
}
const mp = (o: JObject) => o.n as ManagerPeer;

const layerManagerClass: NativeClassDef = {
  name: 'javax/microedition/lcdui/game/LayerManager',
  methods: {
    '<init>()V': (_t, [self]) => {
      self.n = { layers: [], view: { x: 0, y: 0, w: Number.MAX_SAFE_INTEGER, h: Number.MAX_SAFE_INTEGER } } satisfies ManagerPeer;
    },
    'append(Ljavax/microedition/lcdui/game/Layer;)V': (t, [self, layer]) => {
      if (layer === null) throw t.jvm.npe();
      const p = mp(self);
      p.layers = p.layers.filter((l) => l !== layer);
      p.layers.push(layer);
    },
    'insert(Ljavax/microedition/lcdui/game/Layer;I)V': (t, [self, layer, index]) => {
      if (layer === null) throw t.jvm.npe();
      const p = mp(self);
      p.layers = p.layers.filter((l) => l !== layer);
      if (index < 0 || index > p.layers.length) throw t.jvm.throwable('java/lang/IndexOutOfBoundsException');
      p.layers.splice(index, 0, layer);
    },
    'remove(Ljavax/microedition/lcdui/game/Layer;)V': (t, [self, layer]) => {
      if (layer === null) throw t.jvm.npe();
      const p = mp(self);
      p.layers = p.layers.filter((l) => l !== layer);
    },
    'getLayerAt(I)Ljavax/microedition/lcdui/game/Layer;': (t, [self, index]) => {
      const layer = mp(self).layers[index];
      if (!layer) throw t.jvm.throwable('java/lang/IndexOutOfBoundsException');
      return layer;
    },
    'getSize()I': (_t, [self]) => mp(self).layers.length,
    'setViewWindow(IIII)V': (t, [self, x, y, w, h]) => {
      if (w < 0 || h < 0) throw t.jvm.throwable('java/lang/IllegalArgumentException');
      mp(self).view = { x, y, w, h };
    },
    'paint(Ljavax/microedition/lcdui/Graphics;II)V': (t, [self, g, x, y]) => {
      if (g === null) throw t.jvm.npe();
      const p = mp(self);
      const gp = g.n as GraphicsPeer;
      const saved = { tx: gp.tx, ty: gp.ty, cx: gp.clipX, cy: gp.clipY, cw: gp.clipW, ch: gp.clipH };
      try {
        gp.clipRect(x, y, Math.min(p.view.w, 1 << 20), Math.min(p.view.h, 1 << 20));
        gp.translate(x - p.view.x, y - p.view.y);
        // 下标 0 在最上层：从后往前画；游戏自己继承 Layer 时 paint 是 Java 方法，统一走虚调用
        for (let i = p.layers.length - 1; i >= 0; i--) {
          const layer = p.layers[i];
          if (!lp(layer).visible) continue;
          t.jvm.callVirtualSync(t, layer, 'paint(Ljavax/microedition/lcdui/Graphics;)V', [g]);
        }
      } finally {
        gp.tx = saved.tx;
        gp.ty = saved.ty;
        gp.clipX = saved.cx;
        gp.clipY = saved.cy;
        gp.clipW = saved.cw;
        gp.clipH = saved.ch;
      }
    },
  },
};

export const gameLayerNatives: NativeClassDef[] = [layerClass, spriteClass, tiledLayerClass, layerManagerClass];
