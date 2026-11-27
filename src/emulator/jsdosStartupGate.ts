/**
 * js-dos 入口脚本与 ROM / 系统镜像并行加载。资源已明确失败时，不应继续等入口脚本的网络超时；
 * 否则一份损坏的 ROM 也可能让玩家多等 25～60 秒才看到可恢复的错误。
 */
export function createJsdosResourceFailureGate() {
  let resolveFailure: ((result: { type: 'resource-failure'; error: unknown }) => void) | null = null
  let failed = false
  const resourceFailure = new Promise<{ type: 'resource-failure'; error: unknown }>((resolve) => {
    resolveFailure = resolve
  })

  return {
    fail(error: unknown): void {
      if (failed) return
      failed = true
      resolveFailure?.({ type: 'resource-failure', error })
    },
    race<T>(engine: Promise<T>): Promise<T> {
      return Promise.race([
        engine.then((value) => ({ type: 'engine-ready' as const, value })),
        resourceFailure,
      ]).then((result) => {
        if (result.type === 'resource-failure') throw result.error
        return result.value
      })
    },
  }
}
