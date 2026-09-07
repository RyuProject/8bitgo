// IM 接缝（src/services/im.ts）的单元测试。跑：npm run test:im
//
// 这里还没有任何 IM 实现 —— 测的是那两个口子的契约。会盯住三件容易被「顺手简化」掉的事：
//   1. 注销时必须判「当前这个是不是我」（React 严格模式下 effect 会跑两遍）
//   2. 未读数报的是**总数**且要规整（NaN / 负数 / 小数）
//   3. 同值不重复通知（否则顶栏每来一条心跳都白重渲染一次）
import assert from 'node:assert/strict'

const im = await import('../src/services/im.ts')

let passed = 0
function check(name, fn) {
  im.setImUnread(0)
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

check('没接 IM 时 openIm 返回 false，调用方好兜底', () => {
  assert.equal(im.imReady(), false)
  assert.equal(im.openIm(), false)
})

check('注册之后 openIm 会真的调到', () => {
  let hits = 0
  const off = im.registerImOpener(() => hits++)
  assert.equal(im.imReady(), true)
  assert.equal(im.openIm(), true)
  assert.equal(hits, 1)
  off()
  assert.equal(im.imReady(), false)
})

check('注销只清掉自己那一份 —— 严格模式下 effect 跑两遍不能把新的注销掉', () => {
  const offA = im.registerImOpener(() => {})
  let bHits = 0
  im.registerImOpener(() => bHits++) // B 覆盖了 A
  offA() // A 的 cleanup 迟到了，但当前生效的是 B，不该被清
  assert.equal(im.imReady(), true, 'B 还在，imReady 必须仍为 true')
  im.openIm()
  assert.equal(bHits, 1)
})

check('opener 抛异常时 openIm 返回 false，不往上炸', () => {
  const off = im.registerImOpener(() => {
    throw new Error('IM 那边炸了')
  })
  assert.equal(im.openIm(), false)
  off()
})

check('未读数报的是总数，且会规整', () => {
  im.setImUnread(5)
  assert.equal(im.getImUnread(), 5)
  im.setImUnread(2) // 变小也要跟上（服务端说了算，不是本地累加）
  assert.equal(im.getImUnread(), 2)
  im.setImUnread(-3)
  assert.equal(im.getImUnread(), 0, '负数当 0')
  im.setImUnread(3.7)
  assert.equal(im.getImUnread(), 3, '小数向下取整')
  im.setImUnread(NaN)
  assert.equal(im.getImUnread(), 0, 'NaN 当 0，别让红点显示 NaN')
  im.setImUnread(Infinity)
  assert.equal(im.getImUnread(), 0, 'Infinity 也当 0')
})

check('同值不重复通知', () => {
  let hits = 0
  const off = im.onImChange(() => hits++)
  im.setImUnread(4)
  im.setImUnread(4)
  im.setImUnread(4)
  assert.equal(hits, 1)
  off()
})

check('退订之后不再收到通知', () => {
  let hits = 0
  const off = im.onImChange(() => hits++)
  im.setImUnread(1)
  off()
  im.setImUnread(9)
  assert.equal(hits, 1)
})

check('一个监听者抛异常不连累其他人', () => {
  let good = 0
  const offBad = im.onImChange(() => {
    throw new Error('boom')
  })
  const offGood = im.onImChange(() => good++)
  im.setImUnread(2)
  assert.equal(good, 1)
  offBad()
  offGood()
})

check('红点文字：0 不画，超过上限显示 99+', () => {
  assert.equal(im.imUnreadLabel(0), '')
  assert.equal(im.imUnreadLabel(-1), '')
  assert.equal(im.imUnreadLabel(1), '1')
  assert.equal(im.imUnreadLabel(im.IM_UNREAD_CAP), String(im.IM_UNREAD_CAP))
  assert.equal(im.imUnreadLabel(im.IM_UNREAD_CAP + 1), `${im.IM_UNREAD_CAP}+`)
  assert.equal(im.imUnreadLabel(99999), `${im.IM_UNREAD_CAP}+`)
})

check('imUnreadLabel 不传参数时用当前未读数', () => {
  im.setImUnread(7)
  assert.equal(im.imUnreadLabel(), '7')
})

console.log(`\n✅ IM 接缝：${passed} 项检查通过`)
