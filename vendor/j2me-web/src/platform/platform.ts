import type { Jvm } from '../jvm/jvm';
import { JObject } from '../jvm/types';
import { AudioService } from './audio';
import { DisplayService } from './display';
import { FontPeer } from './font';
import { GraphicsPeer } from './graphics';
import { RmsService } from './rms';
import type { Surface } from './surface';

export type LogLevel = 'info' | 'warn' | 'error';

export interface PlatformConfig {
  width: number;
  height: number;
  manifest: Map<string, string>;
  resources: Map<string, Uint8Array>;
  /** Namespace for saved data, normally derived from MIDlet vendor + name. */
  storageId: string;
  present(surface: Surface): void;
  vibrate(ms: number): void;
  log(level: LogLevel, message: string): void;
  onExit(): void;
  fontSizes?: { small: number; medium: number; large: number };
  hasPointerEvents?: boolean;
  locale?: string;
}

export class Platform {
  jvm!: Jvm;
  readonly display: DisplayService;
  readonly rms: RmsService;
  readonly audio: AudioService;
  runtimeObject: JObject | null = null;
  midlet: JObject | null = null;
  private readonly fonts = new Map<string, JObject>();
  private readonly lowerCaseResources = new Map<string, string>();

  constructor(readonly config: PlatformConfig) {
    this.display = new DisplayService(this);
    this.rms = new RmsService(config.storageId);
    this.audio = new AudioService(config.log);
    for (const path of config.resources.keys()) this.lowerCaseResources.set(path.toLowerCase(), path);
  }

  attach(jvm: Jvm): void {
    this.jvm = jvm;
    jvm.platform = this;
  }

  onMidletCreated(midlet: JObject): void {
    this.midlet = midlet;
  }

  getResource(path: string): Uint8Array | null {
    const clean = path.replace(/^\/+/, '');
    const exact = this.config.resources.get(clean);
    if (exact) return exact;
    const alt = this.lowerCaseResources.get(clean.toLowerCase());
    return alt ? this.config.resources.get(alt)! : null;
  }

  appProperty(key: string): string | null {
    return this.config.manifest.get(key) ?? null;
  }

  systemProperty(key: string): string | null {
    switch (key) {
      case 'microedition.platform':
        return 'j2me-web';
      case 'microedition.encoding':
        return 'ISO-8859-1';
      case 'microedition.configuration':
        return 'CLDC-1.1';
      case 'microedition.profiles':
        return 'MIDP-2.0';
      case 'microedition.locale':
        return this.config.locale ?? 'en-US';
      case 'microedition.media.version':
        return '1.1';
      case 'supports.mixing':
        return 'false';
      default:
        return null;
    }
  }

  font(face: number, style: number, size: number): JObject {
    const key = `${face}:${style}:${size}`;
    let obj = this.fonts.get(key);
    if (!obj) {
      obj = new JObject(this.jvm.loadClass('javax/microedition/lcdui/Font'));
      obj.n = new FontPeer(face, style, size, this.config.fontSizes ?? { small: 12, medium: 14, large: 16 });
      this.fonts.set(key, obj);
    }
    return obj;
  }

  defaultFont(): { peer: FontPeer; obj: JObject } {
    const obj = this.font(0, 0, 0);
    return { peer: obj.n as FontPeer, obj };
  }

  newGraphics(surface: Surface): JObject {
    const g = new JObject(this.jvm.loadClass('javax/microedition/lcdui/Graphics'));
    g.n = new GraphicsPeer(surface, () => this.defaultFont());
    return g;
  }
}
