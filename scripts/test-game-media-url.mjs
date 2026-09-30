import assert from 'node:assert/strict'
import { gameMediaUrl } from '../src/services/roms.ts'

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

console.log('game media URL tests passed')
