import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'flash-api/armor-games/src/test_fla/MainTimeline.as'))
const swfPath = join(root, 'public/flash-api/armor-games/AGI.swf')
assert.ok(
  existsSync(swfPath),
  '缺少 public/flash-api/armor-games/AGI.swf：它是必须随 Git 部署的构建产物；本地请运行 npm run flashbridge 后提交该文件',
)
const swf = readFileSync(swfPath)
const manifest = JSON.parse(readFileSync(join(root, 'public/flash-api/armor-games/runtime.json'), 'utf8'))
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

assert.ok(['FWS', 'CWS', 'ZWS'].includes(swf.subarray(0, 3).toString('ascii')), 'AGI.swf 不是有效的 SWF')
assert.equal(swf.length, manifest.bytes, 'AGI.swf 长度与 manifest 不符，请重新运行 npm run flashbridge')
assert.equal(sha(swf), manifest.swfSha256, 'AGI.swf 内容与 manifest 不符，请重新运行 npm run flashbridge')
assert.equal(sha(source), manifest.sourceSha256, '桥接源码改过但 SWF 没重建，请运行 npm run flashbridge')

if (process.argv.includes('--dist')) {
  const built = readFileSync(join(root, 'dist/client/flash-api/armor-games/AGI.swf'))
  assert.equal(sha(built), manifest.swfSha256, 'dist 里的 AGI.swf 不是当前版本，请重新运行 npm run build')
}

console.log(`✅ Flash 在线存档桥完整（${swf.length} bytes${process.argv.includes('--dist') ? '，dist 已同步' : ''}）`)
