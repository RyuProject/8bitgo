/** PS1 单数据轨 ISO → CD CHD：格式与后台接线回归；本机有 chdman 时再做真实转换。 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import {
  chdmanCreateCdArgs,
  conversionScratchBytes,
  isPsxIsoFile,
  isPsxIsoHeader,
  validatePspConversionRequest,
} from '../src/psp-conversion.js'

const request = {
  platform: 'psx',
  sourceKey: 'psp-staging/12345678-1234-1234-1234-123456789abc.iso',
  targetKey: 'roms/psx/crash.zh-Hans.chd',
  sourceSize: 1024 * 1024,
  gameSlug: 'crash',
  lang: 'zh-Hans',
  expectedCurrentKey: 'roms/psx/crash.zh-Hans.iso.8bg',
  overwrite: true,
}
assert.deepEqual(validatePspConversionRequest(request), request)
assert.throws(() => validatePspConversionRequest({ ...request, sourceKey: 'roms/psx/source.iso' }), /临时 ISO key/)
assert.throws(() => validatePspConversionRequest({ ...request, targetKey: 'roms/psp/crash.chd' }), /roms\/psx/)
assert.throws(() => validatePspConversionRequest({ ...request, platform: 'ps2' }), /只支持/)
assert.equal(validatePspConversionRequest({ ...request, targetKey: 'games/psx/crash.chd' }, { ROM_PREFIX: 'games' }).targetKey,
  'games/psx/crash.chd', '自定义 ROM_PREFIX 的后台上传也能通过目标路径守卫')
assert.deepEqual(chdmanCreateCdArgs('/tmp/input.cue', '/tmp/output.chd', 2), [
  'createcd', '-c', 'cdzl', '-np', '2', '-i', '/tmp/input.cue', '-o', '/tmp/output.chd',
])
assert.ok(conversionScratchBytes(1024 ** 3, 0, 0, 'psx') > conversionScratchBytes(1024 ** 3),
  'CD CHD 的磁盘预算必须包含 2048→2352 扇区开销')

const bytes = Buffer.from(randomBytes(2048 * 80))
bytes[0x8000] = 1
bytes.write('CD001', 0x8001)
bytes[0x8006] = 1
const root = 0x8000 + 156
bytes[root] = 34
bytes.writeUInt32LE(20, root + 2)
bytes.writeUInt32LE(2048, root + 10)
bytes[root + 32] = 1
const at = 20 * 2048
const name = 'SYSTEM.CNF;1'
bytes[at] = 33 + name.length
bytes.writeUInt32LE(21, at + 2)
bytes.writeUInt32LE(64, at + 10)
bytes[at + 32] = name.length
bytes.write(name, at + 33)
assert.equal(isPsxIsoHeader(bytes), true)
assert.equal(isPsxIsoHeader(Buffer.from('<html>not an ISO')), false)

const dir = await mkdtemp(join(tmpdir(), '8bitgo-psx-chd-'))
try {
  const input = join(dir, 'input.iso')
  const cue = join(dir, 'input.cue')
  const output = join(dir, 'output.chd')
  await writeFile(input, bytes)
  assert.equal(await isPsxIsoFile(input, bytes.length), true)
  const invalid = Buffer.from(bytes)
  invalid.write('NOTSYSTEM.CNF', at + 33)
  await writeFile(input, invalid)
  assert.equal(await isPsxIsoFile(input, invalid.length), false, '非 PS1 ISO 不应被发布成可玩 CHD')
  await writeFile(input, bytes)
  const chdman = process.env.PSP_CHDMAN_BIN || 'chdman'
  const available = spawnSync(chdman, ['help'], { stdio: 'ignore' }).status === 0
  if (available) {
    await writeFile(cue, 'FILE "input.iso" BINARY\n  TRACK 01 MODE1/2048\n    INDEX 01 00:00:00\n')
    const created = spawnSync(chdman, chdmanCreateCdArgs(cue, output, 2), { encoding: 'utf8' })
    assert.equal(created.status, 0, created.stderr || created.stdout)
    const verified = spawnSync(chdman, ['verify', '-i', output], { encoding: 'utf8' })
    assert.equal(verified.status, 0, verified.stderr || verified.stdout)
    const info = spawnSync(chdman, ['info', '-i', output], { encoding: 'utf8' })
    assert.match(info.stdout, /TRACK:1 TYPE:MODE1\b/)
    assert.equal((await readFile(output)).subarray(0, 8).toString('ascii'), 'MComprHD')
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}

const schema = readFileSync(new URL('../schema-v2.sql', import.meta.url), 'utf8')
const migration = readFileSync(new URL('./migrate.mjs', import.meta.url), 'utf8')
const server = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
const form = readFileSync(new URL('../../src/admin/GameForm.tsx', import.meta.url), 'utf8')
assert.match(schema, /disc_platform\s+VARCHAR\(8\)/)
assert.match(migration, /ADD COLUMN `disc_platform`/)
assert.match(server, /\/api\/admin\/disc-conversions/)
assert.match(form, /createPsxConversion\(request\)/)
assert.match(form, /psxChdKey\(defKey\(file\.name\)\)/)
assert.match(form, /confirmConvertedUpload\(finalKey\)/, '覆盖授权必须来自明确探测和确认')
assert.match(form, /overwrite: allowOverwrite/, '不能像普通上传一样无条件允许覆盖')

console.log('✅ PS1 ISO → CD CHD：输入格式、轨道、迁移与后台上传接线通过')
