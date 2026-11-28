import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const cover = read('src/components/game/GameCover.tsx')
const gameCard = read('src/components/game/GameCard.tsx')
const detailSections = read('src/components/game/GameDetailSections.tsx')
const collectionCard = read('src/components/game/CollectionCard.tsx')
const collectionsPage = read('src/pages/CollectionsPage.tsx')
const gamesPage = read('src/pages/GamesPage.tsx')
const collectionPage = read('src/pages/CollectionPage.tsx')

assert.match(cover, /const coverSizes = sizes \|\| \(thumb \? '96px' : ''\)/,
  '封面缩略图要使用 96px 目标尺寸，已知卡片尺寸由调用方优先指定')
assert.match(cover, /sizes=\{srcSet \? coverSizes \|\| \(priority \|\| eager \? '100vw' : 'auto, 100vw'\) : undefined\}/,
  '响应式图片优先使用实际尺寸，否则保留按优先级选择的默认尺寸')
assert.match(cover, /sizes=\{srcSet && !sourceMedia \? coverSizes \|\| \(priority \|\| eager \? '100vw' : 'auto, 100vw'\) : undefined\}/,
  'picture 的主图与 source 必须使用同一组尺寸策略')
assert.equal((cover.match(/decoding=\{priority \? 'sync' : 'async'\}/g) ?? []).length, 2,
  '首屏图和视频海报都优先解码，避免 LCP 画面等图片解码')
assert.match(cover, /deferMedia\?: boolean/)
assert.match(cover, /const mediaDeferred = deferMedia && !mediaVisible/)
assert.match(cover, /videoSrc && !mediaDeferred/)
assert.match(cover, /coverSrc && !coverFailed && !mediaDeferred/)
assert.match(cover, /!mediaDeferred && priority && videoSrc && coverSrc/)
assert.match(cover, /posterSrcSet = videoSrc && coverSrc/)
assert.match(cover, /const activePosterSrcSet = posterSrc === poster \? posterSrcSet : ''/)
assert.match(cover, /srcSet=\{activePosterSrcSet \|\| undefined\}/)
assert.match(cover, /sizes=\{activePosterSrcSet \? posterSizes : undefined\}/)
assert.match(cover, /imageSrcSet: posterSrcSet, imageSizes: posterSizes/)
assert.match(gameCard, /GAME_CARD_IMAGE_SIZES = '240px'/)
assert.match(gameCard, /eager=\{eager\}/)
assert.match(gameCard, /priority=\{priority\}/)
assert.match(gameCard, /deferMedia=\{deferCover\}/)
assert.match(
  gameCard,
  /sizes=\{coverSizes \?\? \(priority \? GAME_CARD_IMAGE_SIZES : undefined\)\}/,
  '优先封面使用 240px 目标尺寸，调用方传入的真实尺寸仍优先',
)
assert.match(detailSections, /new IntersectionObserver\(\(\[entry\]\) => \{[\s\S]*?setCoversReady\(true\)[\s\S]*?\}\)/)
assert.match(detailSections, /GameCard key=\{g\.slug\} game=\{g\} showCoin=\{false\} deferCover=\{!coversReady\}/)
assert.match(gamesPage, /coverSizes=\{GAME_CARD_IMAGE_SIZES\}/)
assert.match(collectionPage, /coverSizes=\{GAME_CARD_IMAGE_SIZES\}/)
assert.match(collectionsPage, /eager=\{i < 4\} priority=\{i === 0\}/)
assert.match(read('src/components/home/sections.tsx'), /priority=\{i === 0\} eager=\{i === 1\} deferCover=\{i >= 2\}/)
assert.doesNotMatch(read('src/components/home/sections.tsx'), /GameCardWide key=\{g\.slug\} game=\{g\} isNew=\{i < 3\} priority=\{i === 0\}/)
assert.match(collectionCard, /priority=\{priority && i === 0\}/)
assert.match(collectionCard, /eager=\{\(eager && !incoming\) \|\| swapped\}/)
assert.match(collectionCard, /sizes="120px"/)

console.log('✅ 游戏列表和合集封面按真实展示尺寸加载，详情页相关推荐仅在进入视口后请求媒体')
