/**
 * PS1 分配不出 WASM 内存时改用低起步内存的 PCSX（`pcsx_rearmed-lowmem`）。
 *
 * 2026-11-16 大陆 Chrome 132 / Windows 64 位、8GB 内存、8 核《生化危机 3：最终逃脱》（诊断包 #780 / #783）：
 * 3G 1.35Mbps 上先下了 15 分钟 358MB 的 8BG CHD，随后 pcsx_rearmed 在 instantiate 时报
 * `Out of memory: Cannot allocate Wasm memory for new instance`，原地重试一轮、玩家手动再开一局，
 * 4 次全是同一个错误。取证（scripts/build-pcsx-lowmem-core.mjs 的头注释）：EmulatorJS 发布的 pcsx_rearmed
 * 在 WASM 里写死起步 512 MiB，而核心静态区只有约 5.4MB；本地用合成光盘实测，低内存版开机后堆自然长到
 * 约 92MB、做一次即时存档后约 110MB。这台机器当时为什么连 512 MiB 都提交不出来（系统提交额度、
 * 渲染进程限额还是别的进程占用）诊断包里没有证据，不下结论；能确定的是那 512 MiB 不是核心的硬需求。
 *
 * 低内存版只改了 memory section 的起步页数，代码 / 胶水 / 即时存档格式与默认 PCSX 逐字节一致
 * （本地实测把默认核心存的即时存档读进低内存版，读后状态与原档只差 68 字节的 RetroArch 计时字段），
 * 所以和 fbneo-lowmem 不同：**不另开存档档位**；记忆卡（.srm）按核心库名 `PCSX-ReARMed` 落目录，也共用。
 *
 *   - 开局前预检（emulatorjs 适配器）分配不出默认核心那 512 MiB：下载 ROM 之前就换它重开；
 *   - 实例化真的报内存不足：本局立刻换它重开（ROM 已在缓存里，不再白等一轮原地重试）；
 *   - 在这个浏览器里记 30 天，之后 PS1 开局直接用它；
 *   - 它也起不来时照旧报内存不足，不再来回切。
 *
 * ⚠️ 只替换会落到 PCSX 的开局。CHD 头里压缩器全是 Beetle 认识的（服务端 ISO 转出的 cdzl 盘）会走 Beetle，
 * 它的即时存档和 PCSX 不通用，同一个档位混写会让两边都读不出（见 psxChd.ts 的 psxCoreForPreparedName）。
 * Beetle 没有低内存版（它的栈与静态区就占了约 497MB，只改起步页数行不通），那类游戏仍按内存不足报错。
 */
import type { PlatformId } from '@/types'

export const PSX_LOWMEM_CORE = 'pcsx_rearmed-lowmem'
/** 被它替换的默认 PS1 核心（引擎别名 `psx` 也落到它） */
export const PSX_DEFAULT_CORE = 'pcsx_rearmed'
/** 换低内存核心的派生时同步改这里（test:psx-lowmem 会对构建报告核对），旧记录随之作废。 */
export const PSX_LOWMEM_BUILD = '53db2c6b'
const STORAGE_KEY = `8bitgo:psx-oom:${PSX_LOWMEM_BUILD}`
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000

/**
 * 这次内存不足该不该换低内存核心；返回下一局的核心，null = 不换。
 * 只给能原地重开的本机会话：联机双方要同一份核心 URL / 设置，擅自换会让访客与房主不一致。
 */
export function psxMemoryFallbackCore(
  platform: PlatformId,
  failedCore: string,
  restartable: boolean,
): string | null {
  return platform === 'psx' && failedCore === PSX_DEFAULT_CORE && restartable ? PSX_LOWMEM_CORE : null
}

/** 开局时这一局的 PS1 核心要不要直接换成低内存版（只换默认 PCSX，后台显式选的 Beetle 不动）。 */
export function psxLowmemCoreFor(core: string | null | undefined, preferLowmem: boolean): string | null {
  return preferLowmem && core === PSX_DEFAULT_CORE ? PSX_LOWMEM_CORE : null
}

function safeStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

export function rememberPsxMemoryFailure(storage: Storage | null = safeStorage(), now = Date.now()): void {
  try { storage?.setItem(STORAGE_KEY, String(now)) } catch { /* 无痕 / 配额满：本局照样即时切换 */ }
}

/** 这个浏览器近期默认 PCSX 分配不出内存过：PS1 开局直接用低内存核心。 */
export function prefersPsxLowmem(storage: Storage | null = safeStorage(), now = Date.now()): boolean {
  try {
    const at = Number(storage?.getItem(STORAGE_KEY))
    return Number.isFinite(at) && at > 0 && at <= now && now - at < RETAIN_MS
  } catch {
    return false
  }
}
