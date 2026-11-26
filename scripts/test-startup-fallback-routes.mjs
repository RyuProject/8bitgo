import assert from 'node:assert/strict'
import { startupEventDedupeKey } from '../src/services/startupFunnel.ts'

const base = {
  visitId: '12345678-abcd-4321-abcd-123456789012',
  attemptId: 'abcdef12-abcd-4321-abcd-123456789012',
  event: 'fallback_started',
}

const firstHop = startupEventDedupeKey('contra', {
  ...base,
  detail: 'runtime:jsnes>emulatorjs:unsupported-rom',
})
const fullRoute = startupEventDedupeKey('contra', {
  ...base,
  detail: 'runtime:jsnes>emulatorjs:unsupported-rom;core:fbneo>fbneo-lowmem:out-of-memory',
})

assert.notEqual(firstHop, fullRoute, '兜底链每增加一跳，都必须允许客户端上报更新后的路线')
assert.equal(
  startupEventDedupeKey('contra', { ...base, detail: 'runtime:jsnes>emulatorjs:unsupported-rom' }),
  firstHop,
  '同一路线的重复回调仍应在客户端去重',
)
assert.equal(
  startupEventDedupeKey('contra', { ...base, event: 'fallback_failed', detail: '同一条说明' }),
  startupEventDedupeKey('contra', { ...base, event: 'fallback_failed', detail: '另一条说明' }),
  '结果事件继续按事件类型去重，只有路线事件带版本内容',
)

console.log('✅ 启动兜底路线增量上报测试通过')
