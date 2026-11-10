import assert from 'node:assert/strict'
import { clearPageDataCache, getPageDataCache, peekPageDataCache, setPageDataCache } from '../src/services/pageDataCache.ts'

clearPageDataCache()
setPageDataCache('/api/page?path=/', { route: 'home' }, 1_000)
assert.deepEqual(getPageDataCache('/api/page?path=/', 20_999), { route: 'home' }, '有效期内命中')
assert.equal(getPageDataCache('/api/page?path=/', 21_000), null, '过期内容不复用')

clearPageDataCache()
for (let i = 0; i < 24; i++) setPageDataCache(`/page/${i}`, i, 1_000)
assert.equal(peekPageDataCache('/page/0', 1_001), 0)
setPageDataCache('/page/new-after-peek', 'new', 1_002)
assert.equal(peekPageDataCache('/page/0', 1_003), null, '渲染期只读查询不改变淘汰顺序')

clearPageDataCache()
for (let i = 0; i < 24; i++) setPageDataCache(`/page/${i}`, i, 1_000)
// 访问最早的一项会把它提升到 LRU 队尾。
assert.equal(getPageDataCache('/page/0', 1_001), 0)
setPageDataCache('/page/new', 'new', 1_002)
assert.equal(getPageDataCache('/page/0', 1_003), 0, '最近使用的条目保留')
assert.equal(getPageDataCache('/page/1', 1_003), null, '最久未使用条目被淘汰')
assert.equal(getPageDataCache('/page/new', 1_003), 'new')

clearPageDataCache()
assert.equal(getPageDataCache('/page/new', 1_003), null, '缓存可整体清空')
console.log('page data memory cache: ok')
