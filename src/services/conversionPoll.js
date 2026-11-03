/**
 * 服务器转换是长任务，短暂的 502 / DNS 抖动只代表这次状态查询失败，不代表任务失败。
 * 只重试网关、限流和浏览器网络错误；权限、参数、任务不存在等 4xx 仍立即交给调用方。
 */
export function isTransientConversionPollError(error) {
  if (error?.name === 'AbortError') return false
  const status = Number(error?.status)
  if (Number.isInteger(status) && status > 0) {
    return status === 408 || status === 425 || status === 429 || status >= 500
  }
  // fetch 在 DNS / 断网 / 连接重置时抛 TypeError；其它普通 Error 多半是应用层错误。
  return error instanceof TypeError
}

function abortError() {
  return new DOMException('页面已离开，后台转换仍会继续', 'AbortError')
}

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 轮询转换任务。一次网关错误不应抹掉前端保存的任务 ID：任务在服务端独立运行，
 * 之后的查询必须继续，直到拿到完成状态或明确的任务失败状态。
 */
export async function waitForConversionJob(read, {
  signal,
  onUpdate,
  isCompleted,
  isFailed,
  failureMessage,
  pollIntervalMs = 1500,
  sleep = delay,
}) {
  let consecutiveFailures = 0
  for (;;) {
    if (signal?.aborted) throw abortError()

    let job
    try {
      job = await read()
    } catch (error) {
      if (!isTransientConversionPollError(error)) throw error
      consecutiveFailures += 1
      const backoff = Math.min(15_000, 1000 * 2 ** Math.min(consecutiveFailures - 1, 4))
      await sleep(backoff, signal)
      continue
    }

    consecutiveFailures = 0
    onUpdate?.(job)
    if (isCompleted(job)) return job
    if (isFailed(job)) throw new Error(failureMessage?.(job) || '服务器转换失败')
    await sleep(pollIntervalMs, signal)
  }
}
