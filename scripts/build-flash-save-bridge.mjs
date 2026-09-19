/**
 * 构建旧 Armor Games AGI 的兼容 SWF（两代：AGI1 的 AGI.swf / AGI2 的 AGI2.swf）。
 *
 * FFDec 能重编译现有 SWF 的 AS3 文档类，但不能从零创建时间轴，所以借 Ruffle 自己的
 * MIT/Apache-2.0 回归测试 SWF 作最小空壳。固定提交避免 master 改动导致同一份源码产物漂移。
 * 模板只在缺失时下载到临时目录；正式产物提交到 public，线上构建不需要联网。
 *
 * 每一代桥各自一套源码树和产物：文件名就是游戏侧加载的那个地址，不能互换
 * （两套接口不兼容，见 server/src/flash-save-contract.js 的 GAME_PROTOCOLS）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const FFDEC = process.env.FFDEC || '/Applications/FFDec.app/Contents/Resources/ffdec.sh'
const TEMPLATE_URL = 'https://raw.githubusercontent.com/ruffle-rs/ruffle/a4f5b5256e245693bc9077ef6c6b6abc95490e7f/tests/tests/swfs/avm2/array_access/test.swf'

/** 每一代桥：源码树 → 产物 SWF + manifest。manifest 供 check-flash-save-bridge.mjs 校验。 */
const BRIDGES = [
  {
    label: 'AGI（AGI1：Infectonator 2）',
    source: 'flash-api/armor-games/src',
    sourceFile: 'test_fla/MainTimeline.as',
    output: 'public/flash-api/armor-games/AGI.swf',
    manifest: 'public/flash-api/armor-games/runtime.json',
  },
  {
    label: 'AGI2（Kingdom Rush Frontiers）',
    source: 'flash-api/armor-games/src-agi2',
    sourceFile: 'test_fla/MainTimeline.as',
    output: 'public/flash-api/armor-games/AGI2.swf',
    manifest: 'public/flash-api/armor-games/runtime-agi2.json',
  },
]

if (!existsSync(FFDEC)) throw new Error(`找不到 FFDec：${FFDEC}`)
const work = mkdtempSync(join(tmpdir(), '8bitgo-flash-bridge-'))
const template = join(work, 'template.swf')
execFileSync('curl', ['-fsSL', '--retry', '2', '-o', template, TEMPLATE_URL], { stdio: 'inherit' })

let built = 0
for (const bridge of BRIDGES) {
  const sourceDir = join(ROOT, bridge.source)
  const sourceFile = join(sourceDir, bridge.sourceFile)
  /*
    源码还没落地的那一代跳过，而不是报错。
    「第二代还在写」不该把第一代的重新构建也一起卡住 —— 否则改一句 AGI1 的注释都跑不了脚本。
  */
  if (!existsSync(sourceFile)) {
    console.log(`⏭  跳过 ${bridge.label}：还没有 ${bridge.source}/${bridge.sourceFile}`)
    continue
  }
  const output = join(ROOT, bridge.output)
  const manifest = join(ROOT, bridge.manifest)
  mkdirSync(resolve(output, '..'), { recursive: true })
  execFileSync('bash', [FFDEC, '-config', 'useFlexAs3Compiler=false', '-importScript', template, output, sourceDir], {
    stdio: 'inherit',
    env: { ...process.env, HOME: work },
  })
  const bytes = readFileSync(output)
  if (bytes.length < 100 || !['FWS', 'CWS', 'ZWS'].includes(bytes.subarray(0, 3).toString('ascii'))) {
    throw new Error(`FFDec 没有生成有效的 SWF：${bridge.output}`)
  }
  const swfSha256 = createHash('sha256').update(bytes).digest('hex')
  const sourceSha256 = createHash('sha256').update(readFileSync(sourceFile)).digest('hex')
  writeFileSync(manifest, `${JSON.stringify({ version: 1, bytes: bytes.length, swfSha256, sourceSha256, template: TEMPLATE_URL }, null, 2)}\n`)
  built++
  console.log(`✅ ${bridge.output}`)
  console.log(`   ${bytes.length} bytes · sha256 ${swfSha256}`)
}
if (built === 0) throw new Error('没有任何一代桥被构建：检查上面被跳过的源码路径')
