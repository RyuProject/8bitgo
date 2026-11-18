/**
 * SRS（WebRTC SFU）一侧的连接参数。纯函数，便于在 Node 里单测（scripts/test-live-srs-ice.mjs）。
 *
 * ── 为什么不等 ICE 候选 ─────────────────────────────────────
 * SRS 是 ICE-lite：它从不主动探测浏览器的候选，只回应浏览器发来的 STUN 绑定请求，并把请求的
 * 来源地址（NAT 之后的公网地址）当成对端。所以浏览器 offer 里带不带 host / srflx 候选都无所谓 ——
 * 连通性靠的是「浏览器 → SRS 公网 IP:8000」这一个方向，SRS 官方 SDK 也是建完 offer 立刻 POST。
 *
 * 以前这里会等到收集到 srflx（公网映射）候选才提交，并且收集不到就当失败。这是把 P2P 的规则
 * 套到了 SFU 上，代价很实在：
 *   · 每次推流 / 拉流平白多等一轮 STUN（弱网下就是一两秒，最长 10 秒）；
 *   · 默认 STUN 是 Google 的，大陆网络根本连不上 —— 收不到 srflx，于是**直播在大陆整片拉不起来**，
 *     而 SRS 本身其实是直连可达的。
 * 现在 SRS 连接默认不配任何 ICE 服务器，offer 落地即提交。
 *
 * ── 什么时候才要中继 ────────────────────────────────────────
 * UDP 8000 和 TCP 8000 都被封的网络（部分公司 / 校园网只放行 80/443）直连不可能成功。
 * 这种情况在一次连接**从没连上就 failed** 之后，才带上站点自建的 TURN（turns:443 之类）重来：
 * 浏览器从中继地址去探 SRS，SRS 同样只认来源地址，所以照样不需要 trickle。
 * 能直连时中继候选优先级最低、不会被选中，只多一次中继分配。
 */

/** WHIP / WHEP 的 PeerConnection 配置：SRS 只支持 BUNDLE + rtcp-mux，直接要求，少收集一套传输 */
export function srsPeerConfiguration(iceServers: RTCIceServer[] = []): RTCConfiguration {
  return { iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' }
}

/**
 * 从直播 ICE 配置里只挑出 TURN 中继（带凭证的 turn: / turns:）。
 * STUN 对 SRS 没有任何用处（见文件头），留着只会多一轮注定超时的请求。
 */
export function relayOnlyIceServers(servers: readonly RTCIceServer[]): RTCIceServer[] {
  const out: RTCIceServer[] = []
  for (const server of servers) {
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((url) => /^turns?:/i.test(String(url)))
    if (!urls.length) continue
    out.push({ ...server, urls: urls.length === 1 ? urls[0] : urls })
  }
  return out
}

/** 本地 offer 一落地就提交给 SRS。拿不到 SDP 只可能是连接已经被关了 */
export function srsOfferSdp(pc: Pick<RTCPeerConnection, 'localDescription'>): string {
  const sdp = pc.localDescription?.sdp
  if (!sdp) throw new Error('SRS offer missing SDP')
  return sdp
}

type CodecLike = { mimeType: string; sdpFmtpLine?: string }

/**
 * H.264 内部的兼容性排序。SFU 不转码：主播协商出什么 profile，所有观众就得解什么。
 * Constrained Baseline（42e0xx）+ packetization-mode=1 是所有浏览器 / 手机硬解都吃的那一档；
 * Mac / 部分安卓的硬件编码器默认偏好 High，推上去后低端机观众可能软解吃力甚至黑屏。
 */
function h264Rank(codec: CodecLike): number {
  const fmtp = (codec.sdpFmtpLine ?? '').toLowerCase()
  const mode1 = /packetization-mode=1/.test(fmtp)
  const profile = /profile-level-id=([0-9a-f]{6})/.exec(fmtp)?.[1] ?? ''
  if (mode1 && profile.startsWith('42e0')) return 0
  if (mode1 && profile.startsWith('4200')) return 1
  if (mode1) return 2
  return 3
}

/**
 * 把 SRS 稳定支持的编码排到最前：视频 H.264（按兼容性细排），音频 Opus。
 * 其余编码保留在后面，浏览器和 SRS 仍可协商兜底；返回 null 表示没有可用的首选编码。
 */
export function rankSrsCodecs<T extends CodecLike>(codecs: readonly T[], kind: 'audio' | 'video'): T[] | null {
  const preferredMime = kind === 'video' ? 'video/h264' : 'audio/opus'
  const preferred = codecs.filter((codec) => codec.mimeType.toLowerCase() === preferredMime)
  if (!preferred.length) return null
  if (kind === 'video') preferred.sort((a, b) => h264Rank(a) - h264Rank(b))
  return [...preferred, ...codecs.filter((codec) => !preferred.includes(codec))]
}

/**
 * 弱网观众的抖动缓冲目标（毫秒）。
 *
 * SFU 不能给单个弱网观众降码率（SRS 没有联播），能做的是让丢包重传赶得上：NACK 重传要一个 RTT
 * 才回来，缓冲比 RTT 短时补回来的包已经过了播放时刻，只能丢帧再等关键帧 —— 弱网下的「一卡一卡」
 * 大半就是这么来的。所以有丢包时把缓冲放到约两个 RTT；网络干净就回到基线，延迟不白涨。
 */
export function srsJitterTargetMs(sample: { loss: number; rttMs?: number }): number {
  const BASE = 300
  if (!(sample.loss >= 0.01)) return BASE
  const rtt = typeof sample.rttMs === 'number' && Number.isFinite(sample.rttMs) ? sample.rttMs : 200
  return Math.max(BASE, Math.min(1_000, Math.round(rtt * 2 + 150)))
}
