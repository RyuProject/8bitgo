#!/usr/bin/env node
/**
 * N-Gage 卡带转储导入（scripts/eka2l1-ngage-card.js）的回归测试，不联网、不需要固件。
 *
 *   npm run test:eka2l1-ngage-card
 *   NGAGE_CARD_ZIP=<卡带转储.zip> npm run test:eka2l1-ngage-card   # 再拿一份真实转储跑解析与全部 CRC
 *
 * 守的是上游 install_ngage_game_card 的规则（版本选择、Libs 复制、只注册一份 AIF）和本站加的安全边界
 * （路径穿越、ZIP64、加密、解压超量、写盘前全部核对、失败不落盘）。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { crc32 as zlibCrc32, deflateRawSync } from 'node:zlib'
import { EKA2L1_SITE_SCRIPTS, injectSiteScripts } from './lib/eka2l1-site-scripts.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const scriptFile = join(root, 'scripts', 'eka2l1-ngage-card.js')
vm.runInThisContext(readFileSync(scriptFile, 'utf8'), { filename: scriptFile })
const C = globalThis.EightBitGoNgageCard
const C_ = C
assert.ok(C, '脚本没有导出 EightBitGoNgageCard')

let passed = 0
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✖ ${name}`)
    throw err
  }
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err && err.name, 'CardError', `期望 CardError(${code})，实际 ${err && err.stack}`)
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}（${err.message}）`)
    return true
  })
}

// ---- 构造 ZIP / E32 / AIF -------------------------------------------------

function makeZip(files, { zip64Locator = false, totalOverride } = {}) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8')
    const raw = f.dir ? Buffer.alloc(0) : Buffer.from(f.data ?? '')
    const method = f.dir ? 0 : (f.method ?? 8)
    const body = method === 8 ? deflateRawSync(raw) : (f.body ?? raw)
    const crc = f.crc ?? zlibCrc32(raw)
    const size = f.size ?? raw.length
    const flags = f.flags ?? 0x800
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034B50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014B50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const parts = [...locals, cd]
  if (zip64Locator) {
    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(0x07064B50, 0)
    parts.push(locator)
  }
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054B50, 0)
  eocd.writeUInt16LE(totalOverride ?? files.length, 8)
  eocd.writeUInt16LE(totalOverride ?? files.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  parts.push(eocd)
  return new Blob([Buffer.concat(parts)])
}

const CCITT = (() => {
  const table = new Uint16Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n << 8
    for (let k = 0; k < 8; k++) c = (c & 0x8000) ? (((c << 1) ^ 0x1021) & 0xFFFF) : ((c << 1) & 0xFFFF)
    table[n] = c
  }
  return table
})()
function crc16(bytes) {
  let crc = 0
  for (const b of bytes) crc = ((crc << 8) & 0xFFFF) ^ CCITT[((crc >> 8) ^ b) & 0xFF]
  return crc
}
function writeUids(buf, uid1, uid2, uid3) {
  buf.writeUInt32LE(uid1, 0)
  buf.writeUInt32LE(uid2, 4)
  buf.writeUInt32LE(uid3, 8)
  const even = []
  const odd = []
  for (let i = 0; i < 12; i++) (i % 2 ? odd : even).push(buf[i])
  buf.writeUInt32LE(((crc16(odd) << 16) | crc16(even)) >>> 0, 12)
}

/** EKA1 的 .app：fileSize 小于头里声明的代码段就是存根 */
function makeE32({ uid3 = 0x101FD3DE, codeSize = 0x100, fileSize } = {}) {
  const size = fileSize ?? (0x7C + codeSize + 8)
  const buf = Buffer.alloc(Math.max(size, 0x7C))
  writeUids(buf, 0x10000079, 0x100039CE, uid3)
  buf.write('EPOC', 0x10, 'latin1')
  buf.writeUInt32LE(0x2000, 0x14)
  buf.writeUInt32LE(codeSize, 0x30)
  buf.writeUInt32LE(1, 0x54) // dll ref count
  buf.writeUInt32LE(codeSize, 0x60) // text size
  buf.writeUInt32LE(0x7C, 0x64) // code offset
  buf.writeUInt32LE(0x7C + codeSize, 0x6C) // import offset
  return buf.subarray(0, size)
}

function makeAif(uid3 = 0x101FD3DE, { uid2 = 0x10003A38 } = {}) {
  const buf = Buffer.alloc(64, 0x11)
  writeUids(buf, 0x10000037, uid2, uid3)
  return buf
}

/** 照《模拟人生：脱颖而出》转储的形状：两个版本，_1 是存根，System/Libs 里有一个 DLL */
function simsLikeCard(prefix = '', overrides = {}) {
  return [
    { name: `${prefix}game.id`, data: "Test Card 1.0\n" },
    { name: `${prefix}nokia.dat`, data: Buffer.alloc(20, 7), method: 0 },
    { name: `${prefix}System/Apps/6RAK/6RAK.AIF`, data: makeAif() },
    { name: `${prefix}System/Apps/6RAK/6rak.app`, data: makeE32() },
    { name: `${prefix}System/Apps/6RAK/thesims.dat`, data: Buffer.alloc(300000, 3) },
    { name: `${prefix}System/Apps/6rak_1/6rak_1.aif`, data: makeAif() },
    { name: `${prefix}System/Apps/6rak_1/6rak_1.app`, data: makeE32({ uid3: 0, codeSize: 0x1304, fileSize: 416 }) },
    { name: `${prefix}System/Libs/cryptoshim.dll`, data: 'shim' },
    ...(overrides.extra || []),
  ]
}

// ---- 假 Emscripten FS -----------------------------------------------------

const DIR = 0o40000
const FILE = 0o100000
class FakeFS {
  constructor() { this.nodes = new Map([['/', { mode: DIR }]]) }
  errno(code) { const err = new Error(code); err.errno = code; return err }
  stat(path) {
    const node = this.nodes.get(path)
    if (!node) throw this.errno('ENOENT')
    return { mode: node.mode, mtime: new Date(0) }
  }
  isDir(mode) { return (mode & 0o170000) === DIR }
  mkdirTree(path) {
    let cur = ''
    for (const part of path.split('/').filter(Boolean)) {
      cur += '/' + part
      const node = this.nodes.get(cur)
      if (node && !this.isDir(node.mode)) throw this.errno('ENOTDIR')
      if (!node) this.nodes.set(cur, { mode: DIR })
    }
  }
  writeFile(path, data, opts) {
    const parent = path.slice(0, path.lastIndexOf('/')) || '/'
    if (!this.nodes.has(parent)) throw this.errno('ENOENT')
    const node = this.nodes.get(path)
    if (node && this.isDir(node.mode)) throw this.errno('EISDIR')
    this.nodes.set(path, { mode: FILE, data, canOwn: opts && opts.canOwn })
  }
  unlink(path) {
    if (!this.nodes.has(path)) throw this.errno('ENOENT')
    this.nodes.delete(path)
  }
  readdir(path) {
    const node = this.nodes.get(path)
    if (!node || !this.isDir(node.mode)) throw this.errno('ENOTDIR')
    const prefix = path === '/' ? '/' : path + '/'
    const names = new Set()
    for (const p of this.nodes.keys()) {
      if (p !== path && p.startsWith(prefix)) names.add(p.slice(prefix.length).split('/')[0])
    }
    return ['.', '..', ...names]
  }
  mkdir(path) {
    const parent = path.slice(0, path.lastIndexOf('/')) || '/'
    const p = this.nodes.get(parent)
    if (!p || !this.isDir(p.mode)) throw this.errno('ENOENT')
    if (this.nodes.has(path)) throw this.errno('EEXIST')
    this.nodes.set(path, { mode: DIR })
  }
  dirs() { return [...this.nodes].filter(([, n]) => this.isDir(n.mode)).map(([p]) => p).sort() }
  files() { return [...this.nodes].filter(([, n]) => !this.isDir(n.mode)).map(([p]) => p).sort() }
}

function deps(fs, extra = {}) {
  const calls = { saved: [], deleted: [] }
  return {
    calls,
    deps: {
      FS: fs,
      savePaths: async (paths) => { calls.saved.push(...paths) },
      deletePathPrefixes: async (prefixes) => { calls.deleted.push(...prefixes) },
      estimate: async () => ({ quota: 1 << 30, usage: 0 }),
      ...extra,
    },
  }
}

const E = '/eka2l1/drives/e/'

console.log('N-Gage 卡带转储导入')

await test('E32 / AIF 判据：真实规则下存根判不可加载', () => {
  assert.equal(C.e32Loadable(makeE32()), true)
  assert.equal(C.e32Loadable(makeE32({ uid3: 0, codeSize: 0x1304, fileSize: 416 })), false)
  const badCheck = Buffer.from(makeE32())
  badCheck.writeUInt32LE(0, 12)
  assert.equal(C.e32Loadable(badCheck), false, 'UID 校验和不对必须判不可加载')
  const noSig = Buffer.from(makeE32())
  noSig.write('XXXX', 0x10, 'latin1')
  assert.equal(C.e32Loadable(noSig), false)
  assert.equal(C.aifLooksValid(makeAif()), true)
  assert.equal(C.aifLooksValid(makeAif(1, { uid2: 0x10000000 })), false)
  assert.equal(C.crc32(Buffer.from('123456789')), 0xCBF43926)
})

await test('两个版本、_1 是存根：运行 <代号>，不写 _1 的 AIF，Libs 复制进游戏目录', async () => {
  const blob = makeZip(simsLikeCard())
  const plan = await C.planCard(blob, await C.readZipDirectory(blob))
  assert.equal(plan.prefix, '')
  assert.equal(plan.gameFolder, '6rak')
  assert.equal(plan.dropFolder, '6rak_1')
  assert.equal(plan.libsFolder, '6rak')
  assert.equal(plan.appUid, 0x101FD3DE)
  assert.equal(plan.title, 'Test Card 1.0')
  assert.deepEqual(plan.saveFolders, ['6RAK'])
  const dests = plan.writes.map((w) => w.dest).sort()
  assert.deepEqual(dests, [
    'game.id', 'nokia.dat',
    'system/apps/6rak/6rak.aif', 'system/apps/6rak/6rak.app', 'system/apps/6rak/cryptoshim.dll', 'system/apps/6rak/thesims.dat',
    'system/apps/6rak_1/6rak_1.app',
    'system/libs/cryptoshim.dll',
  ])
})

await test('_1 能加载时运行 _1，去掉 <代号> 的 AIF，Libs 仍进 <代号>', async () => {
  const files = simsLikeCard().map((f) => (f.name.endsWith('6rak_1.app') ? { ...f, data: makeE32() } : f))
  const blob = makeZip(files)
  const plan = await C.planCard(blob, await C.readZipDirectory(blob))
  assert.equal(plan.gameFolder, '6rak_1')
  assert.equal(plan.dropFolder, '6rak')
  assert.equal(plan.dropAif, 'system/apps/6rak/6rak.aif')
  assert.deepEqual(plan.saveFolders, ['6RAK', '6RAK_1'])
  assert.ok(plan.writes.some((w) => w.dest === 'system/apps/6rak_1/6rak_1.aif'))
  assert.ok(!plan.writes.some((w) => w.dest === 'system/apps/6rak/6rak.aif'))
  assert.ok(plan.writes.some((w) => w.dest === 'system/apps/6rak/cryptoshim.dll'))
})

await test('外层多包一层文件夹、带 macOS 元数据也能认出卡带根', async () => {
  const blob = makeZip([
    { name: 'My Card/', dir: true },
    ...simsLikeCard('My Card/'),
    { name: '__MACOSX/My Card/System/Apps/6RAK/._6rak.app', data: 'junk' },
    { name: 'My Card/.DS_Store', data: 'junk' },
    { name: 'readme.txt', data: 'outside the card root' },
  ])
  const plan = await C.planCard(blob, await C.readZipDirectory(blob))
  assert.equal(plan.prefix, 'my card/')
  assert.equal(plan.gameFolder, '6rak')
  assert.ok(plan.writes.every((w) => !w.dest.includes('macosx') && !w.dest.includes('ds_store') && w.dest !== 'readme.txt'))
})

await test('单个游戏目录 + Browser 目录：Browser 不算游戏', async () => {
  const blob = makeZip([
    { name: 'system/apps/GAME/GAME.aif', data: makeAif(0x10203040) },
    { name: 'system/apps/GAME/GAME.app', data: makeE32() },
    { name: 'system/apps/Browser/Browser.aif', data: makeAif(1) },
  ])
  const plan = await C.planCard(blob, await C.readZipDirectory(blob))
  assert.equal(plan.gameFolder, 'game')
  assert.equal(plan.dropFolder, '')
  assert.equal(plan.appUid, 0x10203040)
})

await test('不是卡带 / 多款游戏 / 缺 AIF / AIF 损坏都给出明确错误', async () => {
  const plan = async (files) => { const b = makeZip(files); return C.planCard(b, await C.readZipDirectory(b)) }
  await rejectsCode(plan([{ name: 'game.n-gage', data: 'x' }]), 'no-game')
  await rejectsCode(plan([
    { name: 'system/apps/a/a.aif', data: makeAif() },
    { name: 'system/apps/b/b.aif', data: makeAif() },
    { name: 'system/apps/c/c.aif', data: makeAif() },
  ]), 'multiple-games')
  await rejectsCode(plan([
    { name: 'system/apps/a/a.aif', data: makeAif() },
    { name: 'system/apps/b/b.aif', data: makeAif() },
  ]), 'multiple-games')
  await rejectsCode(plan([{ name: 'system/apps/a/a.app', data: makeE32() }]), 'no-registration')
  await rejectsCode(plan([{ name: 'system/apps/a/a.aif', data: makeAif(1, { uid2: 0x12345678 }) }]), 'bad-registration')
  await rejectsCode(plan([
    { name: 'system/apps/a/A.DAT', data: '1' },
    { name: 'system/apps/a/a.dat', data: '2' },
    { name: 'system/apps/a/a.aif', data: makeAif() },
  ]), 'name-collision')
})

await test('路径穿越、盘符、绝对路径一律拒绝', async () => {
  for (const name of ['../evil.dll', 'system/apps/a/../../x', 'C:/system/x', '/abs/x', 'a\\..\\b']) {
    const blob = makeZip([{ name, data: 'x' }, { name: 'system/apps/a/a.aif', data: makeAif() }])
    await rejectsCode((async () => C.planCard(blob, await C.readZipDirectory(blob)))(), 'unsafe-path')
  }
})

await test('ZIP 结构：不是 ZIP、ZIP64、超限都拒绝', async () => {
  await rejectsCode(C.readZipDirectory(new Blob([Buffer.alloc(100, 1)])), 'not-zip')
  await rejectsCode(C.readZipDirectory(makeZip([{ name: 'a', data: 'x' }], { zip64Locator: true })), 'zip64')
  await rejectsCode(C.readZipDirectory(makeZip([{ name: 'a', data: 'x' }], { totalOverride: 0xFFFF })), 'zip64')
  const small = { ...C.LIMITS, archiveBytes: 10 }
  await rejectsCode(C.readZipDirectory(makeZip([{ name: 'a', data: 'x' }]), small), 'too-large')
  const fewEntries = { ...C.LIMITS, entries: 1 }
  await rejectsCode(C.readZipDirectory(makeZip([{ name: 'a', data: 'x' }, { name: 'b', data: 'y' }]), fewEntries), 'too-many')
})

await test('解压：加密、未知压缩方式、CRC 不符、解出超过声明大小都拒绝', async () => {
  const one = async (file) => {
    const blob = makeZip([file])
    const [entry] = await C.readZipDirectory(blob)
    return C.readEntryData(blob, entry)
  }
  await rejectsCode(one({ name: 'a', data: 'x', flags: 0x801 }), 'encrypted')
  await rejectsCode(one({ name: 'a', data: 'x', method: 12, body: Buffer.from('x') }), 'method')
  await rejectsCode(one({ name: 'a', data: 'hello', crc: 1 }), 'corrupt')
  await rejectsCode(one({ name: 'a', data: Buffer.alloc(5000, 1), size: 100 }), 'corrupt')
  await rejectsCode(one({ name: 'a', data: 'hello', method: 0, size: 3 }), 'corrupt')
  const ok = await one({ name: 'a', data: Buffer.alloc(70000, 9) })
  assert.equal(ok.length, 70000)
})

await test('installCard：写进 E 盘、只持久化这些文件、清掉以前那份 _1 的 AIF', async () => {
  const fs = new FakeFS()
  fs.mkdirTree(E + 'system/apps/6rak_1')
  fs.writeFile(E + 'system/apps/6rak_1/6rak_1.aif', Buffer.from('old'))
  const { deps: d, calls } = deps(fs)
  const stages = []
  d.onStage = (name) => stages.push(name)
  const result = await C.installCard(makeZip(simsLikeCard()), d)
  assert.deepEqual(fs.files(), [
    E + 'game.id', E + 'nokia.dat',
    E + 'system/apps/6rak/6rak.aif', E + 'system/apps/6rak/6rak.app', E + 'system/apps/6rak/cryptoshim.dll',
    E + 'system/apps/6rak/thesims.dat', E + 'system/apps/6rak_1/6rak_1.app', E + 'system/libs/cryptoshim.dll',
  ])
  assert.deepEqual([...calls.saved].sort(), fs.files())
  assert.deepEqual(calls.deleted, [E + 'system/apps/6rak_1/6rak_1.aif'])
  assert.equal(result.removedStale, E + 'system/apps/6rak_1/6rak_1.aif')
  assert.equal(Buffer.from(fs.nodes.get(E + 'system/apps/6rak/thesims.dat').data).equals(Buffer.alloc(300000, 3)), true)
  const lib = fs.nodes.get(E + 'system/libs/cryptoshim.dll').data
  const libCopy = fs.nodes.get(E + 'system/apps/6rak/cryptoshim.dll').data
  assert.notEqual(lib, libCopy, 'Libs 复制件不能和原件共用一块数组（MEMFS canOwn 会接管）')
  assert.equal(Buffer.from(libCopy).toString(), 'shim')
  assert.ok(fs.nodes.get(E + 'game.id').canOwn)
  for (const s of ['read', 'extract', 'write', 'persist']) assert.ok(stages.includes(s), `缺少阶段 ${s}`)
})

await test('installCard：在 C 盘预建存档目录并放好已知游戏的空存档（首次启动 memory full 的绕法），沿用已有目录的大小写', async () => {
  const C = '/eka2l1/drives/c'
  const fs = new FakeFS()
  fs.mkdirTree(C + '/System')
  const { deps: d, calls } = deps(fs)
  const result = await C_.installCard(makeZip(simsLikeCard()), d)
  assert.deepEqual(result.saveFolders, {
    created: [C + '/System/Apps', C + '/System/Apps/6RAK'],
    seeded: [C + '/System/Apps/6RAK/THESIMS.SAV'],
    blocked: [],
  })
  assert.ok(fs.dirs().includes(C + '/System/Apps/6RAK'))
  assert.equal(fs.nodes.get(C + '/System/Apps/6RAK/THESIMS.SAV').data.length, 0, '预放的存档必须是空文件')
  for (const p of [...result.saveFolders.created, ...result.saveFolders.seeded]) {
    assert.ok(calls.saved.includes(p), `${p} 没有存进浏览器存储`)
  }

  // 已有任意大小写的同名目录：复用，不另建一份
  const fs2 = new FakeFS()
  fs2.mkdirTree(C + '/SYSTEM/apps/6rak')
  const r2 = await C_.installCard(makeZip(simsLikeCard()), deps(fs2).deps)
  assert.deepEqual(r2.saveFolders, { created: [], seeded: [C + '/SYSTEM/apps/6rak/THESIMS.SAV'], blocked: [] })
  assert.deepEqual(fs2.dirs().filter((p) => p.startsWith(C + '/')), [C + '/SYSTEM', C + '/SYSTEM/apps', C + '/SYSTEM/apps/6rak'])

  // 已有存档（不论大小写、不论内容）绝不覆盖
  const fs4 = new FakeFS()
  fs4.mkdirTree(C + '/System/Apps/6RAK')
  fs4.writeFile(C + '/System/Apps/6RAK/thesims.sav', Buffer.from('ASIE0000 real save'))
  const r4 = await C_.installCard(makeZip(simsLikeCard()), deps(fs4).deps)
  assert.deepEqual(r4.saveFolders.seeded, [])
  assert.equal(Buffer.from(fs4.nodes.get(C + '/System/Apps/6RAK/thesims.sav').data).toString(), 'ASIE0000 real save')
  assert.ok(!fs4.files().includes(C + '/System/Apps/6RAK/THESIMS.SAV'))

  // 不在名单里的游戏只建目录、不放文件
  assert.deepEqual(Object.keys(C_.KNOWN_EMPTY_SAVES), ['6RAK'])

  // 被同名文件挡住：跳过这一步，卡带照样导入
  const fs3 = new FakeFS()
  fs3.mkdirTree(C + '/System')
  fs3.writeFile(C + '/System/Apps', Buffer.from('not a folder'))
  const r3 = await C_.installCard(makeZip(simsLikeCard()), deps(fs3).deps)
  assert.deepEqual(r3.saveFolders.blocked, ['6RAK'])
  assert.ok(fs3.files().includes(E + 'system/apps/6rak/6rak.app'))
})

await test('installCard：任何一项不对都不落盘', async () => {
  const badCrc = simsLikeCard().map((f) => (f.name.endsWith('thesims.dat') ? { ...f, crc: 123 } : f))
  const fs1 = new FakeFS()
  await rejectsCode(C.installCard(makeZip(badCrc), deps(fs1).deps), 'corrupt')
  assert.deepEqual(fs1.files(), [], 'CRC 不对时一个文件都不能写')

  const fs2 = new FakeFS()
  fs2.mkdirTree(E + 'system/apps/6rak/thesims.dat')
  await rejectsCode(C.installCard(makeZip(simsLikeCard()), deps(fs2).deps), 'fs-conflict')
  assert.deepEqual(fs2.files(), [])

  const fs3 = new FakeFS()
  fs3.mkdirTree(E)
  fs3.writeFile(E + 'system', Buffer.from('a file named system'))
  await rejectsCode(C.installCard(makeZip(simsLikeCard()), deps(fs3).deps), 'fs-conflict')
  assert.deepEqual(fs3.files(), [E + 'system'])

  const fs4 = new FakeFS()
  const tight = deps(fs4, { estimate: async () => ({ quota: 1000, usage: 0 }) }).deps
  await rejectsCode(C.installCard(makeZip(simsLikeCard()), tight), 'quota')
  assert.deepEqual(fs4.files(), [])

  const encrypted = simsLikeCard().map((f) => (f.name.endsWith('nokia.dat') ? { ...f, flags: 0x801 } : f))
  const fs5 = new FakeFS()
  await rejectsCode(C.installCard(makeZip(encrypted), deps(fs5).deps), 'encrypted')
  assert.deepEqual(fs5.files(), [])
})

await test('installCard：保存到浏览器存储失败时报 persist', async () => {
  const fs = new FakeFS()
  const failing = deps(fs, { savePaths: async () => { throw new Error('QuotaExceededError') } }).deps
  await rejectsCode(C.installCard(makeZip(simsLikeCard()), failing), 'persist')
})

await test('构建接线：清单登记了导入脚本，注入幂等，当前运行时目录带着同一份脚本', () => {
  const entry = EKA2L1_SITE_SCRIPTS.find((s) => s.source === 'scripts/eka2l1-ngage-card.js')
  assert.ok(entry, 'eka2l1-site-scripts.mjs 没有登记卡带导入脚本')
  const html = '<html><body></body></html>'
  const once = injectSiteScripts(html)
  assert.equal(injectSiteScripts(once), once)
  for (const s of EKA2L1_SITE_SCRIPTS) {
    // play.html / 播放器脚本只由详情页的播放页加载，不注入程序库页
    assert.equal(once.includes(`<script src="${s.published}"></script>`), s.inject !== false, s.published)
  }
  const constants = readFileSync(join(root, 'src/emulator/eka2l1Runtime.ts'), 'utf8')
  const buildId = /EKA2L1_BUILD_ID = '([0-9a-f]{12})'/.exec(constants)?.[1]
  if (!buildId) return
  const dir = join(root, 'public', 'eka2l1', `v${buildId}`)
  assert.equal(readFileSync(join(dir, entry.published), 'utf8'), readFileSync(scriptFile, 'utf8'),
    '发布目录里的导入脚本与仓库不一致，需运行 npm run eka2l1:repackage')
  assert.ok(readFileSync(join(dir, 'index.html'), 'utf8').includes(`<script src="${entry.published}"></script>`))
})

const realZip = process.env.NGAGE_CARD_ZIP
if (realZip) {
  await test(`真实转储：${realZip.split('/').pop()}`, async () => {
    assert.ok(existsSync(realZip), `找不到 ${realZip}`)
    const blob = new Blob([readFileSync(realZip)])
    const entries = await C.readZipDirectory(blob)
    const plan = await C.planCard(blob, entries)
    for (const w of plan.writes) await C.readEntryData(blob, w.entry)
    const fs = new FakeFS()
    const { deps: d, calls } = deps(fs)
    await C.installCard(blob, d)
    assert.equal(calls.saved.length, plan.writes.length)
    console.log(`    运行 ${plan.gameFolder}${plan.dropFolder ? `（不注册 ${plan.dropFolder}）` : ''}，`
      + `UID 0x${plan.appUid.toString(16)}，${plan.writes.length} 个文件 / ${(plan.totalBytes / 1048576).toFixed(1)} MiB，`
      + `标题「${plan.title || '（无 game.id）'}」`)
  })
}

console.log(`✓ N-Gage 卡带导入 ${passed} 项通过`)
