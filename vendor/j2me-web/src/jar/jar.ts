import { unzipSync } from 'fflate';

export interface JarFile {
  /** Entry path (no leading slash) → bytes. */
  entries: Map<string, Uint8Array>;
  /** Main attributes of META-INF/MANIFEST.MF. */
  manifest: Map<string, string>;
}

export function readJar(bytes: Uint8Array): JarFile {
  const files = unzipSync(bytes);
  const entries = new Map<string, Uint8Array>();
  for (const [path, data] of Object.entries(files)) {
    if (!path.endsWith('/')) entries.set(path.replace(/^\/+/, ''), data);
  }

  const manifestEntry = [...entries.keys()].find((p) => p.toUpperCase() === 'META-INF/MANIFEST.MF');
  const manifest = manifestEntry ? parseManifest(decodeText(entries.get(manifestEntry)!)) : new Map<string, string>();
  return { entries, manifest };
}

/** Parses manifest / JAD style "Key: value" text, honouring manifest line continuations. */
export function parseManifest(text: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let current: string | null = null;
  for (const line of lines) {
    if (line.startsWith(' ') && current !== null) {
      result.set(current, result.get(current)! + line.slice(1));
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) {
      if (line.trim() === '' && result.size > 0) break; // end of main section
      continue;
    }
    current = line.slice(0, colon).trim();
    result.set(current, line.slice(colon + 1).trim());
  }
  return result;
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

export interface MidletEntry {
  name: string;
  icon: string;
  className: string;
}

/** MIDlet-1, MIDlet-2, ... entries: "Name, /icon.png, com.example.Main". */
export function listMidlets(manifest: Map<string, string>): MidletEntry[] {
  const midlets: MidletEntry[] = [];
  for (let i = 1; manifest.has(`MIDlet-${i}`); i++) {
    const parts = manifest.get(`MIDlet-${i}`)!.split(',').map((s) => s.trim());
    if (parts.length >= 3 && parts[2]) midlets.push({ name: parts[0], icon: parts[1], className: parts[2] });
  }
  return midlets;
}
