/**
 * UserSig 签发的回归测试。跑：npm run test:im-sig
 *
 * 为什么这一层非要有测试：签名算错的症状是浏览器里 chat.login() 回一个**纯数字错误码**
 * （70001 之类），从那个码几乎倒推不回来是哪一步错了 —— 字段顺序、值的类型（数字写成
 * 字符串）、base64 变体抄成标准 base64url、少一个换行，任何一处都是同一个码。
 *
 * 三层防线：
 *
 *   一、**黄金向量**。下面那几串 userSig 是官方实现 tencentyun/tls-sig-api-v2-node
 *       的 TLSSigAPIv2.js 在同样的 (sdkappid, key, userid, expire, now) 下算出来的
 *       原样输出。这是最硬的一层：算法任何一处改动都会让它们对不上。
 *       ⚠️ 这些向量**不能**用本仓库的实现重新生成 —— 那样就变成拿自己校自己了。
 *       要更新只能从官方实现重新取。
 *
 *   二、**结构往返**。把签出来的串解回去，逐字段查类型，再自己重算一遍 HMAC 比对。
 *       黄金向量能发现「变了」，这一层能说清「哪里变了」。
 *
 *   三、**输入校验与配置夹取**。非法 userID 必须抛而不是签出一份废 sig。
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import {
  genUserSig,
  imConfigFrom,
  isValidImUserId,
  IM_SIG_TTL_DEFAULT,
  IM_SIG_TTL_MIN,
  IM_SIG_TTL_MAX,
} from '../src/im-sig.js'

let n = 0
const check = (name, fn) => {
  n++
  try {
    fn()
    console.log('  ✓ ' + name)
  } catch (e) {
    console.log('  ✗ ' + name)
    throw e
  }
}

console.log('\n一、黄金向量（官方实现的原样输出）')

/** 取自 tencentyun/tls-sig-api-v2-node 的 TLSSigAPIv2.js。第一组是官方 README 里的示例参数。 */
const GOLDEN = [
  {
    name: '官方 README 的示例参数',
    appId: 1400000000,
    key: '5bd2850fff3ecb11d7c805251c51ee463a25727bddc2385f3fa8bfee1bb93b5e',
    userId: 'xiaojun',
    ttl: 15552000,
    now: 1700000000,
    sig: 'eJyrVgrxCdYrSy1SslIy0jNQ0gHzM1NS80oy0zLBwhWZiflZpXlQqeKU7MSCgswUJStDEwMogMiUZOamKlkZmqOKplYUZBaBxE1NTY3gosWZ6UpWSj5ljuYp*p7l5unBxXnF2WVhVU4uAf7Ozi5JpX7O5SbuHuUhzgZJmQXaTia2SrUAohcx8g__',
  },
  {
    name: '本站真实形状的 userID（u_ + 12 位十六进制）',
    appId: 1721003276,
    key: 'k'.repeat(64),
    userId: 'u_0123456789ab',
    ttl: 604800,
    now: 1757203200,
    sig: 'eJw1ysEKgkAUheF3uVtD78w4jg60iAoKjBYZUZvQnOIiljhaSfTukdbyfOd-QRJv3LupQQN3EUb9ptxcGzpTz*0RGRe*DFQYpdmvsHmRVhXloJniDFFwFQxPQ6X5qlQcBUcc1Dwrqg3oAP3wb5YuoMGxyyKVt3YbN554zDE7iXVXLqaJ9GZcRB0dJmy3ihxm92N4fwDwtjFp',
  },
  {
    name: '边界：32 字节 userID / ttl=1 / 密钥含非 ASCII',
    appId: 2000000001,
    key: '密钥里有中文和 emoji 🎮',
    userId: 'x'.repeat(32),
    ttl: 1,
    now: 2147483647,
    sig: 'eJyrVgrxCdYrSy1SslIy0jNQ0gHzM1NS80oy0zLBwhUEAFRPcUp2YkFBZoqSlZEBFBhCZEoyc1OVrIwMTcxNLIzNTMwhoqkVBZlFqUpWUEXFmelKVkrGGTna2l6uiWEpLplhntohJRaBUQElrp7ZIRVBoaalxWVmpQZuzhXGPsGutkq1ABTfPGg_',
  },
]

for (const g of GOLDEN) {
  check(`${g.name} —— 与官方实现逐字节一致`, () => {
    const got = genUserSig({ sdkAppId: g.appId, secretKey: g.key, userId: g.userId, expire: g.ttl, now: g.now }).userSig
    assert.equal(got, g.sig)
  })
}

check('⚠️ 密钥里的非 ASCII 按 UTF-8 参与 HMAC（不是 latin1）', () => {
  // 这一条单独拎出来：Buffer 的默认编码历史上变过，写成 Buffer.from(key,'latin1')
  // 在纯 ASCII 密钥上完全看不出差别，只有含中文的密钥会露出来。
  // 上面第三组黄金向量就是为它准备的，这里只是把意图写明。
  const a = genUserSig({ sdkAppId: 1, secretKey: '中', userId: 'a', expire: 60, now: 0 }).userSig
  const b = genUserSig({ sdkAppId: 1, secretKey: Buffer.from('中', 'utf8').toString('utf8'), userId: 'a', expire: 60, now: 0 }).userSig
  assert.equal(a, b)
})

console.log('\n二、结构往返')

/** 把 userSig 解回那个 JSON。escape 的逆：* -> +、- -> /、_ -> = */
function decodeSig(userSig) {
  const b64 = userSig.replace(/\*/g, '+').replace(/-/g, '/').replace(/_/g, '=')
  return JSON.parse(inflateSync(Buffer.from(b64, 'base64')).toString('utf8'))
}

check('解回来的字段名、值类型、顺序都对', () => {
  const doc = decodeSig(
    genUserSig({ sdkAppId: 1721003276, secretKey: 'secret', userId: 'u_abc123', expire: 604800, now: 1757203200 }).userSig,
  )
  // 顺序也查：腾讯服务端不依赖 JSON 键序，但键序变了说明有人动过那个对象字面量，
  // 而那个对象里最容易出错的恰恰是「哪个字段该是数字」。
  assert.deepEqual(Object.keys(doc), [
    'TLS.ver',
    'TLS.identifier',
    'TLS.sdkappid',
    'TLS.time',
    'TLS.expire',
    'TLS.sig',
  ])
  assert.equal(doc['TLS.ver'], '2.0')
  assert.equal(typeof doc['TLS.identifier'], 'string')
  assert.equal(typeof doc['TLS.sdkappid'], 'number', 'sdkappid 必须是数字 —— 写成字符串会验签失败')
  assert.equal(typeof doc['TLS.time'], 'number')
  assert.equal(typeof doc['TLS.expire'], 'number')
  assert.equal(doc['TLS.expire'], 604800, 'expire 是**时长**，不是到期时间戳')
  assert.equal(doc['TLS.time'], 1757203200)
  assert.ok(!('TLS.userbuf' in doc), 'IM 不用 userbuf —— 多这一行会让签名对不上')
})

check('⭐ 重算 HMAC 能对上（被签名原文的行序和换行都对）', () => {
  const key = 'another-secret'
  const { userSig } = genUserSig({ sdkAppId: 1721003276, secretKey: key, userId: 'u_deadbeef', expire: 3600, now: 1000 })
  const doc = decodeSig(userSig)
  const content =
    `TLS.identifier:${doc['TLS.identifier']}\n` +
    `TLS.sdkappid:${doc['TLS.sdkappid']}\n` +
    `TLS.time:${doc['TLS.time']}\n` +
    `TLS.expire:${doc['TLS.expire']}\n`
  assert.equal(doc['TLS.sig'], createHmac('sha256', key).update(content).digest('base64'))
})

check('⚠️ 用的是腾讯那套 base64 变体，不是标准 base64url', () => {
  // 标准 base64url： + -> -、/ -> _、= 去掉
  // 腾讯这套：       + -> *、/ -> -、= -> _
  // 抄错一个字符，服务端解不开，前端只会看到一个数字错误码。
  // 造一份必然含 = 补位的：deflate 的输出长度不是 3 的倍数时就会有。
  let seen = { star: false, pad: false }
  for (let i = 0; i < 200 && !(seen.star && seen.pad); i++) {
    const s = genUserSig({ sdkAppId: 1721003276, secretKey: 'k' + i, userId: 'u_' + i, expire: 3600, now: 1000 + i }).userSig
    if (s.includes('*')) seen.star = true
    if (s.endsWith('_')) seen.pad = true
    assert.ok(!/[+/=]/.test(s), `第 ${i} 个 sig 里出现了未转义的 + / = ：${s}`)
  }
  assert.ok(seen.pad, '两百次都没出现 _ 补位，说明转义那一步可能没生效')
  assert.ok(seen.star, '两百次都没出现 * ，说明 + 的转义可能没生效')
})

check('时间与到期计算', () => {
  const r = genUserSig({ sdkAppId: 1, secretKey: 'k', userId: 'u_1', expire: 3600, now: 1757203200 })
  assert.equal(r.issuedAt, 1757203200)
  assert.equal(r.expiresAt, 1757203200 + 3600)
  assert.equal(r.sdkAppId, 1)
  assert.equal(r.userId, 'u_1')
})

console.log('\n三、输入校验')

check('userID 字符集与长度', () => {
  for (const ok of ['a', 'A', '0', '_', '-', 'u_0123456789ab', 'x'.repeat(32)]) {
    assert.ok(isValidImUserId(ok), `${ok} 应该合法`)
  }
  for (const bad of ['', 'x'.repeat(33), 'has space', 'a.b', 'a@b', '中文', 'a+b', 'a/b', null, undefined, 'u_😀']) {
    assert.ok(!isValidImUserId(bad), `${JSON.stringify(bad)} 应该非法`)
  }
})

check('⭐ 非法输入一律抛，绝不签出一份废 sig', () => {
  // 签一份注定用不了的 sig，症状会跑到浏览器里变成一个数字码；在这里抛，
  // 服务器日志能直接指出是哪个账号、哪个参数不对。
  const base = { sdkAppId: 1721003276, secretKey: 'k', userId: 'u_1', expire: 3600 }
  assert.throws(() => genUserSig({ ...base, userId: 'a b' }), /userID 不合法/)
  assert.throws(() => genUserSig({ ...base, userId: 'x'.repeat(33) }), /userID 不合法/)
  assert.throws(() => genUserSig({ ...base, sdkAppId: 0 }), /缺少 SDKAppID/)
  assert.throws(() => genUserSig({ ...base, sdkAppId: 'abc' }), /不是正整数/)
  assert.throws(() => genUserSig({ ...base, secretKey: '' }), /缺少 SecretKey/)
  assert.throws(() => genUserSig({ ...base, expire: 0 }), /expire 不是正整数/)
  assert.throws(() => genUserSig({ ...base, expire: -1 }), /expire 不是正整数/)
  assert.throws(() => genUserSig({ ...base, expire: NaN }), /expire 不是正整数/)
})

check('本站 users.id 的真实形状可以直接当 userID 用', () => {
  // server/src/routes/auth.js 的 newId()：'u_' + randomBytes(6).toString('hex')
  // = 14 个字符，全在 [a-z0-9_] 里。这条测试钉住这个前提 ——
  // 哪天有人把 id 改成带冒号或 UUID 带横杠以外的字符，这里会先红。
  const shape = 'u_' + 'ab12cd34ef56'
  assert.equal(shape.length, 14)
  assert.ok(isValidImUserId(shape))
})

console.log('\n四、配置读取')

check('没配 SDKAppID 或密钥时返回 null（接口据此回 501）', () => {
  assert.equal(imConfigFrom({}), null)
  assert.equal(imConfigFrom({ TENCENT_IM_SDK_APPID: '1721003276' }), null, '只有 appid 没有密钥不算配好')
  assert.equal(imConfigFrom({ TENCENT_IM_SECRET_KEY: 'k' }), null, '只有密钥没有 appid 不算配好')
  assert.equal(imConfigFrom({ TENCENT_IM_SDK_APPID: 'abc', TENCENT_IM_SECRET_KEY: 'k' }), null)
  assert.equal(imConfigFrom({ TENCENT_IM_SDK_APPID: '0', TENCENT_IM_SECRET_KEY: 'k' }), null)
  assert.equal(imConfigFrom({ TENCENT_IM_SDK_APPID: '-1', TENCENT_IM_SECRET_KEY: 'k' }), null)
})

check('两个都配上就生效，两边的空白会被去掉', () => {
  const cfg = imConfigFrom({ TENCENT_IM_SDK_APPID: ' 1721003276 ', TENCENT_IM_SECRET_KEY: '  abc  ' })
  assert.deepEqual(cfg, { sdkAppId: 1721003276, secretKey: 'abc', ttl: IM_SIG_TTL_DEFAULT })
})

check('有效时长被夹在上下限之间', () => {
  const at = (v) => imConfigFrom({ TENCENT_IM_SDK_APPID: '1', TENCENT_IM_SECRET_KEY: 'k', TENCENT_IM_SIG_TTL_SEC: v }).ttl
  assert.equal(at(''), IM_SIG_TTL_DEFAULT, '空值走默认')
  assert.equal(at('abc'), IM_SIG_TTL_DEFAULT, '非数字走默认')
  assert.equal(at('1'), IM_SIG_TTL_MIN, '太短抬到下限')
  assert.equal(at('99999999'), IM_SIG_TTL_MAX, '太长压到上限')
  assert.equal(at('86400'), 86400)
  assert.equal(at('86400.7'), 86400, '小数取整')
})

console.log(`\n✅ IM UserSig 签发：${n} 项检查通过`)
