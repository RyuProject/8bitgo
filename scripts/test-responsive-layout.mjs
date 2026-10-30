import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const css = read('src/index.css')
const layout = read('src/components/layout/Layout.tsx')

assert.match(layout, /<main className="site-main flex-1">/, '主要内容区必须定义尺寸容器，断点才能避开侧栏误判')
assert.match(css, /\.site-main\s*\{[^}]*container-name:\s*page-content;[^}]*container-type:\s*inline-size;/s)
assert.match(css, /\.site-main\s*\{[^}]*min-width:\s*0;/s, 'flex 内容区必须允许收缩，防止长内容撑出横向滚动')

for (const breakpoint of ['36rem', '56rem', '72rem', '90rem']) {
  assert.match(css, new RegExp(`@container page-content \\(min-width: ${breakpoint}\\)`), `缺少 ${breakpoint} 容器断点`)
}

const skeleton = read('src/components/ui/PageSkeleton.tsx')
assert.match(skeleton, /className = 'adaptive-game-grid'/, '通用游戏骨架默认使用自适应网格')
assert.match(skeleton, /className="mt-8 adaptive-game-grid"/, '路由级占位必须与游戏列表共用列数')

const pairedGrids = [
  ['src/pages/GamesPage.tsx', 'adaptive-game-grid', 2],
  ['src/pages/CollectionPage.tsx', 'adaptive-game-grid', 2],
  ['src/pages/RoomsPage.tsx', 'adaptive-game-grid', 2],
  ['src/pages/CollectionsPage.tsx', 'adaptive-entity-grid', 2],
  ['src/pages/AppsPage.tsx', 'adaptive-app-grid', 2],
  ['src/pages/BlogPage.tsx', 'adaptive-blog-grid', 2],
  ['src/components/profile/MyCollections.tsx', 'adaptive-entity-grid', 2],
]

for (const [path, className, expectedUses] of pairedGrids) {
  const source = read(path)
  const count = source.split(className).length - 1
  assert.ok(count >= expectedUses, `${path} 的骨架和真实内容没有共用 ${className} 网格`)
}

assert.match(read('src/pages/RoomsPage.tsx'), /<ul className="adaptive-room-grid">/, '房间卡片需要按内容宽度自适应')
assert.match(css, /\.adaptive-room-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s)

console.log('✅ 内容区、卡片网格与加载骨架使用统一的自适应布局规则')
