/**
 * 打包模式下注入的构建期常量。
 *
 * 由 experiments/pack-jianxin/vite.pack.config.ts 在构建时写进产物，
 * 正式构建（vite.config.ts）不注入任何东西，所以主程序的库界面行为不变。
 */

export interface EmbeddedGame {
  /** 显示名，用于界面标题。 */
  name: string;
  /** jar 文件名，会进 GamePlayer（影响部分游戏的资源查找）。 */
  fileName: string;
  /** base64 编码的 jar 字节。 */
  jarBase64: string;
}

export interface PackIdentity {
  /**
   * 存档隔离前缀。不设的话用 jar 清单推导的 vendor|name——
   * 同域名部署多个游戏包时两个包可能推出同一个 id，存档会互相覆盖。
   */
  storageId?: string;
  /** IndexedDB 库名，用于存放这个包自己的游戏列表。 */
  databaseName?: string;
}

declare global {
  interface Window {
    __PACK__?: { game: EmbeddedGame; identity: PackIdentity; title?: string; description?: string };
  }
}

export function embeddedGame(): EmbeddedGame | null {
  return window.__PACK__?.game ?? null;
}

export function packIdentity(): PackIdentity | null {
  return window.__PACK__?.identity ?? null;
}

/** jar 的真实字节（从 base64 解出来），不是打包模式就返回 null。 */
export function embeddedJarBytes(): Uint8Array | null {
  const packed = window.__PACK__?.game;
  if (!packed) return null;
  const bin = atob(packed.jarBase64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
/** 是否为打包构建（jar 已内嵌，没有「上传 jar」的库界面）。 */
export function isPacked(): boolean {
  return window.__PACK__?.game != null;
}
