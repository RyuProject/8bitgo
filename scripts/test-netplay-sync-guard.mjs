/** 房主帧轴的回归：访客冻结后的第 20 帧和恶意远期帧都不能积在引擎里。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeHostSync } from '../src/emulator/netplaySyncGuard.ts'

// 房主端包的是 dataMessage 方法；引擎若改成直接捕获原函数，注入器就失效，必须在升级时发现。
const engine = readFileSync(new URL('../public/emulatorjs/emulator.min.js', import.meta.url), 'utf8')
assert.match(engine, /this\.socket\.on\("data-message",t=>\{this\.dataMessage\(t\)\}\)/)

const input = (frame, player = 1, index = 8, value = 1) => ({ frame, connected_input: [player, index, value] })
const message = { 'sync-control': [input(20)], chat: 'still here' }
const onHost = normalizeHostSync(message, true, 100_000)
assert.equal(onHost['sync-control'][0].frame, 100_020, '访客冻结的旧帧号必须换成房主当前帧')
assert.equal(onHost.chat, 'still here', '其它消息不能丢')
assert.equal(message['sync-control'][0].frame, 20, '不能就地改 Socket.IO 收到的消息')

const far = normalizeHostSync({ 'sync-control': [input(2 ** 31 - 1), input(-1), input(999_999)] }, true, 40)
assert.deepEqual(far['sync-control'].map((entry) => entry.frame), [60, 60, 60], '任意远期帧只能占房主附近的小窗口')

const flood = normalizeHostSync({ 'sync-control': Array.from({ length: 1000 }, (_, i) => input(i)) }, true, 40)
assert.equal(flood['sync-control'].length, 32, '单包上限防止绕过服务器时撑爆房主')

const bad = normalizeHostSync({ 'sync-control': [input(20, 1, {}, 1), input(20, 1, 8, 'x')], chat: 'keep' }, true, 40)
assert.equal('sync-control' in bad, false, '畸形按键不能进引擎')
assert.equal(bad.chat, 'keep', '畸形按键和聊天同包时聊天仍要显示')

assert.equal(normalizeHostSync(message, false, 100_000), message, '访客端保持引擎原来的接收行为')
assert.equal(normalizeHostSync({ chat: 'hi' }, true, 100_000).chat, 'hi', '非按键消息原样转发')
console.log('✅ 房主帧轴与畸形输入守门通过（8 项）')
