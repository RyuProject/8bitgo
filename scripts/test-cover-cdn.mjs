import assert from 'node:assert/strict'
import { coverCdnProbeUrl, reportCoverCdnFailure, selectedCoverCdn, startCoverCdnProbe, subscribeCoverCdn } from '../src/services/coverCdn.ts'
import { ASSETS_ORIGIN_QUERY, coverCdnHint, stripCoverCdnQuery, stripQueryParam } from '../shared/cover-cdn-hint.js'
import { readFileSync } from 'node:fs'

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

// 边缘已经定了就不测速
startCoverCdnProbe('covers/third.webp', { ...config, candidates: [main, cn, 'https://x.example'], decided: true })
await new Promise((resolve) => setTimeout(resolve, 10))
assert.equal(probeCount, 2, 'decided 时不发探测')

// 故障切换：同一域名三张不同的图失败才切；同一张图反复失败不算
reportCoverCdnFailure(`${cn}/covers/a.webp`, candidates)
reportCoverCdnFailure(`${cn}/covers/a.webp`, candidates)
reportCoverCdnFailure(`${cn}/covers/b.webp`, candidates)
assert.equal(selectedCoverCdn(candidates, main), cn, '两张不同的图失败还不切')
reportCoverCdnFailure(`${cn}/covers/c.webp`, candidates)
assert.equal(selectedCoverCdn(candidates, main), main, '三张不同的图失败切到主域')
await new Promise((resolve) => setTimeout(resolve, 5))
assert.equal(changes, 2, '切换时通知封面重算')
// 两边都坏：不再来回切
for (const k of ['a', 'b', 'c']) reportCoverCdnFailure(`${main}/covers/${k}.webp`, candidates)
assert.equal(selectedCoverCdn(candidates, main), cn, '两边都坏时留在原测速结果')

// 边缘提示
assert.equal(coverCdnHint({ cnSite: true, country: 'US' }), 'cn')
assert.equal(coverCdnHint({ queryValue: 'cn' }), 'cn')
assert.equal(coverCdnHint({ country: 'US' }), 'main')
assert.equal(coverCdnHint({ country: 'CN' }), '', '大陆访客没带改写参数时不能渲染成 cn（会污染共用缓存）')
assert.equal(coverCdnHint({ country: 'XX' }), '')
assert.equal(coverCdnHint({}), '')
assert.deepEqual(stripCoverCdnQuery('/de/games/x?__cdn=cn'), { url: '/de/games/x', value: 'cn' })
assert.deepEqual(stripCoverCdnQuery('/games?page=2&__cdn=cn'), { url: '/games?page=2', value: 'cn' })
assert.deepEqual(stripCoverCdnQuery('/games?&__cdn=cn'), { url: '/games', value: 'cn' })
assert.deepEqual(stripCoverCdnQuery('/games?page=2'), { url: '/games?page=2', value: '' })
assert.deepEqual(stripCoverCdnQuery('/games'), { url: '/games', value: '' })
assert.deepEqual(stripCoverCdnQuery('/games?__cdn=%E0%A4'), { url: '/games', value: '' }, '坏的百分号编码不能让中间件抛错')

// 兜底页「改用主站资源重新载入」的参数（2026-11-16 诊断包 #761）：和 __cdn 一起剥，顺序无关
assert.equal(ASSETS_ORIGIN_QUERY, '__assets')
assert.deepEqual(stripQueryParam('/games/x?__assets=origin&__cdn=cn', ASSETS_ORIGIN_QUERY), { url: '/games/x?__cdn=cn', value: 'origin' })
assert.deepEqual(stripQueryParam('/games?page=2&__assets=origin', ASSETS_ORIGIN_QUERY), { url: '/games?page=2', value: 'origin' })
assert.deepEqual(stripQueryParam('/games?page=2', ASSETS_ORIGIN_QUERY), { url: '/games?page=2', value: '' })

// 接线：参数在 normalizeUrl 之前剥掉，SSR 写 meta，客户端读同一个 meta
const index = readFileSync(new URL('../server/src/index.js', import.meta.url), 'utf8')
assert.ok(index.indexOf('stripCoverCdnQuery(req.url)') < index.indexOf('app.use(normalizeUrl)'), '__cdn 必须在 normalizeUrl 之前剥掉')
assert.ok(index.indexOf('stripQueryParam(req.url, ASSETS_ORIGIN_QUERY)') < index.indexOf('app.use(normalizeUrl)'), '__assets 必须在 normalizeUrl 之前剥掉')
const ssr = readFileSync(new URL('../server/src/ssr.js', import.meta.url), 'utf8')
assert.match(ssr, /coverCdnHint\(\{[\s\S]*?queryValue: req\.coverCdnQuery/)
assert.match(ssr, /if \(coverHint === 'cn' && !cnSite && !req\.assetsFromOrigin\) page = retargetStaticToCnEdge\(/, '带 __assets=origin 的这次不改写到 EdgeOne')
assert.match(ssr, /COVER_CDN_META/)
// 边缘路由（public/edge-route-v4.js）在 <head> 里同步读 <html data-8bitgo-cdn>：meta 在 </head> 前，那时还没解析到
assert.match(ssr, /if \(coverHint\) page = page\.replace\(\/<html\\b\/, `<html data-8bitgo-cdn="\$\{coverHint\}"`\)/)
const edgeRoute = readFileSync(new URL('../public/edge-route-v4.js', import.meta.url), 'utf8')
assert.match(edgeRoute, /var HINT_ATTR = 'data-8bitgo-cdn'/)
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
assert.match(indexHtml, /<script src="\/edge-route-v4\.js"><\/script>/)
assert.ok(indexHtml.indexOf('<html') < indexHtml.indexOf('edge-route-v4.js'), '<html> 上的属性在路由脚本运行前就已解析')
const cnHost = readFileSync(new URL('../src/services/cnHost.ts', import.meta.url), 'utf8')
assert.match(cnHost, /meta\[name="\$\{COVER_CDN_META\}"\]/)

console.log('✅ 封面 CDN：边缘决策、测速兜底、故障切换、缓存复用和 URL 体积约束通过')
