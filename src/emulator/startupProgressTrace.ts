import type { LoadProgress } from './types'

/**
 * 启动诊断包里的「下载走到哪了」。
 *
 * 2026-11-10 阿联酋《心灵之金》慢启动诊断包：时间线只有 start_click → slow_start，网络表只有一条 7 秒的
 * 第 0 片（8MB），后面的分片还在下载、没进 Resource Timing，于是看不出这局是「42MB ROM 跑在 6Mbps 上，
 * 物理上就要 50 秒」还是「下载早完了、核心卡住」。这里记下最后一次进度和吞吐，交给两处：
 * - slow_start 的原因原文带上阶段（仍在下载 / 下载完成后启动中），后台按原文归组时两类自然分开；
 * - 诊断包末尾的 snapshot 行带上字节数、总量、平均速率。
 */
export interface StartupProgressTrace {
  accept(progress: LoadProgress): void
  /** slow_start 原因原文后缀；没有进度时返回空串 */
  phaseNote(): string
  /** 诊断包 snapshot 行 */
  snapshot(): string | null
}

const mb = (n: number) => `${(n / 1048576).toFixed(1)}MB`

export function createStartupProgressTrace(startedAt: number, now: () => number = Date.now): StartupProgressTrace {
  let phase: LoadProgress['phase'] | null = null
  let loaded = 0
  let total = 0
  let fromCache = false
  let streaming = false
  let romStartedAt = 0
  let romBytesAtStart = 0
  let romDoneAt = 0
  let lastAt = 0

  const romDone = () => phase === 'starting' || (!streaming && total > 0 && loaded >= total)
  const rate = () => {
    const end = romDoneAt || lastAt
    const seconds = (end - romStartedAt) / 1000
    const bytes = loaded - romBytesAtStart
    return romStartedAt && seconds > 0.5 && bytes > 0 ? (bytes * 8) / seconds / 1e6 : 0
  }

  return {
    accept(progress) {
      const at = now()
      lastAt = at
      phase = progress.phase
      if (progress.phase === 'rom') {
        const nextLoaded = Number(progress.loaded) || 0
        if (!romStartedAt) {
          romStartedAt = at
          romBytesAtStart = nextLoaded
        }
        if (nextLoaded >= loaded) loaded = nextLoaded
        if (Number(progress.total) > 0) total = Number(progress.total)
        if (progress.cached) fromCache = true
        if (progress.streaming) streaming = true
      }
      if (!romDoneAt && romStartedAt && romDone()) romDoneAt = at
    },
    phaseNote() {
      if (!phase) return '（还没有任何加载进度）'
      if (phase === 'rom' && streaming) return `（流式读盘中：已读 ${mb(loaded)}）`
      if (phase === 'rom' && !romDone()) {
        const size = total ? `${mb(loaded)}/${mb(total)}` : mb(loaded)
        const speed = rate()
        return `（仍在下载 ROM：${size}${speed ? `，平均 ${speed.toFixed(1)}Mbps` : ''}）`
      }
      if (phase === 'engine' || phase === 'assets') return `（仍在加载${phase === 'engine' ? '引擎' : '资源'}）`
      return `（下载已完成，正在启动${romDoneAt ? `，下载完已 ${((now() - romDoneAt) / 1000).toFixed(1)} 秒` : ''}）`
    },
    snapshot() {
      if (!phase) return null
      const speed = rate()
      const parts = [
        `加载进度：阶段 ${phase}`,
        romStartedAt ? `ROM ${total ? `${mb(loaded)}/${mb(total)}` : mb(loaded)}${fromCache ? '（缓存）' : ''}${streaming ? '（流式）' : ''}` : '',
        romStartedAt ? `ROM 起于 ${((romStartedAt - startedAt) / 1000).toFixed(1)}s` : '',
        romDoneAt ? `ROM 完成于 ${((romDoneAt - startedAt) / 1000).toFixed(1)}s` : '',
        speed ? `平均 ${speed.toFixed(1)}Mbps` : '',
        `最后进度 ${((lastAt - startedAt) / 1000).toFixed(1)}s`,
      ]
      return parts.filter(Boolean).join('，')
    },
  }
}
