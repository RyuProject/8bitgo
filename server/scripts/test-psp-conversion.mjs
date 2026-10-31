/** PSP ISO → CHD 队列的离线回归；不连数据库、不访问 R2、不要求本机安装 chdman。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  chdmanCreateArgs,
  chdmanProgress,
  concurrentMapOrdered,
  conversionScratchBytes,
  isPspIsoFile,
  isIso9660Pvd,
  objectVersionMatches,
  pspConversionConfig,
  readExactlyAt,
  validatePspConversionRequest,
  validObjectKey,
  writeAllAt,
} = await import('../src/psp-conversion.js')

const env = { PSP_CONVERT_MAX_ISO_MB: '2560' }
const valid = {
  sourceKey: 'psp-staging/12345678-1234-1234-1234-123456789abc.iso',
  targetKey: 'roms/psp/monster-hunter.zh-Hans.chd',
  sourceSize: 800 * 1024 * 1024,
  gameSlug: 'monster-hunter',
  lang: 'zh-Hans',
  expectedCurrentKey: 'roms/psp/monster-hunter.zh-Hans.iso',
  overwrite: true,
}

assert.deepEqual(validatePspConversionRequest(valid, env), {
  ...valid,
  gameSlug: valid.gameSlug,
  lang: valid.lang,
})
assert.throws(() => validatePspConversionRequest({ ...valid, sourceKey: '../secret.iso' }, env), /临时 ISO key/)
assert.throws(() => validatePspConversionRequest({ ...valid, targetKey: 'covers/x.chd' }, env), /psp 目录/)
assert.throws(() => validatePspConversionRequest({ ...valid, targetKey: 'roms/psp/x.iso' }, env), /\.chd/)
assert.throws(() => validatePspConversionRequest({ ...valid, sourceSize: 3 * 1024 ** 3 }, env), /ISO 大小/)
assert.throws(() => validatePspConversionRequest({ ...valid, lang: 'fr' }, env), /语言/)
assert.equal(validObjectKey('roms/psp/a.chd'), true)
assert.equal(validObjectKey('roms/../secret'), false)
assert.equal(objectVersionMatches(null, ''), true, '创建时不存在、发布前仍不存在才允许继续')
assert.equal(objectVersionMatches({ etag: '"new"' }, ''), false, '排队期间新出现的目标不能被覆盖')
assert.equal(objectVersionMatches({ etag: '"same"' }, '"same"'), true)
assert.equal(objectVersionMatches({ etag: '"changed"' }, '"same"'), false)

const written = Buffer.alloc(7)
let writeCalls = 0
const shortWriter = {
  async write(bytes, offset, length, position) {
    const count = Math.min(2, length)
    Buffer.from(bytes).copy(written, position, offset, offset + count)
    writeCalls += 1
    return { bytesWritten: count }
  },
}
assert.equal(await writeAllAt(shortWriter, Buffer.from('1234567'), 0), 7)
assert.equal(written.toString(), '1234567')
assert.equal(writeCalls, 4, '短写必须继续补齐，不能把下一块接到错误偏移')

const sourceBytes = Buffer.from('abcdefg')
const readBuffer = Buffer.alloc(sourceBytes.length)
let readCalls = 0
const shortReader = {
  async read(target, offset, length, position) {
    const count = Math.min(2, length, Math.max(0, sourceBytes.length - position))
    if (count) sourceBytes.copy(target, offset, position, position + count)
    readCalls += 1
    return { bytesRead: count }
  },
}
assert.equal(await readExactlyAt(shortReader, readBuffer, 0), sourceBytes.length)
assert.equal(readBuffer.toString(), 'abcdefg')
assert.equal(readCalls, 4, '短读必须继续补齐整个分片')

assert.deepEqual(chdmanCreateArgs('/tmp/in.iso', '/tmp/out.chd'), [
  'createdvd', '-hs', '2048', '-c', 'zstd', '-i', '/tmp/in.iso', '-o', '/tmp/out.chd',
])
assert.deepEqual(chdmanCreateArgs('/tmp/in.iso', '/tmp/out.chd', 4), [
  'createdvd', '-hs', '2048', '-c', 'zstd', '-np', '4', '-i', '/tmp/in.iso', '-o', '/tmp/out.chd',
])
assert.equal(chdmanProgress('Compressing, 18.5% complete'), 18.5)
assert.equal(chdmanProgress('10%\r20%\r100%'), 100)
assert.equal(chdmanProgress('no progress'), null)

function writeBothEndian32(bytes, offset, value) {
  bytes.writeUInt32LE(value, offset)
  bytes.writeUInt32BE(value, offset + 4)
}

function writeBothEndian16(bytes, offset, value) {
  bytes.writeUInt16LE(value, offset)
  bytes.writeUInt16BE(value, offset + 2)
}

function isoRecord(name, extent, size, directory = false) {
  const nameBytes = name === '.' ? Buffer.from([0]) : name === '..' ? Buffer.from([1]) : Buffer.from(name, 'ascii')
  const length = 33 + nameBytes.length + (nameBytes.length % 2 === 0 ? 1 : 0)
  const record = Buffer.alloc(length)
  record[0] = length
  writeBothEndian32(record, 2, extent)
  writeBothEndian32(record, 10, size)
  record[25] = directory ? 0x02 : 0
  writeBothEndian16(record, 28, 1)
  record[32] = nameBytes.length
  nameBytes.copy(record, 33)
  return record
}

function isoDirectory(entries) {
  const bytes = Buffer.alloc(2048)
  let offset = 0
  for (const entry of entries) {
    const record = isoRecord(...entry)
    record.copy(bytes, offset)
    offset += record.length
  }
  return bytes
}

function pspIsoFixture({ includeEboot = true, ebootMagic = '~PSP' } = {}) {
  const sectors = 32
  const iso = Buffer.alloc(sectors * 2048)
  const pvdOffset = 16 * 2048
  iso[pvdOffset] = 1
  iso.write('CD001', pvdOffset + 1, 'ascii')
  iso[pvdOffset + 6] = 1
  // 使用真实用户镜像中的第三方卷标，避免再次把自由文本误当作 PSP 身份标记。
  iso.write('VcdromX By HJH98', pvdOffset + 40, 'ascii')
  writeBothEndian32(iso, pvdOffset + 80, sectors)
  writeBothEndian16(iso, pvdOffset + 128, 2048)
  isoRecord('.', 20, 2048, true).copy(iso, pvdOffset + 156)
  const terminator = 17 * 2048
  iso[terminator] = 255
  iso.write('CD001', terminator + 1, 'ascii')
  iso[terminator + 6] = 1

  isoDirectory([
    ['.', 20, 2048, true], ['..', 20, 2048, true], ['PSP_GAME', 21, 2048, true],
    ['UMD_DATA.BIN;1', 25, 48, false],
  ]).copy(iso, 20 * 2048)
  isoDirectory([
    ['.', 21, 2048, true], ['..', 20, 2048, true], ['PARAM.SFO;1', 23, 32, false], ['SYSDIR', 22, 2048, true],
  ]).copy(iso, 21 * 2048)
  isoDirectory([
    ['.', 22, 2048, true], ['..', 21, 2048, true],
    ...(includeEboot ? [['EBOOT.BIN;1', 24, 128, false]] : []),
  ]).copy(iso, 22 * 2048)
  iso.set(Buffer.from([0x00, 0x50, 0x53, 0x46]), 23 * 2048)
  if (includeEboot) iso.set(Buffer.from(ebootMagic), 24 * 2048)
  return iso
}

const fixtureDir = await mkdtemp(join(tmpdir(), '8bitgo-psp-iso-'))
try {
  const validIso = pspIsoFixture()
  const validPath = join(fixtureDir, 'valid.iso')
  await writeFile(validPath, validIso)
  assert.equal(isIso9660Pvd(validIso.subarray(0, 0x9000)), true, 'PVD 卷标可以是非标准文本，只要 ISO9660 描述符有效')
  assert.equal(await isPspIsoFile(validPath, validIso.byteLength), true, '必须沿目录树找到 PSP_GAME、PARAM.SFO 与 SYSDIR/EBOOT.BIN')

  const missingBootIso = pspIsoFixture({ includeEboot: false })
  const missingBootPath = join(fixtureDir, 'missing-eboot.iso')
  await writeFile(missingBootPath, missingBootIso)
  assert.equal(await isPspIsoFile(missingBootPath, missingBootIso.byteLength), false, '只有卷标或 PSP_GAME 目录、没有启动文件不能通过')

  const invalidBootIso = pspIsoFixture({ ebootMagic: 'NOPE' })
  const invalidBootPath = join(fixtureDir, 'invalid-eboot.iso')
  await writeFile(invalidBootPath, invalidBootIso)
  assert.equal(await isPspIsoFile(invalidBootPath, invalidBootIso.byteLength), false, '目录存在但 EBOOT 不是 PSP PRX/ELF 时不能通过')

  const htmlPath = join(fixtureDir, 'not-iso.iso')
  await writeFile(htmlPath, Buffer.from('<html>not an ISO</html>'))
  assert.equal(await isPspIsoFile(htmlPath, 0x9000), false, 'Worker 错误页不能因扩展名 .iso 通过校验')
} finally {
  await rm(fixtureDir, { recursive: true, force: true })
}

assert.equal(
  conversionScratchBytes(1024 * 1024, 256 * 1024, 512 * 1024),
  273.25 * 1024 * 1024,
  '续跑空间只计算尚未落盘的输入/输出和固定余量',
)

let activeParts = 0
let peakParts = 0
const finishOrder = []
const concurrentResults = await concurrentMapOrdered(7, 3, async (index) => {
  activeParts += 1
  peakParts = Math.max(peakParts, activeParts)
  await new Promise((resolve) => setTimeout(resolve, (7 - index) * 2))
  activeParts -= 1
  return { partNumber: index + 1 }
}, (_completed, results) => finishOrder.push(results.filter(Boolean).length))
assert.equal(peakParts, 3, '服务端 CHD 发布必须真正并发，但不能越过配置上限')
assert.deepEqual(concurrentResults.map((part) => part.partNumber), [1, 2, 3, 4, 5, 6, 7], '完成顺序不能打乱 R2 part 清单')
assert.equal(finishOrder.at(-1), 7)

const config = pspConversionConfig({
  ADMIN_TOKEN: 'fallback-worker-token',
  PSP_CONVERT_WORKER_URL: 'https://roms.example.test/',
  PSP_CONVERT_MAX_ISO_MB: '2048',
  PSP_CONVERT_CONCURRENCY: '99',
  PSP_CONVERT_UPLOAD_CONCURRENCY: '6',
  PSP_CHDMAN_PROCESSORS: '3',
  PSP_CONVERT_TIMEOUT_MINUTES: '240',
})
assert.equal(config.workerUrl, 'https://roms.example.test')
assert.equal(config.workerToken, 'fallback-worker-token')
assert.equal(config.maxIsoBytes, 2048 * 1024 * 1024)
assert.equal(config.concurrency, 1, '越界并发不能偷偷退成一个危险的大值')
assert.equal(config.uploadConcurrency, 6)
assert.equal(config.chdmanProcessors, 3)
assert.equal(config.timeoutMs, 240 * 60 * 1000)

const schema = readFileSync(new URL('../schema-v2.sql', import.meta.url), 'utf8')
const migration = readFileSync(new URL('./migrate.mjs', import.meta.url), 'utf8')
const routes = readFileSync(new URL('../src/routes/psp-conversions.js', import.meta.url), 'utf8')
const frontend = readFileSync(new URL('../../src/admin/GameForm.tsx', import.meta.url), 'utf8')
const frontendService = readFileSync(new URL('../../src/services/pspConversion.ts', import.meta.url), 'utf8')
const conversionSource = readFileSync(new URL('../src/psp-conversion.js', import.meta.url), 'utf8')
assert.match(schema, /CREATE TABLE IF NOT EXISTS psp_conversion_jobs/)
assert.match(schema, /target_etag_before/)
assert.match(schema, /output_etag/)
assert.match(schema, /game_id\s+BIGINT UNSIGNED/)
assert.match(migration, /psp_conversion_jobs（PSP ISO → CHD 后台压缩队列）/)
assert.match(routes, /requireAbility\('site:manage'\)/)
assert.match(frontend, /pspStagingKey\(\)/)
assert.match(frontend, /waitForPspConversion/)
assert.match(frontend, /sameStoredFormat/)
assert.match(frontend, /persistedSlug/)
assert.match(frontendService, /isoKey\.replace\(\/\\\.\[\^\.\/\]\+\$\/, '\.chd'\)/)
assert.match(conversionSource, /Range: `bytes=\$\{received\}-`/, 'R2 下载失败后必须从本地断点续传')
assert.match(conversionSource, /Readable\.fromWeb\(response\.body\)/, '下载必须使用带背压的流式磁盘管线')
assert.match(conversionSource, /复用上次已完整校验的 CHD/, '发布失败后不能重新下载和压缩')

console.log('✅ PSP ISO → CHD：格式守卫、命令参数、断点任务与后台接线通过')
