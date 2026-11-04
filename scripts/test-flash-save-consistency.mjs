/**
 * Flash 在线存档的「四处一致」检查。
 *
 * 这块功能最容易出的错不是崩溃，而是**静默错配**：前端把游戏引到 AGI2 的桥，后端却按 AGI1
 * 的形状回数据 —— 桥加载成功、游戏也能连上，就是永远读不到档，而且没有任何报错。
 * 四种错配都在这条线上，所以逐条钉死：
 *
 *   1. 共用注册表里的每款游戏都有方言，且方言只有 agi1 / agi2 两种
 *   2. 每款桥都在本站不可变发布目录；同一 key→value 存储方言可以有不同的游戏侧接口
 *   3. 服务端契约从注册表读到的结果和注册表本身一致
 *   4. 前端不再自己写一份桥表（只在注册表里有一份）—— 靠源码文本检查，因为前端模块
 *      引了浏览器 API，没法在 node 里直接 import
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FLASH_SAVE_BRIDGE_RELEASE,
  FLASH_SAVE_GAMES,
  flashSaveBridgeOf,
  flashSaveGameKeyOf,
  flashSaveLoginUrlsOf,
  flashSaveProtocolOf,
  flashSaveRewriteSourcesOf,
} from '../shared/flash-save-games.js'
import {
  FLASH_SAVE_BRIDGES,
  flashSaveBridgeUrl,
  flashSaveGameEnabled,
  flashSaveProtocol,
} from '../server/src/flash-save-contract.js'
import { flashSaveBridgeRewriteRules } from '../src/services/flashBridgeUrl.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROTOCOLS = ['agi1', 'agi2']

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
    assert.ok(entry.bridge.startsWith('/flash-api/'), `${slug} 的桥地址不在站内桥目录下`)
    assert.ok(entry.bridge.endsWith('.swf'), `${slug} 的桥地址不是 SWF`)
    assert.ok(flashSaveBridgeOf(slug) === entry.bridge, `${slug} 的桥地址从表里读出来不一致`)
    assert.ok(flashSaveProtocolOf(slug) === entry.protocol, `${slug} 的方言从表里读出来不一致`)
    if (entry.protocol === 'agi1') {
      assert.ok(entry.agiGameKey, `${slug} 是 AGI1 但没配 agiGameKey`)
      assert.equal(flashSaveGameKeyOf(slug), entry.agiGameKey, `${slug} 的 AGI1 gameKey 读出来不一致`)
    }
  }
})

check('SAS3 的旧 Banana 地址与网页登录地址都从注册表读取', () => {
  assert.deepEqual(flashSaveRewriteSourcesOf('sas-zombie-assault-3'), [
    'http://ninjakiwi.com/nklogin/Banana.swf?gamename=SAS3',
    'http://ninjakiwi.com/nklogin/debugBanana.swf?gamename=SAS3',
  ])
  assert.ok(flashSaveLoginUrlsOf('sas-zombie-assault-3').includes('https://ninjakiwi.com/login'))
  assert.deepEqual(flashSaveRewriteSourcesOf('infectonator-2'), [])
})

check('在线存档 FlashVars 同时进入子桥 URL，且直连桥地址也会自映射', () => {
  const service = readFileSync(join(root, 'src/services/flashOnlineSave.ts'), 'utf8')
  assert.ok(service.includes('flashSaveBridgeRewriteRules(launch.bridgeUrl, launch.rewriteFrom, launch.parameters)'),
    'Ruffle 配置没有接入带 FlashVars 的桥 URL 规则')
  const bridgeUrl = `https://8bitgo.com/flash-api/armor-games/${FLASH_SAVE_BRIDGE_RELEASE}/AGI2.swf?v=1`
  const parameters = {
    eightbitgo_save_token: 'token+/=value',
    eightbitgo_save_endpoint: 'https://8bitgo.com/api/flash-saves/v1/kingdom-rushfrontiers',
    eightbitgo_username: 'Player One',
    eightbitgo_save_mode: 'authenticated',
  }
  const rules = flashSaveBridgeRewriteRules(bridgeUrl, [], parameters)
  const selfRule = rules.find(([source]) => source === bridgeUrl)
  assert.ok(selfRule, '直接加载本站桥时缺少 bridgeUrl 自映射')
  const target = new URL(selfRule[1])
  assert.equal(target.searchParams.get('v'), '1', '原桥 URL 的版本参数必须保留')
  for (const [key, value] of Object.entries(parameters)) {
    assert.equal(target.searchParams.get(key), value, `${key} 没有被正确序列化到桥 URL`)
  }
  assert.ok(rules.some(([source]) => source === 'https://agi.armorgames.com/assets/agi/AGI2.swf'),
    '旧游戏请求 AGI2.swf 时仍需改写到本站桥')
  assert.ok(rules.some(([source]) => source === 'https://8bitgo.com/flash-api/armor-games/20260925-r03/AGI2.swf'),
    '已打补丁的旧版本 AGI2 地址必须继续可用')
  assert.ok(rules.some(([source]) => source === 'https://8bitgo.com/flash-api/armor-games/AGI2.swf'),
    '未版本化的 AGI2 地址必须继续可用')
  assert.ok(rules.every(([, destination]) => destination === selfRule[1]),
    'Armor Games、旧版本、未版本化和直连地址必须进入同一个带 FlashVars 的目标 URL')
  const agi1Rules = flashSaveBridgeRewriteRules(
    `https://8bitgo.com/flash-api/armor-games/${FLASH_SAVE_BRIDGE_RELEASE}/AGI.swf`,
    [],
    parameters,
  )
  assert.ok(agi1Rules.some(([source]) => source === 'https://8bitgo.com/flash-api/armor-games/20260925-r03/AGI.swf'),
    '已打补丁的旧版本 AGI1 地址必须继续可用')
  assert.ok(agi1Rules.some(([source]) => source === 'https://8bitgo.com/flash-api/armor-games/AGI.swf'),
    '未版本化的 AGI1 地址必须继续可用')
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

check('在线存档会话请求有总时限，API 卡住不能挡住游戏启动', () => {
  const source = readFileSync(join(root, 'src/services/flashOnlineSave.ts'), 'utf8')
  assert.match(source, /Promise\.race\(\[requestSessionOnce\(gameSlug\), timeout\]\)/,
    'Ruffle 启动链会 await 这份会话；没有时限时已登录玩家会永远停在加载遮罩')
  assert.match(source, /FLASH_SAVE_SESSION_TIMEOUT_MS = \d+/)
})

check('游客只在游戏内主动用在线槽时才打开登录框', () => {
  const service = readFileSync(join(root, 'src/services/flashOnlineSave.ts'), 'utf8')
  const ruffle = readFileSync(join(root, 'src/emulator/adapters/ruffle.ts'), 'utf8')
  const player = readFileSync(join(root, 'src/emulator/EmulatorPlayer.tsx'), 'utf8')
  const agi1 = readFileSync(join(root, 'flash-api/armor-games/src/test_fla/MainTimeline.as'), 'utf8')
  const agi2 = readFileSync(join(root, 'flash-api/armor-games/src-agi2/KrfAgiBridge.as'), 'utf8')
  const sas3 = readFileSync(join(root, 'flash-api/ninjakiwi/src/test_fla/MainTimeline.as'), 'utf8')

  for (const key of ['eightbitgo_save_mode', 'eightbitgo_login_callback', 'FLASH_SAVE_LOGIN_CALLBACK']) {
    assert.ok(service.includes(key), `启动参数缺 ${key}`)
  }
  assert.ok(ruffle.includes('allowScriptAccess: Boolean(onlineSave)'), '审核过的在线存档游戏没开 ExternalInterface')
  assert.ok(ruffle.includes("onlineSave?.mode === 'guest'"), '页面没有区分游客和服务故障')
  assert.ok(player.includes('onFlashSaveLoginRequired') && player.includes('openAuthModal()'), '播放器没有打开站内登录框')
  for (const [label, source] of [['AGI1', agi1], ['AGI2', agi2], ['SAS3 Banana', sas3]]) {
    assert.ok(source.includes('ExternalInterface.call'), `${label} 没有向页面上报登录意图`)
    assert.ok(source.includes('saveMode != "guest"'), `${label} 会把服务故障误报成未登录`)
  }
  // retrieve 是 KRF 开局自动调的；没有 promptLogin 门槛就会一进游戏弹窗。
  assert.ok(agi2.includes('options.promptLogin === true'), 'AGI2 读档没有「用户主动」门槛')
  assert.ok(ruffle.includes('installFlashLegacyLoginRedirect'), 'SAS3 主 SWF 的 navigateToURL 没接回站内登录框')
})

check('SAS3 Banana 保留旧事件与主进度接口，且读失败时禁止覆盖云档', () => {
  const source = readFileSync(join(root, 'flash-api/ninjakiwi/src/test_fla/MainTimeline.as'), 'utf8')
  for (const fragment of [
    'new Event("connected",true)',
    'new Event(this.loggedIn ? "logged in" : "logged out",true)',
    'public function getUserName()',
    'public function setDataHandler(callback:Function)',
    'public function save(data:Object',
    'if(!this.loggedIn || !this.cloudReady',
    '"expectedRevision":this.revision',
  ]) {
    assert.ok(source.includes(fragment), `SAS3 Banana 缺少关键链路：${fragment}`)
  }
})

check('AGI2 具备幂等重试、条件更新和给新游戏的简化接口', () => {
  const source = readFileSync(join(root, 'flash-api/armor-games/src-agi2/KrfAgiBridge.as'), 'utf8')
  for (const fragment of [
    'public var eightbitgo:Object',
    '"opId":this.nextOpId()',
    'body.expectedRevision',
    'mergeRevisions(result)',
    'this.enqueue({"kind":"read","callback":callback})',
    'else if(task.kind == "read")',
    'MAX_QUEUED_TASKS:int = 12',
    'pending.value = task.value',
    'private function armReadTimeout(task:Object) : void',
    'new Timer(30000,1)',
    '"code":"timeout"',
    '"showLogin": this.simpleShowLogin',
    '"read": this.simpleRead',
    '"write": this.simpleWrite',
    '"remove": this.simpleRemove',
  ]) {
    assert.ok(source.includes(fragment), `AGI2 缺少关键链路：${fragment}`)
  }
  const rootParamsMerge = source.indexOf('for(var rootName:String in rootParams) params[rootName] = rootParams[rootName]')
  const bridgeParamsMerge = source.indexOf('for(var bridgeName:String in bridgeParams) params[bridgeName] = bridgeParams[bridgeName]')
  assert.ok(rootParamsMerge >= 0 && bridgeParamsMerge > rootParamsMerge,
    'AGI2 必须先继承主影片 FlashVars，再让桥 URL query 覆盖同名旧值')
  assert.ok(!source.includes('waitForQueue('), 'AGI2 仍有 3 秒后绕过队列读旧档的路径')
})

check('⚠️ AGI2 不用顶层 JSON 类（KRF 是 SWF 10，Ruffle 不给它 JSON），且能从 connect({stage}) 取 FlashVars', () => {
  const source = readFileSync(join(root, 'flash-api/armor-games/src-agi2/KrfAgiBridge.as'), 'utf8')
  // 去掉注释再查：类注释里会提到 JSON.stringify 这个名字
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.ok(!/\bJSON\s*\./.test(code), 'AGI2 又用了 JSON.parse / JSON.stringify：KRF 里会抛 #1065，游戏弹「CONNECTION LOST」')
  for (const fragment of [
    'request.data = this.encodeJson(body,0)',
    'decodeJson(text) as Object',
    'private function quoteJson(value:String) : String',
    'private function jsonString() : String',
    'this.connectStage = options != null && options.stage != null ? options.stage : null',
    'rootParams = this.connectStage.getChildAt(0).loaderInfo.parameters',
  ]) {
    assert.ok(source.includes(fragment), `AGI2 缺少 SWF 10 兼容链路：${fragment}`)
  }
  assert.ok(source.indexOf('this.connectStage = options') < source.indexOf('this.readParameters();'),
    'connect 必须先记下舞台再读参数')
})

check('AGI1 读档屏障覆盖排队写入、删除与未配对快照，超时失败关闭', () => {
  const source = readFileSync(join(root, 'flash-api/armor-games/src/test_fla/MainTimeline.as'), 'utf8')
  for (const fragment of [
    'private var pendingMutations:int = 0',
    'private var drainWaiters:Array = []',
    'private function mutationsDrained() : Boolean',
    'for(var slot:String in pendingPairs)',
    'new Timer(30000,1)',
    '"error":"timeout"',
    'pendingMutations++',
    'if(pendingMutations > 0) pendingMutations--',
    'private static const MAX_PENDING_MUTATIONS:int = 12',
  ]) {
    assert.ok(source.includes(fragment), `AGI1 缺少一致性保护：${fragment}`)
  }
  assert.ok(!source.includes('writesInFlight'), 'AGI1 仍只等待正在飞的写，漏掉队列和删除')
  assert.ok(!source.includes('waited >= 3000'), 'AGI1 仍会超时后放行可能过期的读取')
})

check('两代桥遇到写入冲突后仍保留条件更新保护', () => {
  const bridges = [
    ['AGI1', readFileSync(join(root, 'flash-api/armor-games/src/test_fla/MainTimeline.as'), 'utf8')],
    ['AGI2', readFileSync(join(root, 'flash-api/armor-games/src-agi2/KrfAgiBridge.as'), 'utf8')],
  ]
  for (const [label, source] of bridges) {
    assert.ok(source.includes('error.currentRevision'), `${label} 没有读取服务端当前代次`)
    assert.ok(source.includes('Number(result.error.currentRevision)'), `${label} 没有恢复本地条件更新基线`)
  }
})

console.log(`\n✅ Flash 在线存档一致性 ${passed} 项通过`)
