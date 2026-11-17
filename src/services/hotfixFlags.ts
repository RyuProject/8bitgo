/**
 * 这一页生效着的 AI 临时修补「开关」（shared/hotfix.js 的 resolveHotfixes 结果）。
 *
 * 单独一个零依赖的小模块：EmulatorJS 适配器、运行时路径（paths.ts）、ROM 线路（romRoute.ts）、
 * 诊断包（startupDiagnostics.ts）都要读它，而拉取修补的 hotfixes.ts 依赖 api.ts —— 让这些底层模块
 * 去 import api.ts 会把半个应用拖进它们的依赖图，测试也跑不起来。
 *
 * 写入方只有 hotfixes.ts（详情页拿到修补后写，离开页面时清空）。
 */
export interface HotfixFlags {
  /** 命中的修补 id，诊断包里带上，服务端据此统计效果、够多失败就自动撤销 */
  ids: string[]
  /** 模拟器运行时不走大陆加速入口（cn.8bitgo.com/_cn） */
  runtimeOrigin: boolean
  /** ROM 固定走某条线路 */
  romHost?: 'primary' | 'mirror'
  /** 本局关掉 EmulatorJS 的 IndexedDB 核心缓存 */
  disableEngineCache: boolean
  /** ROM 放 JS 内存，不经 Blob 存储 */
  memoryRom: boolean
}

const EMPTY: HotfixFlags = Object.freeze({ ids: [], runtimeOrigin: false, disableEngineCache: false, memoryRom: false }) as HotfixFlags

let flags: HotfixFlags = EMPTY
let settle: Promise<unknown> | null = null

export function hotfixFlags(): HotfixFlags {
  return flags
}

export function setHotfixFlags(next: HotfixFlags | null): void {
  flags = next ?? EMPTY
}

/** 修补还在路上时，hotfixesSettled() 可以短暂等它（ROM 线路选择就是这样） */
export function setHotfixSettle(promise: Promise<unknown> | null): void {
  settle = promise
}

/**
 * 等修补拉回来，最多 maxMs。没有在拉（本地 ROM 页、嵌入页）立即返回。
 * 只给本来就是异步、而且晚一点也不碍事的决定用：ROM 线路测速本身就要几百毫秒。
 */
export async function hotfixesSettled(maxMs = 1200): Promise<void> {
  if (!settle) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    settle.catch(() => {}),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, maxMs) }),
  ])
  clearTimeout(timer)
}

export function activeHotfixIds(): string[] {
  return flags.ids
}
