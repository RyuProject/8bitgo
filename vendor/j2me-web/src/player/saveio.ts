import { base64FromBytes } from '../jvm/natives/helpers';

/**
 * 存档导入导出。
 *
 * 只有一种格式、一个文件里可含多个游戏，用户不需要区分「备份」和「分享」：
 *
 * - 备份全部 → 一个 .jsav，含库里所有游戏 + 所有进度
 * - 游戏内导出 → 一个 .jsav，只含这一个游戏（顺带可发给朋友）
 * - 导入 → 自动看文件里有几个游戏，写回几个，不问
 */

const FORMAT = 'j2me-web-save';
const FORMAT_VERSION = 1;
const RMS_PREFIX = 'j2me-web:rms:';
const TOUCH_PREF_KEY = 'j2me-web:touch-controls';

export interface SaveApp {
  name: string;
  vendor: string;
  fileName: string;
  /**
   * 导出时的存档身份。
   *
   * 写死进文件而不是靠 name|vendor 推导：推导在打包构建下对不上
   * （打包版用固定 storageId，库界面版用清单推导），会认不出自己的存档。
   */
  storageId: string;
  /** 游戏本体。为 null 表示只备份了进度（比如 jar 已不在库里）。 */
  jarBase64: string | null;
  /** RecordStore 名 -> 该 store 的原始 JSON 字符串 */
  rms: Record<string, string>;
}

export interface SaveFile {
  format: typeof FORMAT;
  version: number;
  exportedAt: number;
  apps: SaveApp[];
  prefs: Record<string, string>;
}

export interface ApplyReport {
  apps: number;
  written: number;
  skipped: number;
}

// ---------------------------------------------------------------------------------------------
// 收集

/** 把 localStorage 里所有 j2me-web:rms:* 的内容按 storageId 分组。 */
export function collectAllRms(): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(RMS_PREFIX)) continue;
      const rest = key.slice(RMS_PREFIX.length);
      const sep = rest.indexOf(':');
      if (sep < 0) continue;
      const storageId = rest.slice(0, sep);
      const name = rest.slice(sep + 1);
      const raw = localStorage.getItem(key);
      if (raw === null) continue;
      let group = out.get(storageId);
      if (!group) out.set(storageId, (group = {}));
      group[name] = raw;
    }
  } catch {
    /* storage unavailable */
  }
  return out;
}

function collectRmsOf(storageId: string): Record<string, string> {
  return collectAllRms().get(storageId) ?? {};
}

function collectPrefs(): Record<string, string> {
  const prefs: Record<string, string> = {};
  try {
    const touch = localStorage.getItem(TOUCH_PREF_KEY);
    // 用真实 localStorage 键名，导入时才能原样写回去
    if (touch !== null) prefs[TOUCH_PREF_KEY] = touch;
  } catch {
    /* storage unavailable */
  }
  return prefs;
}

function wrap(app: SaveApp): SaveFile {
  return { format: FORMAT, version: FORMAT_VERSION, exportedAt: Date.now(), apps: [app], prefs: collectPrefs() };
}

/** 单个游戏的存档，用于分享。 */
export function buildAppSave(game: { name: string; vendor: string; fileName: string }, storageId: string, bytes: Uint8Array): SaveFile {
  return wrap({ ...game, storageId, jarBase64: base64FromBytes(bytes), rms: collectRmsOf(storageId) });
}

/**
 * 全量备份：所有游戏的进度 + 库里所有 jar。
 *
 * jars 由调用方（IndexedDB）提供，这里只做拼装，方便离线测试。
 */
export function buildBackup(apps: Array<{ game: { name: string; vendor: string; fileName: string }; storageId: string; bytes: Uint8Array | null }>): SaveFile {
  const allRms = collectAllRms();
  const seen = new Map<string, SaveApp>();
  for (const { game, storageId, bytes } of apps) {
    // 同一个 storageId 已有条目就只补 jar，不重复
    const existing = seen.get(storageId);
    if (existing) {
      if (existing.jarBase64 === null && bytes) existing.jarBase64 = base64FromBytes(bytes);
      continue;
    }
    seen.set(storageId, {
      ...game,
      storageId,
      jarBase64: bytes ? base64FromBytes(bytes) : null,
      rms: allRms.get(storageId) ?? {},
    });
  }
  // 库里有、但进度在 storageId 上不匹配的孤儿存档也带上，别弄丢
  for (const [storageId, rms] of allRms) {
    if (seen.has(storageId) || Object.keys(rms).length === 0) continue;
    seen.set(storageId, { name: '(未知游戏)', vendor: '', fileName: 'unknown.jar', storageId, jarBase64: null, rms });
  }
  return { format: FORMAT, version: FORMAT_VERSION, exportedAt: Date.now(), apps: [...seen.values()], prefs: collectPrefs() };
}

// ---------------------------------------------------------------------------------------------
// 文件

export function downloadSaveFile(file: SaveFile, baseName: string): void {
  const d = new Date(file.exportedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const tag = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const n = file.apps.length;
  const url = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = n === 1 ? `${baseName}-存档-${tag}.jsav` : `j2me-web-全部存档-${n}个游戏-${tag}.jsav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function parseSaveFile(text: string): SaveFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('不是有效的 JSON 文件');
  }
  const f = parsed as Partial<SaveFile>;
  if (f?.format !== FORMAT) throw new Error('不是 j2me-web 存档文件');
  if (typeof f.version !== 'number' || f.version > FORMAT_VERSION) {
    throw new Error(`存档版本 ${f.version} 比当前程序（${FORMAT_VERSION}）新，可能来自更新的版本`);
  }
  if (!Array.isArray(f.apps) || f.apps.length === 0) throw new Error('存档里没有任何游戏');
  for (const [i, app] of f.apps.entries()) {
    if (!app || typeof app.storageId !== 'string' || !app.storageId) throw new Error(`第 ${i + 1} 个游戏缺少存档身份`);
    if (app.rms != null && typeof app.rms !== 'object') throw new Error(`第 ${i + 1} 个游戏的 rms 字段损坏`);
  }
  return {
    format: FORMAT,
    version: f.version,
    exportedAt: f.exportedAt ?? 0,
    apps: f.apps.map((a) => ({ ...a, rms: a.rms ?? {}, jarBase64: a.jarBase64 ?? null })),
    prefs: f.prefs ?? {},
  };
}

// ---------------------------------------------------------------------------------------------
// 写回

/**
 * 写回存档。
 *
 * `targetStorageId` 是当前游戏的身份。每个游戏的进度会同时写到
 * 它自己的 storageId 下——这样「库界面版导出的存档」也能被
 * 「打包版」认出来（两者 storageId 不同），不用做迁移。
 *
 * overwrite=false 时只补空缺，保护用户正在玩的进度。
 */
export function applySaveFile(file: SaveFile, targetStorageId?: string, overwrite = false): ApplyReport {
  let written = 0;
  let skipped = 0;
  for (const app of file.apps) {
    const targets = new Set([app.storageId]);
    if (targetStorageId && app.name && app.name !== '(未知游戏)') targets.add(targetStorageId);
    for (const storageId of targets) {
      const prefix = RMS_PREFIX + storageId + ':';
      for (const [name, raw] of Object.entries(app.rms)) {
        const key = prefix + name;
        if (!overwrite) {
          try {
            if (localStorage.getItem(key) !== null) {
              skipped += 1;
              continue;
            }
          } catch {
            /* storage unavailable */
          }
        }
        try {
          localStorage.setItem(key, raw);
          written += 1;
        } catch {
          /* quota exceeded or storage unavailable */
        }
      }
    }
  }
  for (const [k, v] of Object.entries(file.prefs)) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage unavailable */
    }
  }
  return { apps: file.apps.length, written, skipped };
}

/** 这个存档是不是当前这个游戏的。名字对不上时 UI 要提示。 */
export function findAppFor(file: SaveFile, name: string, vendor: string): SaveApp | undefined {
  return file.apps.find((a) => a.name === name && a.vendor === vendor);
}

/** jar 字节，供导入后直接开玩。 */
export function jarBytesOf(app: SaveApp): Uint8Array | null {
  if (!app.jarBase64) return null;
  const bin = atob(app.jarBase64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function describeSize(bytes: number): string {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(2)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}