/**
 * WHIP / WHEP 使用一次 SDP 请求完成协商，SRS 不会收到浏览器后续的 trickle candidate。
 * 所以不能在拿到第一条 host candidate 时就发 offer；但也不能为了等一台不可达的
 * STUN 服务器，把已经有公网映射地址的直播卡死到总超时。拿到 srflx / relay 后稍等
 * 一小段时间收齐同一轮候选，再把当前 SDP 交给 SRS；ICE 在本地仍会继续收集。
 */
const USEFUL_CANDIDATE_SETTLE_MS = 250

function candidateTypes(sdp: string): Set<string> {
  const types = new Set<string>()
  for (const match of sdp.matchAll(/\btyp\s+(host|srflx|prflx|relay)\b/g)) types.add(match[1])
  return types
}

/** WHIP/WHEP 单次 SDP 协商：有可路由候选就尽早继续，不被其他 STUN 超时拖死。 */
export function waitForLiveIceGathering(pc: RTCPeerConnection, timeoutMs = 10_000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve, reject) => {
    let settled = false
    let usefulCandidateTimer: number | undefined
    const cleanup = () => {
      window.clearTimeout(timer)
      if (usefulCandidateTimer !== undefined) window.clearTimeout(usefulCandidateTimer)
      pc.removeEventListener('icegatheringstatechange', onGatheringStateChange)
      pc.removeEventListener('icecandidate', onIceCandidate)
      pc.removeEventListener('connectionstatechange', onConnectionStateChange)
    }
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const hasUsefulCandidate = () => {
      const types = candidateTypes(pc.localDescription?.sdp ?? '')
      return types.has('srflx') || types.has('relay')
    }
    const settleUsefulCandidate = () => {
      if (usefulCandidateTimer !== undefined || !hasUsefulCandidate()) return
      usefulCandidateTimer = window.setTimeout(() => finish(), USEFUL_CANDIDATE_SETTLE_MS)
    }
    const onGatheringStateChange = () => {
      if (pc.iceGatheringState === 'complete') finish()
    }
    const onIceCandidate = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate?.type === 'srflx' || event.candidate?.type === 'relay') settleUsefulCandidate()
    }
    const onConnectionStateChange = () => {
      if (pc.connectionState === 'closed') finish(new Error('SRS ICE gathering was closed'))
    }
    const timer = window.setTimeout(() => {
      const types = candidateTypes(pc.localDescription?.sdp ?? '')
      if (types.has('srflx') || types.has('relay')) finish()
      else finish(new Error(`SRS ICE gathering timed out (host=${Number(types.has('host'))}, srflx=0, relay=0)`))
    }, timeoutMs)
    pc.addEventListener('icegatheringstatechange', onGatheringStateChange)
    pc.addEventListener('icecandidate', onIceCandidate)
    pc.addEventListener('connectionstatechange', onConnectionStateChange)
    // Gathering may finish or a useful candidate may arrive before listener installation.
    settleUsefulCandidate()
    onGatheringStateChange()
  })
}
