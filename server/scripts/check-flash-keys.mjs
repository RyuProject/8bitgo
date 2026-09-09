/**
 * 拿库里的实际 slug 核对 Flash 屏幕手柄键位表。
 *
 *   cd server && npm run check:flash-keys
 *
 * ── 为什么需要它 ────────────────────────────────────────────
 * `src/emulator/flashKeys.ts` 的 FLASH_KEYS 以 **slug** 为键，而 `flashKeysFor()`
 * 查不到就返回 null、**不发默认键位**（那是有意的：Flash 里一大半是纯鼠标游戏）。
 * 两件事凑一起 = slug 写错就**静默地**没有屏幕手柄：手机上既没有十字键，也没有任何提示，
 * 控制台安静，测试全绿。2026-09-08 就踩到了 —— 表里写的是占位 slug
 * `senlin-binghuoren`，而库里的森林冰火人是 `fireboy-and-watergirl` 那四条，
 * 于是这个系列一直没有手柄，从上架起就没人发现。
 *
 * 只读（一条 SELECT），不改任何数据。连不上库就跳过并正常退出。
 *
 * 报两类问题：
 *   ① 表里有、库里没有 —— slug 写错了或者游戏下架了，这一条键位是死的
 *   ② 库里是多人 Flash 游戏、表里没有 —— 大概率漏配（单人/纯鼠标游戏不算，所以只提示不算错）
 */
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ping, query, pool } from '../src/db.js'

const FLASH_KEYS_TS = fileURLToPath(new URL('../../src/emulator/flashKeys.ts', import.meta.url))

/**
 * 从源码里取出 FLASH_KEYS 的键。
 * 用正则而不是 import：这是个 .ts 文件，server/ 这边没有 TS 加载器，
 * 而为了一张字符串表引一套加载器不值得（test:indexnow 里的文本提取是同一个取舍）。
 */
function tableSlugs() {
  const src = readFileSync(FLASH_KEYS_TS, 'utf8')
  const body = src.slice(src.indexOf('export const FLASH_KEYS'))
  const end = body.indexOf('\n}')
  if (end < 0) throw new Error('FLASH_KEYS 的形状变了，改一下这里的提取方式')
  const block = body.slice(0, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  return [...block.matchAll(/^\s*'([^']+)'\s*:/gm)].map((m) => m[1])
}

const slugs = tableSlugs()
console.log(`▌flashKeys.ts 里 ${slugs.length} 条：${slugs.join('、')}`)

/*
  ⚠️ `ping()` 连不上时是**抛**（db.js 里那一路没有 catch），不是返回 false ——
  不包起来的话这个脚本在没有库的机器上是一堆红色堆栈，而不是「跳过」。
*/
let reachable = false
try {
  reachable = await ping()
} catch (e) {
  console.log(`连不上数据库（${e?.code || e?.message || e}）`)
}
if (!reachable) {
  console.log('跳过核对 —— 这一步只在能连库的机器上有意义（服务器上，或本机开着隧道时）')
  await pool.end()
  process.exit(0)
}

const rows = await query("SELECT slug, title, players, hidden FROM games WHERE platform = 'flash' ORDER BY slug")
const bySlug = new Map(rows.map((r) => [r.slug, r]))
console.log(`▌库里 flash 游戏 ${rows.length} 款\n`)

let bad = 0

for (const s of slugs) {
  const row = bySlug.get(s)
  if (!row) {
    bad++
    console.error(`❌ 表里有、库里没有：'${s}' —— 这一条键位是死的（slug 写错？游戏删了？）`)
  } else if (row.hidden) {
    console.warn(`⚠️  '${s}'（${row.title}）在库里是隐藏状态，键位配了也没人用得上`)
  } else {
    console.log(`✅ '${s}' → ${row.title}${Number(row.players) > 1 ? `（${row.players} 人）` : ''}`)
  }
}

const missing = rows.filter((r) => !r.hidden && Number(r.players) > 1 && !slugs.includes(r.slug))
if (missing.length) {
  console.log(`\n▌库里这些多人 Flash 游戏还没配键位（手机上没有屏幕手柄；纯鼠标游戏可以不管）：`)
  for (const r of missing) console.log(`   · ${r.slug} —— ${r.title}（${r.players} 人）`)
}

await pool.end()
if (bad) {
  console.error(`\n${bad} 条键位对不上库里的 slug`)
  process.exit(1)
}
console.log('\n✅ 表里每一条都对得上库里的 slug')
