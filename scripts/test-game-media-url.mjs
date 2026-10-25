import assert from 'node:assert/strict'
import { coverSrcSet, gameMediaUrl } from '../src/services/roms.ts'

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
  `${base}/cdn-cgi/image/width=240,quality=80,format=auto,fit=scale-down/covers/kof%2097.webp 240w, ` +
    `${base}/cdn-cgi/image/width=480,quality=80,format=auto,fit=scale-down/covers/kof%2097.webp 480w`,
)
assert.equal(coverSrcSet(`${base}/covers/kof.webp`, ''), '')
assert.equal(coverSrcSet('/api/games/kof/media/cover?v=1', base), '')
assert.equal(coverSrcSet(`${base}/logos/kof.png`, base), '')
assert.equal(coverSrcSet('http://localhost:8787/covers/kof.webp', 'http://localhost:8787'), '')
// 构建期开关没开（测试环境就是这样）时默认不改写
assert.equal(coverSrcSet(`${base}/covers/kof.webp`), '')

console.log('game media URL tests passed')
