/** Sockdrive 后台队列的离线回归；不连数据库、不访问 R2、不要求本机安装 guestfs。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const {
  sockdriveConversionConfig,
  validateSockdriveConversionRequest,
} = await import('../src/sockdrive-conversion.js')

const env = {
  PSP_CONVERT_WORKER_URL: 'https://worker.example.test/',
  PSP_CONVERT_WORKER_TOKEN: 'shared-token',
  SOCKDRIVE_MAX_SOURCE_MB: '8192',
  SOCKDRIVE_CONVERT_TMP_DIR: '/data/sockdrive-builds',
}
const valid = {
  sourceKey: 'sockdrive-staging/12345678-1234-1234-1234-123456789abc.zip',
  sourceSize: 1500 * 1024 * 1024,
  gameSlug: 'starcraft',
  executable: 'StarCraft/Brood.exe',
  version: 'v20261017010101',
  expectedSockdrive: 'sockdrives/starcraft-v1/',
  encoding: 'br',
}

assert.deepEqual(validateSockdriveConversionRequest(valid, env), {
  ...valid,
  expectedSockdrive: 'sockdrives/starcraft-v1',
  targetPrefix: 'sockdrives/starcraft-v20261017010101',
})
assert.throws(() => validateSockdriveConversionRequest({ ...valid, sourceKey: '../source.zip' }, env), /临时 Sockdrive ZIP key/)
assert.throws(() => validateSockdriveConversionRequest({ ...valid, sourceSize: 9 * 1024 ** 3 }, env), /ZIP 大小/)
assert.throws(() => validateSockdriveConversionRequest({ ...valid, executable: '../bad.exe' }, env), /\.exe/)
assert.throws(() => validateSockdriveConversionRequest({ ...valid, executable: `${'a'.repeat(252)}.exe` }, env), /\.exe/)
assert.throws(() => validateSockdriveConversionRequest({ ...valid, version: 'latest' }, env), /版本/)
assert.throws(() => validateSockdriveConversionRequest({ ...valid, encoding: 'deflate' }, env), /压缩格式/)

const config = sockdriveConversionConfig(env)
assert.equal(config.workerUrl, 'https://worker.example.test')
assert.equal(config.workerToken, 'shared-token')
assert.equal(config.tempDir, '/data/sockdrive-builds')
assert.equal(config.maxSourceBytes, 8192 * 1024 * 1024)
assert.equal(config.concurrency, 1)

const schema = readFileSync(new URL('../schema-v2.sql', import.meta.url), 'utf8')
const migration = readFileSync(new URL('./migrate.mjs', import.meta.url), 'utf8')
const routes = readFileSync(new URL('../src/routes/sockdrive-conversions.js', import.meta.url), 'utf8')
const frontend = readFileSync(new URL('../../src/admin/GameForm.tsx', import.meta.url), 'utf8')
const service = readFileSync(new URL('../../src/services/sockdriveConversion.ts', import.meta.url), 'utf8')
const worker = readFileSync(new URL('../../worker/src/index.js', import.meta.url), 'utf8')
assert.match(schema, /CREATE TABLE IF NOT EXISTS sockdrive_conversion_jobs/)
assert.match(schema, /publish_started/)
assert.match(schema, /expected_executable/)
assert.match(migration, /sockdrive_conversion_jobs（大型 Windows ZIP → Sockdrive 后台队列）/)
assert.match(routes, /requireAbility\('site:manage'\)/)
assert.match(frontend, /上传 ZIP 并自动转换/)
assert.match(frontend, /sockdriveStagingKey\(\)/)
assert.match(service, /8bitgo\.sockdrive\.conversions/)
assert.match(worker, /privateStagingRead/)
assert.match(worker, /contentEncoding/)
assert.match(worker, /privateStagingRead: true, contentEncodingUpload: true/)
assert.match(readFileSync(new URL('../src/sockdrive-conversion.js', import.meta.url), 'utf8'), /const published = row\.publish_started/)
assert.match(readFileSync(new URL('../src/sockdrive-conversion.js', import.meta.url), 'utf8'), /workerSupportsSockdrive/)

console.log('✅ Windows ZIP → Sockdrive：参数守卫、持久队列、私有 staging 与后台接线通过')
