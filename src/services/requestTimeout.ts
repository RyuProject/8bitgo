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
