import assert from 'node:assert/strict'
import { createSlugSubscriptions } from '../src/services/gameCacheSubscriptions.ts'

const subscriptions = createSlugSubscriptions()
let firstCalls = 0
let secondCalls = 0
let emptyCalls = 0

const unsubscribeFirst = subscriptions.subscribe(['game-a', 'game-b', 'game-a'], () => firstCalls++)
subscriptions.subscribe(['game-c'], () => secondCalls++)
subscriptions.subscribe([], () => emptyCalls++)

subscriptions.notify(['game-a', 'game-b', 'unrelated'])
assert.equal(firstCalls, 1, '同一批命中多个订阅 slug 时，一个订阅者只通知一次')
assert.equal(secondCalls, 0, '不同游戏的订阅者不应被无关缓存更新叫醒')
assert.equal(emptyCalls, 0, '空查询不应收到缓存通知')

unsubscribeFirst()
subscriptions.notify(['game-a'])
assert.equal(firstCalls, 1, '卸载后必须移除 slug 订阅')

subscriptions.notify(['game-c'])
assert.equal(secondCalls, 1, '命中订阅的游戏仍会通知对应组件')

console.log('✅ 游戏缓存只通知命中 slug 的订阅者，且重复命中只触发一次')
