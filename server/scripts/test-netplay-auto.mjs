/**
 * 联机人数自动推断（src/netplay-auto.js）回归。不联网、不连库。
 *   cd server && npm run test:netplay-auto
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defaultArcadePlayers,
  inferNetplayPlayers,
  resolveNetplay,
  effectiveNetplayMode,
  romDataDriverName,
  syncNetplayDerived,
} from '../src/netplay-auto.js'
import { netplayModeFromInput, normalizeNetplayMode } from '../../shared/netplay-players.js'
import { netplayGameConfigError } from '../src/routes/games.js'

const here = path.dirname(fileURLToPath(import.meta.url))
let pass = 0
const fails = []
async function check(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fails.push({ name, e })
    console.log(`  ✗ ${name}`)
  }
}

const lookup = defaultArcadePlayers()

await check('FBNeo 人数表能加载，常见 romset 人数对得上', () => {
  assert.ok(lookup, '加载失败')
  assert.ok(lookup.players.size > 9000, `只有 ${lookup.players.size} 个 romset`)
  assert.equal(lookup.players.get('kof97'), 2)
  assert.equal(lookup.players.get('dino'), 3)
  assert.equal(lookup.players.get('tmnt'), 4)
  assert.equal(lookup.players.get('jojobar1'), 2)
})

await check('人数表结构：只列非默认人数 + known 全量名单', () => {
  const data = JSON.parse(readFileSync(path.join(here, '..', '..', 'shared', 'arcade-players.json'), 'utf8'))
  assert.equal(data.defaultPlayers, 2)
  assert.ok(!('2' in data.players), '2 人是默认值，不该再单独列')
  assert.match(data.source, /FBNeo/)
})

await check('按 ROM key 推断：剥掉目录、.zip、.8bg、?romv', () => {
  assert.equal(inferNetplayPlayers({ platform: 'arcade', romKeys: ['roms/arcade/dino.zip.8bg?romv=abc'] }, lookup), 3)
  assert.equal(inferNetplayPlayers({ platform: 'arcade', romKeys: ['roms/arcade/tmnt.zip'] }, lookup), 4)
})

await check('多个语言槽取最少的人数；认不出的槽不参与', () => {
  const keys = ['roms/arcade/tmnt.zip', 'roms/arcade/kof97.zip', 'roms/arcade/whatever-hack.zip']
  assert.equal(inferNetplayPlayers({ platform: 'arcade', romKeys: keys }, lookup), 2)
})

await check('RomData 汉化包按 DrvName 推断', () => {
  const dat = 'ZipName    wofcn\nDrvName    dino\nRomName    ...\n'
  assert.equal(romDataDriverName(dat), 'dino')
  assert.equal(inferNetplayPlayers({ platform: 'arcade', romKeys: ['roms/arcade/wofcn.zip'], romData: dat }, lookup), 3)
})

await check('非街机、认不出的街机都返回 null', () => {
  assert.equal(inferNetplayPlayers({ platform: 'nes', romKeys: ['roms/nes/dino.nes'] }, lookup), null)
  assert.equal(inferNetplayPlayers({ platform: 'arcade', romKeys: ['roms/arcade/tekken-root-flat.zip'] }, lookup), null)
  assert.equal(inferNetplayPlayers({ platform: 'arcade', romKeys: ['roms/arcade/dino.zip'] }, null), null)
})

await check('resolveNetplay：auto 按推断、推断出 1 人就关联机', () => {
  assert.deepEqual(resolveNetplay({ mode: 'auto', platform: 'arcade', players: 1, multiplayer: 0, inferred: 3 }), { players: 3, multiplayer: 1 })
  assert.deepEqual(resolveNetplay({ mode: 'auto', platform: 'arcade', players: 4, multiplayer: 1, inferred: 1 }), { players: 1, multiplayer: 0 })
  assert.deepEqual(resolveNetplay({ mode: 'auto', platform: 'arcade', players: 1, multiplayer: 0, inferred: 8 }), { players: 4, multiplayer: 1 }, '全站上限 4')
})

await check('resolveNetplay：auto 推断不出——街机默认 2 人，其它平台沿用库里的值', () => {
  assert.deepEqual(resolveNetplay({ mode: 'auto', platform: 'arcade', players: 1, multiplayer: 0, inferred: null }), { players: 2, multiplayer: 1 })
  assert.deepEqual(resolveNetplay({ mode: 'auto', platform: 'arcade', players: 4, multiplayer: 1, inferred: null }), { players: 4, multiplayer: 1 })
  assert.deepEqual(resolveNetplay({ mode: 'auto', platform: 'gba', players: 1, multiplayer: 0, inferred: null }), { players: 1, multiplayer: 0 })
  assert.deepEqual(resolveNetplay({ mode: 'auto', platform: 'nes', players: 2, multiplayer: 1, inferred: null }), { players: 2, multiplayer: 1 })
})

await check('resolveNetplay：强制开至少 2 人、强制关一律不联机', () => {
  assert.deepEqual(resolveNetplay({ mode: 'on', platform: 'gba', players: 1, multiplayer: 0, inferred: null }), { players: 2, multiplayer: 1 })
  assert.deepEqual(resolveNetplay({ mode: 'on', platform: 'nes', players: 3, multiplayer: 0, inferred: 2 }), { players: 3, multiplayer: 1 }, '强制开不被推断覆盖')
  assert.deepEqual(resolveNetplay({ mode: 'off', platform: 'nes', players: 2, multiplayer: 1, inferred: 4 }), { players: 2, multiplayer: 0 })
})

await check('街机没有手动开关：on / off 一律按自动识别', () => {
  assert.equal(effectiveNetplayMode('arcade', 'off'), 'auto')
  assert.equal(effectiveNetplayMode('arcade', 'on'), 'auto')
  assert.equal(effectiveNetplayMode('nes', 'off'), 'off')
  assert.deepEqual(resolveNetplay({ mode: 'off', platform: 'arcade', players: 2, multiplayer: 1, inferred: 4 }), { players: 4, multiplayer: 1 })
  assert.deepEqual(resolveNetplay({ mode: 'on', platform: 'arcade', players: 3, multiplayer: 0, inferred: 1 }), { players: 1, multiplayer: 0 })
  assert.deepEqual(resolveNetplay({ mode: 'off', platform: 'arcade', players: 1, multiplayer: 0, inferred: null }), { players: 2, multiplayer: 1 })
  assert.equal(netplayGameConfigError({ platform: 'arcade', netplayMode: 'on', multiplayer: true, players: 1 }), null)
})

await check('请求里的模式：显式值优先；旧客户端勾了联机 = 强制开；没勾不改库', () => {
  assert.equal(netplayModeFromInput({ netplayMode: 'off', multiplayer: true }), 'off')
  assert.equal(netplayModeFromInput({ multiplayer: true }), 'on')
  assert.equal(netplayModeFromInput({ multiplayer: 1 }), 'on')
  assert.equal(netplayModeFromInput({ multiplayer: false }), undefined)
  assert.equal(netplayModeFromInput({ netplayMode: 'bogus' }), undefined)
  assert.equal(normalizeNetplayMode('bogus'), 'auto')
})

await check('后台校验：auto / off 不再要求「勾了联机就得 ≥2 人」', () => {
  assert.equal(netplayGameConfigError({ netplayMode: 'auto', multiplayer: true, players: 1 }), null)
  assert.equal(netplayGameConfigError({ netplayMode: 'off', multiplayer: true, players: 1 }), null)
  assert.ok(netplayGameConfigError({ netplayMode: 'on', multiplayer: true, players: 1 }))
  assert.ok(netplayGameConfigError({ multiplayer: true, players: 1 }), '旧客户端仍按原规则')
})

/** 内存版 run：只认 syncNetplayDerived 用到的几条 SQL */
function fakeDb(game, keys, { missingColumns = false } = {}) {
  const writes = []
  const run = async (sql, params) => {
    if (sql.startsWith('UPDATE games SET netplay_mode')) {
      if (missingColumns) throw Object.assign(new Error('Unknown column'), { code: 'ER_BAD_FIELD_ERROR' })
      game.netplay_mode = params[0]
      writes.push(sql)
      return []
    }
    if (sql.startsWith('SELECT platform, netplay_mode')) {
      if (missingColumns) throw Object.assign(new Error('Unknown column'), { code: 'ER_BAD_FIELD_ERROR' })
      return [{ ...game }]
    }
    if (sql.startsWith('SELECT object_key FROM game_roms')) return keys.map((object_key) => ({ object_key }))
    if (sql.startsWith('UPDATE games SET players')) {
      ;[game.players, game.multiplayer, game.players_inferred] = params
      writes.push(sql)
      return []
    }
    throw new Error(`没模拟的 SQL：${sql}`)
  }
  return { run, game, writes }
}

await check('syncNetplayDerived：auto 街机写回推断人数，再跑一次不再写', async () => {
  const db = fakeDb({ platform: 'arcade', netplay_mode: 'auto', players: 1, multiplayer: 0, players_inferred: null, arcade_romdata: null }, ['roms/arcade/tmnt.zip.8bg'])
  const diff = await syncNetplayDerived(db.run, 1, {}, lookup)
  assert.deepEqual(diff?.to, { players: 4, multiplayer: 1 })
  assert.equal(db.game.players_inferred, 4)
  assert.equal(await syncNetplayDerived(db.run, 1, {}, lookup), null, '第二次应当无改动')
})

await check('syncNetplayDerived：dryRun 只算不写；传 mode 先落库', async () => {
  const db = fakeDb({ platform: 'nes', netplay_mode: 'auto', players: 2, multiplayer: 1, players_inferred: null, arcade_romdata: null }, ['roms/nes/x.nes'])
  const diff = await syncNetplayDerived(db.run, 1, { dryRun: true, mode: 'off' }, lookup)
  assert.deepEqual(diff?.to, { players: 2, multiplayer: 0 })
  assert.equal(db.writes.length, 0)
  await syncNetplayDerived(db.run, 1, { mode: 'off' }, lookup)
  assert.equal(db.game.netplay_mode, 'off')
  assert.equal(db.game.multiplayer, 0)
})

await check('syncNetplayDerived：街机忽略请求里的 off，库里遗留的 on 收回 auto', async () => {
  const db = fakeDb({ platform: 'arcade', netplay_mode: 'auto', players: 1, multiplayer: 0, players_inferred: null, arcade_romdata: null }, ['roms/arcade/dino.zip'])
  await syncNetplayDerived(db.run, 1, { mode: 'off' }, lookup)
  assert.equal(db.game.netplay_mode, 'auto')
  assert.deepEqual([db.game.players, db.game.multiplayer], [3, 1])
  const legacy = fakeDb({ platform: 'arcade', netplay_mode: 'on', players: 4, multiplayer: 1, players_inferred: null, arcade_romdata: null }, ['roms/arcade/dino.zip'])
  await syncNetplayDerived(legacy.run, 1, {}, lookup)
  assert.equal(legacy.game.netplay_mode, 'auto')
  assert.deepEqual([legacy.game.players, legacy.game.multiplayer], [3, 1])
})

await check('syncNetplayDerived：迁移没跑（缺列）时不抛错、不写', async () => {
  const db = fakeDb({}, [], { missingColumns: true })
  assert.equal(await syncNetplayDerived(db.run, 1, { mode: 'on' }, lookup), null)
})

await check('写游戏的两条路径都会重算；迁移会全库重算一次', () => {
  const repo = readFileSync(path.join(here, '..', 'src', 'games-repo.js'), 'utf8')
  assert.equal((repo.match(/await syncNetplayDerived\(run, id, \{ mode: netplayModeFromInput\(game\) \}\)/g) ?? []).length, 2)
  const migrate = readFileSync(path.join(here, 'migrate.mjs'), 'utf8')
  assert.match(migrate, /ADD COLUMN `netplay_mode`/)
  assert.match(migrate, /SET `netplay_mode` = 'on' WHERE `multiplayer` = 1 AND `players` >= 2/)
  assert.match(migrate, /recomputeAllNetplay\(runRows\)/)
})

console.log('')
if (fails.length) {
  for (const f of fails) console.error(`✗ ${f.name}\n${f.e?.stack ?? f.e}`)
  console.error(`\n❌ ${fails.length} 条失败 / 共 ${pass + fails.length} 条`)
  process.exit(1)
}
console.log(`✅ 联机人数自动推断：${pass} 条全过`)
