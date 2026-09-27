import assert from 'node:assert/strict'
import { html5SaveBridgeOrigin, versionHtml5Entry } from '../src/emulator/adapters/html5.ts'

const main = 'https://8bitgo.com/games/pvz'
assert.equal(html5SaveBridgeOrigin('/web/PvZ/cn', main), 'https://8bitgo.com')
assert.equal(html5SaveBridgeOrigin('https://pvz.8bitgo.com/web/PvZ/cn/', main), 'https://pvz.8bitgo.com')
assert.equal(html5SaveBridgeOrigin('https://8bitgo-pvz.pages.dev/web/PvZ/cn/', main), 'https://8bitgo-pvz.pages.dev')
assert.equal(html5SaveBridgeOrigin('https://digiverse.8bitgo.com/web/gamblers-table/', main), 'https://digiverse.8bitgo.com')
assert.equal(html5SaveBridgeOrigin('https://gamblers-table.8bitgo.com/web/gamblers-table/', main), 'https://gamblers-table.8bitgo.com')
assert.equal(html5SaveBridgeOrigin('https://attacker.8bitgo.com/game/', main), null)
assert.equal(html5SaveBridgeOrigin('https://example.com/game/', main), null)

const versioned = new URL(versionHtml5Entry('https://pvz.8bitgo.com/web/PvZ/cn/', main))
assert.equal(versioned.origin, 'https://pvz.8bitgo.com')
assert.equal(versioned.searchParams.get('shell'), '20260924-resume1')
assert.equal(new URL(versionHtml5Entry('https://8bitgo-pvz.pages.dev/web/PvZ/cn/', main)).searchParams.get('shell'), '20260924-resume1')
assert.equal(versionHtml5Entry('https://example.com/web/PvZ/cn/', main), 'https://example.com/web/PvZ/cn/')

const migrations = [
  ['/web/PvZ/cn/', 'https://pvz.8bitgo.com/web/PvZ/cn/'],
  ['/web/diablo/', 'https://diablo.8bitgo.com/web/diablo/'],
  ['/web/Minecraft/', 'https://minecraft.8bitgo.com/web/Minecraft/'],
  ['/web/celeste/', 'https://celeste.8bitgo.com/web/celeste/'],
  ['/web/terraria/', 'https://terraria.8bitgo.com/web/terraria/'],
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

console.log('Pages 跨域运行桥：旧入口迁移、精确来源白名单与 PvZ 发布代次检查通过')
