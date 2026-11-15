import { base64FromBytes, bytesFromBase64 } from '../jvm/natives/helpers';

export interface StoreData {
  nextId: number;
  version: number;
  lastModified: number;
  records: Map<number, Uint8Array>;
}

interface StoredJson {
  n: number;
  v: number;
  m: number;
  r: Record<string, string>;
}

/** Record stores persisted in localStorage, one entry per store. */
export class RmsService {
  private readonly prefix: string;
  private readonly memory = new Map<string, string>();
  private storageBroken = false;

  constructor(storageId: string) {
    this.prefix = `j2me-web:rms:${storageId}:`;
  }

  private getItem(key: string): string | null {
    if (!this.storageBroken) {
      try {
        return localStorage.getItem(key);
      } catch {
        this.storageBroken = true;
      }
    }
    return this.memory.get(key) ?? null;
  }

  private setItem(key: string, value: string): void {
    this.memory.set(key, value);
    if (this.storageBroken) return;
    try {
      localStorage.setItem(key, value);
    } catch {
      this.storageBroken = true;
    }
  }

  list(): string[] {
    const names = new Set<string>();
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(this.prefix)) names.add(key.slice(this.prefix.length));
      }
    } catch {
      /* storage unavailable */
    }
    for (const key of this.memory.keys()) if (key.startsWith(this.prefix)) names.add(key.slice(this.prefix.length));
    return [...names];
  }

  load(name: string): StoreData | null {
    const raw = this.getItem(this.prefix + name);
    if (raw === null) return null;
    try {
      const json = JSON.parse(raw) as StoredJson;
      const records = new Map<number, Uint8Array>();
      for (const [id, b64] of Object.entries(json.r)) records.set(Number(id), bytesFromBase64(b64));
      return { nextId: json.n, version: json.v, lastModified: json.m, records };
    } catch {
      return null;
    }
  }

  save(name: string, data: StoreData): void {
    const r: Record<string, string> = {};
    for (const [id, bytes] of data.records) r[id] = base64FromBytes(bytes);
    this.setItem(this.prefix + name, JSON.stringify({ n: data.nextId, v: data.version, m: data.lastModified, r } satisfies StoredJson));
  }

  delete(name: string): void {
    this.memory.delete(this.prefix + name);
    try {
      localStorage.removeItem(this.prefix + name);
    } catch {
      /* storage unavailable */
    }
  }

  /** All stores of this suite, e.g. for export. */
  exportAll(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of this.list()) out[name] = this.getItem(this.prefix + name) ?? '';
    return out;
  }
}
