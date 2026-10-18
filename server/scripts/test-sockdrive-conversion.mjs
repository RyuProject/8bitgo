/** Sockdrive 后台队列的离线回归；不连数据库、不访问 R2、不要求本机安装 guestfs。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const {
  sockdriveFailureMessage,
  sockdriveConversionConfig,
  sockdriveConversionProgress,
  validateSockdriveConversionRequest,
} = await import('../src/sockdrive-conversion.js')

const env = {
  PSP_CONVERT_WORKER_URL: 'https://worker.example.test/',
  PSP_CONVERT_WORKER_TOKEN: 'shared-token',
  SOCKDRIVE_MAX_SOURCE_MB: '1900',
  SOCKDRIVE_CONVERT_TMP_DIR: '/data/sockdrive-builds',
}
const valid = {
  sourceKey: 'sockdrive-staging/12345678-1234-1234-1234-123456789abc.zip',
  sourceSize: 1500 * 1024 * 1024,
  gameSlug: 'starcraft',
  executable: 'StarCraft.exe',
  version: 'v20261017010101',
  expectedSockdrive: 'sockdrives/starcraft-v1/',
  encoding: 'br',
}

assert.deepEqual(validateSockdriveConversionRequest(valid, env), {
  ...valid,
  lang: null,
  targetRomKey: '',
  expectedRomKey: '',
  expectedSockdrive: 'sockdrives/starcraft-v1',
  targetPrefix: 'sockdrives/starcraft-v20261017010101',
})
const localized = {
  ...valid,
  lang: 'zh-Hans',
  targetRomKey: 'roms/dos/starcraft.zh-Hans.zip.8bg',
  expectedRomKey: 'https://old.example.test/starcraft-cn.zip',
}
assert.deepEqual(validateSockdriveConversionRequest(localized, env), {
  ...valid,
  lang: 'zh-Hans',
  targetRomKey: localized.targetRomKey,
  expectedRomKey: localized.expectedRomKey,
  expectedSockdrive: 'sockdrives/starcraft-v1',
  targetPrefix: 'sockdrives/starcraft-zh-hans-v20261017010101',
})
assert.throws(() => validateSockdriveConversionRequest({ ...valid, lang: '../zh' }, env), /语言代码/)
assert.throws(() => validateSockdriveConversionRequest({ ...localized, targetRomKey: 'covers/not-a-rom.8bg' }, env), /回退包 key/)
assert.throws(() => validateSockdriveConversionRequest({ ...valid, sourceKey: '../source.zip' }, env), /临时 Sockdrive ZIP key/)
assert.throws(() => validateSockdriveConversionRequest({ ...valid, sourceSize: 1901 * 1024 ** 2 }, env), /ZIP 大小/)
assert.throws(() => validateSockdriveConversionRequest({ ...valid, executable: '../bad.exe' }, env), /\.exe/)
assert.throws(() => validateSockdriveConversionRequest({ ...valid, executable: `${'a'.repeat(252)}.exe` }, env), /\.exe/)
assert.throws(() => validateSockdriveConversionRequest({ ...valid, version: 'latest' }, env), /版本/)
assert.throws(() => validateSockdriveConversionRequest({ ...valid, encoding: 'deflate' }, env), /压缩格式/)

const config = sockdriveConversionConfig(env)
assert.equal(config.workerUrl, 'https://worker.example.test')
assert.equal(config.workerToken, 'shared-token')
assert.equal(config.tempDir, '/data/sockdrive-builds')
assert.equal(config.maxSourceBytes, 1900 * 1024 * 1024)
assert.equal(config.freeSpace, '128M')
assert.equal(config.concurrency, 1)
assert.equal(config.compressionConcurrency, 2)
assert.equal(config.brotliQuality, 9)
assert.equal(config.uploadConcurrency, 6)
assert.equal(sockdriveConversionProgress('调用官方 sockify 生成静态分块…'), 55)
assert.equal(sockdriveConversionProgress('压缩 Sockdrive 分块：50/100（50%）'), 61)
assert.equal(sockdriveConversionProgress('压缩 Sockdrive 分块：100/100（100%）'), 67)

const noisyFailure = `node 失败（exit 1）：${'上传分块…'.repeat(300)}\nSyntaxError: metadata is not valid JSON`
const compactFailure = sockdriveFailureMessage(new Error(noisyFailure), 120)
assert.equal(compactFailure.length, 120)
assert.match(compactFailure, /^…/)
assert.match(compactFailure, /SyntaxError: metadata is not valid JSON$/)

const schema = readFileSync(new URL('../schema-v2.sql', import.meta.url), 'utf8')
const migration = readFileSync(new URL('./migrate.mjs', import.meta.url), 'utf8')
const routes = readFileSync(new URL('../src/routes/sockdrive-conversions.js', import.meta.url), 'utf8')
const frontend = readFileSync(new URL('../../src/admin/GameForm.tsx', import.meta.url), 'utf8')
const service = readFileSync(new URL('../../src/services/sockdriveConversion.ts', import.meta.url), 'utf8')
const worker = readFileSync(new URL('../../worker/src/index.js', import.meta.url), 'utf8')
const queue = readFileSync(new URL('../src/sockdrive-conversion.js', import.meta.url), 'utf8')
assert.match(schema, /CREATE TABLE IF NOT EXISTS sockdrive_conversion_jobs/)
assert.match(schema, /publish_started/)
assert.match(schema, /expected_executable/)
assert.match(schema, /expected_object_key/)
assert.match(schema, /target_object_key/)
assert.match(schema, /idx_sockdrive_jobs_game_lang/)
assert.match(migration, /sockdrive_conversion_jobs（大型 Windows ZIP → Sockdrive 后台队列）/)
assert.match(routes, /requireAbility\('site:manage'\)/)
assert.match(frontend, /生成流式盘/)
assert.match(frontend, /完整包 \+ 流式盘/)
assert.match(frontend, /publishLanguageSockdrive/)
assert.match(frontend, /sockdriveStagingKey\(\)/)
assert.match(service, /8bitgo\.sockdrive\.conversions/)
assert.match(service, /8bitgo\.sockdrive\.pending-creations/)
assert.match(service, /一次 502\/断网只代表这次“查询”失败/)
assert.match(frontend, /重试创建任务（无需重传）/)
assert.match(frontend, /sourceUploaded && !taskCreated/)
assert.doesNotMatch(frontend, /if \(stagingKey && !taskCreated\) await deleteRomObjects/)
assert.match(frontend, /const persistedSockdriveLanguage = useRef/)
assert.match(frontend, /onCompleted\(completed\)/)
assert.match(frontend, /initialSnapshot\.current = JSON\.stringify\(\{ \.\.\.snapshot, form: apply\(snapshot\.form\) \}\)/)
assert.match(frontend, /persistedSockdriveLanguage\.current\.roms\[lang\]/)
assert.match(worker, /privateStagingRead/)
assert.match(worker, /contentEncoding/)
assert.match(worker, /privateStagingRead: true, contentEncodingUpload: true/)
assert.match(queue, /workerSupportsSockdrive/)
assert.match(queue, /const CONTROL_PLANE_TIMEOUT_MS = 8_000/)
assert.match(queue, /const \[source, fallback, published\] = await Promise\.all/)
assert.match(queue, /任务尚未创建，请稍后重试/)
assert.match(routes, /Retry-After/)
assert.match(routes, /Number\.isInteger\(status\)/)
const retryBlock = queue.slice(
  queue.indexOf('export async function retrySockdriveConversion'),
  queue.indexOf('async function updateJob'),
)
assert.doesNotMatch(retryBlock, /remoteHead\(|workerRequest\(|fetch\(/, '重试 HTTP 接口不能再同步等待 R2')
assert.match(retryBlock, /processJob 本来就会按 ETag 重新校验源文件/)
assert.match(queue, /'--defer-validation'/)
assert.match(queue, /'--concurrency', String\(config\.uploadConcurrency\)/)
assert.match(queue, /'--compression-concurrency', String\(config\.compressionConcurrency\)/)
assert.match(queue, /'--brotli-quality', String\(config\.brotliQuality\)/)
assert.doesNotMatch(queue, /commandExists\('brotli'\)/)
assert.match(queue, /\[\(\\d\+\)\\\/\(\\d\+\) 字节/)
assert.match(queue, /Readable\.fromWeb\(response\.body\)/)
assert.match(queue, /createWriteStream\(destination, \{ flags: 'wx', highWaterMark: 1024 \* 1024 \}\)/)
assert.doesNotMatch(queue, /writeAllAt/)
assert.match(queue, /UPDATE game_roms SET object_key = \?, dos_sockdrive = \?, dos_executable = \?/)
assert.match(queue, /currentObjectKey !== String\(job\.expected_object_key/)
assert.match(queue, /currentObjectKey !== String\(job\.target_object_key/)
assert.match(queue, /remoteHead\(config, job\.target_object_key\)/)
assert.match(queue, /'Accept-Encoding': job\.encoding === 'identity' \? 'identity' : job\.encoding/)
assert.match(queue, /method: readsBody \? 'GET' : 'HEAD'/)
assert.match(queue, /for \(let pass = 1; pass <= 2; pass\+\+\)/)
assert.match(queue, /边缘缓存可能损坏/)

assert.doesNotMatch(queue, /必须先配置 DOSBox-X 和共享 Windows 系统镜像/)
console.log('✅ DOS / Windows ZIP → Sockdrive：参数守卫、持久队列、私有 staging 与后台接线通过')
