/**
 * SSE 退回轮询的判据。跑：npm run test:sse
 *
 * ── 为什么值得测 ──────────────────────────────────────────
 * 2026-09-08 线上控制台：
 *   GET /api/live/events    net::ERR_QUIC_PROTOCOL_ERROR 200 (OK)
 *   GET /api/netplay/events net::ERR_QUIC_PROTOCOL_ERROR 200 (OK)
 * HTTP/3 长连接在传输层被掐断。**这类失败浏览器会一直自己重连，readyState 停在
 * CONNECTING(0)**，而三处兜底原来写的都是 `readyState === CLOSED` —— 一次都不会触发。
 * 结果：直播/联机大厅静静地停止更新，没有报错、没有降级，玩家只当「没人在播」。
 *
 * 这类 bug 完全静默（HTTP 200、XML/JSON 合法、日志安静），只能靠断言盯着。
 * 纯 node，用一个假 EventSource，不需要 DOM。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const { fallbackAfterErrors, SSE_ERROR_LIMIT } = await import('../src/services/sseFallback.ts')

let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ❌ ${name}\n     ${e.message}`)
  }
}

/** 假的 EventSource：只实现被用到的那三个成员 */
function fakeSse(readyState = 0) {
  const ls = new Map()
  return {
    readyState,
    closed: false,
    close() {
      this.closed = true
      this.readyState = 2
    },
    addEventListener(type, fn) {
      ls.set(type, [...(ls.get(type) ?? []), fn])
    },
    fire(type) {
      for (const fn of ls.get(type) ?? []) fn()
    },
  }
}

check('⚠️ 传输层断流（readyState 一直是 CONNECTING）连续失败后必须退回轮询', () => {
  const es = fakeSse(0)
  let gaveUp = 0
  fallbackAfterErrors(es, () => gaveUp++)
  for (let i = 0; i < SSE_ERROR_LIMIT - 1; i++) es.fire('error')
  assert.equal(gaveUp, 0, `不足 ${SSE_ERROR_LIMIT} 次时别急着放弃 —— 浏览器自己的重连可能会成功`)
  es.fire('error')
  assert.equal(gaveUp, 1, 'ERR_QUIC_PROTOCOL_ERROR 就是这一路：CLOSED 永远不来，只能靠计次')
  assert.equal(es.closed, true, '必须主动 close()，否则浏览器继续在不通的链路上重连')
})

check('服务端明确拒绝（CLOSED）立刻退，不用等次数', () => {
  const es = fakeSse(2)
  let gaveUp = 0
  fallbackAfterErrors(es, () => gaveUp++)
  es.fire('error')
  assert.equal(gaveUp, 1, '老后端没有这个端点时应当立刻降级')
})

check('中间真连上过就归零：偶发抖动不该把长期可用的连接判死', () => {
  const es = fakeSse(0)
  let gaveUp = 0
  fallbackAfterErrors(es, () => gaveUp++)
  for (let i = 0; i < 20; i++) {
    es.fire('error')
    es.fire('open')
  }
  assert.equal(gaveUp, 0)
  assert.equal(es.closed, false)
})

check('放弃只发生一次以后就不再重复回调（各处的 startPolling 也是幂等的）', () => {
  const es = fakeSse(0)
  let gaveUp = 0
  fallbackAfterErrors(es, () => gaveUp++)
  for (let i = 0; i < SSE_ERROR_LIMIT; i++) es.fire('error')
  assert.equal(gaveUp, 1)
  // close() 之后 readyState 变 2，再来的 error 会走 CLOSED 那一路 —— 调用方必须幂等
  es.fire('error')
  assert.equal(gaveUp, 2, '这里确实会再调一次，所以 onGiveUp 的幂等性是硬要求（见注释）')
})

check('close() 抛异常不影响降级', () => {
  const es = fakeSse(0)
  es.close = () => {
    throw new Error('boom')
  }
  let gaveUp = 0
  fallbackAfterErrors(es, () => gaveUp++)
  for (let i = 0; i < SSE_ERROR_LIMIT; i++) es.fire('error')
  assert.equal(gaveUp, 1)
})

check('⚠️ 三处 EventSource 都不许再用 `readyState === CLOSED` 当唯一判据', () => {
  for (const rel of ['src/services/live.ts', 'src/services/netplay.ts']) {
    const src = readFileSync(path.join(ROOT, rel), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.ok(
      !/EventSource\.CLOSED/.test(code),
      `${rel} 里还有 EventSource.CLOSED 判据 —— 传输层断流那一路会漏掉（见文件头注释）`,
    )
    assert.match(code, /fallbackAfterErrors\(/, `${rel} 必须走 fallbackAfterErrors`)
  }
  // 三条连接（直播大厅、联机大厅、单个房间）一条都不能漏
  const live = readFileSync(path.join(ROOT, 'src/services/live.ts'), 'utf8')
  const np = readFileSync(path.join(ROOT, 'src/services/netplay.ts'), 'utf8')
  assert.equal((live.match(/new EventSource\(/g) || []).length, (live.match(/fallbackAfterErrors\(/g) || []).length)
  assert.equal((np.match(/new EventSource\(/g) || []).length, (np.match(/fallbackAfterErrors\(/g) || []).length)
})

check('⚠️ sseFallback.ts 不许引用全局 EventSource（SSR 那侧没有这个全局，导入即抛）', () => {
  const src = readFileSync(path.join(ROOT, 'src/services/sseFallback.ts'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/\bEventSource\b/.test(code), '用数值常量，别取全局')
})

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
