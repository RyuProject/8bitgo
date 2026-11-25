import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from 'node:zlib'
import {
  archiveEntriesFrom7z,
  assertSafeArchiveEntry,
  compressSockdriveDirectory,
  createSockdriveExecutableMatcher,
  fatArchiveEntryKey,
  ensureBaselinePreloadProfile,
  listSockdriveFiles,
  resolveSockdriveExecutable,
  selectSockdriveDiskTemplate,
  SOCKDRIVE_DISK_TEMPLATES,
} from './lib/sockdrive-pipeline.mjs'
import { bindSockdriveGame } from './bind-sockdrive-game.mjs'

assert.equal(assertSafeArchiveEntry('StarCraft.exe'), 'StarCraft.exe')
assert.throws(() => assertSafeArchiveEntry('../outside'), /目录穿越/)
assert.throws(() => assertSafeArchiveEntry('/absolute'), /不安全路径/)
assert.throws(() => assertSafeArchiveEntry('C:\\Windows\\bad.exe'), /不安全路径/)
assert.deepEqual(fatArchiveEntryKey('Program Files/STAR.EXE'), {
  value: 'Program Files/STAR.EXE',
  key: 'program files/star.exe',
})
assert.throws(() => fatArchiveEntryKey('GAME/CON.TXT'), /保留设备名/)
assert.throws(() => fatArchiveEntryKey('GAME/BAD?.DAT'), /不能无损写入 FAT/)
assert.throws(
  () => archiveEntriesFrom7z('archive\n----------\nPath = StarCraft/link\nSymbolic Link = ../../outside\n'),
  /符号链接或硬链接/,
)
assert.deepEqual(
  archiveEntriesFrom7z('archive\n----------\nPath = StarCraft.exe\n'),
  ['StarCraft.exe'],
)
const folderEntries = archiveEntriesFrom7z(
  'archive\n----------\nPath = EMPIRES2.EXE\nFolder = +\nSize = 0\nPath = game/RUN.EXE\nFolder = -\nSize = 1\n',
)
assert.deepEqual(folderEntries, ['EMPIRES2.EXE/', 'game/RUN.EXE'])
const folderMatcher = createSockdriveExecutableMatcher('EMPIRES2.EXE')
for (const entry of folderEntries) folderMatcher.add(entry)
assert.throws(() => folderMatcher.resolve(), /找不到启动程序.*game\/RUN\.EXE/)
assert.throws(
  () => archiveEntriesFrom7z('archive\n----------\nPath = DATA/FILE.DAT\nPath = data/file.dat\n'),
  /FAT 下会互相覆盖/,
)
assert.equal(resolveSockdriveExecutable('empires2.exe', {
  basenameMatchCount: 1,
  basenameMatches: ['Age of Empires II/EMPIRES2.EXE'],
}), 'Age of Empires II/EMPIRES2.EXE', '根目录只填文件名时可安全定位唯一的嵌套启动程序')
assert.equal(resolveSockdriveExecutable('games/empires2.exe', {
  exactPath: 'Games/EMPIRES2.EXE',
  basenameMatchCount: 2,
  basenameMatches: ['Games/EMPIRES2.EXE', 'old/Games/EMPIRES2.EXE'],
}), 'Games/EMPIRES2.EXE', '完整路径大小写不同仍优先精确匹配')
assert.throws(() => resolveSockdriveExecutable('empires2.exe', {
  basenameMatchCount: 2,
  basenameMatches: ['Age II/EMPIRES2.EXE', 'Age II/Setup/EMPIRES2.exe'],
}), /多个同名启动程序.*请填写完整相对路径/)
assert.throws(() => resolveSockdriveExecutable('empires2.exe', {
  exactPath: 'EMPIRES2.EXE',
  basenameMatchCount: 2,
  basenameMatches: ['EMPIRES2.EXE', 'Old Install/EMPIRES2.EXE'],
}), /多个同名启动程序.*请填写完整相对路径/, '裸文件名即使根目录命中，也不能掩盖 ZIP 内另一个同名入口')
assert.throws(() => resolveSockdriveExecutable('games/empires2.exe', {
  basenameMatchCount: 1,
  basenameMatches: ['Age II/EMPIRES2.EXE'],
}), /找不到指定完整启动路径/)
assert.throws(() => resolveSockdriveExecutable('empires2.exe', {
  availableExecutables: ['setup.exe', 'uninstall.exe'],
}), /找不到启动程序.*setup\.exe/)
const executableMatcher = createSockdriveExecutableMatcher('GAME.EXE')
executableMatcher.add('folder.exe/')
executableMatcher.add('Folder/Game.exe')
assert.equal(executableMatcher.resolve(), 'Folder/Game.exe', '目录名不能误当作启动文件')
assert.equal(selectSockdriveDiskTemplate(1, '16M').id, 'fat16-256mb')
assert.equal(selectSockdriveDiskTemplate(1500 * 1024 ** 2, '128M').id, 'fat32-2gb')
assert.equal(selectSockdriveDiskTemplate(1500 * 1024 ** 2, '128M').bytes, 2_147_483_648)
assert.deepEqual(SOCKDRIVE_DISK_TEMPLATES.map(({ bytes }) => bytes), [252_370_944, 2_147_483_648])
assert.throws(() => selectSockdriveDiskTemplate(1950 * 1024 ** 2, '128M'), /最大 2GB 模板/)
assert.throws(
  () => archiveEntriesFrom7z('archive\n----------\nPath = huge.bin\nSize = 2000000000\n', 1_900_000_000),
  /拒绝在制作机解包/,
)

const root = mkdtempSync(join(tmpdir(), '8bitgo-sockdrive-pipeline-'))
try {
  const scanRoot = join(root, 'scan')
  mkdirSync(scanRoot)
  writeFileSync(join(scanRoot, 'b.raw'), Buffer.alloc(2))
  writeFileSync(join(scanRoot, 'a.raw'), Buffer.alloc(1))
  assert.deepEqual(
    (await listSockdriveFiles(scanRoot)).map(({ name, size }) => [name, size]),
    [['a.raw', 1], ['b.raw', 2]],
    '有界文件扫描保持稳定排序并返回实际字节数',
  )
  await assert.rejects(() => listSockdriveFiles(scanRoot, { concurrency: 17 }), /1～16/)
  const emptyRoot = join(root, 'empty')
  mkdirSync(emptyRoot)
  assert.deepEqual(await listSockdriveFiles(emptyRoot, { strict: false }), [])
  await assert.rejects(() => listSockdriveFiles(emptyRoot), /没有可扫描文件/)

  for (const encoding of ['identity', 'br', 'gzip']) {
    const dir = join(root, encoding)
    mkdirSync(dir)
    const metadata = Buffer.from(JSON.stringify({ range_count: 4, preload_ranges: [0, 2] }))
    const encoded = encoding === 'br' ? brotliCompressSync(metadata) : encoding === 'gzip' ? gzipSync(metadata) : metadata
    writeFileSync(join(dir, 'sockdrive.metaj'), encoded)
    const result = ensureBaselinePreloadProfile(dir, encoding)
    assert.deepEqual(result, { created: true, ranges: [0, 2] })
    const stored = readFileSync(join(dir, 'preload_ranges.metaj'))
    const decoded = encoding === 'br' ? brotliDecompressSync(stored) : encoding === 'gzip' ? gunzipSync(stored) : stored
    assert.deepEqual(JSON.parse(decoded), [0, 2])
    assert.equal(ensureBaselinePreloadProfile(dir, encoding).created, false, '真实热点清单不能被基础清单覆盖')
  }

  const identityRoot = join(root, 'identity-summary')
  mkdirSync(identityRoot)
  writeFileSync(join(identityRoot, '0.raw'), Buffer.alloc(7))
  writeFileSync(join(identityRoot, 'sockdrive.metaj'), Buffer.alloc(3))
  assert.deepEqual(await compressSockdriveDirectory(identityRoot, 'identity'), {
    files: 2,
    sourceBytes: 10,
    encodedBytes: 10,
  }, '未压缩发布也提供最终统计，后台不必再扫描一次目录')
} finally {
  rmSync(root, { recursive: true, force: true })
}

for (const encoding of ['br', 'gzip']) {
  const compressionRoot = mkdtempSync(join(tmpdir(), `8bitgo-sockdrive-compress-${encoding}-`))
  try {
    const originals = new Map([
      ['0.raw', Buffer.alloc(256 * 1024, 0x41)],
      ['sockdrive.metaj', Buffer.from(JSON.stringify({ range_count: 1 }))],
      ['preload_ranges.metaj', Buffer.from('[0]')],
    ])
    for (const [name, bytes] of originals) writeFileSync(join(compressionRoot, name), bytes)
    const progress = []
    const result = await compressSockdriveDirectory(compressionRoot, encoding, {
      concurrency: 2,
      brotliQuality: 4,
      onProgress: ({ completed }) => progress.push(completed),
    })
    assert.equal(result.files, originals.size)
    assert.equal(result.sourceBytes, [...originals.values()].reduce((sum, bytes) => sum + bytes.length, 0))
    assert.deepEqual(progress.sort((a, b) => a - b), [1, 2, 3])
    for (const [name, original] of originals) {
      const encoded = readFileSync(join(compressionRoot, name))
      const decoded = encoding === 'br' ? brotliDecompressSync(encoded) : gunzipSync(encoded)
      assert.deepEqual(decoded, original)
    }
    assert.equal(existsSync(join(compressionRoot, '0.raw.compressing')), false)
  } finally {
    rmSync(compressionRoot, { recursive: true, force: true })
  }
}

let patched = null
const fakeFetch = async (url, init = {}) => {
  const value = String(url)
  if (value.includes('/sockdrive.metaj')) return Response.json({ range_count: 3 })
  if (value.includes('/preload_ranges.metaj')) return Response.json([0, 2])
  if (init.method === 'PATCH') {
    patched = JSON.parse(init.body)
    assert.equal(init.headers.Authorization, 'Bearer test-admin')
    return Response.json({
      slug: 'starcraft',
      platform: 'dos',
      dosBackend: 'dosboxX',
      dosSystem: 'systems/dos/win95.jsdos',
      dosExecutable: 'StarCraft.exe',
      dosSockdrive: patched.dosSockdrive,
    })
  }
  return Response.json({
    slug: 'starcraft',
    platform: 'dos',
    dosBackend: 'dosboxX',
    dosSystem: 'systems/dos/win95.jsdos',
    dosExecutable: 'StarCraft.exe',
  })
}
const bound = await bindSockdriveGame({
  slug: 'starcraft',
  prefix: 'sockdrives/starcraft-v1',
  publicBase: 'https://assets.test',
  apiBase: 'https://site.test',
  token: 'test-admin',
  fetchImpl: fakeFetch,
})
assert.equal(bound.changed, true)
assert.deepEqual(patched, { dosSockdrive: 'sockdrives/starcraft-v1' })

let languagePatch = null
const languageBound = await bindSockdriveGame({
  slug: 'fallout',
  prefix: 'sockdrives/fallout-en-v2',
  lang: 'en',
  publicBase: 'https://assets.test',
  apiBase: 'https://site.test',
  token: 'test-admin',
  fetchImpl: async (url, init = {}) => {
    const value = String(url)
    if (value.includes('/sockdrive.metaj')) return Response.json({ range_count: 3 })
    if (value.includes('/preload_ranges.metaj')) return Response.json([0, 2])
    if (init.method === 'PATCH') {
      languagePatch = JSON.parse(init.body)
      return Response.json({
        slug: 'fallout',
        platform: 'dos',
        dosBackend: 'dosboxX',
        dosExecutables: { en: 'FALLOUT.EXE' },
        dosSockdrives: languagePatch.dosSockdrives,
        roms: { en: 'roms/dos/fallout.en.zip.8bg', ja: 'roms/dos/fallout.ja.zip.8bg' },
      })
    }
    return Response.json({
      slug: 'fallout',
      platform: 'dos',
      dosBackend: 'dosboxX',
      dosExecutables: { en: 'FALLOUT.EXE' },
      dosSockdrives: { en: 'sockdrives/fallout-en-v1', ja: 'sockdrives/fallout-ja-v1' },
      roms: { en: 'roms/dos/fallout.en.zip.8bg', ja: 'roms/dos/fallout.ja.zip.8bg' },
    })
  },
})
assert.equal(languageBound.changed, true)
assert.deepEqual(languagePatch, {
  dosSockdrives: { en: 'sockdrives/fallout-en-v2', ja: 'sockdrives/fallout-ja-v1' },
})

await assert.rejects(
  () => bindSockdriveGame({
    slug: 'starcraft',
    prefix: 'sockdrives/starcraft-v1',
    publicBase: 'https://assets.test',
    apiBase: 'https://site.test',
    token: 'test-admin',
    fetchImpl: async (url, init) => {
      if (String(url).includes('/sockdrive.metaj')) return Response.json({ range_count: 2 })
      if (String(url).includes('/preload_ranges.metaj')) return Response.json([2])
      return fakeFetch(url, init)
    },
  }),
  /越界范围/,
)

console.log('Sockdrive 流水线测试通过：ZIP 路径保护 / 基础热点清单 / 发布后校验 / 原子绑定')
