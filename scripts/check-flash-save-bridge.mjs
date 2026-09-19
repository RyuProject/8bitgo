import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const dist = process.argv.includes('--dist')

/**
 * 每一代兼容桥：**源码存在**就必须有配套的产物和 manifest。
 *
 * 源码还没写的那一代（比如第二代实现中）跳过，不挡构建；但源码一旦落地，
 * 缺产物就是硬错误 —— 线上跑的是提交进仓库的 SWF，不是构建时现编的。
 * 少了这道校验，症状是「构建全绿、游戏里在线存档静默失效」，最难查的一类。
 */
const BRIDGES = [
  {
    label: 'AGI（AGI1：Infectonator 2）',
    source: 'flash-api/armor-games/src/test_fla/MainTimeline.as',
    swf: 'public/flash-api/armor-games/AGI.swf',
    manifest: 'public/flash-api/armor-games/runtime.json',
  },
  {
    label: 'AGI2（Kingdom Rush Frontiers）',
    source: 'flash-api/armor-games/src-agi2/test_fla/MainTimeline.as',
    swf: 'public/flash-api/armor-games/AGI2.swf',
    manifest: 'public/flash-api/armor-games/runtime-agi2.json',
  },
]

let checked = 0
for (const bridge of BRIDGES) {
  const sourcePath = join(root, bridge.source)
  if (!existsSync(sourcePath)) {
    console.log(`⏭  跳过 ${bridge.label}：还没有源码（${bridge.source}）`)
    continue
  }
  const swfPath = join(root, bridge.swf)
  assert.ok(
    existsSync(swfPath),
    `缺少 ${bridge.swf}：它是必须随 Git 部署的构建产物；本地请运行 npm run flashbridge 后提交该文件`,
  )
  const swf = readFileSync(swfPath)
  const manifest = JSON.parse(readFileSync(join(root, bridge.manifest), 'utf8'))
  assert.ok(['FWS', 'CWS', 'ZWS'].includes(swf.subarray(0, 3).toString('ascii')), `${bridge.swf} 不是有效的 SWF`)
  assert.equal(swf.length, manifest.bytes, `${bridge.swf} 长度与 manifest 不符，请重新运行 npm run flashbridge`)
  assert.equal(sha(swf), manifest.swfSha256, `${bridge.swf} 内容与 manifest 不符，请重新运行 npm run flashbridge`)
  assert.equal(
    sha(readFileSync(sourcePath)),
    manifest.sourceSha256,
    `${bridge.label} 的桥接源码改过但 SWF 没重建，请运行 npm run flashbridge`,
  )
  if (dist) {
    const builtPath = join(root, 'dist/client', bridge.swf.replace(/^public\//, ''))
    assert.equal(
      sha(readFileSync(builtPath)),
      manifest.swfSha256,
      `dist 里的 ${bridge.swf} 不是当前版本，请重新运行 npm run build`,
    )
  }
  checked++
}
assert.ok(checked > 0, '没有任何一代桥被检查：确认上面的源码路径')
console.log(`✅ Flash 在线存档桥完整（已校验 ${checked} 代${dist ? '，dist 已同步' : ''}）`)
