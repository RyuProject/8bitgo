/**
 * 直播里「每位观众各调各的」网络档位。
 *
 * 这层只处理网络与解码能力，不处理主播 CPU：
 *   · 主播 CPU 吃紧时，broadcast.ts 会统一降低采集帧率，避免游戏主循环被编码抢走；
 *   · 某位观众丢包 / 高延迟 / 解码跟不上时，只降低那一条 RTCRtpSender，不能拖累其他人。
 *
 * WebRTC 自带带宽估计仍然是第一道实时保护；这里用 5 秒统计做慢速、带迟滞的档位调整，
 * 负责把分辨率和帧率也一起降下来。两者时间尺度不同，不会每几百毫秒互相打架。
 */
import { MAX_ENCODE_SCALE_DOWN, type VideoTuning } from './videoTuning'

export type LiveQualityTier = 'high' | 'balanced' | 'low'

export interface ViewerNetworkSample {
  /** 最近一个采样窗口的丢包率（0~1） */
  loss: number
  /** 当前候选对 RTT，毫秒；拿不到是 0 */
  rttMs: number
  /** 观众实际解码帧率；拿不到是 0 */
  fps: number
  /** 最近一个采样窗口实际收到的视频码率，kbps；只用于诊断，不单独作为降档依据 */
  kbps: number
}

export interface LiveQualityState {
  tier: LiveQualityTier
  badStreak: number
  goodStreak: number
  lastChangeAt: number
}

export interface LiveQualityObservation {
  /** 发送端编码器自己判定这一路被带宽限制 */
  bandwidthLimited: boolean
  /** 这一路当前允许的帧率，用来判断观众是否明显解不动 */
  expectedFps: number
  /** 新版观众会经 DataChannel 回传；旧版没有时仍可靠 bandwidthLimited 工作 */
  sample?: ViewerNetworkSample
}

const BAD_LOSS = 0.03
const SEVERE_LOSS = 0.10
const GOOD_LOSS = 0.01
const BAD_RTT_MS = 450
const SEVERE_RTT_MS = 900
const GOOD_RTT_MS = 250
const BAD_FPS_RATIO = 0.65
const GOOD_FPS_RATIO = 0.85
/** 恢复比降级慢：宁可多稳一会儿，也不能在两个档位之间来回闪。 */
const DEGRADE_AFTER = 2
const RECOVER_AFTER = 6
const RECOVER_COOLDOWN_MS = 20_000

export function initialLiveQualityState(now = Date.now()): LiveQualityState {
  return { tier: 'high', badStreak: 0, goodStreak: 0, lastChangeAt: now }
}

function lower(tier: LiveQualityTier): LiveQualityTier {
  return tier === 'high' ? 'balanced' : 'low'
}

function higher(tier: LiveQualityTier): LiveQualityTier {
  return tier === 'low' ? 'balanced' : 'high'
}

/**
 * 吃一轮统计，返回下一状态。函数不改入参，方便用纯 Node 做完整边界回归。
 *
 * 严重丢包 / 延迟会把坏样本权重算成 2，允许一轮就降一档；普通波动必须连续两轮。
 * 恢复则要连续六轮干净样本且距离上次切档至少 20 秒，避免弱网边缘反复抖档。
 */
export function observeLiveQuality(
  state: LiveQualityState,
  observation: LiveQualityObservation,
  now = Date.now(),
): LiveQualityState {
  const sample = observation.sample
  const expected = Math.max(1, Number(observation.expectedFps) || 1)
  const loss = sample?.loss ?? 0
  const rtt = sample?.rttMs ?? 0
  const fps = sample?.fps ?? 0
  const slowDecoder = Boolean(sample && fps > 0 && fps < expected * BAD_FPS_RATIO)
  const severe = Boolean(sample && (loss >= SEVERE_LOSS || rtt >= SEVERE_RTT_MS))
  const bad = observation.bandwidthLimited || severe || Boolean(sample && (loss >= BAD_LOSS || rtt >= BAD_RTT_MS || slowDecoder))
  const good = !observation.bandwidthLimited && Boolean(sample) &&
    loss < GOOD_LOSS && (rtt === 0 || rtt < GOOD_RTT_MS) &&
    (fps === 0 || fps >= expected * GOOD_FPS_RATIO)

  let badStreak = bad ? state.badStreak + (severe ? 2 : 1) : 0
  let goodStreak = good ? state.goodStreak + 1 : 0
  let tier = state.tier
  let lastChangeAt = state.lastChangeAt

  if (badStreak >= DEGRADE_AFTER && tier !== 'low') {
    tier = lower(tier)
    badStreak = 0
    goodStreak = 0
    lastChangeAt = now
  } else if (goodStreak >= RECOVER_AFTER && tier !== 'high' && now - state.lastChangeAt >= RECOVER_COOLDOWN_MS) {
    tier = higher(tier)
    badStreak = 0
    goodStreak = 0
    lastChangeAt = now
  }

  return { tier, badStreak, goodStreak, lastChangeAt }
}

/**
 * 把网络档位叠到按源分辨率算出的基础参数上。
 *
 * 像素画不做二次缩放：GBA / NES 的字本来就只有几像素，缩半比掉几帧更伤。
 * 大画面则同时缩分辨率和码率，能明显减少主播这一路编码器的工作量。
 */
export function tuningForLiveTier(base: VideoTuning, tier: LiveQualityTier): VideoTuning {
  if (tier === 'high') return { ...base }
  const low = tier === 'low'
  const bitrateRatio = low ? 0.42 : 0.70
  const fpsCap = low ? 18 : 24
  const scale = base.retro
    ? base.scaleResolutionDownBy
    : Math.min(MAX_ENCODE_SCALE_DOWN, base.scaleResolutionDownBy * (low ? 2 : 1.35))

  return {
    ...base,
    maxBitrate: Math.max(250_000, Math.round(base.maxBitrate * bitrateRatio)),
    maxFramerate: Math.min(base.maxFramerate, fpsCap),
    scaleResolutionDownBy: scale,
    // 像素画继续保字形；大画面允许降清晰度来换连续播放。
    degradationPreference: base.retro ? 'maintain-resolution' : 'maintain-framerate',
  }
}
