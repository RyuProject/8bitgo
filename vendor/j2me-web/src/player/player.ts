import { type JarFile, listMidlets, readJar } from '../jar/jar';
import { Jvm } from '../jvm/jvm';
import { allNatives } from '../jvm/natives';
import { decodePng, isPng } from '../gfx/png';
import { prewarmImages } from '../gfx/jpeg';
import type { KeyEventKind } from '../platform/display';
import { type LogLevel, Platform } from '../platform/platform';
import { type ScreenSize, detectScreenSize } from './detect';
import { type GamePreset, findPreset } from './presets';

export interface PlayerCallbacks {
  onLog?(level: LogLevel, message: string): void;
  onHalt?(reason: 'exit' | 'error', message?: string): void;
}

export interface MidletInfo {
  name: string;
  vendor: string;
  version: string;
  size: ScreenSize;
  iconDataUrl: string | null;
}

export function inspectJar(jar: JarFile, fileName: string): MidletInfo {
  const midlets = listMidlets(jar.manifest);
  const name = jar.manifest.get('MIDlet-Name') ?? midlets[0]?.name ?? fileName.replace(/\.jar$/i, '');
  const vendor = jar.manifest.get('MIDlet-Vendor') ?? '';
  return {
    name,
    vendor,
    version: jar.manifest.get('MIDlet-Version') ?? '',
    size: findPreset(name, vendor).screen ?? detectScreenSize(jar, fileName),
    iconDataUrl: extractIcon(jar, jar.manifest.get('MIDlet-Icon') ?? midlets[0]?.icon ?? ''),
  };
}

function extractIcon(jar: JarFile, path: string): string | null {
  const clean = path.trim().replace(/^\/+/, '');
  if (!clean) return null;
  const entry = [...jar.entries.entries()].find(([p]) => p.toLowerCase() === clean.toLowerCase());
  if (!entry || !isPng(entry[1])) return null;
  try {
    const img = decodePng(entry[1]);
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.getContext('2d')!.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

/** One running MIDlet: JAR + JVM + platform services + the canvas it draws to. */
export class GamePlayer {
  readonly jar: JarFile;
  readonly info: MidletInfo;
  readonly preset: GamePreset;
  /** 实际使用的存档身份。导出/导入必须用它，不能重新推导。 */
  readonly storageId: string;
  readonly screen: HTMLCanvasElement;
  readonly jvm: Jvm;
  readonly platform: Platform;
  private readonly midletClass: string;
  private readonly screenCtx: CanvasRenderingContext2D;
  /** 构造器里建好的带节流日志函数，prepareImages 等异步流程也要用它。 */
  private readonly log: (level: LogLevel, message: string) => void;

  constructor(bytes: Uint8Array, fileName: string, callbacks: PlayerCallbacks = {}) {
    this.jar = readJar(bytes);
    const midlets = listMidlets(this.jar.manifest);
    if (!midlets.length) throw new Error('JAR 清单里没有 MIDlet-1 —— 这不是 J2ME 游戏？');
    this.midletClass = midlets[0].className;
    this.info = inspectJar(this.jar, fileName);
    this.preset = findPreset(this.info.name, this.info.vendor);

    const { width, height } = this.info.size;
    this.screen = document.createElement('canvas');
    this.screen.width = width;
    this.screen.height = height;
    this.screen.className = 'screen';
    this.screenCtx = this.screen.getContext('2d', { alpha: false })!;
    this.screenCtx.imageSmoothingEnabled = false;
    this.screenCtx.fillStyle = '#000';
    this.screenCtx.fillRect(0, 0, width, height);

    // 日志节流：游戏缺 API 时会在每帧 repaint 里重复抛同一个异常（实测仙剑开声音时
    // 每秒上万条），不收敛的话 console 和 onLog 回调会被刷爆、主线程直接卡死。
    // 同一 level+message：前 3 次逐条打，之后每 1000 次汇总一条，最多 5 条封顶，
    // 再之后彻底闭嘴（并记录最终次数），保证输出量有硬上限。
    const REPEAT_LIMIT = 3;
    const REPEAT_EVERY = 1000;
    const REPEAT_SUMMARIES = 5;
    const seen = new Map<string, { n: number; summaries: number }>();
    const log = (level: LogLevel, message: string) => {
      const key = `${level}|${message}`;
      const rec = seen.get(key);
      if (rec === undefined) {
        seen.set(key, { n: 1, summaries: 0 });
      } else {
        rec.n += 1;
        if (rec.n > REPEAT_LIMIT && rec.n % REPEAT_EVERY !== 0) {
          if (rec.summaries >= REPEAT_SUMMARIES) return;
          rec.summaries += 1;
        }
      }
      const n = rec ? rec.n : 1;
      const suffix = n <= REPEAT_LIMIT ? '' : ` (×${n})`;
      (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[j2me] ${message}${suffix}`);
      callbacks.onLog?.(level, message + suffix);
    };
    this.log = log;

    this.storageId = window.__PACK__?.identity?.storageId ?? `${this.info.vendor}|${this.info.name}`;
    this.platform = new Platform({
      width,
      height,
      manifest: this.jar.manifest,
      resources: this.jar.entries,
      // 打包构建会指定 storageId；默认仍从 jar 清单推导。
      // 同域名部署多个游戏包时，推导出的 vendor|name 可能撞车导致存档串档。
      storageId: this.storageId,
      present: (surface) => this.screenCtx.drawImage(surface.canvas, 0, 0),
      vibrate: (ms) => {
        try {
          navigator.vibrate?.(ms);
        } catch {
          /* not supported */
        }
      },
      log,
      onExit: () => log('info', 'MIDlet exited'),
      locale: navigator.language,
    });
    this.jvm = new Jvm({ log, onHalt: (reason, message) => callbacks.onHalt?.(reason, message) }, this.jar.entries, allNatives);
    this.platform.attach(this.jvm);
  }

  /**
   * 启动前把 jar 里的 JPEG 全部解码好。
   *
   * 浏览器解码 JPEG 是异步的，而 MIDP 的 `Image.createImage(InputStream)` 是同步的，
   * 所以必须在 MIDlet 跑起来之前把像素准备好，运行时才能同步查表（详见 gfx/jpeg.ts）。
   * 没有 jpg 的游戏这一句是零成本的空转。
   */
  async prepareImages(): Promise<{ decoded: number; failed: number; total: number }> {
    const result = await prewarmImages(this.jar.entries, (done, total, name) => {
      if (total > 8 && done % 8 !== 0 && done !== total) return;
      this.log('info', `预解码 JPEG ${done}/${total}：${name.split('/').pop()}`);
    });
    if (result.total > 0) {
      this.log(
        'info',
        `JPEG 预解码完成：${result.decoded}/${result.total} 张成功${result.failed ? `，${result.failed} 张失败` : ''}`,
      );
    }
    return result;
  }

  start(): void {
    this.jvm.startMidlet(this.midletClass);
  }

  stop(): void {
    this.jvm.halt('exit');
  }

  key(kind: KeyEventKind, code: number): void {
    if (!this.jvm.halted) this.platform.display.postKey(kind, code);
  }
}
