/**
 * 加载失败 Lark 通知测试。跑：cd server && npm run test:diag-lark
 * 使用内存假库与假 fetch，不连库，也不向真实 webhook 发送消息。
 */
import { register } from 'node:module'
import assert from 'node:assert/strict'

register('data:text/javascript,' + encodeURIComponent(
  'export async function resolve(specifier, context, nextResolve) {' +
  'if (specifier.endsWith("/db.js")) return { url: "data:text/javascript,export async function query(){throw new Error(\\u0022应注入\\u0022)}", shortCircuit: true };' +
  'return nextResolve(specifier, context)' +
  '}',
))

const { larkConfig, notifyLarkFailure, renderLarkFailure } = await import('../src/diag-lark.js')
const SIG = 'abcdef0123456789'
const webhook = 'https://open.larksuite.com/open-apis/bot/v2/hook/test-token'

function fakeDb() {
  const settings = new Map()
  return {
    settings,
    async query(sql, params) {
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
      throw new Error('意外的 SQL：' + sql)
    },
  }
}

const config = larkConfig({ DIAG_LARK_WEBHOOK_URL: webhook })
assert.equal(config.webhook, webhook)
assert.equal(config.cooldownMs, 10 * 60_000)
assert.equal(larkConfig({}).webhook, '', '没配置时不启用')
assert.equal(larkConfig({ DIAG_LARK_WEBHOOK_URL: 'http://open.larksuite.com/open-apis/bot/v2/hook/x' }).webhook, '')
assert.equal(larkConfig({ DIAG_LARK_WEBHOOK_URL: 'https://example.com/hook/x' }).webhook, '')

const failure = {
  event: 'failed', signature: SIG, signatureText: 'failed · page · Failed to fetch',
  slug: 'fireboy-and-watergirl', runtime: 'page', platform: 'HTML5',
  country: 'CN', browser: 'Mi Browser 20', os: 'Linux', device: 'desktop', elapsedMs: 1200,
}
const rendered = renderLarkFailure(failure, config)
assert.match(rendered, /加载失败/)
assert.match(rendered, /fireboy-and-watergirl/)
assert.match(rendered, /Failed to fetch/)
assert.match(rendered, /Mi Browser 20/)
assert.match(rendered, /admin\/diagnostics/)
assert.doesNotMatch(rendered, /test-token/)

let now = 1_800_000_000_000
const db = fakeDb()
const requests = []
const fetch = async (url, options) => {
  requests.push({ url, options })
  return { ok: true, status: 200, async json() { return { code: 0 } } }
}

assert.equal(await notifyLarkFailure(failure, { config: larkConfig({}), query: db.query, fetch }), 'disabled')
assert.equal(await notifyLarkFailure({ ...failure, event: 'slow_start' }, { config, query: db.query, fetch }), 'ignored')
assert.equal(requests.length, 0, '慢启动不通知')

assert.equal(await notifyLarkFailure(failure, { config, query: db.query, fetch, now }), 'sent')
assert.equal(requests.length, 1)
assert.equal(requests[0].url, webhook)
assert.equal(requests[0].options.method, 'POST')
assert.deepEqual(JSON.parse(requests[0].options.body), {
  msg_type: 'text',
  content: { text: rendered },
})
assert.equal(await notifyLarkFailure(failure, { config, query: db.query, fetch, now: now + 1 }), 'cooldown')
assert.equal(requests.length, 1, '同一错误在冷却期内不重复发')

const second = { ...failure, signature: '0123456789abcdef' }
assert.equal(await notifyLarkFailure(second, { config, query: db.query, fetch, now: now + 2 }), 'global-cap')
assert.equal(requests.length, 1, '全站每分钟最多发一条')
assert.equal(db.settings.has('diag.lark.' + second.signature), false, '全局限频不占用错误特征冷却')

const failDb = fakeDb()
assert.equal(await notifyLarkFailure({ ...failure, signature: 'fedcba9876543210' }, {
  config, query: failDb.query, now: now + 61_000,
  fetch: async () => ({ ok: false, status: 500, async json() { return { code: 1 } } }),
}), 'error')
assert.equal(failDb.settings.has('diag.lark.fedcba9876543210'), false, '发送失败后释放冷却')

const { readFileSync } = await import('node:fs')
const src = readFileSync(new URL('../src/startup-diagnostics.js', import.meta.url), 'utf8')
assert.match(src, /if \(inserted && \(event\.event === 'failed' \|\| event\.event === 'timeout'\)\)/)
assert.match(src, /void notifyLarkFailure\(/)
console.log('✔ 加载失败诊断 Lark 通知：新失败触发、慢启动忽略、消息脱敏、冷却限频、失败不阻塞')
