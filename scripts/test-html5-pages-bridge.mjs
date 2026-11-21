import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { html5SaveBridgeOrigin, versionHtml5Entry } from '../src/emulator/adapters/html5.ts'

const main = 'https://8bitgo.com/games/pvz'
assert.equal(html5SaveBridgeOrigin('/web/PvZ/cn', main), 'https://8bitgo.com')
assert.equal(html5SaveBridgeOrigin('https://pvz.8bitgo.com/web/PvZ/cn/', main), 'https://pvz.8bitgo.com')
assert.equal(html5SaveBridgeOrigin('https://8bitgo-pvz.pages.dev/web/PvZ/cn/', main), 'https://8bitgo-pvz.pages.dev')
assert.equal(html5SaveBridgeOrigin('https://digiverse.8bitgo.com/web/gamblers-table/', main), 'https://digiverse.8bitgo.com')
assert.equal(html5SaveBridgeOrigin('https://gamblers-table.8bitgo.com/web/gamblers-table/', main), 'https://gamblers-table.8bitgo.com')
assert.equal(html5SaveBridgeOrigin('https://attacker.8bitgo.com/game/', main), null)
assert.equal(html5SaveBridgeOrigin('https://example.com/game/', main), null)
// cn / tv 入口嵌同一个 Pages 游戏页；游戏页那一侧的父页面名单（pvz-page.js、Gamblers 存档桥）必须认它们。
assert.equal(html5SaveBridgeOrigin('https://pvz.8bitgo.com/web/PvZ/cn/', 'https://cn.8bitgo.com/games/pvz'), 'https://pvz.8bitgo.com')
// PokeCatch 是未经本站管理、也未接入 postMessage 存档协议的第三方页面；不可开放云存档桥。
assert.equal(html5SaveBridgeOrigin('https://pokecatch-online.netlify.app/', main), null)

const versioned = new URL(versionHtml5Entry('https://pvz.8bitgo.com/web/PvZ/cn/', main))
const adapterSource = readFileSync(new URL('../src/emulator/adapters/html5.ts', import.meta.url), 'utf8')
const shellVersion = adapterSource.match(/const PVZ_SHELL_VERSION = '([^']+)'/)?.[1]
assert.ok(shellVersion, 'HTML5 适配器必须声明 PvZ shell 发布代次')
assert.equal(versioned.origin, 'https://pvz.8bitgo.com')
assert.equal(versioned.searchParams.get('shell'), shellVersion)
assert.equal(new URL(versionHtml5Entry('https://8bitgo-pvz.pages.dev/web/PvZ/cn/', main)).searchParams.get('shell'), shellVersion)
assert.equal(versionHtml5Entry('https://example.com/web/PvZ/cn/', main), 'https://example.com/web/PvZ/cn/')

const migrations = [
  ['/web/PvZ/cn/', 'https://pvz.8bitgo.com/web/PvZ/cn/'],
  ['/web/diablo/', 'https://diablo.8bitgo.com/web/diablo/'],
  ['/web/Minecraft/', 'https://minecraft.8bitgo.com/web/Minecraft/eaglercraft/index.html'],
  ['/web/celeste/', 'https://celeste.8bitgo.com/web/celeste/'],
  ['/web/terraria/', 'https://terraria.8bitgo.com/web/terraria/'],
  ['/web/cs16/', 'https://cs16.8bitgo.com/web/cs16/'],
]
for (const [legacy, expected] of migrations) {
  const migrated = new URL(versionHtml5Entry(`${legacy}?from=database#resume`, main))
  const target = new URL(expected)
  assert.equal(migrated.origin, target.origin)
  assert.equal(migrated.pathname, target.pathname)
  assert.equal(migrated.searchParams.get('from'), 'database')
  assert.equal(migrated.hash, '#resume')
}

const migratedPvz = versionHtml5Entry('/web/PvZ/cn/', main)
assert.equal(html5SaveBridgeOrigin(migratedPvz, main), 'https://pvz.8bitgo.com')
assert.equal(versionHtml5Entry('/web/PvZ2/', main), '/web/PvZ2/')

// 拆播放器时先收最后一份自动快照：存档桥监听不能先于 iframe 置空被摘掉，等待有上限。
{
  const adapter = readFileSync(new URL('../src/emulator/adapters/html5.ts', import.meta.url), 'utf8')
  const destroy = adapter.slice(adapter.indexOf('    destroy() {'))
  const blank = destroy.indexOf("iframe.src = 'about:blank'")
  const unhook = destroy.indexOf("window.removeEventListener('message', onSaveBridgeMessage)")
  assert.ok(blank > 0 && unhook > blank, '存档桥监听必须在 iframe 置空之后（收尾宽限结束时）才摘掉')
  assert.ok(destroy.includes("type: 'auto-final-snapshot'"), 'destroy 要先请游戏页交出最后一份自动快照')
  const limit = Number(adapter.match(/const SAVE_BRIDGE_FINAL_SNAPSHOT_MS = ([\d_]+)/)?.[1].replace(/_/g, ''))
  assert.ok(limit > 0 && limit <= 1500, '收尾等待不超过 1.5 秒，游戏页不回应也要拆')
  assert.ok(destroy.includes('window.setTimeout(teardownFrame, SAVE_BRIDGE_FINAL_SNAPSHOT_MS)'), '收尾有超时兜底')
  assert.ok(adapter.includes("event.source !== saveBridgeWindow"), 'iframe 已脱离 DOM 时仍认存档桥 window 发来的 pagehide 快照')
  assert.ok(adapter.includes("account: result.enabled ? cloudSaveAccountTag() : null"), '开局恢复回执带账号摘要，游戏页据此分账号记同步基线')
}

console.log('Pages 跨域运行桥：旧入口迁移、精确来源白名单、PvZ 发布代次与存档收尾检查通过')
