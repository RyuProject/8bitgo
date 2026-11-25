/** 有界加载全局脚本；超时后清理失败标签，允许调用方安全换源再试。 */
export interface JsdosScriptLoaderOptions {
  timeoutMs?: number
  signal?: AbortSignal
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}

export function loadJsdosScript<T>(
  documentRef: Pick<Document, 'createElement' | 'head'>,
  url: string,
  getRuntime: () => T | undefined,
  options: JsdosScriptLoaderOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 20_000
  const setTimer = options.setTimer ?? globalThis.setTimeout.bind(globalThis)
  const clearTimer = options.clearTimer ?? globalThis.clearTimeout.bind(globalThis)
  return new Promise<T>((resolve, reject) => {
    const script = documentRef.createElement('script')
    script.async = true
    script.src = url
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const signal = options.signal
    const onAbort = () => {
      const reason = signal?.reason
      finish(reason instanceof Error ? reason : new Error(`js-dos script request aborted: ${url}`))
    }

    const finish = (error?: Error, runtime?: T) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimer(timer)
      signal?.removeEventListener('abort', onAbort)
      script.onload = null
      script.onerror = null
      if (error) {
        script.remove()
        reject(error)
      } else if (runtime !== undefined) {
        resolve(runtime)
      } else {
        script.remove()
        reject(new Error(`js-dos loaded without its runtime export: ${url}`))
      }
    }

    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    script.onload = () => {
      try {
        finish(undefined, getRuntime())
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    }
    script.onerror = () => finish(new Error(`js-dos script request failed: ${url}`))
    timer = setTimer(() => finish(new Error(`js-dos script timed out after ${timeoutMs}ms: ${url}`)), timeoutMs)
    try {
      documentRef.head.appendChild(script)
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
