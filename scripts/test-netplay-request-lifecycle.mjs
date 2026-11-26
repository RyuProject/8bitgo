import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createNetplayStateUploadQueue } from '../src/emulator/netplayStateUpload.ts'
import { createRequestTimeout, RequestTimeoutError, withRequestTimeout } from '../src/services/requestTimeout.ts'

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (condition) => {
  for (let i = 0; i < 30 && !condition(); i++) await wait(0)
  assert.ok(condition(), '异步上传队列应在有限时间内推进')
}

// 一份上传未结束时只允许一个请求在途，多个新快照折叠成最新的一份。
const calls = []
const completions = []
const queue = createNetplayStateUploadQueue((state, keepalive) => {
  calls.push({ value: state[0], keepalive })
  return new Promise((resolve) => completions.push(resolve))
})
queue.submit('a', new Uint8Array([1]))
await until(() => calls.length === 1)
queue.submit('b', new Uint8Array([2]))
queue.submit('c', new Uint8Array([3]))
assert.equal(calls.length, 1, '在途请求不能并发覆盖房间存档')
completions.shift()(true)
await until(() => calls.length === 2)
assert.deepEqual(calls.map((c) => c.value), [1, 3], '中间态折叠，只发送最新快照')
completions.shift()(false)
await wait()
queue.submit('c', new Uint8Array([3]))
await until(() => calls.length === 3)
assert.equal(calls[2].value, 3, '失败的存档必须允许下一轮重试')
completions.shift()(true)
await wait()
queue.submit('c', new Uint8Array([3]))
await wait()
assert.equal(calls.length, 3, '成功上传的相同快照无需重复发送')

// 请求 scope 同时支持主动取消与超时，dispose 必须清理计时器。
const timeout = createRequestTimeout(10)
await wait(20)
assert.equal(timeout.signal.aborted, true, '网络半开时请求应按时取消')
timeout.dispose()

const parent = new AbortController()
const child = createRequestTimeout(1000, parent.signal)
parent.abort()
assert.equal(child.signal.aborted, true, 'effect 清理时父信号应取消在途请求')
child.dispose()

const disposable = createRequestTimeout(20)
disposable.dispose()
await wait(30)
assert.equal(disposable.signal.aborted, false, '请求结束后计时器必须清掉，避免误触发')

let requestAborted = false
await assert.rejects(
  withRequestTimeout(10, undefined, (signal) => new Promise(() => {
    signal.addEventListener('abort', () => { requestAborted = true }, { once: true })
  })),
  RequestTimeoutError,
  '即使底层请求没有响应 abort，页面流程也必须在时限内结束',
)
assert.equal(requestAborted, true, '超时需要同时取消底层请求')
const caller = new AbortController()
const callerRequest = withRequestTimeout(1000, caller.signal, (signal) => new Promise((_, reject) => {
  signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })
}))
caller.abort()
await assert.rejects(callerRequest, { name: 'AbortError' }, '页面离开触发的取消不能伪装成超时')
const alreadyCancelled = new AbortController()
alreadyCancelled.abort()
let cancelledOperationStarted = false
await assert.rejects(
  withRequestTimeout(1000, alreadyCancelled.signal, async () => {
    cancelledOperationStarted = true
    return true
  }),
  { name: 'AbortError' },
  '已取消的页面不能再启动新请求',
)
assert.equal(cancelledOperationStarted, false, '父信号已取消时不启动底层工作')

const service = readFileSync(new URL('../src/services/netplay.ts', import.meta.url), 'utf8')
for (const method of ['uploadState', 'downloadState', 'claimRoom', 'migrateRoom']) {
  const start = service.indexOf(`export async function ${method}`)
  assert.ok(start >= 0, `${method} 必须导出`)
  const next = service.indexOf('\nexport ', start + 1)
  const body = service.slice(start, next < 0 ? undefined : next)
  assert.match(body, /createRequestTimeout\(/, `${method} 必须有请求时限`)
  assert.match(body, /signal: request\.signal/, `${method} 必须把取消信号交给 fetch`)
  assert.match(body, /request\.dispose\(\)/, `${method} 必须在完成后清理时限`)
}

const pageData = readFileSync(new URL('../src/services/pageData.ts', import.meta.url), 'utf8')
assert.match(pageData, /PAGE_DATA_TIMEOUT_MS = 20_000/, '页面数据必须有上限，不能让骨架屏永久等待')
assert.match(pageData, /withRequestTimeout\(PAGE_DATA_TIMEOUT_MS/, '首屏与续页请求必须共用有界请求')
const infinite = readFileSync(new URL('../src/services/infinite.ts', import.meta.url), 'utf8')
assert.match(infinite, /activeRequest\.current\?\.abort\(\)/, '切筛选或离开页面必须取消旧续页下载')
assert.match(infinite, /fetchPage\(next, controller\.signal\)/, '续页请求必须接收可取消信号')
assert.match(infinite, /renderedKeyRef\.current !== keyAtStart/, '筛选切换后的 effect 前也不能接入旧响应')

const adapter = readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
assert.match(adapter, /createNetplayStateUploadQueue\(/, '房间存档上传必须串行')
assert.match(adapter, /uploadQueue\.submit\(fp, state, force\)/, '只在队列确认成功后记录上传指纹')
assert.doesNotMatch(adapter, /lastFingerprint\s*=\s*fp/, '请求发出前不能把存档误记成已托管')

const player = readFileSync(new URL('../src/emulator/EmulatorPlayer.tsx', import.meta.url), 'utf8')
assert.match(player, /if \(!claim\) \{[\s\S]{0,300}retryClaim\(\)/, '认领失败必须主动重查，不能依赖已消费的 SSE')
assert.match(player, /downloadState\(roomId, claim, \{ signal: request\.signal \}\)/, 'effect 清理必须能取消存档下载')
const missingState = player.indexOf('if (room.hasState && !state)')
const takeover = player.indexOf('startP2p(undefined, { from: roomId, state })', missingState)
assert.ok(missingState >= 0 && takeover > missingState, '存档下载失败时不能用空进度启动接管')

console.log('✅ 联机存档上传队列、请求超时与接管生命周期通过')
