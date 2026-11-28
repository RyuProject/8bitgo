import assert from 'node:assert/strict'
import { cnPreviewVideoUrl, coverImageUrl, coverPosterWidth, coverSrcSet, gameMediaUrl } from '../src/services/roms.ts'
import { isCnHost, isCnRequest } from '../shared/cn-host.js'

// 测试运行时没有 Vite 注入的对象存储根地址；站内路径仍足以钉住“不误走代理”。
const local = { slug: 'kof-97', cover: '/covers/kof.webp', video: '/videos/kof.mp4' }
assert.equal(gameMediaUrl(local, 'cover'), '/covers/kof.webp')
assert.equal(gameMediaUrl(local, 'video'), '/videos/kof.mp4')

const remote = {
  slug: '别名/episode',
  cover: 'https://screenshots.flash.homes/cover.webp',
  video: 'https://screenshots.flash.homes/clip.mp4',
}
assert.match(gameMediaUrl(remote, 'cover'), /^\/api\/games\/%E5%88%AB%E5%90%8D%2Fepisode\/media\/cover\?v=[a-z0-9]+$/)
assert.match(gameMediaUrl(remote, 'video'), /^\/api\/games\/%E5%88%AB%E5%90%8D%2Fepisode\/media\/video\?v=[a-z0-9]+$/)
assert.equal(gameMediaUrl({ slug: 'empty' }, 'cover'), '')

// 封面 srcset 只改写本站封面域下的 covers/ 原图；其余一律空串，让 <img> 保持原样。
const base = 'https://image.8bitgo.com'
assert.equal(
  coverSrcSet(`${base}/covers/kof%2097.webp`, base),
  `${base}/cdn-cgi/image/width=160,quality=75,format=auto,fit=scale-down/covers/kof%2097.webp 160w, ` +
    `${base}/cdn-cgi/image/width=240,quality=75,format=auto,fit=scale-down/covers/kof%2097.webp 240w, ` +
    `${base}/cdn-cgi/image/width=320,quality=75,format=auto,fit=scale-down/covers/kof%2097.webp 320w, ` +
    `${base}/cdn-cgi/image/width=480,quality=75,format=auto,fit=scale-down/covers/kof%2097.webp 480w`,
)
assert.equal(coverSrcSet(`${base}/covers/kof.webp`, ''), '')
assert.equal(
  coverSrcSet(`${base}/covers/kof.webp`, base, 'auto', '120px'),
  `${base}/cdn-cgi/image/width=96,quality=75,format=auto,fit=scale-down/covers/kof.webp 96w, ` +
    `${base}/cdn-cgi/image/width=160,quality=75,format=auto,fit=scale-down/covers/kof.webp 160w, ` +
    `${base}/cdn-cgi/image/width=240,quality=75,format=auto,fit=scale-down/covers/kof.webp 240w`,
  'srcset 档位应根据实际卡片宽度自动生成并归并到共享宽度档',
)
assert.equal(
  coverSrcSet(`${base}/covers/kof.webp`, base, 'auto', '(min-width: 1280px) 211px, (min-width: 1024px) 158px, 141px'),
  `${base}/cdn-cgi/image/width=160,quality=75,format=auto,fit=scale-down/covers/kof.webp 160w, ` +
    `${base}/cdn-cgi/image/width=240,quality=75,format=auto,fit=scale-down/covers/kof.webp 240w, ` +
    `${base}/cdn-cgi/image/width=320,quality=75,format=auto,fit=scale-down/covers/kof.webp 320w, ` +
    `${base}/cdn-cgi/image/width=480,quality=75,format=auto,fit=scale-down/covers/kof.webp 480w`,
  '媒体断点值不能混入图宽，卡片实际宽度与 4/3 密度候选决定生成档位',
)
assert.equal(coverPosterWidth('111px'), 240, '视频 poster 应按实际卡片尺寸生成并吸附到不低于目标的共享 2x 宽度')
assert.equal(
  coverSrcSet(`${base}/covers/kof.webp`, base, 'auto', '212px'),
  coverSrcSet(`${base}/covers/kof.webp`, base, 'auto', '211px'),
  '相邻卡片尺寸应复用同一组 Cloudflare 变换档位',
)
assert.equal(
  coverSrcSet(`${base}/covers/kof.webp`, base, 'auto', '288px'),
  `${base}/cdn-cgi/image/width=240,quality=75,format=auto,fit=scale-down/covers/kof.webp 240w, ` +
    `${base}/cdn-cgi/image/width=320,quality=75,format=auto,fit=scale-down/covers/kof.webp 320w, ` +
    `${base}/cdn-cgi/image/width=480,quality=75,format=auto,fit=scale-down/covers/kof.webp 480w`,
  '首页最大宽卡的候选封顶在 480px，避免为低分辨率源图生成无收益的大档',
)
assert.equal(coverPosterWidth('auto, 100vw'), 480, '无法解析的布局提示应使用安全的卡片宽度回退')
assert.equal(
  coverImageUrl(`${base}/covers/super-mario-bros-96.jpg`, 96, base, 'auto'),
  `${base}/cdn-cgi/image/width=96,quality=75,format=auto,fit=scale-down/covers/super-mario-bros-96.jpg`,
  '96px 缩略图即使回退到大图对象也必须保持缩放',
)
const avif = `${base}/covers/the-king-of-fighters-2000.avif`
assert.equal(coverSrcSet(avif, base), '', 'Cloudflare 不接受 AVIF 源图变换（HTTP 415），不发出必失败的 srcset')
assert.equal(coverImageUrl(avif, 480, base, 'auto'), avif, 'AVIF video poster 直接复用已压缩源图')
assert.equal(coverSrcSet('/api/games/kof/media/cover?v=1', base), '')
assert.equal(coverSrcSet(`${base}/logos/kof.png`, base), '')
assert.equal(coverSrcSet('http://localhost:8787/covers/kof.webp', 'http://localhost:8787'), '')
// 构建期开关没开（测试环境就是这样）时默认不改写
assert.equal(coverSrcSet(`${base}/covers/kof.webp`), '')

// 大陆入口的封面域是 EdgeOne：缓存键不看 Accept，必须固定 webp，不能 format=auto
const cnBase = 'https://image-cn.8bitgo.com'
assert.equal(
  coverSrcSet(`${cnBase}/covers/kof.webp`, cnBase, 'webp'),
  `${cnBase}/cdn-cgi/image/width=160,quality=75,format=webp,fit=scale-down/covers/kof.webp 160w, ` +
    `${cnBase}/cdn-cgi/image/width=240,quality=75,format=webp,fit=scale-down/covers/kof.webp 240w, ` +
    `${cnBase}/cdn-cgi/image/width=320,quality=75,format=webp,fit=scale-down/covers/kof.webp 320w, ` +
    `${cnBase}/cdn-cgi/image/width=480,quality=75,format=webp,fit=scale-down/covers/kof.webp 480w`,
)

// 只认 cn.<站点域名>；服务端看不到这个 Host，只认 nginx 校验过 EdgeOne 密钥后补的标记头
assert.equal(isCnHost('cn.8bitgo.com', '8bitgo.com'), true)
assert.equal(isCnHost('CN.8bitgo.com', '8bitgo.com'), true)
assert.equal(isCnHost('8bitgo.com', '8bitgo.com'), false)
assert.equal(isCnHost('cn.evil.com', '8bitgo.com'), false)
assert.equal(isCnHost('cn.8bitgo.com', ''), false)
assert.equal(isCnRequest({ hostname: '8bitgo.com', siteHostname: '8bitgo.com', siteHeader: 'cn' }), true)
assert.equal(isCnRequest({ hostname: '8bitgo.com', siteHostname: '8bitgo.com', siteHeader: '' }), false)
assert.equal(isCnRequest({ hostname: '8bitgo.com', siteHostname: '8bitgo.com', siteHeader: 'tv' }), false)

// 大陆访客的预览视频走 cn-assets；其它访客、站内路径、外链、没配镜像一律不改
const mirror = 'https://cn-assets.8bitgo.com'
assert.equal(cnPreviewVideoUrl('videos/kof 97.mp4', 'cn', mirror), `${mirror}/videos/kof%2097.mp4`)
assert.equal(cnPreviewVideoUrl('videos/kof.mp4', 'main', mirror), '')
assert.equal(cnPreviewVideoUrl('videos/kof.mp4', '', mirror), '')
assert.equal(cnPreviewVideoUrl('videos/kof.mp4', 'cn', ''), '')
assert.equal(cnPreviewVideoUrl('/videos/kof.mp4', 'cn', mirror), '')
assert.equal(cnPreviewVideoUrl('https://x.test/clip.mp4', 'cn', mirror), '')

console.log('game media URL tests passed')
