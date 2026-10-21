/** HW 版在浏览器会触发 WASM 表陷阱；实机验证通过的软件版保留 CHD 能力且不整盘预缓存。 */
export const PSX_CHD_CORE = 'mednafen_psx'
/** 此核心走引擎的 legacy 分支；预热同一份文件，避免悬停和开局各下载一遍。 */
export const PSX_CHD_ARCHIVE = 'mednafen_psx-legacy-wasm.data'
/** Beetle 比默认 PCSX 重；多留 64ms 音频队列吸收短时主线程抖动，代价是音画延迟。 */
export const PSX_CHD_AUDIO_LATENCY_MS = 128
const PSX_CHD_SAVE_SUFFIX = ':beetle-soft-chd'
const PSX_CHD_OLD_SAVE_SUFFIX = ':beetle-chd'

function pathWithoutQuery(value: string): string {
  const path = String(value || '').split(/[?#]/, 1)[0]
  try { return decodeURIComponent(path) } catch { return path }
}

/** 上传时可包 8BG；这只影响下载/续传判断，不代表核心能直接读取外层容器。 */
export function isPsxChdTransfer(value: string): boolean {
  return /\.chd(?:\.8bg)?$/i.test(pathWithoutQuery(value))
}

/** 悬停预热只能看到传输地址；已知是 CHD 时预拉目标核心，避免白下默认 PCSX。 */
export function psxCoreForTransfer(platform: string, core: string | null | undefined, url: string): string | null | undefined {
  return platform === 'psx' && isPsxChdTransfer(url) ? PSX_CHD_CORE : core
}

/** 必须在 8BG 解包后用真正的内层文件名判断，不能把一个伪装成 CHD 的 ISO 交错核心。 */
export function psxCoreForPreparedName(platform: string, core: string, name: string): string {
  return platform === 'psx' && /\.chd$/i.test(pathWithoutQuery(name)) ? PSX_CHD_CORE : core
}

/** 软件版与旧 HW 版快照不混用，避免 ABI/渲染状态差异损坏既有存档。 */
export function psxChdSaveSlug(gameSlug: string, transferUrl: string): string {
  return gameSlug.startsWith('local:') || !isPsxChdTransfer(transferUrl)
    ? gameSlug
    : `${gameSlug}${PSX_CHD_SAVE_SUFFIX}`
}

/** 个人页只用基础 slug 查游戏；云端实际存档键仍保留完整后缀。 */
export function parsePsxChdSaveSlug(value: string): string {
  if (value.startsWith('local:')) return value
  const suffix = [PSX_CHD_SAVE_SUFFIX, PSX_CHD_OLD_SAVE_SUFFIX].find(item => value.endsWith(item))
  return suffix ? value.slice(0, -suffix.length) : value
}
