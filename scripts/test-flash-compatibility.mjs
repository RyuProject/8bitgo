import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  flashCompatibilityIssue,
  flashCompatibilityIssueForFingerprint,
} from '../src/emulator/flashCompatibility.ts'
import { flashLegacyBundleRulesForFingerprint } from '../src/emulator/flashLegacyBundle.ts'

const root = join(import.meta.dirname, '..')
const read = (path) => readFileSync(join(root, path), 'utf8')

console.log('── 已知 Armor Games 站点锁样本 ──')
const issue = flashCompatibilityIssueForFingerprint(
  4_443_526,
  '2A37D48DA5EE69B787C0D255A75C06E4EDEA6EA41ACB2925D016A8A2574A3763',
)
assert.equal(issue?.kind, 'site-lock')
assert.match(issue?.message ?? '', /Armor Games.*黑屏/)
assert.equal(flashCompatibilityIssueForFingerprint(4_443_525, '2a37d48da5ee69b787c0d255a75c06e4edea6ea41acb2925d016a8a2574a3763'), null)
assert.equal(flashCompatibilityIssueForFingerprint(4_443_526, '0'.repeat(64)), null)

console.log('── 普通 SWF 快速放行 ──')
assert.equal(await flashCompatibilityIssue(new Uint8Array([0x46, 0x57, 0x53, 0x0e]).buffer), null)

console.log('── 森林冰火人 4 的离线 Spil SDK ──')
const legacyRules = flashLegacyBundleRulesForFingerprint({
  bytes: 4_485_060,
  sha256: '2C4D050191E36179FB936D49AE591F3B14821B2DAF51B4621A55A67789F4BC9A',
  bundleBaseUrl: 'https://assets.example/roms/flash/crystal/',
})
assert.equal(legacyRules.length, 6)
assert.equal(
  'http://api.configar.org/cf/pb/1/settings/0/0/f3eea80c7627f4ee2b907453156f4fb1?type=live&nocache=1'
    .replace(legacyRules[0][0], legacyRules[0][1]),
  'https://assets.example/roms/flash/crystal/api.configar.org/cf/pb/1/settings/0/0/f3eea80c7627f4ee2b907453156f4fb1',
)
assert.equal(
  'http://files.cdn.spilcloud.com/flashapi_1_3_1_147/BrandSystem.swf'
    .replace(legacyRules[1][0], legacyRules[1][1]),
  'https://assets.example/roms/flash/crystal/files.cdn.spilcloud.com/flashapi_1_3_1_147/BrandSystem.swf',
)
assert.deepEqual(flashLegacyBundleRulesForFingerprint({
  bytes: 4_485_060,
  sha256: '0'.repeat(64),
  bundleBaseUrl: 'https://assets.example/roms/flash/crystal/',
}), [], '同尺寸的其它 SWF 不能误接 Spil SDK')

console.log('── 启动回退与上传守卫接线 ──')
const adapter = read('src/emulator/adapters/ruffle.ts')
const player = read('src/emulator/EmulatorPlayer.tsx')
const singleUpload = read('src/admin/GameForm.tsx')
const bundleUpload = read('src/admin/swfUpload.ts')
assert.match(adapter, /flashCompatibilityIssue\(loaded\.data\)/, 'Ruffle 启动前必须检查解密后的 SWF')
assert.match(adapter, /flashLegacyBundleRules\([\s\S]*loaded\.data/, 'Ruffle 必须在 load 前接入多 SWF 兼容资源')
assert.match(adapter, /new frameGlobal\.RegExp\(from\.source, from\.flags\)/,
  '正则必须在 Ruffle iframe realm 重建，否则 instanceof RegExp 会失效')
assert.match(player, /Flash 站点锁/, '站点锁是确定性坏 ROM，不能先原样重试')
// 2026-11-15 起两条上传路径都先 assertSwf（截断 / 坏头直接拦），再查站点锁；两步必须用同一份字节。
assert.match(
  singleUpload,
  /const data = await file\.arrayBuffer\(\)\s*assertSwf\(data\)\s*const issue = await flashCompatibilityIssue\(data\)/,
  '单 SWF 上传必须先校验 SWF 完整性，再拦截已知坏包',
)
assert.match(
  bundleUpload,
  /const mainBuffer = new Uint8Array\(mainData\)\.buffer\s*assertSwf\(mainBuffer\)\s*const compatibilityIssue = await flashCompatibilityIssue\(mainBuffer\)/,
  '多 SWF 包必须在上传前校验并检查主文件',
)
assert.match(singleUpload, /platform === 'flash'[\s\S]{0,260}?await assertSwfBlob\(unpacked\.blob\)/,
  '已打包的 8BG Flash 也必须校验内层 SWF')

console.log('Flash 站点锁兼容性测试全部通过。')
