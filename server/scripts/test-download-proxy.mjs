/**
 * 下载域名转发的客户端 IP 采信规则（server/src/download-proxy.js）。
 * 不联网、不用数据库：node scripts/test-download-proxy.mjs
 */
import assert from 'node:assert/strict'
import { trustedProxyClientIp, PROXY_KEY_HEADER, PROXY_CLIENT_IP_HEADER } from '../src/download-proxy.js'

const SECRET = 'k'.repeat(48)
const h = (key, ip) => ({ [PROXY_KEY_HEADER]: key, [PROXY_CLIENT_IP_HEADER]: ip })
let n = 0
const ok = (name, fn) => { fn(); n += 1; console.log(`  ✓ ${name}`) }

ok('密钥对上时采信 IPv4 / IPv6', () => {
  assert.equal(trustedProxyClientIp(h(SECRET, '203.0.113.9'), SECRET), '203.0.113.9')
  assert.equal(trustedProxyClientIp(h(SECRET, ' 2001:db8::1 '), SECRET), '2001:db8::1')
})
ok('密钥不对、缺失或长度不同都不采信', () => {
  assert.equal(trustedProxyClientIp(h('k'.repeat(47) + 'x', '203.0.113.9'), SECRET), '')
  assert.equal(trustedProxyClientIp(h('', '203.0.113.9'), SECRET), '')
  assert.equal(trustedProxyClientIp({ [PROXY_CLIENT_IP_HEADER]: '203.0.113.9' }, SECRET), '')
  assert.equal(trustedProxyClientIp(h('short', '203.0.113.9'), SECRET), '')
})
ok('源站没配密钥或密钥太短时整条关闭（哪怕请求带了同样的值）', () => {
  assert.equal(trustedProxyClientIp(h('', '203.0.113.9'), ''), '')
  assert.equal(trustedProxyClientIp(h('short', '203.0.113.9'), 'short'), '')
  assert.equal(trustedProxyClientIp(h(SECRET, '203.0.113.9'), undefined), '')
})
ok('报上来的不是合法 IP 时不采信', () => {
  assert.equal(trustedProxyClientIp(h(SECRET, 'not-an-ip'), SECRET), '')
  assert.equal(trustedProxyClientIp(h(SECRET, '203.0.113.9, 1.1.1.1'), SECRET), '')
})
ok('重复头（数组）不采信', () => {
  assert.equal(trustedProxyClientIp({ [PROXY_KEY_HEADER]: [SECRET, SECRET], [PROXY_CLIENT_IP_HEADER]: '203.0.113.9' }, SECRET), '')
})
console.log(`download-proxy: ${n} 组通过`)
