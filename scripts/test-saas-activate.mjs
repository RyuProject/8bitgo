// NS 迁出后自动激活 SaaS 自定义主机名（deploy/saas/activate-hostnames.mjs）的回归。不联网。
import assert from 'node:assert/strict'
import {
  DEFAULT_HOSTS,
  ZONE_COM,
  ZONE_TOP,
  activateRound,
  makeApi,
  probeVia,
  revalidateBody,
  zoneStillServing,
} from '../deploy/saas/activate-hostnames.mjs'

let passed = 0
const ok = (name) => {
  passed += 1
  console.log(`  ✓ ${name}`)
}

/** 极小的 Cloudflare API 替身：按路径回预设的响应，记录收到的请求 */
function fakeApi(routes) {
  const calls = []
  const api = async (method, path, body) => {
    calls.push({ method, path, body })
    const hit = routes[`${method} ${path.split('?')[0]}`]
    if (typeof hit === 'function') return hit(body)
    return hit ?? { success: false, httpStatus: 500, errors: [{ message: 'unexpected' }] }
  }
  return { api, calls }
}

// ── 区域状态：只有明确 active 才算旧区域还在服务；查不到就当不知道，不能动主机名 ──
{
  const at = (status) => fakeApi({ [`GET /zones/${ZONE_COM}`]: { success: true, httpStatus: 200, result: { status } } }).api
  assert.equal(await zoneStillServing(at('active')), true)
  assert.equal(await zoneStillServing(at('moved')), false)
  assert.equal(await zoneStillServing(at('deleted')), false)
  assert.equal(await zoneStillServing(fakeApi({ [`GET /zones/${ZONE_COM}`]: { success: false, httpStatus: 404 } }).api), false)
  assert.equal(await zoneStillServing(fakeApi({ [`GET /zones/${ZONE_COM}`]: { success: false, httpStatus: 0 } }).api), null)
  assert.equal(await zoneStillServing(fakeApi({ [`GET /zones/${ZONE_COM}`]: { success: false, httpStatus: 403 } }).api), null)
  ok('区域 active 才等；moved / deleted / 404 开始激活；网络或权限错误按不知道处理')
}

// ── PATCH 体：ssl 对象原样回填，不带只读字段 ──
{
  const body = revalidateBody({
    id: 'x',
    ssl: {
      id: 'ignored',
      status: 'active',
      method: 'txt',
      type: 'dv',
      settings: { min_tls_version: '1.2' },
      bundle_method: 'ubiquitous',
      wildcard: false,
      certificate_authority: 'ssl_com',
      certificates: [{}],
      validation_records: [{}],
    },
  })
  assert.deepEqual(body, {
    ssl: {
      method: 'txt',
      type: 'dv',
      settings: { min_tls_version: '1.2' },
      bundle_method: 'ubiquitous',
      wildcard: false,
      certificate_authority: 'ssl_com',
    },
  })
  ok('PATCH 带与原请求一致的 ssl 对象，不带证书 / 状态等只读字段')
}

// ── 一轮激活：只 PATCH 没 active 的；同一个主机名有冷却；缺失的报出来 ──
{
  const list = {
    success: true,
    httpStatus: 200,
    result: [
      { id: 'a', hostname: '8bitgo.com', status: 'pending', ssl: { method: 'txt', type: 'dv', status: 'active' }, verification_errors: ['x'] },
      { id: 'b', hostname: 'www.8bitgo.com', status: 'active', ssl: { method: 'txt', type: 'dv', status: 'active' } },
    ],
  }
  const { api, calls } = fakeApi({
    [`GET /zones/${ZONE_TOP}/custom_hostnames`]: list,
    [`PATCH /zones/${ZONE_TOP}/custom_hostnames/a`]: { success: true, httpStatus: 200 },
  })
  const lastPatched = new Map()
  const logs = []
  const hosts = ['8bitgo.com', 'www.8bitgo.com', 'tv.8bitgo.com']
  const states = await activateRound(api, { hosts, lastPatched, minGapMs: 120_000, now: 1_000_000, dryRun: false, log: (l) => logs.push(l) })
  assert.deepEqual(states.map((s) => [s.name, s.status]), [['8bitgo.com', 'pending'], ['www.8bitgo.com', 'active'], ['tv.8bitgo.com', 'missing']])
  const patches = calls.filter((c) => c.method === 'PATCH')
  assert.equal(patches.length, 1)
  assert.equal(patches[0].path, `/zones/${ZONE_TOP}/custom_hostnames/a`)
  assert.deepEqual(patches[0].body, { ssl: { method: 'txt', type: 'dv' } })

  // 冷却期内不再发；过了冷却再发
  await activateRound(api, { hosts, lastPatched, minGapMs: 120_000, now: 1_060_000, dryRun: false, log: () => {} })
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 1)
  await activateRound(api, { hosts, lastPatched, minGapMs: 120_000, now: 1_130_000, dryRun: false, log: () => {} })
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 2)
  ok('只 PATCH 未激活的主机名，同一主机名 2 分钟内不重复发，缺失的主机名会报出来')

  // dry-run 一个请求都不发
  const dry = fakeApi({ [`GET /zones/${ZONE_TOP}/custom_hostnames`]: list })
  await activateRound(dry.api, { hosts, lastPatched: new Map(), minGapMs: 0, now: 1, dryRun: true, log: () => {} })
  assert.equal(dry.calls.filter((c) => c.method === 'PATCH').length, 0)
  ok('--dry-run 不发 PATCH')
}

// ── 列主机名失败要抛出，不能当成「全部 active」 ──
{
  const { api } = fakeApi({ [`GET /zones/${ZONE_TOP}/custom_hostnames`]: { success: false, httpStatus: 500, errors: [{ message: 'boom' }] } })
  await assert.rejects(activateRound(api, { hosts: DEFAULT_HOSTS, lastPatched: new Map(), minGapMs: 0, now: 1, dryRun: false, log: () => {} }))
  ok('列主机名失败时报错，不会误判完成')
}

// ── 核对：看 X-8bitgo-Via；网络失败不抛 ──
{
  const via = await probeVia(async () => new Response('', { status: 404, headers: { 'X-8bitgo-Via': 'saas' } }), 'saas-test.8bitgo.com')
  assert.deepEqual(via, { host: 'saas-test.8bitgo.com', status: 404, via: 'saas' })
  const failed = await probeVia(async () => {
    throw new Error('timeout')
  }, '8bitgo.com')
  assert.equal(failed.status, 0)
  assert.equal(failed.via, '')
  ok('HTTPS 核对只看是否经 SaaS 区域，网络失败记成未通过而不是崩溃')
}

// ── makeApi：HTTP 失败、网络失败都归一成 success:false，带状态码 ──
{
  const api404 = makeApi('t', async () => new Response('{"success":false}', { status: 404 }))
  assert.deepEqual(await api404('GET', '/x').then((r) => [r.success, r.httpStatus]), [false, 404])
  const apiDown = makeApi('t', async () => {
    throw new Error('ECONNRESET')
  })
  assert.deepEqual(await apiDown('GET', '/x').then((r) => [r.success, r.httpStatus]), [false, 0])
  let auth = ''
  await makeApi('tok', async (url, init) => {
    auth = init.headers.Authorization
    return new Response('{"success":true}', { status: 200 })
  })('GET', '/x')
  assert.equal(auth, 'Bearer tok')
  ok('API 封装：失败统一成 success:false 并保留状态码，令牌走 Authorization 头')
}

// ── 默认主机名与 create-hostnames.sh 一致 ──
{
  const { readFileSync } = await import('node:fs')
  const sh = readFileSync(new URL('../deploy/saas/create-hostnames.sh', import.meta.url), 'utf8')
  const line = sh.match(/set -- ([^\n\\]+\\\n\s+[^\n]+)/)?.[1] || ''
  const fromSh = line.replace(/\\\n/g, ' ').split(/\s+/).filter((s) => s.endsWith('8bitgo.com'))
  assert.deepEqual([...fromSh].sort(), [...DEFAULT_HOSTS].sort())
  ok('默认主机名清单与 create-hostnames.sh 一致')
}

console.log(`\n${passed} 项通过`)
