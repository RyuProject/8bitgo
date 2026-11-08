import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createIpxAlias, jsdosIceEndpoint, parseIpxAddress } from '../src/emulator/ipxAddress.ts'

assert.deepEqual(parseIpxAddress('123456'), { kind: 'peer', peerId: 123456 })
assert.deepEqual(parseIpxAddress('4294967295'), { kind: 'peer', peerId: 0xffff_ffff })
assert.equal(parseIpxAddress('4294967296'), null)
assert.equal(parseIpxAddress('0'), null)
assert.deepEqual(parseIpxAddress('IPX=8bg-ab12cd34ef56'), { kind: 'alias', alias: '8bg-ab12cd34ef56' })
assert.equal(parseIpxAddress('https://evil.example/ipx/room'), null)
assert.equal(parseIpxAddress('peer id'), null)
assert.equal(createIpxAlias(Uint8Array.from([0, 1, 2, 3, 4, 5, 254, 255])), '8bg-000102030405feff')
assert.equal(jsdosIceEndpoint('same-origin'), '/api/netplay/ice')
assert.equal(jsdosIceEndpoint(undefined), '/api/netplay/ice')
assert.equal(jsdosIceEndpoint('https://api.example/'), 'https://api.example/api/netplay/ice')

const adapter = readFileSync(new URL('../src/emulator/adapters/jsdos.ts', import.meta.url), 'utf8')
assert.match(adapter, /hand_ipx_startserver/, '房主必须触发 js-dos 的 IPX 主机事件')
assert.match(adapter, /net\.registerAlias\(alias\.alias\)/, '房主必须注册可分享的 P2P 别名')
assert.match(adapter, /networkConnect\(0, String\(peerId\)\)/, '加入时必须把 peer id 交给 js-dos IPX 网络接口')
assert.match(adapter, /jsdosIceEndpoint\(import\.meta\.env\.VITE_API_URL\)/, 'ICE 请求必须正确支持 same-origin')

console.log('js-dos IPX 地址与 ICE 配置回归通过')
