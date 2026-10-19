/*
 * 从获授权的 Funkin 源码组装 Cloudflare Pages Direct Upload 目录。游戏资源不进主仓库；这里保留
 * 可复现的映射与校验，避免临时手工复制漏掉字体、把 OGG 重复包进去，或误把 43MB 视频塞进 Pages。
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const STREAM_VERSION = 'v0.8.6-ee9d492-stream9'
const MAX_PAGES_FILE = 25 * 1024 * 1024
const WEB_TITLE_ATTRACT_DELAY_SECONDS = 300
const ASSET_LIBRARIES = ['songs', 'shared', 'videos', 'tutorial', 'week1', 'week2', 'week3', 'week4', 'week5', 'week6', 'week7', 'weekend1', 'sserafim']
const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')

function args(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) continue
    result[value.slice(2)] = argv[index + 1]
    index += 1
  }
  return result
}

const options = args(process.argv.slice(2))
for (const required of ['source', 'main-js', 'flixel-zip', 'flixel-addons-zip', 'out']) {
  if (!options[required]) throw new Error(`缺少 --${required}`)
}

const source = resolve(options.source)
const mainJs = resolve(options['main-js'])
const flixelZip = resolve(options['flixel-zip'])
const flixelAddonsZip = resolve(options['flixel-addons-zip'])
const output = resolve(options.out)
for (const path of [source, mainJs, flixelZip, flixelAddonsZip]) {
  if (!existsSync(path)) throw new Error(`输入不存在：${path}`)
}

const excludedEditorDirs = new Set([
  'data/ui/animation-editor',
  'data/ui/chart-editor',
  'data/ui/stage-editor',
])

function excluded(rel) {
  const normalized = rel.split(sep).join('/')
  const segments = normalized.split('/')
  const name = segments.at(-1) || ''
  if (segments.some((part) => part.startsWith('.'))) return true
  if (segments.some((part) => part.toLowerCase() === 'cvs')) return true
  if (/^(?:thumbs\.db|desktop\.ini)$/i.test(name)) return true
  if (/\.(?:hash|md|ogg)$/i.test(name)) return true
  // Pages 单文件上限是 25MiB；这一份宣传片由 _worker.js 保留 Range 头代理到版本化 R2 对象。
  if (normalized === 'videos/mobileRelease.mp4') return true
  return [...excludedEditorDirs].some((dir) => normalized === dir || normalized.startsWith(`${dir}/`))
}

function copyTree(from, to) {
  const visit = (dir, root) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name)
      const rel = relative(root, path)
      if (excluded(rel)) continue
      const target = resolve(to, rel)
      if (entry.isDirectory()) {
        mkdirSync(target, { recursive: true })
        visit(path, root)
      } else if (entry.isFile()) {
        mkdirSync(dirname(target), { recursive: true })
        copyFileSync(path, target)
      }
    }
  }
  mkdirSync(to, { recursive: true })
  visit(from, from)
}

function unzipFile(archive, member, target) {
  mkdirSync(dirname(target), { recursive: true })
  const bytes = execFileSync('unzip', ['-p', archive, member], { maxBuffer: 2 * 1024 * 1024 })
  writeFileSync(target, bytes)
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function patchMainProgram(path) {
  const original = readFileSync(path, 'utf8')
  const needle = 'funkin_util_Constants.TITLE_ATTRACT_DELAY = 37.5;'
  const matches = original.split(needle).length - 1
  if (matches !== 1) {
    throw new Error(`Funkin.js 的闲置演示常量命中 ${matches} 次；上游代码可能已变化，请重新取证`)
  }
  /*
   * Pages 冷启动要先建立流式缓存并装载基础资源，原版 37.5 秒会在玩家尚未拿到控制权时
   * 自动切到宣传视频，看起来就像一直卡在加载页。网页端保留演示能力，但给足 5 分钟操作时间。
   */
  let patched = original.replace(
    needle,
    `funkin_util_Constants.TITLE_ATTRACT_DELAY = ${WEB_TITLE_ATTRACT_DELAY_SECONDS};`,
  )
  /*
   * 旧 Service Worker 接管中的页面可能先于新版激活就下载外置清单。给清单 URL 加版本参数，
   * 旧缓存也会因为完整请求 URL 不同而回源；修补范围必须与本次发布的全部资源库一一对应。
   */
  const libraryNames = [...patched.matchAll(/ManifestResources\.rootPath \+ "manifest\/([a-z0-9-]+)\.json"/g)]
    .map((match) => match[1])
  const expectedLibraries = [...ASSET_LIBRARIES, 'art'].sort()
  if (JSON.stringify(libraryNames.sort()) !== JSON.stringify(expectedLibraries)) {
    throw new Error(`Funkin.js 外置资源库清单发生变化：${libraryNames.join(', ')}`)
  }
  patched = patched.replace(
    /ManifestResources\.rootPath \+ "manifest\/([a-z0-9-]+)\.json"/g,
    (_, name) => `ManifestResources.rootPath + "manifest/${name}.json?v=${encodeURIComponent(STREAM_VERSION)}"`,
  )
  /*
   * Lime 遇到资源下载错误会拒绝整个库的 Future，而游戏只监听 onComplete，玩家因此只看到
   * 永远不消失的加载图。记录每个库的开始、完成和失败，便于精确找出卡住的分包或资源。
   */
  const libraryLoader = 'funkin_Assets.loadLibrary(library).onComplete(function(_) {\n\t\t\t\tif(callback != null) {\n\t\t\t\t\tcallback();\n\t\t\t\t}\n\t\t\t});'
  if (patched.split(libraryLoader).length !== 2) {
    throw new Error('LoadingState 库加载回调结构已变化，请重新取证')
  }
  patched = patched.replace(libraryLoader,
    'console.info("[funkin-loading] library start", library);\n\t\t\tfunkin_Assets.loadLibrary(library).onComplete(function(_) {\n\t\t\t\tconsole.info("[funkin-loading] library complete", library);\n\t\t\t\tif(callback != null) {\n\t\t\t\t\tcallback();\n\t\t\t\t}\n\t\t\t}).onError(function(error) {\n\t\t\t\tconsole.error("[funkin-loading] library error", library, error);\n\t\t\t});')
  const assetFailure = '\t,load_onError: function(id,message) {\n\t\tif(message != null && message != "") {'
  if (patched.split(assetFailure).length !== 2) {
    throw new Error('Lime 资源错误回调结构已变化，请重新取证')
  }
  patched = patched.replace(assetFailure,
    '\t,load_onError: function(id,message) {\n\t\tconsole.error("[funkin-loading] asset error", id, message);\n\t\tif(message != null && message != "") {')
  writeFileSync(path, patched)
}

function assetType(path) {
  const extension = path.split('.').at(-1)?.toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(extension)) return 'IMAGE'
  if (['ttf', 'otf'].includes(extension)) return 'FONT'
  if (['json', 'xml', 'txt', 'srt', 'fnt', 'frag', 'vert', 'hx'].includes(extension)) return 'TEXT'
  if (['mp3', 'wav'].includes(extension)) return 'MUSIC'
  return 'BINARY'
}

function filesUnder(dir) {
  const files = []
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  visit(dir)
  return files.sort()
}

function writeLibraryManifest(name, paths) {
  const assets = paths.map((path) => {
    const id = relative(output, path).split(sep).join('/')
    const type = assetType(id)
    const asset = {
      size: statSync(path).size,
      type,
      id,
      /*
       * Lime 的外置资源库只会在 loadLibrary() 时装载 preload=true 的条目。图片和图集索引若不
       * 预载，PlayState 随后的同步 getSparrowAtlas() 只能拿到 null，歌曲会永久卡在加载页。
       * 共享/关卡音效也存在同步读取链路，必须随库装载；只有 songs 主音乐与视频保持惰性读取，
       * 否则点一首歌就会下载整个 404MB 曲库，流式加载失去意义。
       */
      preload: type !== 'BINARY' && !(name === 'songs' && type === 'MUSIC'),
    }
    // Web 版每种音频只保留 MP3；pathGroup 仍是 Lime 识别可选音频源的标准字段。
    if (type === 'MUSIC') asset.pathGroup = [id]
    else asset.path = id
    return asset
  })
  const manifest = {
    name,
    assets,
    rootPath: '..',
    version: 3,
    libraryArgs: [],
    libraryType: null,
  }
  mkdirSync(resolve(output, 'manifest'), { recursive: true })
  writeFileSync(resolve(output, 'manifest', `${name}.json`), `${JSON.stringify(manifest)}\n`)
}

function renderTemplate(name, replacements) {
  let content = readFileSync(resolve(repo, 'deploy/cloudflare-pages/funkin', name), 'utf8')
  for (const [before, after] of Object.entries(replacements)) content = content.replaceAll(before, after)
  writeFileSync(resolve(output, name), content)
}

rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })

copyTree(resolve(source, 'assets/preload'), resolve(output, 'assets'))
copyTree(resolve(source, 'assets/fonts'), resolve(output, 'assets/fonts'))
for (const library of ASSET_LIBRARIES) {
  copyTree(resolve(source, 'assets', library), resolve(output, 'assets', library))
}

copyFileSync(mainJs, resolve(output, 'Funkin.js'))
patchMainProgram(resolve(output, 'Funkin.js'))
copyFileSync(resolve(source, 'art/icons/iconOG.png'), resolve(output, 'favicon.png'))
copyFileSync(resolve(source, 'art/readme.txt'), resolve(output, 'do NOT readme.txt'))
copyFileSync(resolve(source, 'LICENSE.md'), resolve(output, 'LICENSE.md'))
copyFileSync(resolve(source, 'CHANGELOG.md'), resolve(output, 'CHANGELOG.md'))

const flixelPrefix = execFileSync('unzip', ['-Z1', flixelZip], { encoding: 'utf8' })
  .split(/\r?\n/)
  .find((name) => name.endsWith('/assets/fonts/nokiafc22.ttf'))
  ?.replace(/assets\/fonts\/nokiafc22\.ttf$/, '')
if (!flixelPrefix) throw new Error('flixel zip 里找不到 assets/fonts/nokiafc22.ttf')
for (const file of [
  'fonts/nokiafc22.ttf',
  'fonts/monsterrat.ttf',
  'sounds/beep.mp3',
  'sounds/flixel.mp3',
  'images/ui/button.png',
  'images/logo/default.png',
]) {
  unzipFile(flixelZip, `${flixelPrefix}assets/${file}`, resolve(output, 'flixel', file))
}

const flixelAddonsPrefix = execFileSync('unzip', ['-Z1', flixelAddonsZip], { encoding: 'utf8' })
  .split(/\r?\n/)
  .find((name) => name.endsWith('/assets/images/transitions/diagonal_gradient.png'))
  ?.replace(/assets\/images\/transitions\/diagonal_gradient\.png$/, '')
if (!flixelAddonsPrefix) throw new Error('flixel-addons zip 里找不到过场动画图片')
for (const name of ['circle.png', 'diagonal_gradient.png', 'diamond.png', 'square.png']) {
  unzipFile(
    flixelAddonsZip,
    `${flixelAddonsPrefix}assets/images/transitions/${name}`,
    resolve(output, 'flixel/images/transitions', name),
  )
}

for (const library of ASSET_LIBRARIES) {
  writeLibraryManifest(library, filesUnder(resolve(output, 'assets', library)))
}
writeLibraryManifest('art', [
  resolve(output, 'do NOT readme.txt'),
  resolve(output, 'LICENSE.md'),
  resolve(output, 'CHANGELOG.md'),
])

mkdirSync(resolve(output, 'html5-api'), { recursive: true })
copyFileSync(resolve(repo, 'public/html5-api/8bitgo-runtime-bridge.js'), resolve(output, 'html5-api/8bitgo-runtime-bridge.js'))

// 主程序经过网页兼容补丁后内容会变化，缓存键必须取最终产物，避免旧访客沿用上一版脚本。
const mainVersion = sha256(resolve(output, 'Funkin.js')).slice(0, 16)
const replacements = {
  '__STREAM_VERSION__': STREAM_VERSION,
  '__MAIN_JS_VERSION__': mainVersion,
}
for (const template of ['index.html', '8bitgo-streaming.js', 'sw.js', '_worker.js']) renderTemplate(template, replacements)

const tutorialMetadata = [
  '/assets/data/levels/tutorial.json',
  '/assets/data/songs/tutorial/tutorial-chart.json',
  '/assets/data/songs/tutorial/tutorial-metadata.json',
]
const tutorialAudio = readdirSync(resolve(output, 'assets/songs/tutorial'))
  .filter((name) => name.toLowerCase().endsWith('.mp3'))
  .sort()
  .map((name) => `/assets/songs/tutorial/${name}`)
writeFileSync(resolve(output, 'funkin-prefetch-manifest.json'), JSON.stringify({
  version: STREAM_VERSION,
  profiles: {
    metadata: tutorialMetadata,
    tutorial: [...tutorialMetadata, ...tutorialAudio],
  },
}, null, 2) + '\n')

writeFileSync(resolve(output, '.8bitgo-pages.json'), JSON.stringify({
  format: '8bitgo.cloudflare-pages.funkin.v2',
  project: '8bitgo-funkin',
  sourceCommit: 'ee9d492becfc1178b2c80487167d09a880f90146',
  assetsCommit: '9300719cb261d23f72344807055be6d109c9949c',
  streamVersion: STREAM_VERSION,
  mainJsSha256: sha256(mainJs),
}, null, 2) + '\n')

const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.isFile()) files.push(path)
  }
}
walk(output)
for (const path of files) {
  const size = statSync(path).size
  if (size > MAX_PAGES_FILE) throw new Error(`${relative(output, path)} 超过 Pages 25MiB：${size}`)
}
const bytes = files.reduce((sum, path) => sum + statSync(path).size, 0)
console.log(`Funkin Pages：${files.length} 个文件，${(bytes / 1024 / 1024).toFixed(1)} MiB → ${output}`)
