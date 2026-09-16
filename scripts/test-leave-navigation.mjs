#!/usr/bin/env node
/** “确定离开”必须重新发起导航，不能继续赌被 confirm 阻塞过的旧 click。 */
import assert from 'node:assert/strict'
import { confirmAndReplayAnchorNavigation } from '../src/emulator/leaveNavigation.ts'

const fakeEvent = () => {
  const calls = { prevented: 0, stopped: 0 }
  return {
    calls,
    event: {
      preventDefault: () => calls.prevented++,
      stopPropagation: () => calls.stopped++,
    },
  }
}

{
  const first = fakeEvent()
  const state = { current: null }
  let clicks = 0
  const anchor = { click: () => clicks++ }
  const result = confirmAndReplayAnchorNavigation(first.event, anchor, '离开？', state, () => false)
  assert.equal(result, 'cancelled')
  assert.deepEqual(first.calls, { prevented: 1, stopped: 1 })
  assert.equal(clicks, 0, '取消时不能重放链接')
}

{
  const first = fakeEvent()
  const replay = fakeEvent()
  const state = { current: null }
  let confirms = 0
  let nestedResult = ''
  const anchor = {
    click() {
      nestedResult = confirmAndReplayAnchorNavigation(replay.event, anchor, '离开？', state, () => {
        confirms++
        return true
      })
    },
  }
  const result = confirmAndReplayAnchorNavigation(first.event, anchor, '离开？', state, () => {
    confirms++
    return true
  })
  assert.equal(result, 'replayed')
  assert.equal(nestedResult, 'bypass', '重放出来的新 click 必须直接放行')
  assert.equal(confirms, 1, '确认框只能出现一次')
  assert.deepEqual(first.calls, { prevented: 1, stopped: 1 })
  assert.deepEqual(replay.calls, { prevented: 0, stopped: 0 }, '重放事件不能再被取消')
  assert.equal(state.current, null)
}

{
  const first = fakeEvent()
  const state = { current: null }
  const anchor = { click() { /* 模拟链接在确认期间被卸载，没派发第二条事件 */ } }
  confirmAndReplayAnchorNavigation(first.event, anchor, '离开？', state, () => true)
  assert.equal(state.current, null, '重放没有发生时也必须清掉通行标记')
}

console.log('✅ 离开确认：取消不跳 / 确定重放一次 / 重放不递归 / 失效链接不残留通行标记')
