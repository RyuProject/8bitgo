/**
 * 浏览器后台会把 setTimeout 节流到数十秒一次，重负载时主线程也可能暂时停住。
 * 客体启动本身同样靠这些定时器推进；若超时按 Date.now() 计算，恢复前台时
 * 超时回调可能先于尚未执行的启动步骤到达，把仍可成功的会话误判成失败。
 * 每次回调只累计已排定的一小段前台时间，和启动链的计时口径保持一致。
 */
export function startActiveTimeout(
  budgetMs: number,
  active: () => boolean,
  onTimeout: () => void,
  tickMs = 1_000,
): () => void {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0 || !Number.isFinite(tickMs) || tickMs <= 0) {
    throw new Error('前台超时预算必须大于零')
  }
  let remaining = budgetMs
  let timer = 0
  let stopped = false
  const tick = () => {
    if (stopped) return
    if (active()) remaining -= Math.min(tickMs, remaining)
    if (remaining <= 0) {
      stopped = true
      onTimeout()
      return
    }
    timer = window.setTimeout(tick, Math.min(tickMs, remaining))
  }
  timer = window.setTimeout(tick, Math.min(tickMs, remaining))
  return () => {
    stopped = true
    window.clearTimeout(timer)
  }
}
