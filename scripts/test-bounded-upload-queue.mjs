import assert from 'node:assert/strict'
import { BoundedUploadFailure, runBoundedUploadQueue, uploadWorkingMemoryBudgetBytes } from '../src/admin/boundedUploadQueue.ts'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 多文件传输会并行跑满调用方允许的槽位，但不会超过上限。
{
  const items = Array.from({ length: 9 }, (_, i) => ({ path: `asset-${i}.swf`, size: (i + 1) * 1024 }))
  let active = 0
  let maximum = 0
  let completed = 0
  const progress = []
  await runBoundedUploadQueue(items, 3, async (_item, _index, report) => {
    active++
    maximum = Math.max(maximum, active)
    report(30)
    await delay(3)
    report(100)
    active--
    completed++
  }, (value) => progress.push(value))
  assert.equal(maximum, 3)
  assert.equal(completed, items.length)
  assert.equal(progress.at(-1)?.pct, 100)
  assert.equal(progress.at(-1)?.done, items.length)
  assert.equal(progress.at(-1)?.active, 0)
}
console.log('✅ 文件队列按设备并发上限并行，且字节加权进度完成到 100%')

// 任一文件失败后不再从队列派新文件；已经开始的请求正常收尾并保留成功列表。
{
  const items = Array.from({ length: 5 }, (_, i) => ({ path: `asset-${i}.swf`, size: 1 }))
  const started = []
  await assert.rejects(
    runBoundedUploadQueue(items, 2, async (_item, index) => {
      started.push(index)
      if (index === 0) {
        await delay(1)
        throw new Error('模拟上传失败')
      }
      await delay(8)
    }),
    (error) => {
      assert.ok(error instanceof BoundedUploadFailure)
      assert.equal(error.itemIndex, 0)
      assert.deepEqual(error.completedIndices, [1])
      assert.match(String(error.reason), /模拟上传失败/)
      return true
    },
  )
  assert.deepEqual(started, [0, 1], '失败后不得继续上传排队中的文件')
}
console.log('✅ 单个文件失败会停止新任务，并等待已开始的任务安全收尾')

// 进度按字节而非文件数加权；小文件完成不能冒充整个大包已完成。
{
  const items = [{ path: 'small.swf', size: 1 }, { path: 'large.swf', size: 3 }]
  let releaseSmall
  let releaseLarge
  const smallGate = new Promise((resolve) => { releaseSmall = resolve })
  const largeGate = new Promise((resolve) => { releaseLarge = resolve })
  const progress = []
  const pending = runBoundedUploadQueue(items, 2, async (_item, index, report) => {
    report(index === 0 ? 100 : 50)
    await (index === 0 ? smallGate : largeGate)
  }, (value) => progress.push(value))
  await new Promise((resolve) => setImmediate(resolve))
  const sampled = progress.at(-1)
  assert.equal(sampled?.pct, 63)
  assert.equal(sampled?.active, 2)
  releaseSmall()
  releaseLarge()
  await pending
}
console.log('✅ 并行任务的总进度以实际字节数加权')

assert.equal(uploadWorkingMemoryBudgetBytes(2), 32 * 1024 * 1024)
assert.equal(uploadWorkingMemoryBudgetBytes(4), 64 * 1024 * 1024)
assert.equal(uploadWorkingMemoryBudgetBytes(8), 128 * 1024 * 1024)
assert.equal(uploadWorkingMemoryBudgetBytes(), 64 * 1024 * 1024)

{
  const mb = 1024 * 1024
  const items = [
    { path: 'small-a.swf', size: 1 * mb },
    { path: 'large.swf', size: 40 * mb },
    { path: 'small-b.xml', size: 1 * mb },
    { path: 'small-c.xml', size: 1 * mb },
  ]
  let largeActive = false
  let smallActive = 0
  let maxSmallActive = 0
  await runBoundedUploadQueue(items, 4, async (item) => {
    if (item.path === 'large.swf') {
      assert.equal(smallActive, 0, '超过内存预算的大资源应独占解压缓冲')
      largeActive = true
      await delay(3)
      largeActive = false
      return
    }
    assert.equal(largeActive, false, '小资源不得与超预算的大资源重叠')
    smallActive++
    maxSmallActive = Math.max(maxSmallActive, smallActive)
    await delay(2)
    smallActive--
  }, undefined, 64 * mb)
  assert.equal(maxSmallActive, 3, '大文件不应让后续小文件退化成串行')
}
console.log('✅ 大文件独占解压缓冲，后续小资源仍能按并发上限并行')
