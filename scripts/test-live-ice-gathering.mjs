#!/usr/bin/env node
/**
 * SRS WHIP/WHEP ICE 收集回归：可达 STUN 已给出公网映射时，不应被其他失联 STUN 拖到超时。
 * 跑：npm run test:live-ice
 */
import assert from 'node:assert/strict'
import { waitForLiveIceGathering } from '../src/services/liveIceGathering.ts'

globalThis.window = globalThis

class FakePeerConnection {
  iceGatheringState = 'gathering'
  connectionState = 'new'
  localDescription = { sdp: 'v=0\r\na=candidate:1 1 udp 1 192.168.1.5 5000 typ host\r\n' }
  listeners = new Map()

  addEventListener(type, listener) {
    const group = this.listeners.get(type) ?? new Set()
    group.add(listener)
    this.listeners.set(type, group)
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const tests = []
const check = (name, fn) => tests.push([name, fn])

check('不等所有 STUN 结束：收到 srflx 候选并稍作收集后继续', async () => {
  const pc = new FakePeerConnection()
  const started = Date.now()
  const ready = waitForLiveIceGathering(pc, 1_000)
  pc.localDescription.sdp += 'a=candidate:2 1 udp 2 198.51.100.8 40000 typ srflx raddr 192.168.1.5 rport 5000\r\n'
  pc.emit('icecandidate', { candidate: { type: 'srflx' } })
  await ready
  assert.ok(Date.now() - started >= 200, '给同一轮的其他候选留出短暂收集时间')
  assert.equal(pc.listeners.get('icecandidate').size, 0, '成功后清除候选监听器')
})

check('已完成的常规 ICE 收集仍立即继续', async () => {
  const pc = new FakePeerConnection()
  pc.iceGatheringState = 'complete'
  await waitForLiveIceGathering(pc)
})

check('没有 srflx/relay 且未完成时明确失败，不把 host-only SDP 误认为可公网连接', async () => {
  const pc = new FakePeerConnection()
  await assert.rejects(waitForLiveIceGathering(pc, 15), /host=1, srflx=0, relay=0/)
  assert.equal(pc.listeners.get('icecandidate').size, 0, '超时后清除候选监听器')
})

check('监听器安装前已经到达的 srflx 也能被识别', async () => {
  const pc = new FakePeerConnection()
  pc.localDescription.sdp += 'a=candidate:2 1 udp 2 198.51.100.8 40000 typ srflx raddr 192.168.1.5 rport 5000\r\n'
  await waitForLiveIceGathering(pc, 1_000)
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
else console.log(`\n✅ ${tests.length} 项 SRS ICE 收集回归通过`)
