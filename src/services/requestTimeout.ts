/**
 * 为一次 API 操作提供有界的 AbortSignal，并在操作结束时清理计时器与父信号监听。
 *
 * 不用 AbortSignal.timeout / any：本站还支持较旧的浏览器，且两个 API 都不是全覆盖。
 */
export function createRequestTimeout(timeoutMs: number, parent?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  let disposed = false
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
  const abortFromParent = () => controller.abort()

  if (parent?.aborted) controller.abort()
  else parent?.addEventListener('abort', abortFromParent)

  return {
    signal: controller.signal,
    dispose() {
      if (disposed) return
      disposed = true
      clearTimeout(timeout)
      parent?.removeEventListener('abort', abortFromParent)
    },
  }
}

/** 超时与调用方主动取消分开报告，页面可以给玩家明确的重试提示。 */
export class RequestTimeoutError extends Error {
  constructor() {
    super('Request timed out')
    this.name = 'RequestTimeoutError'
  }
}

/**
 * 给不应无限等待的请求加硬时限。只取消信号有一个边界：某些 fetch polyfill / 测试替身
 * 不会响应 AbortSignal，调用方仍会一直等；竞速拒绝能保证流程按时结束，底层请求也会收到 abort。
 */
export async function withRequestTimeout<T>(
  timeoutMs: number,
  parent: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parent?.aborted) {
    const error = new Error('The operation was aborted')
    error.name = 'AbortError'
    throw error
  }
  const request = createRequestTimeout(timeoutMs, parent)
  let onTimeout: (() => void) | undefined
  const timedOut = new Promise<never>((_, reject) => {
    onTimeout = () => {
      if (!parent?.aborted) reject(new RequestTimeoutError())
    }
    request.signal.addEventListener('abort', onTimeout, { once: true })
  })
  let removeParentAbort: (() => void) | undefined
  const callerAborted = new Promise<never>((_, reject) => {
    const onAbort = () => {
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      reject(error)
    }
    if (parent?.aborted) onAbort()
    else if (parent) {
      parent.addEventListener('abort', onAbort, { once: true })
      removeParentAbort = () => parent.removeEventListener('abort', onAbort)
    }
  })
  try {
    return await Promise.race([operation(request.signal), timedOut, callerAborted])
  } finally {
    if (onTimeout) request.signal.removeEventListener('abort', onTimeout)
    removeParentAbort?.()
    request.dispose()
  }
}
