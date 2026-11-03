import assert from 'node:assert/strict'
import { coverCdnProbeUrl, selectedCoverCdn, startCoverCdnProbe, subscribeCoverCdn } from '../src/services/coverCdn.ts'

const main = 'https://image.8bitgo.com'
const cn = 'https://image-cn.8bitgo.com'
const candidates = [main, cn]
const config = { candidates, preferred: main, cnBase: cn, transformEnabled: true }

assert.equal(
  coverCdnProbeUrl(cn, 'covers/game cover.webp', cn, true),
  `${cn}/cdn-cgi/image/width=16,quality=30,format=webp,fit=scale-down/covers/game%20cover.webp`,
)
assert.equal(
  coverCdnProbeUrl(main, 'covers/game.webp', cn, false),
  `${main}/covers/game.webp`,
)

const values = new Map()
let probeCount = 0
globalThis.window = {
  localStorage: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  },
  setTimeout,
  clearTimeout,
}
globalThis.Image = class FakeImage {
  set src(url) {
    if (!url) return
    probeCount++
    const delay = url.includes('image-cn.8bitgo.com') ? 5 : 30
    setTimeout(() => this.onload?.(), delay)
  }
}

let changes = 0
subscribeCoverCdn(() => changes++)
startCoverCdnProbe('covers/game.webp', config)
await new Promise((resolve) => setTimeout(resolve, 60))

assert.equal(selectedCoverCdn(candidates), cn, '应选择较快的 CDN')
assert.equal(probeCount, 2, '每轮只对两域各发一个轻量探测')
assert.equal(changes, 1, '胜出域名不同于默认值时通知封面重算 URL')
assert.match(values.get('8bitgo.cover-cdn.v1'), /image-cn\.8bitgo\.com/)

// 缓存命中时直接复用结果，不重复发探测图。
startCoverCdnProbe('covers/another.webp', config)
await new Promise((resolve) => setTimeout(resolve, 10))
assert.equal(probeCount, 2)

console.log('✅ 封面 CDN 并行测速、赢家选择、缓存复用和 URL 体积约束通过')
