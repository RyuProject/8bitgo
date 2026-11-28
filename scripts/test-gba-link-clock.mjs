/** GBA 锁步时钟固定为 60Hz，并限制网络恢复时的追帧工作量。 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { transform } from 'esbuild'

const source = await readFile(new URL('../src/emulator/gbaLinkClock.ts', import.meta.url), 'utf8')
const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' })
const {
  advanceGbaLinkFrameClock,
  createGbaLinkFrameClock,
  GBA_LINK_MAX_CATCH_UP_FRAMES,
  GBA_LINK_REMOTE_WAIT_TIMEOUT_MS,
  gbaLinkRemoteWaitExpired,
} = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`,
)

function simulateRefreshRate(hz) {
  const clock = createGbaLinkFrameClock()
  let frames = 0
  advanceGbaLinkFrameClock(clock, 0, () => { frames++; return true })
  for (let index = 1; index <= hz; index++) {
    advanceGbaLinkFrameClock(clock, index * 1000 / hz, () => { frames++; return true })
  }
  return frames
}

assert.equal(simulateRefreshRate(30), 60, '30Hz 屏幕每次回调可追两帧，游戏仍保持 60Hz')
assert.equal(simulateRefreshRate(60), 60, '60Hz 屏幕每次回调推进一帧')
assert.equal(simulateRefreshRate(120), 60, '120Hz 屏幕不能把游戏加速到 120fps')

const stalled = createGbaLinkFrameClock()
let simulated = 0
advanceGbaLinkFrameClock(stalled, 0, () => { simulated++; return true })
assert.equal(advanceGbaLinkFrameClock(stalled, 1000 / 60, () => false), 0, '等对端输入时不得推进模拟器')
assert.equal(advanceGbaLinkFrameClock(stalled, 2000 / 60, () => { simulated++; return true }), 2, '输入到达后补齐有限的已积累帧')
assert.equal(simulated, 2)

const stalledNetwork = createGbaLinkFrameClock()
advanceGbaLinkFrameClock(stalledNetwork, 0, () => true)
assert.equal(
  advanceGbaLinkFrameClock(stalledNetwork, 10_000, () => true),
  GBA_LINK_MAX_CATCH_UP_FRAMES,
  '后台长暂停后单次恢复最多补 2 帧，避免阻塞移动端主线程',
)
assert.equal(advanceGbaLinkFrameClock(stalledNetwork, 10_000, () => true), 0, '丢弃过期墙钟时间，不做无界追赶')

assert.equal(gbaLinkRemoteWaitExpired(null, 20_000, true), false, '尚未开始等帧时不触发超时')
assert.equal(gbaLinkRemoteWaitExpired(1_000, 1_000 + GBA_LINK_REMOTE_WAIT_TIMEOUT_MS - 1, true), false,
  '正常等待窗口内允许弱网延迟输入')
assert.equal(gbaLinkRemoteWaitExpired(1_000, 1_000 + GBA_LINK_REMOTE_WAIT_TIMEOUT_MS, true), true,
  '信令仍连接但输入永久停住时最终退出锁步，避免无限冻结')
assert.equal(gbaLinkRemoteWaitExpired(1_000, 100_000, false), false,
  '后台标签页暂停期间不累计对端输入超时')

assert.equal(gbaLinkRemoteWaitExpired(null, 20_000, true), false, '尚未开始等帧时不触发超时')
assert.equal(gbaLinkRemoteWaitExpired(1_000, 1_000 + GBA_LINK_REMOTE_WAIT_TIMEOUT_MS - 1, true), false,
  '正常等待窗口内允许弱网延迟输入')
assert.equal(gbaLinkRemoteWaitExpired(1_000, 1_000 + GBA_LINK_REMOTE_WAIT_TIMEOUT_MS, true), true,
  '信令仍连接但输入永久停住时最终退出锁步，避免无限冻结')
assert.equal(gbaLinkRemoteWaitExpired(1_000, 100_000, false), false,
  '后台标签页暂停期间不累计对端输入超时')

console.log('GBA 联机时钟通过：30/60/120Hz 一致、缺输入锁步、恢复追帧有界')
