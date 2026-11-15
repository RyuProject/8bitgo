/**
 * 启动诊断聚类报警（2026-11-15 #10）。跑：cd server && npm run test:diag-alert
 * 用内存假库模拟 game_startup_diagnostics 与 site_settings，不连库、不发真邮件。
 */
import { register } from 'node:module'
import assert from 'node:assert/strict'

register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/db.js')) return { url: 'data:text/javascript,export async function query(){throw new Error("应注入")}', shortCircuit: true }
    if (specifier.endsWith('/mail.js')) return { url: 'data:text/javascript,export async function sendRawMail(){throw new Error("应注入")}', shortCircuit: true }
    return nextResolve(specifier, context)
  }
`))
const { alertConfig, maybeAlertSignature, renderAlert, resetAlertThrottleForTest } = await import('../src/diag-alert.js')

const SIG = 'abcdef0123456789'
function fakeDb(visits) {
  const settings = new Map()
  return {
    settings,
    async query(sql, params) {
      if (/FROM game_startup_diagnostics/.test(sql)) {
        return visits.map((v, i) => ({ visitId: v, text: 'failed · emulatorjs · Failed to fetch', slug: i % 2 ? 'kof97' : 'metal-slug', browser: 'Chrome 132', os: 'Windows' }))
      }
      if (/INSERT INTO site_settings/.test(sql)) {
        const [name, value, threshold] = params
        if (!settings.has(name)) { settings.set(name, value); return { affectedRows: 1 } }
        if (Number(settings.get(name)) <= threshold) { settings.set(name, value); return { affectedRows: 2 } }
        return { affectedRows: 0 }
      }
      if (/DELETE FROM site_settings/.test(sql)) {
        if (params?.length === 2 && settings.get(params[0]) === params[1]) settings.delete(params[0])
        return { affectedRows: 0 }
      }
      throw new Error(`意外的 SQL：${sql}`)
    },
  }
}
const config = { ...alertConfig({ DIAG_ALERT_EMAIL: 'ops@example.com' }) }
assert.equal(config.minVisits, 10)
assert.equal(config.windowMinutes, 60)
assert.equal(config.cooldownMs, 6 * 3_600_000)
assert.equal(alertConfig({}).to, '', '没配邮箱就不启用')
assert.equal(alertConfig({ DIAG_ALERT_EMAIL: 'not-an-email' }).to, '')

const sent = []
const send = async (m) => { sent.push(m) }
let now = 1_800_000_000_000

// 没配邮箱：不查库
resetAlertThrottleForTest()
assert.equal(await maybeAlertSignature(SIG, { config: alertConfig({}), query: () => { throw new Error('不该查库') }, send }), 'disabled')

// 同一个玩家刷 30 次（只有 1 个访问）：不报
let db = fakeDb(Array(30).fill('v1'))
resetAlertThrottleForTest()
assert.equal(await maybeAlertSignature(SIG, { config, query: db.query, send, now }), 'below')

// 10 个不同访问：报，邮件里有特征、游戏与环境
db = fakeDb(Array.from({ length: 12 }, (_, i) => `v${i % 10}`))
resetAlertThrottleForTest()
assert.equal(await maybeAlertSignature(SIG, { config, query: db.query, send, now }), 'sent')
assert.equal(sent.length, 1)
assert.equal(sent[0].to, 'ops@example.com')
assert.match(sent[0].subject, /10 个访问/)
assert.match(sent[0].text, /Failed to fetch/)
assert.match(sent[0].text, /kof97/)
assert.match(sent[0].text, /Chrome 132 \/ Windows/)
assert.match(sent[0].text, /\/admin\/diagnostics/)

// 一分钟内同一特征不再查库（失败刷屏时不给库加压）
assert.equal(await maybeAlertSignature(SIG, { config, query: () => { throw new Error('不该查库') }, send, now: now + 30_000 }), 'throttled')
// 冷却期内（重置进程内节流，模拟另一个进程 / 重启后）：抢不到，不重复发
resetAlertThrottleForTest()
assert.equal(await maybeAlertSignature(SIG, { config, query: db.query, send, now: now + 3_600_000 }), 'cooldown')
assert.equal(sent.length, 1)
// 过了 6 小时再聚集：再报一次
resetAlertThrottleForTest()
assert.equal(await maybeAlertSignature(SIG, { config, query: db.query, send, now: now + 6 * 3_600_000 + 1 }), 'sent')
assert.equal(sent.length, 2)

// 发信失败 / 查库失败只记日志，不抛
resetAlertThrottleForTest()
assert.equal(await maybeAlertSignature('0123456789abcdef', { config, query: async () => { throw new Error('db down') }, send, now }), 'error')
db = fakeDb(Array.from({ length: 10 }, (_, i) => `mail-fail-${i}`))
resetAlertThrottleForTest()
assert.equal(await maybeAlertSignature('fedcba9876543210', { config, query: db.query, send: async () => { throw new Error('mail down') }, now }), 'error')
assert.equal(db.settings.has('diag.alert.fedcba9876543210'), false, '邮件失败不能占住 6 小时冷却')
resetAlertThrottleForTest()
assert.equal(await maybeAlertSignature('fedcba9876543210', { config, query: db.query, send, now: now + 1 }), 'sent', '邮件恢复后下一次应能补报')
// 非法特征直接忽略
assert.equal(await maybeAlertSignature('../x', { config, query: db.query, send, now }), 'disabled')

assert.ok(renderAlert(SIG, { visits: 3, count: 4, text: 'x', games: [], envs: [] }, config).text.includes('—'))

// 接线：诊断包入库后才触发，且不 await
const { readFileSync } = await import('node:fs')
const src = readFileSync(new URL('../src/startup-diagnostics.js', import.meta.url), 'utf8')
assert.match(src, /if \(inserted\) void maybeAlertSignature\(signature\)/)
console.log('✔ 启动故障聚集报警：阈值按不同访问数、冷却跨进程、失败不抛、没配不启用')
