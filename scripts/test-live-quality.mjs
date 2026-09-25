#!/usr/bin/env node
/** 直播自适应画质的纯逻辑回归测试。跑：npm run test:live-quality */
import assert from 'node:assert/strict'
import {
  initialLiveQualityState,
  observeLiveQuality,
  tuningForLiveTier,
} from '../src/emulator/liveAdaptiveQuality.ts'
import { applyTuning } from '../src/emulator/videoTuning.ts'

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log(`  ok  ${name}`)
}

const good = { loss: 0.002, rttMs: 45, fps: 30, kbps: 1400 }
const bad = { loss: 0.06, rttMs: 520, fps: 17, kbps: 430 }
const severe = { loss: 0.18, rttMs: 1100, fps: 8, kbps: 120 }

check('普通网络波动要连续两轮才降档', () => {
  let s = initialLiveQualityState(0)
  s = observeLiveQuality(s, { bandwidthLimited: false, expectedFps: 30, sample: bad }, 5_000)
  assert.equal(s.tier, 'high')
  s = observeLiveQuality(s, { bandwidthLimited: false, expectedFps: 30, sample: bad }, 10_000)
  assert.equal(s.tier, 'balanced')
})

check('严重弱网一轮降一档，但不会一步从高清砸到最低', () => {
  let s = initialLiveQualityState(0)
  s = observeLiveQuality(s, { bandwidthLimited: false, expectedFps: 30, sample: severe }, 5_000)
  assert.equal(s.tier, 'balanced')
  s = observeLiveQuality(s, { bandwidthLimited: false, expectedFps: 24, sample: severe }, 10_000)
  assert.equal(s.tier, 'low')
})

check('发送端带宽判定在旧观众不回报统计时仍能降档', () => {
  let s = initialLiveQualityState(0)
  s = observeLiveQuality(s, { bandwidthLimited: true, expectedFps: 30 }, 5_000)
  s = observeLiveQuality(s, { bandwidthLimited: true, expectedFps: 30 }, 10_000)
  assert.equal(s.tier, 'balanced')
})

check('恢复必须连续六轮干净样本，防止弱网边缘来回跳', () => {
  let s = { ...initialLiveQualityState(0), tier: 'low', lastChangeAt: 0 }
  for (let i = 1; i <= 5; i++) s = observeLiveQuality(s, { bandwidthLimited: false, expectedFps: 18, sample: good }, i * 5_000)
  assert.equal(s.tier, 'low')
  s = observeLiveQuality(s, { bandwidthLimited: false, expectedFps: 18, sample: good }, 30_000)
  assert.equal(s.tier, 'balanced')
})

check('中性或缺失样本不会凭空升档', () => {
  let s = { ...initialLiveQualityState(0), tier: 'low' }
  for (let i = 0; i < 20; i++) s = observeLiveQuality(s, { bandwidthLimited: false, expectedFps: 18 }, 30_000 + i * 5_000)
  assert.equal(s.tier, 'low')
})

const retro = {
  maxBitrate: 1_000_000,
  maxFramerate: 30,
  degradationPreference: 'maintain-resolution',
  contentHint: 'detail',
  retro: true,
  scaleResolutionDownBy: 4,
}
const large = { ...retro, retro: false, maxBitrate: 6_000_000, scaleResolutionDownBy: 2, contentHint: 'motion' }

check('像素画弱网时保分辨率，优先降码率和帧率', () => {
  const q = tuningForLiveTier(retro, 'low')
  assert.equal(q.scaleResolutionDownBy, 4)
  assert.equal(q.maxFramerate, 18)
  assert.equal(q.maxBitrate, 420_000)
})

check('大画面弱网时按观众独立缩分辨率，降低主播编码负担', () => {
  const q = tuningForLiveTier(large, 'low')
  assert.equal(q.scaleResolutionDownBy, 4)
  assert.equal(q.maxFramerate, 18)
  assert.equal(q.maxBitrate, 2_520_000)
})

check('高清档完全保持基础参数，避免无端损伤画质', () => {
  assert.deepEqual(tuningForLiveTier(large, 'high'), large)
})

{
  const calls = []
  let rejectFirst
  const sender = {
    track: { kind: 'video', contentHint: '' },
    getParameters: () => ({ encodings: [{}] }),
    setParameters(params) {
      calls.push(params)
      if (calls.length === 1) return new Promise((_, reject) => { rejectFirst = reject })
      return Promise.resolve()
    },
  }
  applyTuning(sender, tuningForLiveTier(large, 'balanced'))
  applyTuning(sender, tuningForLiveTier(large, 'low'))
  assert.equal(calls.length, 1, '第一轮仍在飞时不应并发 setParameters')
  rejectFirst(new Error('协商切换期拒绝'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.length, 2, '第一轮失败后必须继续应用等待中的最新档位')
  assert.equal(calls[1].encodings[0].maxFramerate, 18, '最终必须落在最新的低档，而不是过期的均衡档')
  passed++
  console.log('  ok  并发调档会串行并合并到最新值，单次拒绝不会丢掉最终档位')
}

console.log(`\n${passed}/${passed} 通过：直播自适应画质测试通过`)
