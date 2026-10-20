/** 站内已发布的 PCSX ReARMed 不认 CHD；Beetle PSX HW 的 core.json 才声明了 chd。 */
export const PSX_CHD_CORE = 'mednafen_psx_hw'
/** Beetle 比默认 PCSX 重；多留 64ms 音频队列吸收短时主线程抖动，代价是音画延迟。 */
export const PSX_CHD_AUDIO_LATENCY_MS = 128
const PSX_CHD_SAVE_SUFFIX = ':beetle-chd'

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

/** 自动换核心后不能把 Beetle 快照写回旧 PCSX 档位；本地文件本来按文件名独立存。 */
export function psxChdSaveSlug(gameSlug: string, transferUrl: string): string {
  return gameSlug.startsWith('local:') || !isPsxChdTransfer(transferUrl)
    ? gameSlug
    : `${gameSlug}${PSX_CHD_SAVE_SUFFIX}`
}

/** 个人页只用基础 slug 查游戏；云端实际存档键仍保留完整后缀。 */
export function parsePsxChdSaveSlug(value: string): string {
  return !value.startsWith('local:') && value.endsWith(PSX_CHD_SAVE_SUFFIX)
    ? value.slice(0, -PSX_CHD_SAVE_SUFFIX.length)
    : value
}
