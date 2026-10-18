import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from 'node:zlib'
import {
  archiveEntriesFrom7z,
  assertSafeArchiveEntry,
  fatArchiveEntryKey,
  ensureBaselinePreloadProfile,
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
assert.throws(
  () => archiveEntriesFrom7z('archive\n----------\nPath = DATA/FILE.DAT\nPath = data/file.dat\n'),
  /FAT 下会互相覆盖/,
)
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
} finally {
  rmSync(root, { recursive: true, force: true })
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
