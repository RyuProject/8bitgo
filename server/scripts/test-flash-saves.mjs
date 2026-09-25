import assert from 'node:assert/strict'
import {
  FLASH_SAVE_PART_MAX_BYTES,
  FLASH_SAVE_SLOT_MAX_BYTES,
  FLASH_SAVE_TOTAL_MAX_BYTES,
  agi2SaveKey,
  agi2SaveMap,
  flashSaveBridgeUrl,
  flashSaveGameEnabled,
  flashSaveKey,
  flashSaveProtocol,
  flashSaveQuotaError,
  flashSaveSlot,
  legacyFlashSaveMap,
  parseFlashSaveOptions,
  validateAgi2Value,
  validateFlashSavePair,
} from '../src/flash-save-contract.js'
import { flashSaveConfigured, signFlashSaveToken, verifyFlashSaveToken } from '../src/flash-save-token.js'
import { envNumber } from '../src/resource-limits.js'

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log(`✓ ${name}`)
}

const env = {
  FLASH_SAVE_SECRET: 'flash-save-test-secret-that-is-longer-than-32-characters',
  FLASH_SAVE_TTL_SECONDS: '3600',
  FLASH_SAVE_GAMES: 'infectonator-2, another-tested-game',
}

check('独立密钥配置至少 32 字符', () => {
  assert.equal(flashSaveConfigured(env), true)
  assert.equal(flashSaveConfigured({ FLASH_SAVE_SECRET: 'short' }), false)
  assert.equal(flashSaveConfigured({ ...env, JWT_SECRET: env.FLASH_SAVE_SECRET }), false)
})

check('短期令牌绑定用户、游戏和 token_version', () => {
  const signed = signFlashSaveToken({ userId: 'u-1', gameSlug: 'infectonator-2', tokenVersion: 7 }, env)
  const payload = verifyFlashSaveToken(signed.token, env)
  assert.deepEqual(
    { userId: payload.userId, gameSlug: payload.gameSlug, tokenVersion: payload.tokenVersion },
    { userId: 'u-1', gameSlug: 'infectonator-2', tokenVersion: 7 },
  )
  assert.equal(verifyFlashSaveToken(signed.token, { ...env, FLASH_SAVE_SECRET: 'another-secret-that-is-definitely-over-32-characters' }), null)
})

check('只有明确启用的 slug 才能签会话', () => {
  assert.equal(flashSaveGameEnabled('infectonator-2', env), true)
  assert.equal(flashSaveGameEnabled('another-tested-game', env), false, '环境变量不能凭空开启接入表外游戏')
  assert.equal(flashSaveGameEnabled('unreviewed-game', env), false)
})

check('只接受六个固定存档键和 0~2 数字槽', () => {
  assert.deepEqual(flashSaveKey('profileonline2'), { kind: 'profile', slot: 2 })
  assert.deepEqual(flashSaveKey('dataonline0'), { kind: 'data', slot: 0 })
  assert.equal(flashSaveKey('PremiumEnabled'), null)
  assert.equal(flashSaveSlot(null), null)
  assert.equal(flashSaveSlot('0'), null)
  assert.equal(flashSaveSlot(3), null)
})

check('完整的一对 profile/data 通过并算 UTF-8 字节', () => {
  const result = validateFlashSavePair({
    slot: 1,
    profile: { index: 'online1', saved: 1, name: '玩家' },
    data: { index: 'online1', gold: 42 },
  })
  assert.equal(result.ok, true)
  assert.ok(result.size > '玩家'.length)
})

check('拒绝错槽、半份、危险键和过深 JSON', () => {
  assert.equal(validateFlashSavePair({ slot: 0, profile: {}, data: {} }).code, 'invalid_request')
  const polluted = JSON.parse('{"index":"online0","saved":1,"__proto__":{"admin":true}}')
  assert.equal(validateFlashSavePair({ slot: 0, profile: polluted, data: { index: 'online0' } }).code, 'invalid_request')
  let deep = { value: true }
  for (let i = 0; i < 34; i++) deep = { next: deep }
  assert.equal(
    validateFlashSavePair({ slot: 0, profile: { index: 'online0', saved: 1 }, data: { index: 'online0', deep } }).code,
    'invalid_request',
  )
})

check('总配额按覆盖后的净增长计算，缩小始终允许', () => {
  assert.equal(flashSaveQuotaError(32 * 1024 * 1024, 1000, 900), null)
  assert.equal(flashSaveQuotaError(32 * 1024 * 1024, 1000, 1001).code, 'quota_exceeded')
})

check('旧 AGI 全量结果只暴露完整槽，权益字段由服务端覆盖', () => {
  const data = legacyFlashSaveMap([
    { slot: 0, profile_json: { index: 'online0', saved: 1 }, data_json: { index: 'online0' } },
    { slot: 1, profile_json: { index: 'online1', saved: 1 }, data_json: null },
  ])
  assert.equal(data.profileonline0.saved, 1)
  assert.equal(data.dataonline0.index, 'online0')
  assert.equal(data.profileonline1, undefined)
  assert.equal(data.PremiumEnabled, 0)
})

/* ---------------- AGI2（Kingdom Rush Frontiers 那类） ---------------- */

check('方言逐游戏绑定，未知 slug 退回 agi1 而不是乱猜', () => {
  assert.equal(flashSaveProtocol('infectonator-2'), 'agi1')
  assert.equal(flashSaveProtocol('kingdom-rushfrontiers'), 'agi2')
  assert.equal(flashSaveProtocol('some-unreviewed-game'), 'agi1')
  assert.match(flashSaveBridgeUrl('infectonator-2'), /\/AGI\.swf$/)
  assert.match(flashSaveBridgeUrl('kingdom-rushfrontiers'), /\/AGI2\.swf$/)
})

check('AGI2 只认 slot1~3', () => {
  assert.equal(agi2SaveKey('slot1'), 'slot1')
  assert.equal(agi2SaveKey('slot3'), 'slot3')
  for (const bad of ['slot0', 'slot4', 'slot', 'slots1', 'profileonline0', 'PremiumEnabled', '', null]) {
    assert.equal(agi2SaveKey(bad), null, `${bad} 不该被接受`)
  }
})

check('AGI2 的 value 必须是普通对象且不超上限', () => {
  const ok = validateAgi2Value({ key: 'slot2', value: { levels: 1, starsWon: { '1': 3 } } })
  assert.equal(ok.ok, true)
  assert.equal(ok.key, 'slot2')
  assert.ok(ok.size > 0)
  assert.equal(validateAgi2Value({ key: 'slot9', value: {} }).code, 'invalid_request')
  assert.equal(validateAgi2Value({ key: 'slot1', value: [] }).code, 'invalid_request')
  assert.equal(validateAgi2Value({ key: 'slot1', value: null }).code, 'invalid_request')
  const polluted = JSON.parse('{"levels":1,"__proto__":{"admin":true}}')
  assert.equal(validateAgi2Value({ key: 'slot1', value: polluted }).code, 'invalid_request')
})

check('AGI2 全量读取只出 slot1~3，premium 标记一律滤掉', () => {
  const keys = agi2SaveMap([
    { save_key: 'slot1', value_json: { levels: 1 } },
    { save_key: 'slot2', value_json: '{"levels":2}' },
    // 真 Armor 服务当年会塞这一条，等于 2 就解锁付费内容 —— 白名单必须挡住
    { save_key: 'kingdomRushPremiumContentEnabled', value_json: 2 },
    { save_key: 'slot9', value_json: { levels: 9 } },
    { save_key: 'slot3', value_json: null },
  ])
  assert.deepEqual(Object.keys(keys).sort(), ['slot1', 'slot2'])
  assert.equal(keys.slot1.levels, 1)
  assert.equal(keys.slot2.levels, 2)
  assert.equal(keys.kingdomRushPremiumContentEnabled, undefined)
})

check('写入选项 opId / expectedRevision 可选，但边界要挡住', () => {
  // 都不带 = 旧客户端，行为一字不变（这是刻意的：不能在服务端硬性要求新字段）
  assert.deepEqual(parseFlashSaveOptions({}), { ok: true, opId: null, expectedRevision: null })
  assert.equal(parseFlashSaveOptions({ opId: 'op-abcdefgh-1' }).opId, 'op-abcdefgh-1')
  assert.equal(parseFlashSaveOptions({ expectedRevision: 0 }).expectedRevision, 0)
  assert.equal(parseFlashSaveOptions({ expectedRevision: '7' }).expectedRevision, 7)
  for (const bad of [
    { opId: 'short' },
    { opId: 'x'.repeat(65) },
    { opId: 12 },
    { expectedRevision: -1 },
    { expectedRevision: 1.5 },
    { expectedRevision: 'abc' },
    { expectedRevision: 4294967296 },
  ]) {
    const result = parseFlashSaveOptions(bad)
    assert.equal(result.ok, false, `${JSON.stringify(bad)} 不该被接受`)
    assert.equal(result.code, 'invalid_request')
  }
})

check('新游戏同时在白名单和方言表里才放行', () => {
  const withKrf = { FLASH_SAVE_GAMES: 'infectonator-2,kingdom-rushfrontiers' }
  assert.equal(flashSaveGameEnabled('kingdom-rushfrontiers', withKrf), true)
  assert.equal(flashSaveGameEnabled('kingdom-rushfrontiers', { FLASH_SAVE_GAMES: 'infectonator-2' }), false)
})

/* ---------------- 限额配置：填错环境变量不能静默关掉限额 ---------------- */

/** 这些用例故意喂非法值，会触发 warn；测试输出里不需要那几行 */
function muted(fn) {
  const original = console.warn
  console.warn = () => {}
  try {
    fn()
  } finally {
    console.warn = original
  }
}

/** 在临时环境变量下跑一段，跑完还原（免得污染后面的用例） */
function withEnv(name, value, fn) {
  const restore = process.env[name]
  process.env[name] = value
  try {
    fn()
  } finally {
    if (restore === undefined) delete process.env[name]
    else process.env[name] = restore
  }
}

check('数值型环境变量填错时退回默认值，而不是变成 NaN', () => {
  const name = 'FLASH_SAVE_TEST_LIMIT'
  delete process.env[name]
  assert.equal(envNumber(name, 2048), 2048, '没配就用默认')
  withEnv(name, '   ', () => assert.equal(envNumber(name, 2048), 2048, '只有空白也算没配'))
  withEnv(name, 'abc', () => assert.equal(envNumber(name, 2048), 2048, 'NaN 必须退回默认值'))
  withEnv(name, '3000', () => assert.equal(envNumber(name, 2048), 3000, '正常值原样生效'))
  // 小数向下取整：字节数带小数没意义，取整既不报错也不会放大限额
  withEnv(name, '3000.9', () => assert.equal(envNumber(name, 2048), 3000))
  // J2ME 的几个 MB 值走 integer:false —— 「0.5MB」是真的有人会写的配置，不能取整掉
  withEnv(name, '0.5', () => assert.equal(envNumber(name, 20, { min: 0.001, max: 256, integer: false }), 0.5))
})

check('数值型环境变量夹到最近的合法边界', () => {
  const name = 'FLASH_SAVE_TEST_LIMIT'
  withEnv(name, '0', () => assert.equal(envNumber(name, 2048, { min: 8, max: 4096 }), 8))
  withEnv(name, '-5', () => assert.equal(envNumber(name, 2048, { min: 8, max: 4096 }), 8))
  withEnv(name, '999999', () => assert.equal(envNumber(name, 2048, { min: 8, max: 4096 }), 4096))
})

check('非法值会出声，不是静默退回', () => {
  const name = 'FLASH_SAVE_TEST_LIMIT'
  const lines = []
  const original = console.warn
  console.warn = (...args) => lines.push(args.join(' '))
  try {
    withEnv(name, 'abc', () => envNumber(name, 2048))
  } finally {
    console.warn = original
  }
  assert.equal(lines.length, 1, '退回默认值时必须留一条日志')
  assert.match(lines[0], new RegExp(name), '日志里得说清楚是哪个变量')
})

check('三层上限永远是有限正整数，且保持 半份 ≤ 整槽 ≤ 总量', () => {
  /*
    这条盯的是「有人把它写回 Number(process.env.X || 默认)」：
    那样一旦填错就是 NaN，而 NaN 参与的所有比较都是 false —— 等于静默关掉限额，
    正是 resource-limits.js 存在的理由。
  */
  muted(() => {
    for (const [label, value] of [
      ['PART', FLASH_SAVE_PART_MAX_BYTES],
      ['SLOT', FLASH_SAVE_SLOT_MAX_BYTES],
      ['TOTAL', FLASH_SAVE_TOTAL_MAX_BYTES],
    ]) {
      assert.ok(Number.isInteger(value) && value > 0, `${label} 不是有限正整数：${value}`)
    }
    assert.ok(FLASH_SAVE_PART_MAX_BYTES <= FLASH_SAVE_SLOT_MAX_BYTES, '半份上限不该大于整槽')
    assert.ok(FLASH_SAVE_SLOT_MAX_BYTES <= FLASH_SAVE_TOTAL_MAX_BYTES, '单槽上限不该大于账号总量')
  })
})

console.log(`\n✅ Flash 在线存档契约 ${passed} 项通过`)
