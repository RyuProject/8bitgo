/**
 * IM 连接状态机的单元测试。跑：npm run test:im-session
 *
 * 这一份是 2026-09-07 那次自查的产物。当时的测试只 grep 了两个防护的**代码形状**，
 * 形状在、但两个都能绕过 —— 于是一个跨账号冒充漏洞被测试盖住了：
 *
 *   A 点私信（SDK 分包在下载）-> A 登出（hardReset 里 chat 还是 null，early return，
 *   在飞的那次一个字没动）-> B 登录后点私信 -> 拿到 A 那次的 promise
 *   -> 带着 A 的 sig 登录 -> B 看到 A 的会话、以 A 的身份发消息
 *
 * 所以这里测的是**行为**，不是代码长什么样：真的起一次异步、真的在中途登出、
 * 真的换个人再起一次，然后断言第二个人绝对拿不到第一个人的连接。
 */
import assert from 'node:assert/strict'
import {
  __resetImSession,
  currentEpoch,
  imState,
  imStateDetail,
  inflightUserId,
  invalidate,
  isStale,
  onImStateChange,
  setState,
  setStateIf,
  startOnce,
} from '../src/services/imSession.ts'

let n = 0
const check = async (name, fn) => {
  n++
  __resetImSession()
  try {
    await fn()
    console.log('  ✓ ' + name)
  } catch (e) {
    console.log('  ✗ ' + name)
    throw e
  }
}

/** 一个可以从外面决定何时完成的 promise */
function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

console.log('\n一、状态与通知')

await check('初始是 off，改状态会通知，同值不重复通知', () => {
  assert.equal(imState(), 'off')
  let hits = 0
  const off = onImStateChange(() => hits++)
  setState('connecting')
  assert.equal(hits, 1)
  setState('connecting')
  assert.equal(hits, 1, '同值不该再通知（否则每次心跳都白重渲染一次）')
  setState('connecting', '有细节了')
  assert.equal(hits, 2, 'detail 变了也算变')
  assert.equal(imStateDetail(), '有细节了')
  off()
  setState('ready')
  assert.equal(hits, 2, '退订之后不该再收到')
})

await check('一个监听者抛错不影响其他人', () => {
  const seen = []
  onImStateChange(() => {
    throw new Error('boom')
  })
  onImStateChange(() => seen.push(imState()))
  setState('ready')
  assert.deepEqual(seen, ['ready'])
})

console.log('\n二、epoch：旧代的异步改不动当前状态')

await check('setStateIf 认代：旧代写不进去', () => {
  const e = currentEpoch()
  assert.ok(setStateIf(e, 'connecting'))
  assert.equal(imState(), 'connecting')
  invalidate()
  assert.ok(isStale(e), '作废之后旧 epoch 应该过期')
  assert.equal(setStateIf(e, 'error', '旧代的报错'), false)
  assert.equal(imState(), 'connecting', '旧代不该改动状态')
  assert.equal(imStateDetail(), '', '旧代的 detail 也不该写进来')
})

await check('⭐ 登出时那次失败的 login 不会把状态写成 error', async () => {
  // 真实场景：A 的 login 在飞 -> A 登出（invalidate）-> login 抛错 -> 想 setState('error')
  const d = deferred()
  const started = startOnce('A', async (e) => {
    try {
      await d.promise
    } catch (err) {
      setStateIf(e, 'error', String(err.message))
      return false
    }
    return true
  })
  invalidate()
  setState('off') // 登出后的同步状态
  d.reject(new Error('login 失败'))
  assert.equal(await started, false)
  assert.equal(imState(), 'off', '已登出的模块不该停在 error 上')
})

console.log('\n三、防重入与换账号（那个漏洞）')

await check('同一个人、同一代、在飞时复用同一次', async () => {
  const d = deferred()
  let runs = 0
  const run = async () => {
    runs++
    return d.promise
  }
  const p1 = startOnce('A', run)
  const p2 = startOnce('A', run)
  assert.equal(runs, 1, '不该起第二次')
  assert.equal(p1, p2, '应该是同一个 promise')
  assert.equal(inflightUserId(), 'A')
  d.resolve(true)
  assert.equal(await p1, true)
  assert.equal(inflightUserId(), '', '完成后要把在飞记录清掉')
})

await check('⭐⭐⭐ 换人时即使没有任何显式作废，也不能复用上一个人在飞的那次', async () => {
  /*
    这一条是补上来的，因为下面那条（带 invalidate 的版本）**盖住了真正的 bug**：
    它先调 invalidate() 清掉了 inflight，于是第一版那个
    `if (starting) return starting` 也能过 —— 变异测试一试就露了。

    真实里「登出」和「另一个人开始连」之间不保证有 invalidate：登出的 effect 可能
    还没被 React 冲刷、或者调用方走的是别的入口。所以 startOnce 必须**自己**
    按 userId 判断，不能依赖外面先作废。
  */
  const dA = deferred()
  let aFinished = 'A 没跑完'
  const pA = startOnce('A', async (e) => {
    await dA.promise
    aFinished = isStale(e) ? 'A 自己收摊了' : 'A 连上了'
    return !isStale(e)
  })
  const eA = currentEpoch()

  // 注意：这里**故意不调 invalidate()**
  const dB = deferred()
  const pB = startOnce('B', async () => dB.promise)

  assert.notEqual(pA, pB, '⭐ B 绝不能拿到 A 那次（那次带着 A 的 sig）')
  assert.equal(inflightUserId(), 'B', '在飞的那次应该已经换成 B 的')
  assert.ok(isStale(eA), 'A 那一代必须被作废，好让它的续段自己收摊')

  dA.resolve()
  assert.equal(await pA, false)
  assert.equal(aFinished, 'A 自己收摊了')
  dB.resolve(true)
  assert.equal(await pB, true)
})

await check('⭐⭐ 换账号时绝不复用上一个人在飞的那次（跨账号冒充）', async () => {
  /*
    这一条就是那个漏洞。第一版的写法是 `if (starting) return starting`，
    完全不看 starting 属于谁 —— B 会原样拿到 A 那次带着 A 的 sig 的连接。
  */
  const dA = deferred()
  const order = []
  const pA = startOnce('A', async (e) => {
    await dA.promise
    // A 的续段跨了 await，必须自己发现已经不是这一代了
    if (isStale(e)) {
      order.push('A 自己收摊了')
      return false
    }
    order.push('A 连上了')
    return true
  })
  const eA = currentEpoch()

  // A 登出（此时 SDK 分包还在下载，什么都还没建立）
  invalidate()

  // B 登录后也要连
  const dB = deferred()
  const pB = startOnce('B', async () => {
    await dB.promise
    order.push('B 连上了')
    return true
  })

  assert.notEqual(pA, pB, '⭐ B 拿到的必须是新的一次，不能是 A 那次')
  assert.equal(inflightUserId(), 'B')
  assert.ok(isStale(eA), 'A 那一代必须已经过期')

  dA.resolve()
  assert.equal(await pA, false, 'A 那次必须以失败收场')
  dB.resolve()
  assert.equal(await pB, true)
  assert.deepEqual(order, ['A 自己收摊了', 'B 连上了'])
})

await check('⭐ 同一个人但上一代已作废：也要重新起，不能复用', async () => {
  // 场景：连接出错 -> 用户点「重新连接」（invalidate）-> 那次点击不该拿到已被丢弃的旧 promise
  const d1 = deferred()
  let runs = 0
  const p1 = startOnce('A', async () => {
    runs++
    return d1.promise
  })
  invalidate()
  const d2 = deferred()
  const p2 = startOnce('A', async () => {
    runs++
    return d2.promise
  })
  assert.equal(runs, 2, '作废之后必须真的重新起一次')
  assert.notEqual(p1, p2, '重连不能返回被丢弃的那次')
  d1.resolve(false)
  d2.resolve(true)
  assert.equal(await p2, true)
})

await check('在飞的那次完成时，只清自己那一条', async () => {
  // A 在飞 -> 作废 -> B 在飞 -> A 完成。A 的 finally 不能把 B 的记录清掉
  const dA = deferred()
  startOnce('A', async () => dA.promise)
  invalidate()
  const dB = deferred()
  startOnce('B', async () => dB.promise)
  assert.equal(inflightUserId(), 'B')
  dA.resolve(false)
  await new Promise((r) => setImmediate(r))
  assert.equal(inflightUserId(), 'B', '⭐ A 的收尾不能把 B 的在飞记录清掉')
  dB.resolve(true)
})

await check('run 直接抛出时，在飞记录也要清掉（不然永远起不来第二次）', async () => {
  await assert.rejects(
    startOnce('A', async () => {
      throw new Error('炸了')
    }),
    /炸了/,
  )
  assert.equal(inflightUserId(), '', '抛出之后必须清掉，否则模块永久卡死')
  let ran = false
  await startOnce('A', async () => {
    ran = true
    return true
  })
  assert.ok(ran, '抛过一次之后还得能再起')
})

await check('epoch 单调递增，不会绕回', () => {
  const a = currentEpoch()
  invalidate()
  invalidate()
  assert.equal(currentEpoch(), a + 2)
  assert.ok(isStale(a))
  assert.ok(!isStale(a + 2))
})

console.log(`\n✅ IM 连接状态机：${n} 项检查通过`)
