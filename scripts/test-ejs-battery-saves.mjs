/**
 * 电池存档（/data/saves 的 .srm）不再被清库 / 回滚的回归守卫。
 *
 * 2026-11-12 实测：引擎 exit 里 FS.unmount("/data/saves") 之后，autoPersist 排队的同步把
 * IndexedDB 里所有游戏的 .srm 删光（刷新、切游戏、返回都会触发 exit）。修法两道：
 *   - scripts/patch-emulatorjs.mjs 第十三节删掉那句 unmount；
 *   - src/emulator/ejsSaveFs.ts 给核心 IDBFS 的 reconcile 加「只写更新、不删除」。
 * 这里用核心里 IDBFS.reconcile 的原样逻辑（从 mgba 核心 glue 抄下来的）做内存模拟。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { BATTERY_SAVE_SLOT, batteryHash, batteryRelOf, batteryRelPath, createBatterySync, decideBatterySync } from '../src/emulator/batterySync.ts'
import { batterySaveGameName, describeBootState, guardIdbfsPersist, migrateEngineSettingsKey, guardedPersistSets, migrateLegacyBatterySaves } from '../src/emulator/ejsSaveFs.ts'

let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ❌ ${name}\n     ${e.message}`)
  }
}

/**
 * 内存版 IDBFS：remote 是「IndexedDB」，local 是「内存文件系统」。
 * reconcile 的判定与核心 glue 一致：src 里没有或时间戳不同 → 写；dst 有 src 没有 → 删。
 */
function makeIdbfs(remote, local) {
  const IDBFS = {
    reconcile(src, dst, callback) {
      const create = []
      for (const key of Object.keys(src.entries)) {
        const e = src.entries[key]
        const e2 = dst.entries[key]
        if (!e2 || e.timestamp.getTime() !== e2.timestamp.getTime()) create.push(key)
      }
      const remove = Object.keys(dst.entries).filter((key) => !src.entries[key])
      const to = dst.type === 'remote' ? remote : local
      const from = src.type === 'remote' ? remote : local
      for (const key of create) to.set(key, { ...from.get(key) })
      for (const key of remove) to.delete(key)
      callback(null)
    },
  }
  const set = (type, map) => ({ type, entries: Object.fromEntries([...map].map(([k, v]) => [k, { timestamp: new Date(v.t) }])) })
  /** 等价于 IDBFS.syncfs(mount, populate, cb) */
  const syncfs = (populate) => {
    const src = populate ? set('remote', remote) : set('local', local)
    const dst = populate ? set('local', local) : set('remote', remote)
    IDBFS.reconcile(src, dst, () => {})
  }
  return { IDBFS, syncfs }
}

const SRM = '/data/saves/mGBA/pokemon.srm'
const OTHER = '/data/saves/mGBA/zelda.srm'

await check('不加保护时：卸载后的空目录持久化会清空整个库（复现原事故）', () => {
  const remote = new Map([[SRM, { t: 100, d: 'A' }], [OTHER, { t: 50, d: 'Z' }]])
  const { syncfs } = makeIdbfs(remote, new Map())
  syncfs(false)
  assert.equal(remote.size, 0)
})

await check('加保护后：本地为空也一条都不删', () => {
  const remote = new Map([[SRM, { t: 100, d: 'A' }], [OTHER, { t: 50, d: 'Z' }]])
  const { IDBFS, syncfs } = makeIdbfs(remote, new Map())
  assert.equal(guardIdbfsPersist(IDBFS), true)
  syncfs(false)
  assert.deepEqual([...remote.keys()].sort(), [SRM, OTHER].sort())
})

await check('加保护后：本地新写的存档照常落进库', () => {
  const remote = new Map([[SRM, { t: 100, d: 'old' }]])
  const local = new Map([[SRM, { t: 200, d: 'new' }], [OTHER, { t: 150, d: 'Z' }]])
  const { IDBFS, syncfs } = makeIdbfs(remote, local)
  guardIdbfsPersist(IDBFS)
  syncfs(false)
  assert.equal(remote.get(SRM).d, 'new')
  assert.equal(remote.get(OTHER).d, 'Z')
})

await check('加保护后：另一个标签页的旧内存副本不能回滚更新的存档', () => {
  // A 标签页开局时读到 t=100；B 之后存成 t=300 并新建了 zelda.srm；A 再落盘
  const remote = new Map([[SRM, { t: 300, d: 'B-new' }], [OTHER, { t: 310, d: 'B-zelda' }]])
  const local = new Map([[SRM, { t: 100, d: 'A-stale' }]])
  const { IDBFS, syncfs } = makeIdbfs(remote, local)
  guardIdbfsPersist(IDBFS)
  syncfs(false)
  assert.equal(remote.get(SRM).d, 'B-new')
  assert.equal(remote.get(OTHER).d, 'B-zelda')
})

await check('开局方向（库 → 内存）不受影响', () => {
  const remote = new Map([[SRM, { t: 100, d: 'A' }]])
  const local = new Map([['/data/saves/junk', { t: 1, d: 'x' }]])
  const { IDBFS, syncfs } = makeIdbfs(remote, local)
  guardIdbfsPersist(IDBFS)
  syncfs(true)
  assert.equal(local.get(SRM).d, 'A')
  assert.equal(local.has('/data/saves/junk'), false)
})

await check('幂等：装两次只包一层；没有 reconcile 时返回 false 不抛', () => {
  const { IDBFS } = makeIdbfs(new Map(), new Map())
  guardIdbfsPersist(IDBFS)
  const once = IDBFS.reconcile
  guardIdbfsPersist(IDBFS)
  assert.equal(IDBFS.reconcile, once)
  assert.equal(guardIdbfsPersist({}), false)
  assert.equal(guardIdbfsPersist(undefined), false)
})

await check('guardedPersistSets 接受数字时间戳', () => {
  const { src, dst } = guardedPersistSets(
    { type: 'local', entries: { a: { timestamp: 5 }, b: { timestamp: 1 } } },
    { type: 'remote', entries: { a: { timestamp: 4 }, b: { timestamp: 2 }, c: { timestamp: 9 } } },
  )
  assert.deepEqual(Object.keys(src.entries), ['a'])
  assert.deepEqual(Object.keys(dst.entries), ['a'])
})

await check('引擎：exit 里不再卸载 /data/saves，且 check-emulatorjs 守着这条补丁', () => {
  const engine = readFileSync(new URL('../public/emulatorjs/emulator.min.js', import.meta.url), 'utf8')
  assert.equal(engine.includes('FS.unmount("/data/saves")'), false, '先跑 npm run ejspatch')
  assert.ok(engine.includes('this.toggleMainLoop(0),setTimeout(()=>{try{this.Module.abort()}'))
  const checker = readFileSync(new URL('./check-emulatorjs.mjs', import.meta.url), 'utf8')
  assert.ok(checker.includes('退出时不卸载 /data/saves'))
})

await check('适配器：每局都在 callMain 前装存档保护，且排在其它前置修正之前', () => {
  const adapter = readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
  assert.match(adapter, /guardIdbfsPersist\(fs\?\.filesystems\?\.IDBFS\)/)
  assert.match(adapter, /\(emu\) => \{\s*\/\/[^\n]*\n\s*guardSaveFs\(emu\)\s*\n\s*forceArcadeCoreLog\?\.\(emu\)/)
  // 不能再把 installFsInjector 藏在「有注入项才装」的条件后面：存档保护是每局都要的
  assert.equal(/if \(injections\.length \|\|/.test(adapter), false)
})

await check('电池存档名按存档 slug：语言槽各自一份，核心变体后缀不进名字', () => {
  assert.equal(batterySaveGameName('pokemon-firered', '德文.gba'), 'pokemon-firered.gba')
  assert.equal(batterySaveGameName('pokemon-firered~rom-de', '德文.gba'), 'pokemon-firered~rom-de.gba')
  // 兼容核心兜底时游戏内存档必须还是同一份
  assert.equal(batterySaveGameName('pokemon-black~nds-ja:melonds-compat', 'x.nds'), 'pokemon-black~nds-ja.nds')
  assert.equal(batterySaveGameName('ff7:beetle-soft-chd', 'disc.chd'), 'ff7.chd')
  // 两款游戏的管理员本机文件名相同，也不再共用存档
  assert.notEqual(batterySaveGameName('pokemon-firered~rom-de', '德文.gba'), batterySaveGameName('pokemon-leafgreen~rom-de', '德文.gba'))
})

await check('电池存档名：本地文件、压缩包、没有扩展名时保持原样', () => {
  assert.equal(batterySaveGameName('local:my.gba', 'my.gba'), undefined)
  assert.equal(batterySaveGameName('contra', 'contra.zip'), undefined)
  assert.equal(batterySaveGameName('contra', 'contra'), undefined)
  assert.equal(batterySaveGameName(undefined, 'a.gba'), undefined)
  assert.equal(batterySaveGameName('a/b c', 'x.GBA'), 'a_b_c.GBA')
})

/** 极简 Emscripten FS：路径 → { dir } | { data } */
function memFs(files) {
  const nodes = new Map([['/data/saves', { dir: true }]])
  for (const [path, data] of Object.entries(files)) {
    const parts = path.split('/')
    for (let i = 2; i < parts.length; i++) nodes.set(parts.slice(0, i).join('/') || '/', { dir: true })
    nodes.set(path, { data })
  }
  return {
    nodes,
    readdir: (dir) => ['.', '..', ...[...nodes.keys()].filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/')).map((p) => p.slice(dir.length + 1))],
    stat: (p) => ({ mode: nodes.get(p)?.dir ? 1 : 0 }),
    isDir: (mode) => mode === 1,
    analyzePath: (p) => ({ exists: nodes.has(p) }),
    readFile: (p) => nodes.get(p).data,
    writeFile: (p, data) => nodes.set(p, { data }),
  }
}

await check('迁移：旧名字以游戏 slug 开头时复制一份到新名字，旧文件保留', () => {
  const fs = memFs({ '/data/saves/mGBA/pokemon-firered.zh-Hans.srm': 'A', '/data/saves/mGBA/pokemon-firered.zh-Hans.rtc': 'R' })
  const n = migrateLegacyBatterySaves(fs, 'pokemon-firered.zh-Hans.gba', 'pokemon-firered~rom-zh-Hans.gba', 'pokemon-firered~rom-zh-Hans')
  assert.equal(n, 2)
  assert.equal(fs.readFile('/data/saves/mGBA/pokemon-firered~rom-zh-Hans.srm'), 'A')
  assert.equal(fs.readFile('/data/saves/mGBA/pokemon-firered.zh-Hans.srm'), 'A')
})

await check('迁移：新名字已有存档时不覆盖；通用旧名（可能属于别的游戏）不迁', () => {
  const fs = memFs({ '/data/saves/mGBA/pokemon-firered.en.srm': 'old', '/data/saves/mGBA/pokemon-firered.srm': 'new', '/data/saves/mGBA/德文.srm': 'other-game' })
  assert.equal(migrateLegacyBatterySaves(fs, 'pokemon-firered.en.gba', 'pokemon-firered.gba', 'pokemon-firered'), 0)
  assert.equal(fs.readFile('/data/saves/mGBA/pokemon-firered.srm'), 'new')
  assert.equal(migrateLegacyBatterySaves(fs, '德文.gba', 'pokemon-firered~rom-de.gba', 'pokemon-firered~rom-de'), 0)
  assert.equal(fs.analyzePath('/data/saves/mGBA/pokemon-firered~rom-de.srm').exists, false)
})

await check('适配器：8BG 解包名改成存档 slug 名，并在开局前迁移旧存档', () => {
  const adapter = readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
  assert.match(adapter, /const batteryName = batterySaveGameName\(options\.gameSlug, engineGameName\)/)
  assert.match(adapter, /migrateLegacyBatterySaves\(fs as unknown as SaveFsLike, legacyBatteryName, engineGameName, options\.gameSlug\)/)
})

// ── 云同步 ──────────────────────────────────────────────────────
const bytes = (...v) => new Uint8Array(v)

await check('同步规则：比上次同步时的指纹，不比时间', () => {
  const a = bytes(1, 2), b = bytes(3, 4), base = batteryHash(bytes(9))
  assert.equal(decideBatterySync(null, null, undefined), 'none')
  assert.equal(decideBatterySync(a, null, undefined), 'keep-local')
  assert.equal(decideBatterySync(null, b, undefined), 'use-cloud')
  assert.equal(decideBatterySync(a, bytes(1, 2), undefined), 'in-sync')
  assert.equal(decideBatterySync(a, b, batteryHash(a)), 'use-cloud') // 本地没动，别的设备玩过
  assert.equal(decideBatterySync(a, b, batteryHash(b)), 'keep-local') // 云端没动，本地玩过
  assert.equal(decideBatterySync(a, b, base), 'conflict')
  assert.equal(decideBatterySync(a, b, undefined), 'conflict')
})

await check('同步路径：只接受 /data/saves 底下、不越级的相对路径', () => {
  assert.equal(batteryRelPath('battery:mGBA/x.srm'), 'mGBA/x.srm')
  assert.equal(batteryRelPath('battery:x.srm'), 'x.srm')
  for (const bad of ['battery:../x.srm', 'battery:/etc/x', 'battery:a//b', 'emulatorjs-state', undefined, 'battery:a\\b']) {
    assert.equal(batteryRelPath(bad), null, String(bad))
  }
  assert.equal(batteryRelOf('/data/saves/mGBA/x.srm'), 'mGBA/x.srm')
  assert.equal(batteryRelOf('/home/x.srm'), null)
})

function fakeFs(files = {}) {
  const map = new Map(Object.entries(files))
  return {
    map,
    analyzePath: (p) => ({ exists: map.has(p) }),
    readFile: (p) => map.get(p),
    writeFile: (p, d) => map.set(p, d),
    mkdir: () => {},
  }
}
function fakeStore() {
  const m = new Map()
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }
}
const deps = (over) => ({ enabled: () => true, now: () => 1, timeoutMs: 50, log: () => {}, storage: fakeStore(), ...over })
const P = '/data/saves/mGBA/pokemon-firered.srm'

await check('新设备：云端有、本地没有 → 开机前写进 FS，随后没改过就不重复上传', async () => {
  const pushes = []
  const sync = createBatterySync('pokemon-firered', deps({
    fetch: async (runtime, slug, slot) => {
      assert.deepEqual([runtime, slug, slot], ['emulatorjs', 'pokemon-firered', BATTERY_SAVE_SLOT])
      return { data: bytes(7, 7), revision: 'r1', updatedAt: 1, format: 'battery:mGBA/pokemon-firered.srm' }
    },
    push: async (...a) => { pushes.push(a); return { ok: true, where: 'cloud' } },
  }))
  const fs = fakeFs()
  assert.equal(await sync.apply(fs), 'use-cloud')
  assert.deepEqual([...fs.readFile(P)], [7, 7])
  assert.equal(await sync.push(fs, P), 'unchanged')
  assert.equal(pushes.length, 0)
})

await check('玩家存了档 → 带 format 推到 slot 9；推成功后同内容不再推', async () => {
  const pushes = []
  const sync = createBatterySync('pokemon-firered', deps({
    fetch: async () => null,
    push: async (...a) => { pushes.push(a); return { ok: true, where: 'cloud' } },
  }))
  const fs = fakeFs({ [P]: bytes(1) })
  // 云端没有时不知道核心目录，FS 不动，只是允许之后上传
  assert.equal(await sync.apply(fs), 'none')
  assert.equal(await sync.push(fs, P, 'mgba'), 'pushed')
  assert.equal(pushes[0][3], BATTERY_SAVE_SLOT)
  assert.equal(pushes[0][4], 'cloud')
  assert.deepEqual(pushes[0][5], { format: 'battery:mGBA/pokemon-firered.srm', core: 'mgba' })
  assert.equal(await sync.push(fs, P), 'unchanged')
  fs.writeFile(P, bytes(2))
  assert.equal(await sync.push(fs, P), 'pushed')
  assert.equal(pushes.length, 2)
})

await check('开局没读到云端（断网 / 超时）→ 本局只用本地，绝不上传', async () => {
  for (const fetch of [async () => { throw new Error('HTTP 500') }, () => new Promise(() => {})]) {
    let pushed = 0
    const sync = createBatterySync('g', deps({ fetch, push: async () => { pushed++; return { where: 'cloud' } } }))
    const fs = fakeFs({ '/data/saves/mGBA/g.srm': bytes(5) })
    assert.equal(await sync.apply(fs), 'pull-failed')
    assert.equal(await sync.push(fs, '/data/saves/mGBA/g.srm'), 'skipped')
    assert.equal(pushed, 0)
    assert.deepEqual([...fs.readFile('/data/saves/mGBA/g.srm')], [5])
  }
})

await check('两边都改过 → 留本地，云端那份另存 .bak，不丢', async () => {
  const sync = createBatterySync('g', deps({
    fetch: async () => ({ data: bytes(9), revision: 'r', updatedAt: 1, format: 'battery:mGBA/g.srm' }),
    push: async () => ({ where: 'cloud' }),
    now: () => 42,
  }))
  const fs = fakeFs({ '/data/saves/mGBA/g.srm': bytes(5) })
  assert.equal(await sync.apply(fs), 'conflict')
  assert.deepEqual([...fs.readFile('/data/saves/mGBA/g.srm')], [5])
  assert.deepEqual([...fs.readFile('/data/saves/mGBA/g.srm.cloud-42.bak')], [9])
})

await check('同一台设备第二次开局：本地没动、云端被别的设备更新 → 用云端', async () => {
  const storage = fakeStore()
  const fs = fakeFs({ '/data/saves/mGBA/g.srm': bytes(1) })
  const first = createBatterySync('g', deps({ storage, fetch: async () => null, push: async () => ({ where: 'cloud' }) }))
  await first.apply(fs)
  await first.push(fs, '/data/saves/mGBA/g.srm')
  const second = createBatterySync('g', deps({
    storage,
    fetch: async () => ({ data: bytes(2), revision: 'r2', updatedAt: 2, format: 'battery:mGBA/g.srm' }),
    push: async () => ({ where: 'cloud' }),
  }))
  assert.equal(await second.apply(fs), 'use-cloud')
  assert.deepEqual([...fs.readFile('/data/saves/mGBA/g.srm')], [2])
})

await check('云端连续拒收（409 / 超配额）三次后本局停止上传', async () => {
  let pushed = 0
  const sync = createBatterySync('g', deps({ fetch: async () => null, push: async () => { pushed++; return { where: 'local', error: 'conflict', cloudFailed: true } } }))
  const fs = fakeFs({ '/data/saves/mGBA/g.srm': bytes(1) })
  await sync.apply(fs)
  for (let i = 0; i < 5; i++) {
    fs.writeFile('/data/saves/mGBA/g.srm', bytes(i + 10))
    await sync.push(fs, '/data/saves/mGBA/g.srm')
  }
  assert.equal(pushed, 3)
})

await check('没登录 / 选了只存本地 → 不拉不推', async () => {
  let called = 0
  const sync = createBatterySync('g', deps({ enabled: () => false, fetch: async () => { called++; return null }, push: async () => { called++; return {} } }))
  const fs = fakeFs({ '/data/saves/mGBA/g.srm': bytes(1) })
  assert.equal(await sync.apply(fs), 'off')
  assert.equal(await sync.push(fs, '/data/saves/mGBA/g.srm'), 'skipped')
  assert.equal(called, 0)
})

await check('适配器：开机前等同步、刷存档后推送；本地文件 / 街机 / 联机加入方不同步', () => {
  const adapter = readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
  assert.match(adapter, /options\.platform !== 'arcade' && options\.netplay\?\.mode !== 'join'\s*\n\s*\? createBatterySync\(options\.gameSlug\)/)
  assert.match(adapter, /await batterySync\.apply\(fs as unknown as BatteryFs\)/)
  assert.match(adapter, /gm\?\.saveSaveFiles\?\.\(\)[\s\S]{0,400}batterySync\.push\(/)
  // 异步步骤必须在 beforeStart（含存档库保护与旧名迁移）之后、original 之前
  assert.match(adapter, /beforeStart\?\.\(next\)[\s\S]{0,300}await beforeStartAsync\(next\)[\s\S]{0,300}return original\.call\(this\)/)
  const saves = readFileSync(new URL('../src/services/saves.ts', import.meta.url), 'utf8')
  assert.match(saves, /export async function fetchCloudSaveStrict/)
})

// ── 引擎逐游戏设置跟着改名走；开机状态进诊断包 ─────────────────────
function memStorage(init = {}) {
  const m = new Map(Object.entries(init))
  return { m, get length() { return m.size }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }
}

await check('改名后把引擎设置（改键 / 金手指 / 核心选项）从旧键复制到新键', () => {
  const st = memStorage({ 'ejs-123-gba-德文.gba-settings': '{"cheats":[1]}', 'ejs-999-gba-德文.gba-settings': 'other-game' })
  assert.equal(migrateEngineSettingsKey(st, 123, '德文.gba', 'pokemon-firered~rom-de.gba'), 1)
  assert.equal(st.getItem('ejs-123-gba-pokemon-firered~rom-de.gba-settings'), '{"cheats":[1]}')
  assert.equal(st.getItem('ejs-123-gba-德文.gba-settings'), '{"cheats":[1]}', '旧键保留')
  // 另一款游戏（gameId 不同）的同名旧键不能被搬过来
  assert.equal(st.getItem('ejs-999-gba-pokemon-firered~rom-de.gba-settings'), null)
})

await check('新键已有设置时不覆盖；没有 gameId 时按引擎的默认 1', () => {
  const st = memStorage({ 'ejs-5-gba-a.gba-settings': 'old', 'ejs-5-gba-b.gba-settings': 'new', 'ejs-1-nds-x.nds-settings': 'v' })
  assert.equal(migrateEngineSettingsKey(st, 5, 'a.gba', 'b.gba'), 0)
  assert.equal(st.getItem('ejs-5-gba-b.gba-settings'), 'new')
  assert.equal(migrateEngineSettingsKey(st, undefined, 'x.nds', 'y.nds'), 1)
  assert.equal(st.getItem('ejs-1-nds-y.nds-settings'), 'v')
  assert.equal(migrateEngineSettingsKey(null, 1, 'a', 'b'), 0)
})

await check('开机状态摘要：电池存档大小、设置项名、金手指条数，不带存档内容', () => {
  const fs = {
    readdir: (p) => (p === '/data/saves' ? ['.', '..', 'mGBA'] : ['.', '..', 'pokemon-firered.srm', 'zelda.srm']),
    stat: (p) => (p.endsWith('mGBA') ? { mode: 1 } : { mode: 0, size: 131072 }),
    isDir: (m) => m === 1,
  }
  const line = describeBootState(fs, 'pokemon-firered.gba', JSON.stringify({ settings: { rewindEnabled: 'enabled' }, cheats: [{ code: 'secret' }], controlSettings: {} }))
  assert.match(line, /电池存档 mGBA\/\*\.srm 131072B/)
  assert.match(line, /1 项（rewindEnabled）、金手指 1 条、改键有/)
  assert.doesNotMatch(line, /secret|zelda/)
  assert.match(describeBootState(undefined, 'x.gba', null), /电池存档 无；引擎设置 无/)
})

await check('适配器：改名时迁移引擎设置键；开机前把状态写进诊断包', () => {
  const adapter = readFileSync(new URL('../src/emulator/adapters/emulatorjs.ts', import.meta.url), 'utf8')
  assert.match(adapter, /engineGameName = batteryName\s*\n[\s\S]{0,300}migrateEngineSettingsKey\(window\.localStorage, gameId, legacyBatteryName, engineGameName\)/)
  assert.match(adapter, /diagLog\('adapter', 'info', describeBootState\(/)
})

if (failed) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
