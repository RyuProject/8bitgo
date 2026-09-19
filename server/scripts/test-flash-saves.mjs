import assert from 'node:assert/strict'
import {
  agi2SaveKey,
  agi2SaveMap,
  flashSaveBridgeUrl,
  flashSaveGameEnabled,
  flashSaveKey,
  flashSaveProtocol,
  flashSaveQuotaError,
  flashSaveSlot,
  legacyFlashSaveMap,
  validateAgi2Value,
  validateFlashSavePair,
} from '../src/flash-save-contract.js'
import { flashSaveConfigured, signFlashSaveToken, verifyFlashSaveToken } from '../src/flash-save-token.js'

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
  assert.equal(flashSaveProtocol('kingdom-rush-frontiers'), 'agi2')
  assert.equal(flashSaveProtocol('some-unreviewed-game'), 'agi1')
  assert.equal(flashSaveBridgeUrl('infectonator-2'), '/flash-api/armor-games/AGI.swf')
  assert.equal(flashSaveBridgeUrl('kingdom-rush-frontiers'), '/flash-api/armor-games/AGI2.swf')
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

check('新游戏同时在白名单和方言表里才放行', () => {
  const withKrf = { FLASH_SAVE_GAMES: 'infectonator-2,kingdom-rush-frontiers' }
  assert.equal(flashSaveGameEnabled('kingdom-rush-frontiers', withKrf), true)
  assert.equal(flashSaveGameEnabled('kingdom-rush-frontiers', { FLASH_SAVE_GAMES: 'infectonator-2' }), false)
})

console.log(`\n✅ Flash 在线存档契约 ${passed} 项通过`)
