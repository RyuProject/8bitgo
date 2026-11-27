/**
 * 把一个 Flash 多 SWF 包整包传到 R2 的同一个目录下。
 *
 * 单文件 ROM 是「一次 PUT 完事」，多 SWF 包得逐个文件 PUT ——
 * Worker 那边一个 key 一个对象，没有「上传整个目录」这种接口。所以这里做三件事：
 *   1. 传之前看目录里有没有旧文件，有就问一句（重传同一个包属于原地覆盖，很正常；
 *      但传成了另一个包就会两份混在一起，谁也跑不起来）
 *   2. 按设备和网络并发限额解压 + 上传，把整体进度按字节算出来给界面
 *   3. 传完清理「这次没传、上次留下的」孤儿文件 —— 版本换了、文件改名了都会留下这种
 *
 * 界面上的确认弹窗留在这里而不是组件里：和 uploadGuards.ts 一个路数，
 * 上传相关的守卫集中在一处，组件只管画。
 */
import { extractZipEntry } from '@/lib/unzip'
import type { SwfBundleFile } from '@/lib/swfBundle'
import { deleteRomObjectsExactly, listRomDir, uploadRom } from '@/services/roms'
import { human } from './uploadGuards'
import { flashCompatibilityIssue } from '@/emulator/flashCompatibility'
import { assertSwf } from '@/lib/romValidation'
import { trackUploadActivity } from '@/services/uploadActivity'
import { BoundedUploadFailure, runBoundedUploadQueue, uploadWorkingMemoryBudgetBytes } from './boundedUploadQueue'

export interface BundleUploadProgress {
  /** 已经传完的文件数 */
  done: number
  total: number
  /** 当前并行上传的文件数 */
  active: number
  /** 最近有进度的资源（相对包目录的路径） */
  path: string
  /** 整体百分比，按字节算 —— 按文件数算的话 10MB 的 war.swf 和 2KB 的配置文件一样重 */
  pct: number
}

export interface BundleUploadResult {
  /** 要绑到游戏上的主 SWF 的 key */
  mainKey: string
  keys: string[]
  bytes: number
  /** 顺手清掉的孤儿文件 */
  removed: string[]
  /** Worker / R2 未确认删除的旧对象数；上传成功不应被可选清理失败覆盖 */
  cleanupFailed: number
}

/** 传一个文件，失败重试一次 —— 几十个文件里偶发一个网络抖动就整包失败太脆了 */
async function putOnce(blob: Blob, key: string, onPct: (p: number) => void) {
  try {
    return await uploadRom(blob, key, onPct, { failureIsFatal: false })
  } catch (err) {
    // 口令 / 地址不对这类问题重试多少次都一样，直接抛
    if (err instanceof Error && /被拒绝|不可用|尚未配置/.test(err.message)) throw err
    return await uploadRom(blob, key, onPct, { failureIsFatal: false })
  }
}

/**
 * 整包上传。返回 null 表示管理员在确认弹窗里选了取消。
 *
 * @param zip   压缩包的完整内容（解压是逐个文件现解的，不会一次性把整包展开在内存里）
 * @param files 上传计划里的文件（只传 include 为 true 的）
 * @param main  主 SWF 的相对路径
 * @param dir   包目录的对象 key 前缀，如 roms/flash/jyqx3
 */
export async function uploadSwfBundle({
  zip,
  files,
  main,
  dir,
  onProgress,
}: {
  zip: ArrayBuffer
  files: SwfBundleFile[]
  main: string
  dir: string
  onProgress?: (p: BundleUploadProgress) => void
}): Promise<BundleUploadResult | null> {
  const picked = files.filter((f) => f.include)
  if (!picked.length) throw new Error('一个文件都没勾选')
  if (!main) throw new Error('还没选主 SWF')
  if (!picked.some((f) => f.path === main)) throw new Error(`主 SWF ${main} 没有被勾选上传`)

  /*
    整包也要在第一个 PUT 之前检查主 SWF。放进上传循环里才检查会留下“前几个素材已经上传、
    主文件被拦”的半成品目录；下一次排查时看见文件都在，反而更像 Ruffle 的问题。
  */
  const mainFile = picked.find((file) => file.path === main)!
  const mainData = await extractZipEntry(zip, mainFile.entry)
  const mainBuffer = new Uint8Array(mainData).buffer
  assertSwf(mainBuffer)
  const compatibilityIssue = await flashCompatibilityIssue(mainBuffer)
  if (compatibilityIssue) throw new Error(`${main}：${compatibilityIssue.message}；整包没有上传`)

  // 复用大文件分片上传的网络自适应规则：弱网 / 省流量 / 低内存设备自动收缩并发。
  // 整包没有单片测速样本，因此先按浏览器网络提示选择并发；策略模块加载失败时保守单路。
  // 提前与目录预检并行加载，若管理员取消确认也不会留下未处理的模块加载拒绝。
  const concurrencyTask = import('@/services/romMultipart')
    .then(({ adaptiveUploadConcurrency, browserUploadNetworkHints }) =>
      adaptiveUploadConcurrency(0, 0, browserUploadNetworkHints()))
    .catch(() => 1)

  const base = dir.replace(/\/+$/, '')
  const keyOf = (path: string) => `${base}/${path}`

  // 探测失败（Worker 不通）不该把上传堵死，和 uploadGuards 里一个态度
  const existing = await listRomDir(base).catch(() => [])
  if (existing.length) {
    const incoming = new Set(picked.map((f) => keyOf(f.path)))
    const stale = existing.filter((o) => !incoming.has(o.key))
    const ok = window.confirm(
      `${base}/\n\n这个目录里已经有 ${existing.length} 个文件（${human(existing.reduce((s, o) => s + o.size, 0))}）。\n` +
        `继续会用新包里的 ${picked.length} 个文件覆盖同名的那些` +
        (stale.length ? `，另外 ${stale.length} 个新包里没有的文件会在传完后询问是否删除` : '') +
        '。\n\n继续吗？',
    )
    if (!ok) return null
  }

  return trackUploadActivity(`Flash 整包发布：${base}`, async () => {
    const totalBytes = picked.reduce((s, f) => s + f.size, 0) || 1
    const preferred = await concurrencyTask
    const deviceMemoryGb = (globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined)?.deviceMemory
    const workingMemoryBudget = uploadWorkingMemoryBudgetBytes(deviceMemoryGb)
    try {
      await runBoundedUploadQueue(picked, preferred, async (f, _index, reportPercent) => {
        const key = keyOf(f.path)
        const data = await extractZipEntry(zip, f.entry)
        const blob = new Blob([data as BlobPart])
        await putOnce(blob, key, reportPercent)
      }, (progress) => onProgress?.(progress), workingMemoryBudget)
    } catch (error) {
      if (error instanceof BoundedUploadFailure) {
        const failed = picked[error.itemIndex]
        const reason = error.reason instanceof Error ? error.reason.message : String(error.reason)
        throw new Error(
          `第 ${error.itemIndex + 1}/${picked.length} 个文件 ${failed?.path ?? ''} 失败：${reason}` +
          `（已确认 ${error.completedIndices.length} 个文件成功；同时上传的其它对象可能已写入 R2，重新上传整包会覆盖同名文件）`,
        )
      }
      throw error
    }

    const keys = picked.map((f) => keyOf(f.path))
    onProgress?.({ done: picked.length, total: picked.length, active: 0, path: '', pct: 100 })

    // 清理孤儿：上一版包里有、这一版没有的文件。留着不影响加载，但会一直占空间，
    // 而且下次有人来看目录会以为它们还在被引用。
    const removed: string[] = []
    let cleanupFailed = 0
    const uploaded = new Set(keys)
    const stale = existing.filter((o) => !uploaded.has(o.key))
    if (stale.length) {
      const ok = window.confirm(
        `${base}/\n\n目录里还剩 ${stale.length} 个这次没传的旧文件：\n` +
          stale.slice(0, 8).map((o) => `  ${o.key.slice(base.length + 1)}`).join('\n') +
          (stale.length > 8 ? `\n  …还有 ${stale.length - 8} 个` : '') +
          '\n\n从 R2 删掉吗？（不确定就选取消，它们不影响游戏加载）',
      )
      if (ok) {
        try {
          // 已有清单来自上传前的目录核对；按这些精确 key 一次批量提交，避免几百次串行 Worker 往返。
          const deletion = await deleteRomObjectsExactly(stale.map((object) => object.key))
          removed.push(...deletion.removed)
          cleanupFailed = deletion.failed.length
        } catch {
          // 清理是可选收尾；不能把已经确认上传的游戏包误报成失败。
          cleanupFailed = stale.length
        }
      }
    }

    return { mainKey: keyOf(main), keys, bytes: totalBytes, removed, cleanupFailed }
  })
}
