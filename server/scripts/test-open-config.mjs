/**
 * `open/config.js` 的自检 —— 重点是 `openConfigDiagnosis()`。
 *
 * 它存在的理由是一次真实故障（2026-09-13）：.env 配好了、密钥文件也在，
 * 但取令牌一直 501 —— 因为文件是**在进程启动之后**才生成的，而配置只在启动时读一次。
 * 当时开放平台一行启动日志都没有，这件事完全静默。
 *
 * ⚠️ 这里最要紧的一条是**诊断和真实行为必须一致**：
 * 诊断说「能用」而 openConfig() 回 null（或者反过来），比没有诊断更糟 ——
 * 启动日志会明明白白地撒一次谎，而那正是要排查的人唯一的线索。
 *
 * 用法：cd server && npm run test:open-config
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConfig, resetOpenConfig, openConfigDiagnosis } from '../src/open/config.js'

let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ❌ ${name}\n     ${e.message}`)
  }
}

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
const dir = mkdtempSync(join(tmpdir(), 'openkey-'))
const keyPath = join(dir, 'open-jwt.pem')
writeFileSync(keyPath, privateKey)

/** openConfig 按 env 对象身份缓存，每次换 env 都要先清 */
const cfgOf = (env) => {
  resetOpenConfig()
  const v = openConfig(env)
  resetOpenConfig()
  return v
}

const BASE = { OPEN_ROM_SECRET: 'r'.repeat(32), OPEN_EMBED_SECRET: 'e'.repeat(32) }

console.log('\n诊断：说得对不对，以及和真实行为一不一致')

await check('什么都没配 -> not-configured（这不是错误，公开目录照常）', () => {
  const d = openConfigDiagnosis({})
  assert.equal(d.ok, false)
  assert.equal(d.reason, 'not-configured')
})

await check('⚠️ 路径指向一个不存在的文件 -> key-unreadable，并报出路径', () => {
  /* 这就是那次线上故障的形状：.env 配好了，但启动那一刻文件还不在 */
  const d = openConfigDiagnosis({ ...BASE, OPEN_JWT_PRIVATE_KEY_PATH: join(dir, 'nope.pem') })
  assert.equal(d.reason, 'key-unreadable')
  assert.match(d.path, /nope\.pem$/, '没把路径报出来 —— 那这行日志帮不上任何忙')
})

await check('⚠️ 文件在但读不动（权限）-> 也是 key-unreadable', () => {
  const locked = join(dir, 'locked.pem')
  writeFileSync(locked, privateKey)
  chmodSync(locked, 0o000)
  try {
    // root 无视文件权限，那种环境下这条跳过（CI 里常见）
    let readable = true
    try {
      readFileSync(locked, 'utf8')
    } catch {
      readable = false
    }
    // root 无视文件权限 —— 那种环境下这条测不了，跳过而不是假装通过
    if (readable) return
    assert.equal(openConfigDiagnosis({ ...BASE, OPEN_JWT_PRIVATE_KEY_PATH: locked }).reason, 'key-unreadable')
  } finally {
    chmodSync(locked, 0o600)
  }
})

await check('把路径填进了 OPEN_JWT_PRIVATE_KEY（该填 _PATH）-> key-malformed', () => {
  const d = openConfigDiagnosis({ ...BASE, OPEN_JWT_PRIVATE_KEY: '/srv/open-jwt.pem' })
  assert.equal(d.reason, 'key-malformed')
})

await check('是 PEM 但不是能用的私钥 -> key-invalid，并带上原始报错', () => {
  const bad = join(dir, 'bad.pem')
  writeFileSync(bad, '-----BEGIN PRIVATE KEY-----\nbm90LWEta2V5\n-----END PRIVATE KEY-----\n')
  const d = openConfigDiagnosis({ ...BASE, OPEN_JWT_PRIVATE_KEY_PATH: bad })
  assert.equal(d.reason, 'key-invalid')
  assert.ok(d.detail && d.detail.length > 3, '把原始报错吞了 —— 那是排查时最有用的一行')
})

await check('配好了 -> ok，并说清 ROM / 嵌入那两把有没有', () => {
  const full = openConfigDiagnosis({ ...BASE, OPEN_JWT_PRIVATE_KEY_PATH: keyPath })
  assert.deepEqual(full, { ok: true, romEnabled: true, embedEnabled: true })
  const partial = openConfigDiagnosis({ OPEN_JWT_PRIVATE_KEY_PATH: keyPath })
  assert.equal(partial.ok, true)
  assert.equal(partial.romEnabled, false, 'ROM 密钥没配却说配了')
  assert.equal(partial.embedEnabled, false)
})

await check('⚠️⚠️ 诊断和 openConfig() 的真实结果必须一致（撒谎的日志比没日志更糟）', () => {
  /*
    build() 和 diagnosis 是两段独立的代码，天生会漂。
    漂了的症状是：启动日志说「开放平台已启用」，而每一条接口都 501 ——
    排查的人会因为那行日志而完全不往这个方向想。
  */
  const cases = [
    {},
    { OPEN_JWT_PRIVATE_KEY_PATH: keyPath },
    { OPEN_JWT_PRIVATE_KEY_PATH: join(dir, 'nope.pem') },
    { OPEN_JWT_PRIVATE_KEY: privateKey },
    { OPEN_JWT_PRIVATE_KEY: '/srv/open-jwt.pem' },
    { OPEN_JWT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nbm90\n-----END PRIVATE KEY-----\n' },
    { ...BASE, OPEN_JWT_PRIVATE_KEY_PATH: keyPath },
    { ...BASE, OPEN_JWT_PRIVATE_KEY_PATH: '' },
    // 两个都给：readKey 里 inline 优先
    { OPEN_JWT_PRIVATE_KEY: privateKey, OPEN_JWT_PRIVATE_KEY_PATH: join(dir, 'nope.pem') },
  ]
  for (const env of cases) {
    const real = cfgOf(env) !== null
    const said = openConfigDiagnosis(env).ok
    assert.equal(
      said, real,
      `诊断说「${said ? '能用' : '不能用'}」，openConfig() 实际${real ? '能用' : '回了 null'}：` +
        JSON.stringify(Object.keys(env)),
    )
  }
})

await check('⚠️ 诊断结果里不含密钥内容（这行会进 journald）', () => {
  for (const env of [
    { ...BASE, OPEN_JWT_PRIVATE_KEY_PATH: keyPath },
    { OPEN_JWT_PRIVATE_KEY: privateKey },
  ]) {
    const blob = JSON.stringify(openConfigDiagnosis(env))
    assert.ok(!blob.includes('BEGIN PRIVATE KEY'), '诊断里带上了私钥内容')
    assert.ok(!blob.includes(BASE.OPEN_ROM_SECRET), '诊断里带上了 ROM 密钥')
  }
})

rmSync(dir, { recursive: true, force: true })
console.log(failed ? `\n❌ ${failed} 条失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
