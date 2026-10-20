import { romCacheKey } from './romCache'
import { EJS_RUNTIME_GENERATION, NDS_COMPAT_CORE } from './paths'

// 只靠引擎资源代次不够：单独重编核心却忘记换代时，会把旧核心的失败误套到新二进制。
// 测试会把这段前缀与实际核心构建报告核对，换核心不更新这里就不能通过回归。
export const NDS_MODERN_CORE_BUILD = 'b86fb4f324f9dba8'
const STORAGE_KEY = `8bitgo:nds-core-failures:${EJS_RUNTIME_GENERATION}:${NDS_MODERN_CORE_BUILD}`
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000
const MAX_RECORDS = 32

type FailureRecord = { identity: string; at: number }

/** 没有内容版本的远端地址可能原地换包，不能把上一次的核心失败套到新 ROM。 */
export function ndsRomIdentity(game: File | string): string | null {
  if (typeof game === 'string') {
    const key = romCacheKey(game)
    return key ? `remote:${key}` : null
  }
  return game.size > 0 ? `local:${game.name}:${game.size}:${game.lastModified}` : null
}

function safeStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

function readRecords(storage: Storage | null, now: number): FailureRecord[] {
  if (!storage) return []
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is FailureRecord =>
      Boolean(value) && typeof value.identity === 'string' &&
      typeof value.at === 'number' && value.at <= now && now - value.at < RETAIN_MS)
  } catch { return [] }
}

/** 只记“新版核心确实发生 WASM 陷阱”的 ROM；新核心换代后键会自动失效。 */
export function rememberNdsCoreFailure(game: File | string, storage: Storage | null = safeStorage(), now = Date.now()): void {
  const identity = ndsRomIdentity(game)
  if (!identity || !storage) return
  try {
    const records = readRecords(storage, now).filter((record) => record.identity !== identity)
    records.push({ identity, at: now })
    storage.setItem(STORAGE_KEY, JSON.stringify(records.slice(-MAX_RECORDS)))
  } catch {
    // 无痕模式、配额满或禁用站点数据时，本次启动仍走原有的即时回退。
  }
}

export function rememberedNdsCore(game: File | string, storage: Storage | null = safeStorage(), now = Date.now()): string | null {
  const identity = ndsRomIdentity(game)
  return identity && readRecords(storage, now).some((record) => record.identity === identity) ? NDS_COMPAT_CORE : null
}
