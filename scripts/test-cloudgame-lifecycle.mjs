/**
 * 云游戏的断线生命周期源码守卫。
 *
 * cloud-game 需要外部 coordinator 和真实 WebRTC 媒体，普通单测环境起不来整条链；
 * 这里把两个浏览器真实会出现、又最容易退化成永久黑屏的分支锁住。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/emulator/adapters/cloudgame.ts', import.meta.url), 'utf8')

assert.match(source, /const PEER_DISCONNECT_GRACE_MS = 10_000/)
assert.match(
  source,
  /connectionState === 'disconnected'[\s\S]{0,700}PEER_DISCONNECT_GRACE_MS/,
  'disconnected 必须有自愈宽限和终止计时器',
)
assert.match(
  source,
  /track\.kind === 'video'[\s\S]{0,500}addEventListener\('ended'[\s\S]{0,300}fail\(rt\.cloudDisconnected\)/,
  '视频轨结束时必须结束会话，不能永久定格最后一帧',
)
assert.match(source, /if \(destroyed \|\| terminal\) return[\s\S]{0,100}terminal = true/, '致命错误只能进入一次终态')
assert.match(source, /clearTimeout\(peerDisconnectTimer\)/, '销毁或失败时必须清掉断线计时器')

console.log('云游戏生命周期通过：永久 disconnected、视频轨结束与重复终态均有保护')
