import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { flashSaveBridgeOf } from '../shared/flash-save-games.js'

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
    releaseSwf: `public${flashSaveBridgeOf('infectonator-2')}`,
    manifest: 'public/flash-api/armor-games/runtime.json',
  },
  {
    label: 'AGI2（Kingdom Rush Frontiers）',
    // ⚠️ 源码在源码树的根（顶层类 KrfAgiBridge），不是 test_fla/ 下 ——
    // AGI2 的模板是自己那份已核对的 SWF，文档类就叫 KrfAgiBridge，见 build-flash-save-bridge.mjs
    source: 'flash-api/armor-games/src-agi2/KrfAgiBridge.as',
    swf: 'public/flash-api/armor-games/AGI2.swf',
    releaseSwf: `public${flashSaveBridgeOf('kingdom-rushfrontiers')}`,
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
  const releasePath = join(root, bridge.releaseSwf)
  assert.ok(existsSync(releasePath), `缺少不可变发布副本 ${bridge.releaseSwf}，请重新运行 npm run flashbridge`)
  const releaseSwf = readFileSync(releasePath)
  const manifest = JSON.parse(readFileSync(join(root, bridge.manifest), 'utf8'))
  assert.ok(['FWS', 'CWS', 'ZWS'].includes(swf.subarray(0, 3).toString('ascii')), `${bridge.swf} 不是有效的 SWF`)
  assert.equal(swf.length, manifest.bytes, `${bridge.swf} 长度与 manifest 不符，请重新运行 npm run flashbridge`)
  assert.equal(sha(swf), manifest.swfSha256, `${bridge.swf} 内容与 manifest 不符，请重新运行 npm run flashbridge`)
  assert.equal(sha(releaseSwf), manifest.swfSha256, `${bridge.releaseSwf} 没有同步当前桥，请重新运行 npm run flashbridge`)
  assert.equal(
    sha(readFileSync(sourcePath)),
    manifest.sourceSha256,
    `${bridge.label} 的桥接源码改过但 SWF 没重建，请运行 npm run flashbridge`,
  )
  if (dist) {
    const builtPath = join(root, 'dist/client', bridge.swf.replace(/^public\//, ''))
    const builtReleasePath = join(root, 'dist/client', bridge.releaseSwf.replace(/^public\//, ''))
    assert.equal(
      sha(readFileSync(builtPath)),
      manifest.swfSha256,
      `dist 里的 ${bridge.swf} 不是当前版本，请重新运行 npm run build`,
    )
    assert.equal(
      sha(readFileSync(builtReleasePath)),
      manifest.swfSha256,
      `dist 里的 ${bridge.releaseSwf} 不是当前版本，请重新运行 npm run build`,
    )
  }
  checked++
}
assert.ok(checked > 0, '没有任何一代桥被检查：确认上面的源码路径')
console.log(`✅ Flash 在线存档桥完整（已校验 ${checked} 代${dist ? '，dist 已同步' : ''}）`)
