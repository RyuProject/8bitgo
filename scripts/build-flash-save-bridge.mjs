/**
 * 构建旧 Armor Games AGI 的兼容 SWF。
 *
 * FFDec 能重编译现有 SWF 的 AS3 文档类，但不能从零创建时间轴，所以借 Ruffle 自己的
 * MIT/Apache-2.0 回归测试 SWF 作最小空壳。固定提交避免 master 改动导致同一份源码产物漂移。
 * 模板只在缺失时下载到临时目录；正式产物提交到 public，线上构建不需要联网。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SOURCE = join(ROOT, 'flash-api/armor-games/src')
const SOURCE_FILE = join(SOURCE, 'test_fla/MainTimeline.as')
const OUTPUT = join(ROOT, 'public/flash-api/armor-games/AGI.swf')
const MANIFEST = join(ROOT, 'public/flash-api/armor-games/runtime.json')
const FFDEC = process.env.FFDEC || '/Applications/FFDec.app/Contents/Resources/ffdec.sh'
const TEMPLATE_URL = 'https://raw.githubusercontent.com/ruffle-rs/ruffle/a4f5b5256e245693bc9077ef6c6b6abc95490e7f/tests/tests/swfs/avm2/array_access/test.swf'

if (!existsSync(FFDEC)) throw new Error(`找不到 FFDec：${FFDEC}`)
const work = mkdtempSync(join(tmpdir(), '8bitgo-flash-bridge-'))
const template = join(work, 'template.swf')
execFileSync('curl', ['-fsSL', '--retry', '2', '-o', template, TEMPLATE_URL], { stdio: 'inherit' })
mkdirSync(resolve(OUTPUT, '..'), { recursive: true })
execFileSync('bash', [FFDEC, '-config', 'useFlexAs3Compiler=false', '-importScript', template, OUTPUT, SOURCE], {
  stdio: 'inherit',
  env: { ...process.env, HOME: work },
})
const bytes = readFileSync(OUTPUT)
if (bytes.length < 100 || !['FWS', 'CWS', 'ZWS'].includes(bytes.subarray(0, 3).toString('ascii'))) {
  throw new Error('FFDec 没有生成有效的 SWF')
}
const swfSha256 = createHash('sha256').update(bytes).digest('hex')
const sourceSha256 = createHash('sha256').update(readFileSync(SOURCE_FILE)).digest('hex')
writeFileSync(MANIFEST, `${JSON.stringify({ version: 1, bytes: bytes.length, swfSha256, sourceSha256, template: TEMPLATE_URL }, null, 2)}\n`)
console.log(`✅ ${OUTPUT}`)
console.log(`   ${bytes.length} bytes · sha256 ${swfSha256}`)
