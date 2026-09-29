import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { brotliCompressSync, gzipSync } from 'node:zlib'

const uploader = new URL('./upload-sockdrive-r2.mjs', import.meta.url)
const root = mkdtempSync(join(tmpdir(), '8bitgo-sockdrive-upload-'))

const makeFixture = (name, encoding) => {
  const dir = join(root, name)
  const metadata = Buffer.from(JSON.stringify({
    size: 2,
    ahead_read: 1024,
    range_count: 2,
    sector_size: 512,
    dropped_ranges: [1],
    small_ranges: [],
    preload_ranges: [0],
  }))
  const range = Buffer.alloc(1024, 0x5a)
  const encode = encoding === 'br'
    ? brotliCompressSync
    : encoding === 'gzip'
      ? gzipSync
      : (value) => value
  // 测试产物只活在系统临时目录；和真实发布脚本一样，压缩模式连元数据也要压缩。
  writeFileSync(join(dir, 'sockdrive.metaj'), encode(metadata))
  writeFileSync(join(dir, '0.raw'), encode(range))
  writeFileSync(join(dir, 'preload_ranges.metaj'), encode(Buffer.from('[0]')))
  return dir
}

const run = (dir, encoding, prefix = `sockdrives/test-${encoding}-v1`) => execFileSync(
  process.execPath,
  [uploader.pathname, '--src', dir, '--prefix', prefix, '--encoding', encoding, '--dry-run'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
)

try {
  for (const encoding of ['identity', 'br', 'gzip']) {
    const dir = join(root, encoding)
    mkdirSync(dir)
    const actual = makeFixture(encoding, encoding)
    assert.match(run(actual, encoding), /Sockdrive 结构完整：2 个范围，发布 3 个文件/)
  }

  assert.throws(
    () => run(join(root, 'br'), 'identity', 'sockdrives/wrong-encoding-v1'),
    /sockdrive\.metaj 不是有效 JSON/,
  )
  assert.throws(
    () => run(join(root, 'identity'), 'identity', 'sockdrives/no-version'),
    /必须带版本号或内容哈希/,
  )

  const invalidProfile = join(root, 'invalid-profile')
  mkdirSync(invalidProfile)
  makeFixture('invalid-profile', 'identity')
  writeFileSync(join(invalidProfile, 'preload_ranges.metaj'), '[0,0]')
  assert.throws(
    () => run(invalidProfile, 'identity', 'sockdrives/invalid-profile-v1'),
    /preload_ranges\.metaj 无效.*重复分块/,
  )

  console.log('Sockdrive 发布器测试通过：热点预热 / identity / Brotli / gzip / 编码错配 / 版本目录')
} finally {
  rmSync(root, { recursive: true, force: true })
}
