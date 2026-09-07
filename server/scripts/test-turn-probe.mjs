/**
 * TURN 主动探活 + 下发时切换（2026-09-07 新增）
 *
 *   cd server && npm run test:turn-probe
 *
 * 分五节：
 *   一、报文编解码 —— 拿**手写的字节**当基准，不拿自己的编码器当基准
 *   二、MESSAGE-INTEGRITY 覆盖范围 —— 整个实现里唯一「写错了对方只回 401 也不告诉你为什么」的地方
 *   三、Allocate 流程 —— 对着一个假 coturn 跑，含**把线上那次凭证过期原样复现**
 *   四、up / down 状态机 —— 判死要慢（连续两次）、恢复要快（一次就够）、凭证必须每次现签
 *   五、下发时真的切了 —— 死的那路从 iceServers 里消失，以及「摘完一路不剩」时的安全阀
 *
 * ⚠️ **这份测试证明不了的事**：MESSAGE-INTEGRITY 到底算得对不对、你那台 coturn 的
 * realm / secret / 中继端口段对不对 —— 假服务端和探针共用同一套编码器，符号相反的错误会互相抵消。
 * 那一步只有真机能证明：`cd server && npm run turn:probe`。
 * 这里能钉住的是「流程、状态机、切换决策」，以及第一二节那些手写字节。
 */
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { createHash, createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import express from 'express'

import {
  ATTR,
  CLASS,
  METHOD,
  appendIntegrity,
  attrBuf,
  decodeMessage,
  encodeMessage,
  errorCode,
  longTermKey,
  msgType,
  parseTurnUrl,
  parseType,
  xorAddress,
} from '../src/turnStun.js'

let failed = 0
const check = (name, fn) => {
  try {
    const r = fn()
    if (r instanceof Promise)
      return r.then(
        () => console.log(`  ✅ ${name}`),
        (e) => {
          failed++
          console.error(`  ❌ ${name}\n     ${e.message}`)
        },
      )
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ❌ ${name}\n     ${e.message}`)
  }
  return Promise.resolve()
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const u32 = (n) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n, 0)
  return b
}

/* ================ 一、报文编解码（基准是手写字节） ================ */

console.log('一、报文编解码（基准是手写字节，不是自己的编码器）')

await check('⭐ 消息类型那 14 位是被切成三段的，不是「方法<<4|类别」', () => {
  // Allocate = 0x003；请求 0x0003 / 成功 0x0103 / 失败 0x0113
  assert.equal(msgType(METHOD.ALLOCATE, CLASS.REQUEST), 0x0003)
  assert.equal(msgType(METHOD.ALLOCATE, CLASS.SUCCESS), 0x0103)
  assert.equal(msgType(METHOD.ALLOCATE, CLASS.ERROR), 0x0113)
  assert.equal(msgType(METHOD.REFRESH, CLASS.REQUEST), 0x0004)
  assert.deepEqual(parseType(0x0113), { method: 0x003, cls: CLASS.ERROR })
  assert.deepEqual(parseType(0x0103), { method: 0x003, cls: CLASS.SUCCESS })
})

// 手写一份 coturn 真会回的 401：ERROR-CODE + REALM + NONCE
const TX = Buffer.from('000102030405060708090a0b', 'hex')
const REAL_401 = Buffer.from(
  '01130030' +
    '2112a442' +
    '000102030405060708090a0b' +
    '00090010' + '00000401' + '556e617574686f72697a6564' + // 401 "Unauthorized"
    '0014000b' + '38626974676f2e74657374' + '00' +          // realm "8bitgo.test"（11 字节 + 1 补零）
    '00150008' + '6162636465663031',                        // nonce "abcdef01"
  'hex',
)

await check('⭐ 能解开手写的 401（长度字段 / 补零 / 属性偏移全对得上）', () => {
  const m = decodeMessage(REAL_401)
  assert.ok(m, '解不出来')
  assert.equal(m.method, METHOD.ALLOCATE)
  assert.equal(m.cls, CLASS.ERROR)
  assert.ok(m.transactionId.equals(TX))
  assert.equal(m.attrs.get(ATTR.REALM).toString('utf8'), '8bitgo.test')
  assert.equal(m.attrs.get(ATTR.NONCE).toString('utf8'), 'abcdef01')
  const { code, reason } = errorCode(m.attrs.get(ATTR.ERROR_CODE))
  assert.equal(code, 401, 'ERROR-CODE 是「类*100+号」，前两字节保留')
  assert.equal(reason, 'Unauthorized')
})

await check('⭐ XOR-RELAYED-ADDRESS 要解异或 —— 不解就会把中继地址读成垃圾', () => {
  // 手算：203.0.113.7:49173，端口 ^ 0x2112、地址 ^ 0x2112a442
  const v = Buffer.from('0001' + 'e107' + 'ea12d545', 'hex')
  assert.equal(xorAddress(v, TX), '203.0.113.7:49173')
  assert.equal(xorAddress(Buffer.alloc(4), TX), null, '长度不够要给 null，不能瞎读')
})

await check('属性长度字段写「值的真实长度」，但后面补零到 4 字节', () => {
  const a = attrBuf(ATTR.USERNAME, 'abc') // 3 字节 → 值长 3、总长 8
  assert.equal(a.readUInt16BE(2), 3)
  assert.equal(a.length, 8)
  assert.equal(attrBuf(ATTR.NONCE, 'abcd').length, 8, '正好 4 字节时不该多补一轮')
})

await check('编码 → 解码来回一致', () => {
  const msg = encodeMessage({
    method: METHOD.ALLOCATE,
    transactionId: TX,
    attrs: [
      [ATTR.REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0])],
      [ATTR.SOFTWARE, '8bitgo-turn-probe'],
    ],
  })
  const m = decodeMessage(msg)
  assert.equal(m.attrs.get(ATTR.REQUESTED_TRANSPORT)[0], 17, '17 = UDP')
  assert.equal(m.attrs.get(ATTR.SOFTWARE).toString('utf8'), '8bitgo-turn-probe')
  assert.equal(decodeMessage(Buffer.alloc(20)), null, 'magic cookie 不对要拒掉')
})

await check('⭐ turn: / turns: 的默认值按 RFC 7065，别拿 new URL() 解', () => {
  assert.deepEqual(parseTurnUrl('turn:t.example.com'), {
    host: 't.example.com',
    port: 3478,
    secure: false,
    transport: 'udp',
    raw: 'turn:t.example.com',
  })
  // turns: 默认是 TCP(TLS) 5349，不是 UDP 3478
  assert.equal(parseTurnUrl('turns:t.example.com').port, 5349)
  assert.equal(parseTurnUrl('turns:t.example.com').transport, 'tcp')
  assert.equal(parseTurnUrl('turn:t.example.com:3478?transport=tcp').transport, 'tcp')
  // IPv6 的方括号
  assert.equal(parseTurnUrl('turn:[2001:db8::1]:3478').host, '2001:db8::1')
  assert.equal(parseTurnUrl('turn:[2001:db8::1]:3478').port, 3478)
  assert.equal(parseTurnUrl('https://x'), null)
})

/* ================ 二、MESSAGE-INTEGRITY 的覆盖范围 ================ */

console.log('\n二、MESSAGE-INTEGRITY 覆盖到哪儿（唯一一处「错了只回 401 不说为什么」的地方）')

await check('长期凭证的密钥就是 MD5("用户名:realm:密码")', () => {
  assert.ok(longTermKey('u', 'r', 'p').equals(createHash('md5').update('u:r:p').digest()))
})

await check('⭐ HMAC 覆盖的是「长度字段已经改成含这条 integrity」之后的前半段（+24）', () => {
  const key = longTermKey('1788792506:probe', '8bitgo.test', 'pw')
  const msg = encodeMessage({ method: METHOD.ALLOCATE, transactionId: TX, attrs: [[ATTR.USERNAME, 'ab']] })
  // 属性体 = 4 头 + 2 值 + 2 补零 = 8
  assert.equal(msg.readUInt16BE(2), 8)
  assert.equal(msg.length, 28)

  const signed = appendIntegrity(msg, key)
  assert.equal(signed.readUInt16BE(2), 8 + 24, '长度字段必须 = 原属性体 + 4 头 + 20 值')
  assert.equal(signed.length, 20 + 8 + 24)

  // 独立复算一遍：先把长度改掉，再对前 28 字节做 HMAC
  const covered = Buffer.from(msg)
  covered.writeUInt16BE(32, 2)
  const want = createHmac('sha1', key).update(covered).digest()
  assert.ok(want.equals(signed.subarray(32, 52)), 'HMAC 覆盖范围不对 —— coturn 会一律回 401')

  // 反证：拿「没改长度」的版本算出来的必须不一样，否则这条断言什么都没测到
  const naive = createHmac('sha1', key).update(msg).digest()
  assert.ok(!naive.equals(want), '改不改长度算出来一样？那这条测试是假的')
})

/* ================ 假 coturn ================ */

/**
 * 一个够真的假 coturn（UDP）。
 * `secret` 模式复刻 coturn 的 `use-auth-secret`：密码 = base64(HMAC-SHA1(secret, username))，
 * 并且**校验 username 里的过期时间戳** —— 线上那次 CDN 缓存事故就是死在这一步。
 */
function fakeTurn({ secret, realm = '8bitgo.test', mode = 'ok', checkExpiry = true } = {}) {
  const st = { packets: 0, refresh0: 0, integrityOk: 0, integrityBad: 0, expired: 0, mode }
  const sock = dgram.createSocket('udp4')
  let nonce = 'nonce-1'

  /** 独立实现的校验：靠**扫属性**找到 integrity 的位置，不复用 appendIntegrity 的构造过程 */
  const verify = (buf, key) => {
    let off = 20
    const end = 20 + buf.readUInt16BE(2)
    while (off + 4 <= end) {
      const t = buf.readUInt16BE(off)
      const l = buf.readUInt16BE(off + 2)
      if (t === ATTR.MESSAGE_INTEGRITY) {
        const covered = Buffer.from(buf.subarray(0, off))
        covered.writeUInt16BE(off - 20 + 24, 2)
        return createHmac('sha1', key).update(covered).digest().equals(buf.subarray(off + 4, off + 4 + l))
      }
      off += 4 + l + ((4 - (l % 4)) % 4)
    }
    return false
  }
  const errMsg = (method, tx, code, reason, withAuth) =>
    encodeMessage({
      method,
      cls: CLASS.ERROR,
      transactionId: tx,
      attrs: [
        [
          ATTR.ERROR_CODE,
          Buffer.concat([Buffer.from([0, 0, Math.floor(code / 100), code % 100]), Buffer.from(reason, 'utf8')]),
        ],
        ...(withAuth ? [[ATTR.REALM, realm], [ATTR.NONCE, nonce]] : []),
      ],
    })

  sock.on('message', (buf, rinfo) => {
    st.packets++
    if (st.mode === 'silent') return
    const m = decodeMessage(buf)
    if (!m) return
    const send = (b) => sock.send(b, rinfo.port, rinfo.address)

    if (!m.attrs.has(ATTR.MESSAGE_INTEGRITY))
      return send(errMsg(m.method, m.transactionId, 401, 'Unauthorized', true))

    const username = m.attrs.get(ATTR.USERNAME).toString('utf8')
    const password = createHmac('sha1', secret).update(username).digest('base64')
    const key = longTermKey(username, m.attrs.get(ATTR.REALM).toString('utf8'), password)
    if (!verify(buf, key)) {
      st.integrityBad++
      return send(errMsg(m.method, m.transactionId, 401, 'Unauthorized', true))
    }
    st.integrityOk++

    // coturn 会校验 username 里的时间戳 —— 这一条就是线上那次事故的机理
    if (checkExpiry && Number(username.split(':')[0]) < Math.floor(Date.now() / 1000)) {
      st.expired++
      return send(errMsg(m.method, m.transactionId, 401, 'Unauthorized', true))
    }
    if (st.mode === 'bad-cred') return send(errMsg(m.method, m.transactionId, 401, 'Unauthorized', true))
    if (st.mode === 'wrong-realm') return send(errMsg(m.method, m.transactionId, 441, 'Wrong realm', false))
    if (st.mode === 'stale-once' && m.attrs.get(ATTR.NONCE).toString('utf8') === 'nonce-1') {
      nonce = 'nonce-2'
      return send(errMsg(m.method, m.transactionId, 438, 'Stale nonce', true))
    }
    if (m.method === METHOD.REFRESH) {
      const lt = m.attrs.get(ATTR.LIFETIME)
      if (lt && lt.readUInt32BE(0) === 0) st.refresh0++
      return send(
        encodeMessage({
          method: METHOD.REFRESH,
          cls: CLASS.SUCCESS,
          transactionId: m.transactionId,
          attrs: [[ATTR.LIFETIME, u32(0)]],
        }),
      )
    }
    const attrs =
      st.mode === 'no-relay'
        ? [[ATTR.LIFETIME, u32(600)]]
        : [[ATTR.XOR_RELAYED_ADDRESS, Buffer.from('0001e107ea12d545', 'hex')], [ATTR.LIFETIME, u32(600)]]
    send(encodeMessage({ method: METHOD.ALLOCATE, cls: CLASS.SUCCESS, transactionId: m.transactionId, attrs }))
  })

  return new Promise((res) => {
    sock.bind(0, '127.0.0.1', () =>
      res({ st, url: `turn:127.0.0.1:${sock.address().port}?transport=udp`, close: () => sock.close() }),
    )
  })
}

const SECRET = 's3cr3t-for-tests'
const signFor = (label = 'probe', ttlSec = 3600) => {
  const username = `${Math.floor(Date.now() / 1000) + ttlSec}:${label}`
  return { username, credential: createHmac('sha1', SECRET).update(username).digest('base64') }
}

/* ================ 三、Allocate 流程 ================ */

console.log('\n三、Allocate 流程（对着假 coturn 跑）')

const { probeTurnUrl } = await import('../src/turnProbe.js')
const srv = await fakeTurn({ secret: SECRET })

await check('⭐ 通的时候要拿回**中继地址** —— 只有它能证明「TURN 能用」', async () => {
  const r = await probeTurnUrl({ url: srv.url, ...signFor(), timeoutMs: 1500 })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.relay, '203.0.113.7:49173')
  assert.ok(r.rttMs >= 0)
  assert.equal(srv.st.integrityOk > 0, true, 'MESSAGE-INTEGRITY 得真的过了校验，不是被跳过')
})

await check('⭐ 拿到分配后要发 lifetime=0 退掉 —— 否则每探一次就在 coturn 上留一个 10 分钟的中继', async () => {
  const before = srv.st.refresh0
  await probeTurnUrl({ url: srv.url, ...signFor(), timeoutMs: 1500 })
  await sleep(60)
  assert.ok(srv.st.refresh0 > before, '没退掉分配')
})

await check('⭐ 过期凭证 → 401，而且错误里要指得出根因（这就是线上那次事故）', async () => {
  const stale = `${Math.floor(Date.now() / 1000) - 7200}:probe` // 两小时前签的
  const r = await probeTurnUrl({
    url: srv.url,
    username: stale,
    credential: createHmac('sha1', SECRET).update(stale).digest('base64'),
    timeoutMs: 1500,
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, 401)
  assert.match(r.error, /CDN/, '401 的解释必须先指向「ICE 接口被 CDN 缓存」')
  assert.match(r.error, /static-auth-secret/, '第二种可能（secret 不一致）也要提')
  assert.ok(srv.st.expired > 0, '假服务端得真的是因为时间戳过期才拒的')
})

await check('凭证不对 → 401（整段签名校验没过）', async () => {
  const r = await probeTurnUrl({ url: srv.url, username: signFor().username, credential: 'wrong', timeoutMs: 1500 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 401)
})

await check('⭐ 438 Stale Nonce 要拿新 nonce 再来一次，不能当失败', async () => {
  const s = await fakeTurn({ secret: SECRET, mode: 'stale-once' })
  const r = await probeTurnUrl({ url: s.url, ...signFor(), timeoutMs: 1500 })
  s.close()
  assert.equal(r.ok, true, `438 之后没重试：${r.error}`)
})

await check('⭐ 给了成功响应但没有中继地址 = 不算通（中继端口段没放行的形状）', async () => {
  const s = await fakeTurn({ secret: SECRET, mode: 'no-relay' })
  const r = await probeTurnUrl({ url: s.url, ...signFor(), timeoutMs: 1500 })
  s.close()
  assert.equal(r.ok, false, '握手过了就当通 = 把最常见的一种死法漏掉')
  assert.match(r.error, /中继端口段/)
})

await check('441 realm 不匹配 → 指向 turnserver.conf', async () => {
  const s = await fakeTurn({ secret: SECRET, mode: 'wrong-realm' })
  const r = await probeTurnUrl({ url: s.url, ...signFor(), timeoutMs: 1500 })
  s.close()
  assert.equal(r.ok, false)
  assert.match(r.error, /realm/)
})

await check('⭐ 对方不回包 → 超时判失败，而且 UDP 要重传过（丢一个包不该误判成挂了）', async () => {
  const s = await fakeTurn({ secret: SECRET, mode: 'silent' })
  const r = await probeTurnUrl({ url: s.url, ...signFor(), timeoutMs: 2200 })
  assert.equal(r.ok, false)
  assert.match(r.error, /超时/)
  assert.ok(s.st.packets >= 2, `只发了 ${s.st.packets} 个包 —— 没重传，丢一个包就会误判`)
  s.close()
})

await check('地址解析不了 / 没凭证 → 直接判失败，不发包', async () => {
  assert.equal((await probeTurnUrl({ url: 'http://x', ...signFor() })).ok, false)
  assert.equal((await probeTurnUrl({ url: srv.url, username: '', credential: '' })).ok, false)
})

await check('turns: + transport=udp（DTLS）要标成 skipped，不能算「不通」', async () => {
  const r = await probeTurnUrl({ url: 'turns:127.0.0.1:1?transport=udp', ...signFor() })
  assert.equal(r.skipped, true, '当成不通会把一路好的 TURN 误判死')
  assert.equal(r.ok, false)
})

/* ================ 四、up / down 状态机 ================ */

console.log('\n四、up / down 状态机（判死要慢、恢复要快、凭证必须现签）')

const { registerTurnPath, turnPathState, probeNow, _resetTurnHealth } = await import('../src/turnProbe.js')

await check('⭐ 一次失败不算死（连续两次才判 down）—— 一个丢包不该踢掉一路 TURN', async () => {
  _resetTurnHealth()
  const s = await fakeTurn({ secret: SECRET })
  registerTurnPath('t', [s.url], () => signFor())
  await probeNow()
  assert.equal(turnPathState('t'), 'up')
  s.st.mode = 'bad-cred'
  await probeNow()
  assert.equal(turnPathState('t'), 'up', '第一次失败就判死 = 抖动一下就切走')
  await probeNow()
  assert.equal(turnPathState('t'), 'down', '连续两次还不判死？那探活白做')
  s.close()
})

await check('⭐ 恢复只要一次成功（判死慢、恢复快，方向不能反）', async () => {
  _resetTurnHealth()
  const s = await fakeTurn({ secret: SECRET, mode: 'bad-cred' })
  registerTurnPath('t', [s.url], () => signFor())
  await probeNow()
  await probeNow()
  assert.equal(turnPathState('t'), 'down')
  s.st.mode = 'ok'
  await probeNow()
  assert.equal(turnPathState('t'), 'up')
  s.close()
})

await check('⭐ 恢复之后失败计数要归零 —— 否则刚恢复的那路，一次抖动就又被踢掉', async () => {
  _resetTurnHealth()
  const s = await fakeTurn({ secret: SECRET })
  registerTurnPath('t', [s.url], () => signFor())
  s.st.mode = 'bad-cred'
  await probeNow()
  await probeNow()
  assert.equal(turnPathState('t'), 'down')
  s.st.mode = 'ok'
  await probeNow()
  assert.equal(turnPathState('t'), 'up')
  // 关键：这一次失败**不该**立刻判死 —— 计数没归零的话 fails 会从 2 接着往上数
  s.st.mode = 'bad-cred'
  await probeNow()
  assert.equal(turnPathState('t'), 'up', '恢复后没把 fails 归零：判死门槛塌成「一次即死」，会来回抖')
  s.close()
})

await check('⭐ 凭证必须**每轮现签** —— 存死凭证的话没人开局一小时后就会自己 401', async () => {
  _resetTurnHealth()
  const s = await fakeTurn({ secret: SECRET })
  let mints = 0
  registerTurnPath('t', [s.url], () => {
    mints++
    return signFor()
  })
  await probeNow()
  await probeNow()
  await probeNow()
  assert.equal(mints, 3, `签了 ${mints} 次 —— 存死凭证会把「没人玩」误判成「TURN 挂了」`)
  s.close()
})

await check('还没探过 = unknown，绝不能当成 down', () => {
  _resetTurnHealth()
  registerTurnPath('t', ['turn:127.0.0.1:1'], () => signFor())
  assert.equal(turnPathState('t'), 'unknown')
})

await check('地址换了就当一路新的，历史判定作废', async () => {
  _resetTurnHealth()
  const s = await fakeTurn({ secret: SECRET, mode: 'bad-cred' })
  registerTurnPath('t', [s.url], () => signFor())
  await probeNow()
  await probeNow()
  assert.equal(turnPathState('t'), 'down')
  registerTurnPath('t', ['turn:1.2.3.4:3478'], () => signFor())
  assert.equal(turnPathState('t'), 'unknown', '换了地址还沿用旧结论 = 运维换完服务器要等到下一轮才恢复')
  s.close()
})

/* ================ 五、下发时真的切了 ================ */

console.log('\n五、下发时真的切了（以及「摘完一路不剩」的安全阀）')

const selfSrv = await fakeTurn({ secret: SECRET })
const mgdSrv = await fakeTurn({ secret: SECRET, checkExpiry: false })
const MGD_USER = '9999999999:managed'
const MGD_PASS = createHmac('sha1', SECRET).update(MGD_USER).digest('base64')

process.env.TURN_URLS = selfSrv.url
process.env.TURN_SECRET = SECRET
process.env.TURN_BACKUP_URLS = mgdSrv.url
process.env.TURN_BACKUP_USERNAME = MGD_USER
process.env.TURN_BACKUP_CREDENTIAL = MGD_PASS
process.env.TURN_PROBE_TIMEOUT_MS = '1200'
delete process.env.TURN_CF_KEY_ID
delete process.env.TURN_CF_API_TOKEN

const { iceRouter, registerTurnProbeTargets } = await import('../src/routes/ice.js')
const app = express()
app.use('/api/netplay/ice', iceRouter)
const http = createServer(app)
await new Promise((r) => http.listen(0, r))
const ice = async () => (await fetch(`http://127.0.0.1:${http.address().port}/api/netplay/ice`)).json()
const urlsOf = (d) => d.iceServers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]))

_resetTurnHealth()
await registerTurnProbeTargets()

await check('两路都好 → 都下发，turnDropped 是空的', async () => {
  await probeNow()
  const d = await ice()
  assert.deepEqual(d.turnSources, ['self-hosted', 'managed'])
  assert.deepEqual(d.turnDropped, [])
  assert.equal(d.hasTurn, true)
  assert.equal(d.turnHealth['self-hosted'].state, 'up')
  assert.ok(urlsOf(d).includes(selfSrv.url) && urlsOf(d).includes(mgdSrv.url))
})

await check('⭐ 自建那路死了 → **从 iceServers 里消失**，turnDropped 记着它', async () => {
  selfSrv.st.mode = 'bad-cred'
  await registerTurnProbeTargets()
  await probeNow()
  await probeNow()
  const d = await ice()
  assert.deepEqual(d.turnDropped, ['self-hosted'], '这就是「切换发生过」的凭据')
  assert.deepEqual(d.turnSources, ['managed'])
  assert.equal(urlsOf(d).includes(selfSrv.url), false, '死的那路还发出去 = 白耗浏览器的候选收集时间')
  assert.equal(d.hasTurn, true, '还剩一路活的，hasTurn 该是 true')
})

await check('⭐ 安全阀：两路都被判死时**照旧全发**，但 hasTurn 如实报 false', async () => {
  mgdSrv.st.mode = 'bad-cred'
  await probeNow()
  await probeNow()
  const d = await ice()
  const u = urlsOf(d)
  assert.ok(u.includes(selfSrv.url) && u.includes(mgdSrv.url), '摘光了会让所有人退回纯 STUN —— 一到两成必然连不通')
  assert.deepEqual(d.turnDropped, [], '没真摘，就不该报「摘了」')
  assert.equal(d.hasTurn, false, '一路活的都没有还报 true = 骗观众端「有中继」')
})

await check('恢复之后又回到下发里', async () => {
  selfSrv.st.mode = 'ok'
  mgdSrv.st.mode = 'ok'
  await probeNow()
  const d = await ice()
  assert.deepEqual(d.turnSources, ['self-hosted', 'managed'])
  assert.equal(d.hasTurn, true)
})

await check('⭐ 判定为 unknown 时一律照发 —— 探活还没跑完不能让站点先瘸一条腿', async () => {
  _resetTurnHealth()
  await registerTurnProbeTargets()
  const d = await ice()
  assert.deepEqual(d.turnSources, ['self-hosted', 'managed'])
  assert.equal(d.hasTurn, true)
  assert.equal(d.turnHealth['self-hosted'].state, 'unknown')
})

await check('expiry 取最早的那个（托管那路固定账号不会过期，不进 expiry）', async () => {
  const d = await ice()
  assert.ok(d.expiry > Math.floor(Date.now() / 1000), 'expiry 应该在将来')
  assert.ok(d.expiry - Math.floor(Date.now() / 1000) <= d.ttl + 5)
})

selfSrv.close()
mgdSrv.close()
srv.close()
http.close()

console.log(failed ? `\n${failed} 项失败` : '\nTURN 探活测试全部通过 ✅')
process.exit(failed ? 1 : 0)
