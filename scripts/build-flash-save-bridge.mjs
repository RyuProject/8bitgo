/**
 * 构建旧 Armor Games AGI 的兼容 SWF。两代各一套源码、模板和产物：
 *
 *   AGI1 → public/flash-api/armor-games/AGI.swf   （Infectonator 2）
 *   AGI2 → public/flash-api/armor-games/AGI2.swf  （Kingdom Rush Frontiers）
 *
 * 两代的**模板不一样**，这是关键区别：
 *
 *   · AGI1 借 Ruffle 自己的回归测试 SWF 当空壳（MIT/Apache-2.0），它的文档类是
 *     `test_fla.MainTimeline`，所以源码里包名/类名必须叫这个，FFDec 重编译的就是它。
 *     模板按固定提交下载，避免 master 变动让同一份源码产出漂移；只在缺失时下载到临时目录。
 *
 *   · AGI2 的产物文档类叫 `KrfAgiBridge`（顶层类，游戏通过 Loader.content 取实例）。
 *     FFDec 没有「指定文档类」的选项，所以拿仓库里那份**已核对的 AGI2.swf 当种子模板**：
 *     种子里的文档类就是 KrfAgiBridge，源码同名重编译后名字不变。
 *     ⚠️ 别把它换成 Ruffle 空壳 —— 那样文档类会变成 test_fla.MainTimeline，游戏就取不到了。
 *
 * 两代的源码缺失时各自跳过（不挡另一代的构建）；产物和 manifest 都要提交进仓库，
 * 线上构建不再编译 Flash。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { flashSaveBridgeOf } from '../shared/flash-save-games.js'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const FFDEC = process.env.FFDEC || '/Applications/FFDec.app/Contents/Resources/ffdec.sh'
const RUFFLE_TEMPLATE_URL =
  'https://raw.githubusercontent.com/ruffle-rs/ruffle/a4f5b5256e245693bc9077ef6c6b6abc95490e7f/tests/tests/swfs/avm2/array_access/test.swf'

const BRIDGES = [
  {
    label: 'AGI（AGI1：Infectonator 2）',
    source: 'flash-api/armor-games/src',
    sourceFile: 'test_fla/MainTimeline.as',
    template: { ruffle: RUFFLE_TEMPLATE_URL },
    output: 'public/flash-api/armor-games/AGI.swf',
    releaseOutput: `public${flashSaveBridgeOf('infectonator-2')}`,
    manifest: 'public/flash-api/armor-games/runtime.json',
  },
  {
    label: 'AGI2（Kingdom Rush Frontiers）',
    source: 'flash-api/armor-games/src-agi2',
    sourceFile: 'KrfAgiBridge.as',
    template: { seed: 'flash-api/armor-games/template-agi2.swf' },
    output: 'public/flash-api/armor-games/AGI2.swf',
    releaseOutput: `public${flashSaveBridgeOf('kingdom-rushfrontiers')}`,
    manifest: 'public/flash-api/armor-games/runtime-agi2.json',
  },
]

if (!existsSync(FFDEC)) throw new Error(`找不到 FFDec：${FFDEC}`)
const work = mkdtempSync(join(tmpdir(), '8bitgo-flash-bridge-'))

/** Ruffle 空壳只在真的要用时才下载（另一代可能根本不需要它） */
let ruffleTemplate = ''
function resolveTemplate(bridge) {
  if (bridge.template.seed) {
    const seed = join(ROOT, bridge.template.seed)
    if (!existsSync(seed)) throw new Error(`找不到种子模板：${bridge.template.seed}`)
    return seed
  }
  if (!ruffleTemplate) {
    ruffleTemplate = join(work, 'ruffle-template.swf')
    execFileSync('curl', ['-fsSL', '--retry', '2', '-o', ruffleTemplate, bridge.template.ruffle], { stdio: 'inherit' })
  }
  return ruffleTemplate
}

let built = 0
for (const bridge of BRIDGES) {
  const sourceDir = join(ROOT, bridge.source)
  const sourceFile = join(sourceDir, bridge.sourceFile)
  /*
    源码还没落地的那一代跳过，而不是报错。
    「第二代还在写」不该把第一代的重新构建也一起卡住 —— 改一句 AGI1 的注释都跑不了脚本。
  */
  if (!existsSync(sourceFile)) {
    console.log(`⏭  跳过 ${bridge.label}：还没有 ${bridge.source}/${bridge.sourceFile}`)
    continue
  }
  const output = join(ROOT, bridge.output)
  const releaseOutput = join(ROOT, bridge.releaseOutput)
  const manifest = join(ROOT, bridge.manifest)
  mkdirSync(resolve(output, '..'), { recursive: true })
  mkdirSync(resolve(releaseOutput, '..'), { recursive: true })
  execFileSync('bash', [FFDEC, '-config', 'useFlexAs3Compiler=false', '-importScript', resolveTemplate(bridge), output, sourceDir], {
    stdio: 'inherit',
    env: { ...process.env, HOME: work },
  })
  const bytes = readFileSync(output)
  if (bytes.length < 100 || !['FWS', 'CWS', 'ZWS'].includes(bytes.subarray(0, 3).toString('ascii'))) {
    throw new Error(`FFDec 没有生成有效的 SWF：${bridge.output}`)
  }
  const swfSha256 = createHash('sha256').update(bytes).digest('hex')
  const sourceSha256 = createHash('sha256').update(readFileSync(sourceFile)).digest('hex')
  const template = bridge.template.seed ? { seed: bridge.template.seed } : { url: bridge.template.ruffle }
  writeFileSync(manifest, `${JSON.stringify({ version: 1, bytes: bytes.length, swfSha256, sourceSha256, template }, null, 2)}\n`)
  copyFileSync(output, releaseOutput)
  built++
  console.log(`✅ ${bridge.output}`)
  console.log(`   发布副本 ${bridge.releaseOutput}`)
  console.log(`   ${bytes.length} bytes · sha256 ${swfSha256}`)
}
if (built === 0) throw new Error('没有任何一代桥被构建：检查上面被跳过的源码路径')
