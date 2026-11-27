/**
 * 有界并行上传队列。
 *
 * Flash 多文件包里通常有很多很小的素材；逐个 PUT 会让每个文件都单独等待网络往返。
 * 并行度由调用方根据设备和网络能力决定，这里只负责限制活动任务数、合并字节进度，
 * 并在任一任务失败后停止派发新文件。已开始的任务会自然收尾，避免把已提交的 R2 写入
 * 误当成取消成功；调用方可以据此准确提示哪些对象已确认上传。
 */
export interface BoundedUploadItem {
  path: string
  size: number
}

export interface BoundedUploadProgress {
  done: number
  total: number
  active: number
  path: string
  pct: number
}

export class BoundedUploadFailure extends Error {
  readonly itemIndex: number
  readonly reason: unknown
  readonly completedIndices: number[]

  constructor(itemIndex: number, reason: unknown, completedIndices: number[]) {
    super(`第 ${itemIndex + 1} 个文件上传失败`)
    this.name = 'BoundedUploadFailure'
    this.itemIndex = itemIndex
    this.reason = reason
    this.completedIndices = completedIndices
  }
}

/** 解压缓冲的额外内存预算；大文件允许单独上传，不会因此拒绝管理员的文件。 */
export function uploadWorkingMemoryBudgetBytes(deviceMemoryGb?: number): number {
  const memory = Number(deviceMemoryGb)
  return Number.isFinite(memory) && memory > 0
    ? memory <= 2 ? 32 * 1024 * 1024 : memory <= 4 ? 64 * 1024 * 1024 : 128 * 1024 * 1024
    : 64 * 1024 * 1024
}

/** 有界并行处理文件；失败后不再从队列取新项，但等待当前已开始的请求结束。 */
export async function runBoundedUploadQueue<T extends BoundedUploadItem>(
  items: readonly T[],
  requestedConcurrency: number,
  upload: (item: T, index: number, reportPercent: (percent: number) => void) => Promise<void>,
  onProgress?: (progress: BoundedUploadProgress) => void,
  workingMemoryBudgetBytes = Infinity,
): Promise<void> {
  if (!items.length) return

  const concurrency = Math.max(1, Math.min(
    items.length,
    Number.isFinite(requestedConcurrency) ? Math.floor(requestedConcurrency) : 1,
  ))
  const weights = items.map(({ size }) => Number.isFinite(size) ? Math.max(0, size) : 0)
  // 解压结果和上传 Blob 可能短暂并存；为每个已知大小的资源预留两份内存。
  const workingWeights = weights.map((size) => Math.max(1, size * 2))
  const totalBytes = weights.reduce((sum, size) => sum + size, 0)
  const totalWeight = totalBytes || items.length
  const loaded = new Float64Array(items.length)
  // 进度事件只改当前文件的权重差值，避免每个 XHR 事件都遍历整包文件。
  let loadedWeight = 0
  const completed = new Set<number>()
  const firstFailure: { value: { index: number; reason: unknown } | null } = { value: null }
  const pending = items.map((_, index) => index)
  let active = 0
  let activeMemory = 0
  let latestPath = ''

  const emit = (index: number) => {
    latestPath = items[index]?.path ?? latestPath
    onProgress?.({
      done: completed.size,
      total: items.length,
      active,
      path: latestPath,
      pct: Math.min(100, Math.round((loadedWeight / totalWeight) * 100)),
    })
  }

  const budget = Number.isFinite(workingMemoryBudgetBytes) && workingMemoryBudgetBytes > 0
    ? workingMemoryBudgetBytes
    : Infinity

  await new Promise<void>((resolve, reject) => {
    const finishIfSettled = () => {
      if (active > 0 || (!firstFailure.value && pending.length > 0)) return
      if (firstFailure.value) {
        reject(new BoundedUploadFailure(
          firstFailure.value.index,
          firstFailure.value.reason,
          [...completed].sort((a, b) => a - b),
        ))
      } else resolve()
    }

    const pump = () => {
      while (!firstFailure.value && active < concurrency && pending.length) {
        // 大到超过预算的资源可单独跑；其它小资源仍可利用剩余预算并行，避免一个大 SWF
        // 把整包里的数百个小配置文件也拖成串行。
        const firstIsOversizedAndAlone = active === 0 && workingWeights[pending[0]] > budget
        const fittingPosition = firstIsOversizedAndAlone
          ? 0
          : pending.findIndex((index) => activeMemory + workingWeights[index] <= budget)
        const position = fittingPosition >= 0 ? fittingPosition : -1
        if (position < 0) break

        const index = pending.splice(position, 1)[0]
        active++
        activeMemory += workingWeights[index]
        emit(index)
        void Promise.resolve()
        .then(() => upload(items[index], index, (percent) => {
          const safePercent = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0
          const weight = totalBytes ? weights[index] : 1
          const nextLoaded = Math.max(loaded[index], totalBytes ? (weight * safePercent) / 100 : safePercent > 0 ? 1 : 0)
          loadedWeight += nextLoaded - loaded[index]
          loaded[index] = nextLoaded
          emit(index)
        }))
          .then(() => {
            const weight = totalBytes ? weights[index] : 1
            loadedWeight += weight - loaded[index]
            loaded[index] = weight
            completed.add(index)
          }, (reason) => {
            firstFailure.value ??= { index, reason }
          })
          .finally(() => {
            active--
            activeMemory = Math.max(0, activeMemory - workingWeights[index])
            emit(index)
            pump()
            finishIfSettled()
          })
      }
      finishIfSettled()
    }

    pump()
  })
}
