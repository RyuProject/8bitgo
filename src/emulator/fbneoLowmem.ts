/**
 * FBNeo 分配不出 WASM 内存时改用低内存核心（`fbneo-lowmem`）。
 *
 * 2026-11-11 ～ 11-13 后台：大陆 Chrome 109 / Windows（8GB、4 核）与 Chrome 114 / Android 12 平板，
 * 《拳皇 97》《合金弹头 2》《1941》核心编译完在 instantiate 时报
 * `Out of memory: Cannot allocate Wasm memory for new instance`。线上默认 FBNeo 起步就要一整块
 * 128 MiB 连续地址；32 位浏览器、或地址空间已被别的东西占碎的渲染进程给不出来。旧逻辑对同一个
 * 核心原地重试两遍、再换线路 / 换 ROM，三轮都是同一个错误（样本 1 十秒内撞了三次）。
 *
 * `fbneo-lowmem`（scripts/build-fbneo-lowmem-core.mjs）起步只要 80 MiB、按需增长到 2 GiB，
 * 能跑的游戏和默认核心一样，只是不再一开局就索要一整块 128 MiB。所以：
 *   - 默认 FBNeo 一报内存不足，本局立刻换它重开，不再原地重试同一个核心；
 *   - 在这个浏览器里记一笔（内存不够是设备的事，和哪款游戏无关），之后的街机开局直接用它；
 *   - 它也起不来时照旧报内存不足，不再来回切。
 *
 * 低内存版是更新一批的 FBNeo 源码现编的，和默认核心（npm 2025-06 发布版）的即时存档不能假定
 * 互通：即时存档单独存一档（`:fbneo-lowmem` 后缀，同 NDS 兼容核心的做法）。
 *
 * 只给能原地重开的本机会话：联机双方必须是同一个核心，否则帧数据对不上。
 */
import type { PlatformId } from '@/types'

export const FBNEO_LOWMEM_CORE = 'fbneo-lowmem'
const SAVE_SUFFIX = ':fbneo-lowmem'
/** 换低内存核心的构建时同步改这里（test:fbneo-lowmem 会对构建报告核对），旧记录随之作废。 */
export const FBNEO_LOWMEM_BUILD = '0a473a39'
const STORAGE_KEY = `8bitgo:fbneo-oom:${FBNEO_LOWMEM_BUILD}`
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000

/** 这次内存不足该不该换低内存核心；返回下一局的核心，null = 不换。 */
export function fbneoMemoryFallbackCore(
  platform: PlatformId,
  failedCore: string,
  restartable: boolean,
): string | null {
  return platform === 'arcade' && failedCore === 'fbneo' && restartable ? FBNEO_LOWMEM_CORE : null
}

export function fbneoLowmemSaveSlug(slug: string): string {
  return slug.endsWith(SAVE_SUFFIX) ? slug : `${slug}${SAVE_SUFFIX}`
}

/** 个人页从低内存核心的存档档位回到原游戏。 */
export function parseFbneoLowmemSaveSlug(value: string): string {
  return value.endsWith(SAVE_SUFFIX) && !value.startsWith('local:') ? value.slice(0, -SAVE_SUFFIX.length) : value
}

function safeStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

export function rememberFbneoMemoryFailure(storage: Storage | null = safeStorage(), now = Date.now()): void {
  try { storage?.setItem(STORAGE_KEY, String(now)) } catch { /* 无痕 / 配额满：本局照样即时切换 */ }
}

/** 这个浏览器近期默认 FBNeo 分配不出内存过：街机开局直接用低内存核心。 */
export function prefersFbneoLowmem(storage: Storage | null = safeStorage(), now = Date.now()): boolean {
  try {
    const at = Number(storage?.getItem(STORAGE_KEY))
    return Number.isFinite(at) && at > 0 && at <= now && now - at < RETAIN_MS
  } catch {
    return false
  }
}
