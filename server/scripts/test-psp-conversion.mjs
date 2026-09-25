/** PSP ISO → CHD 队列的离线回归；不连数据库、不访问 R2、不要求本机安装 chdman。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const {
  chdmanCreateArgs,
  chdmanProgress,
  isPspIsoHeader,
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
assert.equal(chdmanProgress('Compressing, 18.5% complete'), 18.5)
assert.equal(chdmanProgress('10%\r20%\r100%'), 100)
assert.equal(chdmanProgress('no progress'), null)

const header = new Uint8Array(0x9000)
header.set(Buffer.from('CD001'), 0x8001)
header.set(Buffer.from('PSP GAME'), 0x8008)
assert.equal(isPspIsoHeader(header), true)
header[0x8008] = 0
assert.equal(isPspIsoHeader(header), false)

const config = pspConversionConfig({
  ADMIN_TOKEN: 'fallback-worker-token',
  PSP_CONVERT_WORKER_URL: 'https://roms.example.test/',
  PSP_CONVERT_MAX_ISO_MB: '2048',
  PSP_CONVERT_CONCURRENCY: '99',
  PSP_CONVERT_TIMEOUT_MINUTES: '240',
})
assert.equal(config.workerUrl, 'https://roms.example.test')
assert.equal(config.workerToken, 'fallback-worker-token')
assert.equal(config.maxIsoBytes, 2048 * 1024 * 1024)
assert.equal(config.concurrency, 1, '越界并发不能偷偷退成一个危险的大值')
assert.equal(config.timeoutMs, 240 * 60 * 1000)

const schema = readFileSync(new URL('../schema-v2.sql', import.meta.url), 'utf8')
const migration = readFileSync(new URL('./migrate.mjs', import.meta.url), 'utf8')
const routes = readFileSync(new URL('../src/routes/psp-conversions.js', import.meta.url), 'utf8')
const frontend = readFileSync(new URL('../../src/admin/GameForm.tsx', import.meta.url), 'utf8')
const frontendService = readFileSync(new URL('../../src/services/pspConversion.ts', import.meta.url), 'utf8')
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

console.log('✅ PSP ISO → CHD：格式守卫、命令参数、断点任务与后台接线通过')
