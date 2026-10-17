/**
 * 游戏联机配置的一致性回归。
 *
 * 线上《超级马力欧兄弟》出现过 multiplayer=1、players=1：前端承诺可开房，
 * 服务端却必然拒绝。这里同时盯共享判定、API 降级、开房鉴权、列表筛选和数据修复，
 * 防止以后某一层又只看其中一列。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gameSupportsNetplay } from '../shared/netplay-players.js'
import { gameRowToApi } from '../server/src/mappers.js'

assert.equal(gameSupportsNetplay(1, 1), false, '一人脏数据不能被当成可联机')
assert.equal(gameSupportsNetplay(true, 2), true, '明确开启的双人游戏应允许联机')
assert.equal(gameSupportsNetplay(0, 4), false, '人数够但后台关闭联机时仍应拒绝')

assert.equal(gameRowToApi({ slug: 'broken', multiplayer: 1, players: 1 }).multiplayer, false)
assert.equal(gameRowToApi({ slug: 'ready', multiplayer: 1, players: 2 }).multiplayer, true)

const policy = readFileSync(new URL('../server/src/netplay-game-policy.js', import.meta.url), 'utf8')
assert.match(policy, /SELECT slug, players, multiplayer, hidden/)
assert.match(policy, /gameSupportsNetplay\(row\.multiplayer, row\.players\)/)

const repo = readFileSync(new URL('../server/src/games-repo.js', import.meta.url), 'utf8')
assert.match(repo, /g\.multiplayer = 1 AND g\.players >= 2/)

const route = readFileSync(new URL('../server/src/routes/games.js', import.meta.url), 'utf8')
assert.match(route, /启用联机时，最大玩家数至少要设置为 2/)
assert.match(route, /netplayGameConfigError\(candidate\)/)

const migration = readFileSync(new URL('../server/scripts/migrate.mjs', import.meta.url), 'utf8')
assert.match(migration, /slug = \? AND multiplayer = 1 AND COALESCE\(players, 0\) < 2/)
assert.match(migration, /UPDATE games SET players = 2 WHERE slug = \? AND multiplayer = 1/)

console.log('✅ 联机标记、玩家人数、后台写入、API 展示、开房鉴权和马力欧数据修复保持一致（12 项）')
