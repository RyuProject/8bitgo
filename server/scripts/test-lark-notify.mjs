/**
 * 飞书告警（server/src/lark-notify.js、scripts/notify-lark.mjs）与诊断聚集报警的飞书通道。
 * 跑：cd server && npm run test:lark-notify。不联网：fetch 注入，命令行只测不需要发送的路径。
 */
import { register } from 'node:module'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/db.js')) return { url: 'data:text/javascript,export async function query(){throw new Error("应注入")}', shortCircuit: true }
    if (specifier.endsWith('/mail.js')) return { url: 'data:text/javascript,export async function sendRawMail(){throw new Error("应注入")};export function mailProvider(){return "none"}', shortCircuit: true }
    return nextResolve(specifier, context)
  }
`))
const { larkConfig, larkSign, buildLarkPayload, sendLark } = await import('../src/lark-notify.js')
const { alertConfig, maybeAlertSignature, resetAlertThrottleForTest } = await import('../src/diag-alert.js')

const HOOK = 'https://open.larksuite.com/open-apis/bot/v2/hook/4b8c2305-0000-0000-0000-000000000000'

// ── 配置：只认飞书 / Lark 官方机器人地址 ──
assert.equal(larkConfig({ ALERT_LARK_WEBHOOK: HOOK }).webhook, HOOK)
assert.equal(larkConfig({ ALERT_LARK_WEBHOOK: HOOK.replace('larksuite.com', 'feishu.cn') }).webhook, HOOK.replace('larksuite.com', 'feishu.cn'))
for (const bad of ['http://open.larksuite.com/open-apis/bot/v2/hook/abcdefgh12', 'https://evil.example/open-apis/bot/v2/hook/abcdefgh12',
  'https://open.larksuite.com.evil.example/open-apis/bot/v2/hook/abcdefgh12', `${HOOK}?x=1`]) {
  const cfg = larkConfig({ ALERT_LARK_WEBHOOK: bad })
  assert.equal(cfg.webhook, '', bad)
  assert.equal(cfg.invalid, true, bad)
}
assert.deepEqual(larkConfig({}), { webhook: '', invalid: false, secret: '' })

// ── 签名：key = timestamp + "\n" + secret，对空串 HmacSHA256，base64 ──
assert.equal(larkSign('1700000000', 's3cret'), createHmac('sha256', '1700000000\ns3cret').update('').digest('base64'))

// ── 消息体 ──
{
  const p = buildLarkPayload({ title: '部署失败', text: '原因' })
  assert.equal(p.msg_type, 'text')
  assert.equal(p.content.text, '【8BitGo】部署失败\n原因')
  assert.equal(p.sign, undefined, '没配签名密钥就不带 sign')
  const signed = buildLarkPayload({ title: 't' }, { secret: 'k', now: 1_700_000_000_123 })
  assert.equal(signed.timestamp, '1700000000')
  assert.equal(signed.sign, larkSign('1700000000', 'k'))
  const long = buildLarkPayload({ title: 't', text: 'x'.repeat(10_000) })
  assert.ok(long.content.text.length < 4100 && long.content.text.endsWith('（已截断）'), '超长正文要截断')
}

// ── 发送：按飞书返回码判定 ──
{
  const calls = []
  const ok = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ code: 0, msg: 'success' }), { status: 200 }) }
  assert.equal(await sendLark({ title: 't', text: 'b' }, { config: larkConfig({ ALERT_LARK_WEBHOOK: HOOK }), fetchImpl: ok }), true)
  assert.equal(calls[0].url, HOOK)
  assert.equal(calls[0].init.method, 'POST')
  assert.ok(calls[0].init.signal, '要有超时，飞书卡住不能拖住调用方')
  assert.equal(JSON.parse(calls[0].init.body).content.text, '【8BitGo】t\nb')

  const keyword = async () => new Response(JSON.stringify({ code: 19024, msg: 'Key Words Not Found' }), { status: 200 })
  await assert.rejects(sendLark({ title: 't' }, { config: larkConfig({ ALERT_LARK_WEBHOOK: HOOK }), fetchImpl: keyword }), /code=19024/)
  const http500 = async () => new Response('oops', { status: 500 })
  await assert.rejects(sendLark({ title: 't' }, { config: larkConfig({ ALERT_LARK_WEBHOOK: HOOK }), fetchImpl: http500 }), /HTTP 500/)
  assert.equal(await sendLark({ title: 't' }, { config: larkConfig({}), fetchImpl: () => { throw new Error('不该发') } }), false, '没配就不发')
  await assert.rejects(sendLark({ title: 't' }, { config: larkConfig({ ALERT_LARK_WEBHOOK: 'https://evil.example/x' }) }), /不是飞书/)
}

// ── 诊断聚集报警的通道组合 ──
const SIG = 'abcdef0123456789'
function fakeDb(visitCount) {
  const settings = new Map()
  return {
    settings,
    async query(sql, params) {
      if (/FROM game_startup_diagnostics/.test(sql)) {
        return Array.from({ length: visitCount }, (_, i) => ({ visitId: `v${i}`, text: 'failed · emulatorjs · EmulatorJS 引擎加载失败', slug: 'kof97', browser: 'Chrome 150', os: 'Windows' }))
      }
      if (/INSERT INTO site_settings/.test(sql)) {
        if (!settings.has(params[0])) { settings.set(params[0], params[1]); return { affectedRows: 1 } }
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
{
  // 只配飞书（生产现状：没配邮箱）也要启用
  const cfg = alertConfig({ ALERT_LARK_WEBHOOK: HOOK })
  const lark = []
  const db = fakeDb(12)
  resetAlertThrottleForTest()
  const r = await maybeAlertSignature(SIG, { config: cfg, query: db.query, send: () => { throw new Error('没配邮箱不该发邮件') }, sendLark: async (m) => { lark.push(m) }, now: 1 })
  assert.equal(r, 'sent')
  assert.equal(lark.length, 1)
  assert.match(lark[0].title, /启动故障聚集：12 个访问/)
  assert.match(lark[0].text, /EmulatorJS 引擎加载失败/)
  assert.match(lark[0].text, /admin\/diagnostics/)
}
{
  // 两个通道：飞书挂了、邮件成功 → 仍算报出去了，冷却保留
  const cfg = alertConfig({ ALERT_LARK_WEBHOOK: HOOK, DIAG_ALERT_EMAIL: 'ops@example.com' })
  const db = fakeDb(12)
  resetAlertThrottleForTest()
  const mails = []
  const r = await maybeAlertSignature(SIG, { config: cfg, query: db.query, send: async (m) => { mails.push(m) }, sendLark: async () => { throw new Error('lark down') }, now: 1 })
  assert.equal(r, 'sent')
  assert.equal(mails.length, 1)
  assert.ok(db.settings.has(`diag.alert.${SIG}`), '有一个通道成功就保留冷却')
}
{
  // 两个通道都失败 → 撤销冷却，下一次还能报
  const cfg = alertConfig({ ALERT_LARK_WEBHOOK: HOOK, DIAG_ALERT_EMAIL: 'ops@example.com' })
  const db = fakeDb(12)
  resetAlertThrottleForTest()
  const r = await maybeAlertSignature(SIG, { config: cfg, query: db.query, send: async () => { throw new Error('mail down') }, sendLark: async () => { throw new Error('lark down') }, now: 1 })
  assert.equal(r, 'error')
  assert.ok(!db.settings.has(`diag.alert.${SIG}`), '全部失败要撤销冷却')
}

// ── 命令行：不联网的路径（去重、清除、没配置） ──
{
  const cli = fileURLToPath(new URL('./notify-lark.mjs', import.meta.url))
  const state = mkdtempSync(join(tmpdir(), 'lark-cli-'))
  const env = { ...process.env, ALERT_STATE_DIR: state, ALERT_LARK_WEBHOOK: 'unset-for-test' }
  delete env.ALERT_LARK_SECRET
  const run = (...a) => spawnSync(process.execPath, [cli, ...a], { env, encoding: 'utf8' })
  // 冷却期内：不发，也不需要网络
  writeFileSync(join(state, 'smoke-down.last'), String(Date.now()))
  let r = run('--title', 't', '--text', 'b', '--dedupe', 'smoke-down', '--cooldown', '3600', '--strict')
  assert.equal(r.status, 0)
  assert.match(r.stdout, /冷却期内/)
  // 恢复：清掉去重记录
  r = run('--clear', 'smoke-down')
  assert.equal(r.status, 0)
  assert.ok(!existsSync(join(state, 'smoke-down.last')))
  // 地址不合法：默认退出 0（不能拖垮部署脚本），--strict 退出 1
  r = run('--title', 't', '--text', 'b')
  assert.equal(r.status, 0)
  assert.match(r.stderr, /不是飞书官方机器人地址/)
  assert.equal(run('--title', 't', '--text', 'b', '--strict').status, 1)
  rmSync(state, { recursive: true, force: true })
}

console.log('✔ 飞书告警：地址白名单、签名、消息体截断、返回码判定、诊断报警通道组合、命令行去重 / 清除 / 失败不拖垮调用方')
