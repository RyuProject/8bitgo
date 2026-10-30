import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const cover = read('src/components/game/GameCover.tsx')
const gameCard = read('src/components/game/GameCard.tsx')
const collectionCard = read('src/components/game/CollectionCard.tsx')
const collectionsPage = read('src/pages/CollectionsPage.tsx')
const gamesPage = read('src/pages/GamesPage.tsx')
const collectionPage = read('src/pages/CollectionPage.tsx')

assert.match(cover, /sizes=\{srcSet \? sizes \|\| \(priority \|\| eager \? '100vw' : 'auto, 100vw'\) : undefined\}/)
assert.match(gameCard, /GAME_CARD_IMAGE_SIZES = '240px'/)
assert.match(gameCard, /eager=\{eager\} sizes=\{coverSizes\}/)
assert.match(gamesPage, /coverSizes=\{GAME_CARD_IMAGE_SIZES\}/)
assert.match(collectionPage, /coverSizes=\{GAME_CARD_IMAGE_SIZES\}/)
assert.match(collectionsPage, /eager=\{i < 4\} priority=\{i === 0\}/)
assert.match(collectionCard, /priority=\{priority && i === 0\}/)
assert.match(collectionCard, /eager=\{\(eager && !incoming\) \|\| swapped\}/)
assert.match(collectionCard, /sizes="120px"/)

console.log('✅ 游戏列表和合集封面按真实展示尺寸加载，首屏合集只提升一格网络优先级')
