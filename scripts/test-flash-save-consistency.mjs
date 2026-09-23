/**
 * Flash 在线存档的「四处一致」检查。
 *
 * 这块功能最容易出的错不是崩溃，而是**静默错配**：前端把游戏引到 AGI2 的桥，后端却按 AGI1
 * 的形状回数据 —— 桥加载成功、游戏也能连上，就是永远读不到档，而且没有任何报错。
 * 四种错配都在这条线上，所以逐条钉死：
 *
 *   1. 共用注册表里的每款游戏都有方言，且方言只有 agi1 / agi2 两种
 *   2. 桥文件名和方言配套（agi1 → AGI.swf，agi2 → AGI2.swf）
 *   3. 服务端契约从注册表读到的结果和注册表本身一致
 *   4. 前端不再自己写一份桥表（只在注册表里有一份）—— 靠源码文本检查，因为前端模块
 *      引了浏览器 API，没法在 node 里直接 import
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FLASH_SAVE_GAMES,
  flashSaveBridgeOf,
  flashSaveGameKeyOf,
  flashSaveProtocolOf,
} from '../shared/flash-save-games.js'
import {
  FLASH_SAVE_BRIDGES,
  flashSaveBridgeUrl,
  flashSaveGameEnabled,
  flashSaveProtocol,
} from '../server/src/flash-save-contract.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROTOCOLS = ['agi1', 'agi2']
/** 每一代方言加载的桥文件名是固定的，改桥文件名等于改协议，必须同时改后端 */
const BRIDGE_FILE_BY_PROTOCOL = { agi1: 'AGI.swf', agi2: 'AGI2.swf' }

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log(`✓ ${name}`)
}

check('注册表里出现过的方言都受支持，且每款都带桥地址', () => {
  const entries = Object.entries(FLASH_SAVE_GAMES)
  assert.ok(entries.length > 0, '注册表是空的')
  for (const [slug, entry] of entries) {
    assert.ok(PROTOCOLS.includes(entry.protocol), `${slug} 的方言 ${entry.protocol} 不认识`)
    assert.ok(entry.bridge.startsWith('/flash-api/armor-games/'), `${slug} 的桥地址不在站内桥目录下`)
    assert.ok(flashSaveBridgeOf(slug) === entry.bridge, `${slug} 的桥地址从表里读出来不一致`)
    assert.ok(flashSaveProtocolOf(slug) === entry.protocol, `${slug} 的方言从表里读出来不一致`)
    if (entry.protocol === 'agi1') {
      assert.ok(entry.agiGameKey, `${slug} 是 AGI1 但没配 agiGameKey`)
      assert.equal(flashSaveGameKeyOf(slug), entry.agiGameKey, `${slug} 的 AGI1 gameKey 读出来不一致`)
    }
  }
})

check('桥文件名和方言配套（指错了就是「能连上但读不到档」）', () => {
  for (const [slug, entry] of Object.entries(FLASH_SAVE_GAMES)) {
    const expected = BRIDGE_FILE_BY_PROTOCOL[entry.protocol]
    assert.ok(
      entry.bridge.endsWith(`/${expected}`),
      `${slug} 是 ${entry.protocol}，桥文件应该是 ${expected}，实际是 ${entry.bridge}`,
    )
  }
})

check('服务端契约读到的方言 / 桥地址和注册表一致', () => {
  for (const [slug, entry] of Object.entries(FLASH_SAVE_GAMES)) {
    assert.equal(flashSaveProtocol(slug), entry.protocol, `${slug} 前后端方言不一致`)
    assert.equal(flashSaveBridgeUrl(slug), entry.bridge, `${slug} 前后端桥地址不一致`)
  }
  // 表外的 slug 一律退回 agi1：老游戏的行为不能被新方言悄悄改掉
  assert.equal(flashSaveProtocol('never-reviewed'), 'agi1')
  assert.equal(flashSaveBridgeUrl('never-reviewed'), FLASH_SAVE_BRIDGES.agi1)
})

check('白名单默认值就是注册表全量（不再靠手写字符串）', () => {
  for (const slug of Object.keys(FLASH_SAVE_GAMES)) {
    assert.equal(flashSaveGameEnabled(slug, {}), true, `${slug} 在注册表里但默认白名单没放行`)
  }
  assert.equal(flashSaveGameEnabled('never-reviewed', {}), false)
})

check('前端不再自己维护一份桥表', () => {
  const source = readFileSync(join(root, 'src/services/flashOnlineSave.ts'), 'utf8')
  assert.ok(
    !/['"]\/flash-api\/armor-games\//.test(source),
    '前端又出现了写死的桥地址：桥表只应该有一份（shared/flash-save-games.js）',
  )
  assert.ok(
    source.includes("from '../../shared/flash-save-games.js'"),
    '前端没有从共用注册表读桥地址',
  )
})

check('游客只在游戏内主动用在线槽时才打开登录框', () => {
  const service = readFileSync(join(root, 'src/services/flashOnlineSave.ts'), 'utf8')
  const ruffle = readFileSync(join(root, 'src/emulator/adapters/ruffle.ts'), 'utf8')
  const player = readFileSync(join(root, 'src/emulator/EmulatorPlayer.tsx'), 'utf8')
  const agi1 = readFileSync(join(root, 'flash-api/armor-games/src/test_fla/MainTimeline.as'), 'utf8')
  const agi2 = readFileSync(join(root, 'flash-api/armor-games/src-agi2/KrfAgiBridge.as'), 'utf8')

  for (const key of ['eightbitgo_save_mode', 'eightbitgo_login_callback', 'FLASH_SAVE_LOGIN_CALLBACK']) {
    assert.ok(service.includes(key), `启动参数缺 ${key}`)
  }
  assert.ok(ruffle.includes('allowScriptAccess: Boolean(onlineSave)'), '审核过的在线存档游戏没开 ExternalInterface')
  assert.ok(ruffle.includes("onlineSave?.mode === 'guest'"), '页面没有区分游客和服务故障')
  assert.ok(player.includes('onFlashSaveLoginRequired') && player.includes('openAuthModal()'), '播放器没有打开站内登录框')
  for (const [label, source] of [['AGI1', agi1], ['AGI2', agi2]]) {
    assert.ok(source.includes('ExternalInterface.call'), `${label} 没有向页面上报登录意图`)
    assert.ok(source.includes('saveMode != "guest"'), `${label} 会把服务故障误报成未登录`)
  }
  // retrieve 是 KRF 开局自动调的；没有 promptLogin 门槛就会一进游戏弹窗。
  assert.ok(agi2.includes('options.promptLogin === true'), 'AGI2 读档没有「用户主动」门槛')
})

check('AGI2 具备幂等重试、条件更新和给新游戏的简化接口', () => {
  const source = readFileSync(join(root, 'flash-api/armor-games/src-agi2/KrfAgiBridge.as'), 'utf8')
  for (const fragment of [
    'public var eightbitgo:Object',
    '"opId":this.nextOpId()',
    'body.expectedRevision',
    'mergeRevisions(result)',
    'waitForQueue(function()',
    '"showLogin": this.simpleShowLogin',
    '"read": this.simpleRead',
    '"write": this.simpleWrite',
    '"remove": this.simpleRemove',
  ]) {
    assert.ok(source.includes(fragment), `AGI2 缺少关键链路：${fragment}`)
  }
})

console.log(`\n✅ Flash 在线存档一致性 ${passed} 项通过`)
