/** WebRTC 统计的兼容读取：不同浏览器对同一字段的命名并不完全一致。 */
export interface LiveRtcStat extends Record<string, unknown> {
  id?: string
  type?: string
  kind?: string
  mediaType?: string
}

/** Chrome 仍主要给 kind；Firefox 等实现可能只给 mediaType。 */
export function isVideoRtpStat(value: unknown, direction: 'inbound-rtp' | 'outbound-rtp'): value is LiveRtcStat {
  if (!value || typeof value !== 'object') return false
  const stat = value as LiveRtcStat
  return stat.type === direction && (stat.kind === 'video' || stat.mediaType === 'video')
}

/** Safari / Firefox 等实现可能只提供 mediaType，因此音轨也按双字段兼容读取。 */
export function isAudioRtpStat(value: unknown, direction: 'inbound-rtp' | 'outbound-rtp'): value is LiveRtcStat {
  if (!value || typeof value !== 'object') return false
  const stat = value as LiveRtcStat
  return stat.type === direction && (stat.kind === 'audio' || stat.mediaType === 'audio')
}

/**
 * 汇总入站音视频 RTP 的累计字节数。
 * 静止画面可以合法地没有视频包，但带音轨的 SRS 拉流仍应持续收到 Opus 包；
 * 因此断流检测必须看音视频总字节，同时确认浏览器确实报告了音频 RTP 统计。
 */
export function inboundRtpByteCounts(stats: readonly unknown[]): { totalBytes: number; videoBytes: number; hasAudioStats: boolean } {
  let totalBytes = 0
  let videoBytes = 0
  let hasAudioStats = false
  for (const value of stats) {
    if (isAudioRtpStat(value, 'inbound-rtp')) hasAudioStats = true
    else if (!isVideoRtpStat(value, 'inbound-rtp')) continue

    const bytesReceived = Number((value as LiveRtcStat).bytesReceived)
    if (!Number.isFinite(bytesReceived) || bytesReceived <= 0) continue
    totalBytes += bytesReceived
    if (isVideoRtpStat(value, 'inbound-rtp')) videoBytes += bytesReceived
  }
  return { totalBytes, videoBytes, hasAudioStats }
}

/**
 * 读当前真正选中的 ICE 路径 RTT。
 *
 * 一条 PeerConnection 可能同时留着多条 succeeded candidate pair（旧路径、备用路径、TURN 路径）。
 * 按 report 遍历顺序拿“最后一个 succeeded”会随机切 RTT，误触发观众画质降档；优先用
 * transport.selectedCandidatePairId，老实现才回退到 nominated / succeeded。
 */
export function selectedCandidateRttMs(stats: readonly unknown[]): number {
  const values = stats.filter((value): value is LiveRtcStat => Boolean(value) && typeof value === 'object')
  const byId = new Map(values.filter((stat) => typeof stat.id === 'string').map((stat) => [stat.id as string, stat]))
  const transports = values.filter((stat) => stat.type === 'transport')
  for (const transport of transports) {
    const id = transport.selectedCandidatePairId
    const pair = typeof id === 'string' ? byId.get(id) : undefined
    const rtt = Number(pair?.currentRoundTripTime)
    if (Number.isFinite(rtt) && rtt >= 0) return Math.round(rtt * 1000)
  }

  const pairs = values.filter((stat) => stat.type === 'candidate-pair' && stat.state === 'succeeded')
  const selected = pairs.find((stat) => stat.selected === true) ?? pairs.find((stat) => stat.nominated === true) ?? pairs[0]
  const rtt = Number(selected?.currentRoundTripTime)
  return Number.isFinite(rtt) && rtt >= 0 ? Math.round(rtt * 1000) : 0
}
