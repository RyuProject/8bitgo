/**
 * MAME CHD 的本地续传键与有限热区预读。
 *
 * mame-current 现阶段仍必须把整份 CHD 写进 MEMFS 才能启动；这里不把它包装成伪流式。
 * 预读仅把桌面端“准备开始”的空档换成最先会读取的 CHD 头 / map 所在分片，正式下载会从
 * 同一内容寻址键接续，浏览器不支持 OPFS 时自动改由 IndexedDB 保存这些片。
 */
import { readMameChdHeader } from '@/lib/mameArcadeMedia'
import { CHUNK_BYTES, prewarmBlobChunks } from './loadProgress'
import { mameChdResumeStore } from './downloadResume'
import { romCacheGetBlob } from './romCache'
import type { MameArcadeDiskSource } from './types'

/** 目前 EmulatorJS 会完整下载；这条上限同时防止热区预读接受异常元数据。 */
export const MAME_CHD_MAX_BYTES = 1024 * 1024 * 1024
/** 悬停最多预读 16 MiB，不让一次犹豫的鼠标移动消耗整张盘的流量。 */
export const MAME_CHD_HOT_BYTES = 2 * CHUNK_BYTES

export function mameChdCacheKey(disk: Pick<MameArcadeDiskSource, 'chdSha1' | 'dataSha1' | 'storedBytes'>): string {
  return `mame-chd:${disk.chdSha1}:${disk.dataSha1}:${disk.storedBytes}`
}

function usable(disk: MameArcadeDiskSource): boolean {
  return Boolean(disk.url) && Number.isSafeInteger(disk.storedBytes) &&
    disk.storedBytes >= 124 && disk.storedBytes <= MAME_CHD_MAX_BYTES &&
    /^[a-f\d]{40}$/i.test(disk.chdSha1) && /^[a-f\d]{40}$/i.test(disk.dataSha1) &&
    Number.isSafeInteger(disk.logicalBytes) && disk.logicalBytes > 0
}

/**
 * 只预读一个 CHD 的连续开头。首个 CHD map 紧接 v5 固定头，MAME 挂盘时首先需要这里；
 * 后面无论如何都由完整下载负责，不能猜“某段游戏关卡的数据”并浪费用户流量。
 */
export async function prewarmMameChd(disk: MameArcadeDiskSource, budgetBytes = MAME_CHD_HOT_BYTES): Promise<void> {
  if (!usable(disk) || !Number.isFinite(budgetBytes) || budgetBytes < CHUNK_BYTES) return
  // 完整副本已在 ROM 缓存时，悬停不应再碰网络；点击后的完整性核验仍由适配器负责，
  // 这里不为了预热多读一遍 160MB 字节。
  const cacheKey = mameChdCacheKey(disk)
  const cached = await romCacheGetBlob(cacheKey).catch(() => null)
  if (cached?.size === disk.storedBytes) return
  const chunks = Math.min(Math.ceil(budgetBytes / CHUNK_BYTES), Math.ceil(disk.storedBytes / CHUNK_BYTES))
  await prewarmBlobChunks(disk.url, {
    resumeKey: cacheKey,
    expectedBytes: disk.storedBytes,
    chunks,
    resumeStore: mameChdResumeStore,
    checkPart: async (part, index) => {
      // 不完整 / 错对象的第一片绝不能进入持久化续传池；以后正式下载读到它会出现
      // “总长度正确但 MAME 静默回菜单”的假象。完整 SHA-1 仍由 MAME 真正读盘时复核。
      if (index !== 0) return
      const header = readMameChdHeader(await part.slice(0, 124).arrayBuffer())
      if (header.chdSha1 !== disk.chdSha1 || header.dataSha1 !== disk.dataSha1 || header.logicalBytes !== disk.logicalBytes) {
        throw new Error('CHD 热区文件头与已验证媒体不一致')
      }
    },
  })
}

/** 把有限预算按 CHD 顺序切分，多盘游戏也不会因悬停偷下超过 16 MiB。 */
export function prewarmMameChdMedia(disks: readonly MameArcadeDiskSource[]): void {
  const candidates = disks.filter(usable)
  let slots = Math.floor(MAME_CHD_HOT_BYTES / CHUNK_BYTES)
  for (let index = 0; index < candidates.length && slots > 0; index += 1) {
    const disk = candidates[index]
    // 至少给后面的盘留一片：两张盘各有头比第一张盘独占 16MiB 更容易减少开局等待。
    const reserve = Math.min(slots - 1, candidates.length - index - 1)
    const chunks = Math.min(Math.ceil(disk.storedBytes / CHUNK_BYTES), Math.max(1, slots - reserve))
    slots -= chunks
    const budget = chunks * CHUNK_BYTES
    void prewarmMameChd(disk, budget).catch(() => {
      // 预热失败只能回到正常点击下载，不能给玩家显示一条与开局无关的错误。
    })
  }
}
