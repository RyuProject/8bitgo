/**
 * 把预热请求（httpWarm.ts）接到线路监视器（runtimeEdgeRoute.ts）上：加速入口失速 / 极慢时
 * 判坏、持久化、中止还挂在坏线上的预热，并把没下完的那几份改从同源重新预热。
 *
 * 只看预热这一路：运行时正式加载（<script>、Worker、wasm 编译）大多命中预热写进的 HTTP 缓存，
 * 而且没有字节级进度可看；预热慢，正式请求只会更慢。
 */
import { cancelHttpWarms, subscribeHttpWarmEvents, warmHttpCache } from './httpWarm'
import { createEdgeRouteMonitor, type RuntimeEdgeKind } from './runtimeEdgeRoute'
import { markRuntimeEdgeBad } from './paths'
import { diagLog } from '@/services/startupDiagnostics'

const CHECK_INTERVAL_MS = 2_000
const watching = new Set<RuntimeEdgeKind>()

export interface RuntimeEdgeWatchTarget {
  kind: RuntimeEdgeKind
  /** 这种运行时在加速入口上的目录（paths.ts 的 jsdosEdgePrefix 等）；空串 = 不走加速入口 */
  edgePrefix: string
  /** 同源目录，判坏后据此改写 URL */
  originPath: string
  /** 这一页现在实际用的目录；已经不是加速入口（判坏过 / 修补要求同源）就不用盯 */
  currentBase: string
}

/** 每页每种运行时装一次；返回是否真的装上了 */
export function watchRuntimeEdge(target: RuntimeEdgeWatchTarget): boolean {
  const { kind, edgePrefix, originPath, currentBase } = target
  if (typeof window === 'undefined' || !edgePrefix || currentBase !== edgePrefix || watching.has(kind)) return false
  watching.add(kind)

  let timer = 0
  const stopTimer = () => {
    if (timer) window.clearInterval(timer)
    timer = 0
  }
  let unsubscribe: () => void = () => {}
  const monitor = createEdgeRouteMonitor((verdict, detail) => {
    const pending = monitor.openUrls()
    console.warn(`[runtime-edge] ${kind} 加速入口${verdict === 'stalled' ? '失速' : '过慢'}（${detail}），剩余文件改走同源`)
    diagLog('route', 'warn', `${kind} 运行时加速入口${verdict === 'stalled' ? '失速' : '过慢'}，改走同源并记 2 小时：${detail}`)
    unsubscribe()
    stopTimer()
    markRuntimeEdgeBad(kind)
    // 让出带宽：坏线上还在下的预热全部中止，没下完的改从同源再预热一遍
    const cancelled = cancelHttpWarms((url) => url.startsWith(edgePrefix))
    for (const url of new Set([...pending, ...cancelled])) warmHttpCache(`${originPath}${url.slice(edgePrefix.length)}`)
  })
  unsubscribe = subscribeHttpWarmEvents((event) => {
    if (!event.url.startsWith(edgePrefix)) return
    if (event.type === 'start') {
      monitor.start(event.url)
      if (!timer) {
        timer = window.setInterval(() => {
          monitor.check(typeof document === 'undefined' || document.visibilityState !== 'hidden')
          if (!monitor.openUrls().length) stopTimer()
        }, CHECK_INTERVAL_MS)
      }
    } else if (event.type === 'bytes') {
      monitor.bytes(event.url, event.bytes)
    } else {
      // 普通的失败（HTTP 错误、网络错误）不算线路硬证据：只认失速和吞吐
      monitor.end(event.url, event.outcome === 'stalled' ? 'stalled' : event.outcome === 'done' ? 'done' : 'failed')
    }
  })
  return true
}
