import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const index = process.argv.indexOf('--dir')
if (index < 0 || !process.argv[index + 1]) throw new Error('用法：node scripts/check-funkin-pages.mjs --dir <目录>')
const root = resolve(process.argv[index + 1])
const libraries = ['songs', 'shared', 'videos', 'tutorial', 'week1', 'week2', 'week3', 'week4', 'week5', 'week6', 'week7', 'weekend1', 'sserafim', 'art']
const required = [
  'index.html',
  'Funkin.js',
  '8bitgo-streaming.js',
  'sw.js',
  '_worker.js',
  'funkin-prefetch-manifest.json',
  ...libraries.map((name) => `manifest/${name}.json`),
  'flixel/images/ui/button.png',
  'flixel/images/logo/default.png',
  'flixel/images/transitions/circle.png',
  'flixel/images/transitions/diagonal_gradient.png',
  'flixel/images/transitions/diamond.png',
  'flixel/images/transitions/square.png',
]
for (const name of required) {
  if (!existsSync(resolve(root, name))) throw new Error(`缺少 ${name}`)
}

const html = readFileSync(resolve(root, 'index.html'), 'utf8')
const loader = readFileSync(resolve(root, '8bitgo-streaming.js'), 'utf8')
const sw = readFileSync(resolve(root, 'sw.js'), 'utf8')
const worker = readFileSync(resolve(root, '_worker.js'), 'utf8')
const main = readFileSync(resolve(root, 'Funkin.js'), 'utf8')
const manifest = JSON.parse(readFileSync(resolve(root, 'funkin-prefetch-manifest.json'), 'utf8'))

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

assert(!html.includes('__STREAM_VERSION__') && !html.includes('__MAIN_JS_VERSION__'), '入口仍含未替换的版本占位符')
assert(!loader.includes('__STREAM_VERSION__') && !loader.includes('__MAIN_JS_VERSION__'), '流式脚本仍含未替换的版本占位符')
const mainHash = createHash('sha256').update(readFileSync(resolve(root, 'Funkin.js'))).digest('hex').slice(0, 16)
assert(loader.includes(`./Funkin.js?v=${mainHash}`), '主程序缓存指纹不是最终修补产物的哈希')
assert(!html.includes('<script src="./Funkin.js'), 'Funkin.js 必须等流式缓存接管后再动态加载')
assert(loader.includes("document.createElement('script')") && loader.includes('window.__8bitgoFunkinReady'), '缺少主程序动态加载门闩')
assert(loader.includes('const startupGate = new Promise') && loader.includes('startupBypass'), '缓存接管失败时必须按预算降级启动')
assert(loader.includes("connection?.saveData") && loader.includes("effectiveType === '2g'"), '缺少省流量/慢网降级')
assert(sw.includes("request.headers.has('Range')"), 'Range 请求必须绕开 Cache Storage')
assert(sw.includes('response.clone()') && sw.includes('inflight'), '缺少流式旁路缓存或并发请求合并')
assert(sw.includes('MAX_CACHEABLE_BYTES'), '缺少单文件缓存上限')
assert(sw.includes("url.pathname.startsWith('/manifest/')"), '游戏分包清单没有进入按需缓存')
assert(worker.includes("request.headers") || worker.includes('new Request(PROMO_VIDEO, request)'), '视频代理没有保留 Range 请求头')
assert(worker.includes('Accept-Ranges'), '视频代理缺少 Accept-Ranges')
assert(main.includes('willReadFrequently'), 'Funkin.js 尚未包含 Canvas 频繁读回优化')
assert(main.includes('funkin_util_Constants.TITLE_ATTRACT_DELAY = 300;'), '网页端闲置演示仍会抢在冷启动后自动播放')
assert(!main.includes('funkin_util_Constants.TITLE_ATTRACT_DELAY = 37.5;'), '原版 37.5 秒闲置演示延迟仍在产物中')
assert(main.includes('[funkin-loading] library error') && main.includes('[funkin-loading] asset error'), '歌曲分包失败缺少可定位的错误日志')
assert(!existsSync(resolve(root, 'assets/videos/videos/mobileRelease.mp4')), '43.6MB 宣传视频不能进入 Pages 静态目录')

for (const name of libraries) {
  assert(main.includes(`ManifestResources.rootPath + "manifest/${name}.json?v=${manifest.version}"`), `${name} 分包清单缺少版本化 URL`)
  const library = JSON.parse(readFileSync(resolve(root, 'manifest', `${name}.json`), 'utf8'))
  assert(library.version === 3 && Array.isArray(library.assets), `${name} 资源清单格式不正确`)
  assert(library.rootPath === '..', `${name} 资源清单必须从 manifest/ 返回站点根目录`)
  assert(library.assets.length > 0, `${name} 资源清单为空`)
  for (const asset of library.assets) {
    const paths = asset.pathGroup || [asset.path]
    assert(asset.id && paths.every(Boolean), `${name} 资源清单存在无路径条目`)
    for (const path of paths) assert(existsSync(resolve(root, path)), `${name} 资源文件不存在：${path}`)
    const synchronous = asset.type !== 'BINARY' && !(name === 'songs' && asset.type === 'MUSIC')
    assert(asset.preload === synchronous, `${name} 资源 preload 策略错误：${asset.id}`)
  }
}

const shared = JSON.parse(readFileSync(resolve(root, 'manifest/shared.json'), 'utf8'))
for (const id of [
  'assets/shared/images/notes.png',
  'assets/shared/images/notes.xml',
  'assets/shared/images/noteStrumline.png',
  'assets/shared/images/noteStrumline.xml',
]) {
  const asset = shared.assets.find((entry) => entry.id === id)
  assert(asset?.preload === true, `歌曲开局必需的音符图集没有预载：${id}`)
}
for (const id of [
  'assets/shared/sounds/gameplay/countdown/funkin/introTHREE.mp3',
  'assets/shared/sounds/gameplay/countdown/funkin/introTWO.mp3',
  'assets/shared/sounds/gameplay/countdown/funkin/introONE.mp3',
  'assets/shared/sounds/gameplay/countdown/funkin/introGO.mp3',
]) {
  const asset = shared.assets.find((entry) => entry.id === id)
  assert(asset?.preload === true, `歌曲开局必需的倒计时音效没有预载：${id}`)
}

for (const profile of Object.values(manifest.profiles || {})) {
  for (const url of profile) {
    assert(url.startsWith('/'), `预热 URL 不是站内绝对路径：${url}`)
    assert(existsSync(resolve(root, url.slice(1))), `预热文件不存在：${url}`)
  }
}

const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.isFile()) files.push(path)
  }
}
walk(root)
assert(files.length <= 20_000, `Pages 文件数超限：${files.length}`)
for (const path of files) {
  assert(statSync(path).size <= 25 * 1024 * 1024, `Pages 单文件超限：${relative(root, path)}`)
}

console.log(`Funkin 流式体检通过：${files.length} 个文件，${manifest.profiles.tutorial.length} 个教学曲预热资源`)
