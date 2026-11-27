import type { Plugin } from 'vite'

export declare const INTEGRITY_MANIFEST_VERSION: number
export declare function integrityManifestName(entryFileName: string): string | null
export declare function sha256Base64(bytes: Uint8Array | string): string
export declare function isIntegrityTarget(fileName: string): boolean
export declare function localeAssetsFromBundle(bundle: Record<string, unknown>): Record<string, string>
export declare function buildIntegrityManifest(
  entryFileName: string,
  files: Record<string, string>,
  imports?: Record<string, string[]>,
): { v: number; alg: 'sha256'; entry: string; files: Record<string, string>; imports: Record<string, string[]> }
export declare function assetIntegrityPlugin(): Plugin
