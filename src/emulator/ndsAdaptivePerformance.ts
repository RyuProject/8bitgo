import { EJS_CORE_VERSIONS } from './ejsCoreVersionsData'
import { ndsRomIdentity } from './ndsCorePreference'
import { EJS_RUNTIME_GENERATION } from './paths'

/**
 * melonDS DS 当前构建没有可验证的运行时帧跳选项；DeSmuME 的帧跳则由核心公开，
 * 适配器还会在每次调整后回读确认。低帧率时只把 DeSmuME 作为下一局的一次性尝试。
 */
export const NDS_ADAPTIVE_PERFORMANCE_CORE = 'desmume'
export const NDS_ADAPTIVE_PERFORMANCE_SAVE_SUFFIX = ':nds-desmume-adaptive'
// melonDS DS / DeSmuME 的核心目标约为 59.9 / 60 FPS；48 FPS 是持续低约两成，50Hz 游戏仍不会触发。
export const NDS_PERFORMANCE_SAMPLE_MS = 5_000
export const NDS_PERFORMANCE_SLOW_FPS = 48
// 连续三个 5 秒窗口都低于阈值才调档，排除开场编译、短暂载入和一次性掉帧。
export const NDS_PERFORMANCE_SLOW_WINDOWS = 3

const DESMUME_BUILD = [
  EJS_CORE_VERSIONS['cores/desmume-wasm.data'] ?? 'unknown',
  EJS_CORE_VERSIONS['cores/desmume-legacy-wasm.data'] ?? 'unknown',
].join('.')
const STORAGE_KEY = `8bitgo:nds-performance-trial:${EJS_RUNTIME_GENERATION}:${DESMUME_BUILD}`
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000
const MAX_RECORDS = 32

type PerformanceRecord = { identity: string; at: number }

function safeStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

function readRecords(storage: Storage | null, now: number): PerformanceRecord[] {
  if (!storage) return []
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is PerformanceRecord =>
      Boolean(value) && typeof value.identity === 'string' &&
      typeof value.at === 'number' && value.at <= now && now - value.at < RETAIN_MS)
  } catch { return [] }
}

/** 玩家明确选择「下次尝试」后，才记录一次 DeSmuME 性能核心试用。 */
export function rememberNdsPerformanceCore(
  game: File | string,
  storage: Storage | null = safeStorage(),
  now = Date.now(),
): boolean {
  const identity = ndsRomIdentity(game)
  if (!identity || !storage) return false
  try {
    const records = readRecords(storage, now).filter((record) => record.identity !== identity)
    records.push({ identity, at: now })
    storage.setItem(STORAGE_KEY, JSON.stringify(records.slice(-MAX_RECORDS)))
    return true
  } catch {
    // 禁用站点存储时不宣称已记住下一局核心。
    return false
  }
}

export function rememberedNdsPerformanceCore(
  game: File | string,
  storage: Storage | null = safeStorage(),
  now = Date.now(),
): string | null {
  const identity = ndsRomIdentity(game)
  return identity && readRecords(storage, now).some((record) => record.identity === identity)
    ? NDS_ADAPTIVE_PERFORMANCE_CORE
    : null
}

/** 只在性能核心成功出首帧后清掉一次性偏好，启动失败时保留以便下次继续尝试。 */
export function clearRememberedNdsPerformanceCore(
  game: File | string,
  storage: Storage | null = safeStorage(),
  now = Date.now(),
): void {
  const identity = ndsRomIdentity(game)
  if (!identity || !storage) return
  try {
    const records = readRecords(storage, now).filter((record) => record.identity !== identity)
    if (records.length) storage.setItem(STORAGE_KEY, JSON.stringify(records))
    else storage.removeItem(STORAGE_KEY)
  } catch {
    // 存储不可用不影响当前已启动的游戏。
  }
}
