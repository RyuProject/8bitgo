#!/usr/bin/env node
/**
 * SRS（ICE-lite SFU）连接参数回归。
 *
 * 钉住的事：
 *   · SRS 连接默认不配 ICE 服务器、offer 落地即提交 —— 以前要等到 srflx 候选才提交，
 *     默认 STUN（Google）在大陆不可达时直播整片拉不起来；
 *   · 只有直连失败后才带 TURN，而且只带 turn:/turns:，不带 STUN；
 *   · H.264 按兼容性排序（Constrained Baseline 优先），音频 Opus 优先；
 *   · 弱网抖动缓冲随 RTT 放大、有上下限。
 * 跑：npm run test:live-ice
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  rankSrsCodecs,
  relayOnlyIceServers,
  srsJitterTargetMs,
  srsOfferSdp,
  srsPeerConfiguration,
} from '../src/services/liveSrsIce.ts'

const tests = []
const check = (name, fn) => tests.push([name, fn])

check('SRS 连接默认不带任何 ICE 服务器，并要求 BUNDLE + rtcp-mux', () => {
  const config = srsPeerConfiguration()
  assert.deepEqual(config.iceServers, [])
  assert.equal(config.bundlePolicy, 'max-bundle')
  assert.equal(config.rtcpMuxPolicy, 'require')
})

check('offer 落地即可提交：没有候选的 SDP 也照样交给 SRS', () => {
  const sdp = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n'
  assert.equal(srsOfferSdp({ localDescription: { type: 'offer', sdp } }), sdp)
  assert.throws(() => srsOfferSdp({ localDescription: null }), /missing SDP/)
})

check('中继兜底只保留 TURN（带凭证），STUN 一条不留', () => {
  const servers = relayOnlyIceServers([
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: ['stun:turn.example.com:3478', 'turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:443?transport=tcp'], username: 'u', credential: 'c' },
    { urls: 'turn:cn.example.com:3478', username: 'u2', credential: 'c2' },
  ])
  assert.deepEqual(servers, [
    { urls: ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:443?transport=tcp'], username: 'u', credential: 'c' },
    { urls: 'turn:cn.example.com:3478', username: 'u2', credential: 'c2' },
  ])
  assert.deepEqual(relayOnlyIceServers([{ urls: 'stun:a' }]), [])
})

check('H.264 按兼容性排在最前：Constrained Baseline + packetization-mode=1 第一', () => {
  const codecs = [
    { mimeType: 'video/VP8' },
    { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f' },
    { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f' },
    { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f' },
    { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' },
    { mimeType: 'video/rtx' },
  ]
  const ranked = rankSrsCodecs(codecs, 'video')
  assert.deepEqual(ranked.slice(0, 4).map((c) => c.sdpFmtpLine?.match(/packetization-mode=(\d);profile-level-id=(\w+)/)?.slice(1).join('/')), [
    '1/42e01f',
    '1/42001f',
    '1/640c1f',
    '0/42e01f',
  ])
  assert.equal(ranked.length, codecs.length, '其余编码保留在后面兜底')
  assert.equal(rankSrsCodecs([{ mimeType: 'video/VP8' }], 'video'), null, '没有 H.264 就不改浏览器默认')
  assert.equal(rankSrsCodecs([{ mimeType: 'audio/PCMU' }, { mimeType: 'audio/opus' }], 'audio')[0].mimeType, 'audio/opus')
})

check('抖动缓冲：网络干净时保持基线，丢包时按 RTT 放大，最多 1 秒', () => {
  assert.equal(srsJitterTargetMs({ loss: 0, rttMs: 600 }), 300)
  assert.equal(srsJitterTargetMs({ loss: 0.05, rttMs: 100 }), 350)
  assert.equal(srsJitterTargetMs({ loss: 0.05, rttMs: 300 }), 750)
  assert.equal(srsJitterTargetMs({ loss: 0.2, rttMs: 2_000 }), 1_000)
  assert.equal(srsJitterTargetMs({ loss: 0.05 }), 550, 'RTT 读不到时按 200ms 估')
})

check('⭐ 推流 / 拉流两端都不再等 ICE 收集', async () => {
  const sources = await Promise.all([
    readFile(new URL('../src/emulator/broadcast.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/emulator/adapters/liveview.ts', import.meta.url), 'utf8'),
  ])
  for (const source of sources) {
    assert.doesNotMatch(source, /waitForLiveIceGathering|liveStunServers/, '不能再等 srflx 候选或只给 SRS 配 STUN')
    assert.match(source, /srsPeerConfiguration\(/)
    assert.match(source, /srsOfferSdp\(/)
  }
})

let failed = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log(`✅ ${name}`)
  } catch (error) {
    failed++
    console.error(`❌ ${name}\n   ${error?.stack ?? error}`)
  }
}
if (failed) process.exitCode = 1
else console.log(`\n✅ ${tests.length} 项 SRS 连接参数回归通过`)
