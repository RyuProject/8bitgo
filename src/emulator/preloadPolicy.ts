export interface NetworkHint {
  saveData?: boolean
  effectiveType?: string
  downlink?: number
  rtt?: number
}

/**
 * 播放器本体有数百 KB，只适合在网络明显宽裕时投机预拉。
 *
 * 年龄检查与播放器预拉会在详情页水合后同时开始；弱网下前者只要几十字节，却可能被后者占着连接
 * 一直显示“正在确认”。没有 Network Information API 时维持旧行为，避免 Safari 全部失去预热。
 */
export function allowsSpeculativePlayerPreload(connection?: NetworkHint): boolean {
  if (!connection) return true
  if (connection.saveData) return false
  if (connection.effectiveType && connection.effectiveType !== '4g') return false
  if (Number.isFinite(connection.downlink) && Number(connection.downlink) > 0 && Number(connection.downlink) < 3) return false
  if (Number.isFinite(connection.rtt) && Number(connection.rtt) > 300) return false
  return true
}
