/** Ruffle 的 SharedObject 存在同源 localStorage；键由 SWF 的虚拟 URL 和槽名组成。 */

export const FLASH_SAVE_FORMAT = '8bitgo-flash-save'
export const LEGACY_FLASH_PREFIX = '/srcdoc/'

/**
 * Ruffle 的 load_data 会把 window.location 最后一段换成 swfFileName。
 * 播放框先用 history.replaceState 换成逐游戏地址，这里必须照它的算法算同一条路径。
 */
export function flashMovieUrl(frameHref: string, swfFileName: string): URL {
  const frame = new URL(frameHref)
  frame.search = ''
  frame.hash = ''
  return new URL(encodeURIComponent(swfFileName), new URL('.', frame))
}

/**
 * 存档路径里的 SWF 名要跟着**游戏**走，而不是跟着这次下载到的文件名走。
 *
 * 同一款游戏的 ROM 可能是 `<slug>.swf`、重新上传后的 `<slug>.swf.8bg`（解包名是管理员本地的
 * 原始文件名）、或多 SWF 包 `<slug>/root.swf`。旧实现直接用解包 / 下载名，三种形态各落一条路径，
 * 后台一换形态，老玩家的进度就读不到了。这里从 ROM 地址推一个稳定名：剥掉 `.8bg`，
 * `root.swf` 换成所在目录名。单 SWF 的 `<slug>.swf` 结果不变，存量存档无需迁移；
 * 语言版本（`<slug>.zh-Hans.swf`）仍各自独立，避免不同构建互读存档格式。
 */
export function flashSaveSwfName(gameUrl: string | null | undefined, loadedName: string): string {
  if (!gameUrl) return loadedName
  try {
    const parts = new URL(gameUrl, 'https://8bitgo.invalid/').pathname
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part))
    let last = (parts.pop() ?? '').replace(/\.8bg$/i, '')
    if (/^root\.swf$/i.test(last) && parts.length) last = `${parts[parts.length - 1]}.swf`
    return /\.swf$/i.test(last) && !/[\\/]/.test(last) ? last : loadedName
  } catch {
    return loadedName
  }
}

/**
 * Ruffle 当前按 `loadedName` 实际落盘的前缀候选。它和我们用 encodeURIComponent 算出来的
 * 可能不同（WHATWG URL 不转义 `[]` 等字符），两种都列出来，迁移时逐个找。
 */
export function flashLegacySavePrefixes(frameHref: string, loadedName: string): string[] {
  const out = new Set<string>()
  out.add(flashSavePrefix(flashMovieUrl(frameHref, loadedName)))
  try {
    const frame = new URL(frameHref)
    frame.search = ''
    frame.hash = ''
    const whatwg = new URL(loadedName.replace(/[?#]/g, encodeURIComponent), new URL('.', frame))
    out.add(flashSavePrefix(whatwg))
  } catch {
    /* 名字无法组成 URL 时只留第一种 */
  }
  return [...out]
}

export function flashSavePrefix(movieUrl: URL): string {
  return `${movieUrl.hostname}/${movieUrl.pathname.replace(/^\//, '')}/`
}

/** 只认 Ruffle 自己用的 SOL 文件头，避免把本站其他 localStorage 数据带进存档。 */
export function isSolBase64(value: string): boolean {
  try {
    const raw = atob(value)
    return raw.length >= 16 && raw.charCodeAt(0) === 0 && raw.charCodeAt(1) === 0xbf &&
      raw.slice(6, 10) === 'TCSO' &&
      [0, 4, 0, 0, 0, 0].every((byte, i) => raw.charCodeAt(10 + i) === byte)
  } catch {
    return false
  }
}

/** v2 只存槽名，换域名、换设备时仍能恢复到当前游戏的独立路径。 */
export function readFlashEntries(store: Storage, prefix: string): Record<string, string> {
  const entries: Record<string, string> = Object.create(null)
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i)
    if (!key?.startsWith(prefix)) continue
    const slot = key.slice(prefix.length)
    const value = store.getItem(key)
    if (slot && value && isSolBase64(value)) entries[slot] = value
  }
  return entries
}

/** 旧 srcdoc 地址没有域名，且所有游戏共用；这里只供玩家手动恢复，不自动归属。 */
export function readLegacyFlashEntries(store: Storage): Record<string, string> {
  return readFlashEntries(store, LEGACY_FLASH_PREFIX)
}

export function validFlashEntries(entries: unknown): entries is Record<string, string> {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return false
  return Object.keys(entries).length > 0 && Object.entries(entries).every(([slot, value]) =>
    Boolean(slot) && !slot.includes('\0') && typeof value === 'string' && isSolBase64(value))
}

/**
 * 导入是替换当前游戏的一整份进度：多槽游戏的旧槽也要清掉。
 * 配额不足等写入失败时先删本次写入，再还原原值，不能留下半份新旧混合的存档。
 */
export function restoreFlashEntries(store: Storage, prefix: string, entries: Record<string, string>, replace: boolean): void {
  const incoming = Object.entries(entries).map(([slot, value]) => [prefix + slot, value] as const)
  const existing = replace ? Object.keys(readFlashEntries(store, prefix)).map((slot) => prefix + slot) : []
  const touched = new Set([...existing, ...incoming.map(([key]) => key)])
  const before = new Map([...touched].map((key) => [key, store.getItem(key)]))
  try {
    if (replace) for (const key of existing) store.removeItem(key)
    for (const [key, value] of incoming) store.setItem(key, value)
  } catch (error) {
    for (const key of touched) store.removeItem(key)
    for (const [key, value] of before) if (value !== null) store.setItem(key, value)
    throw error
  }
}
