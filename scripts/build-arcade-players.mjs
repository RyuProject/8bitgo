#!/usr/bin/env node
/**
 * 从 FBNeo 驱动表生成「街机 romset 短名 → 最大玩家数」→ shared/arcade-players.json
 *
 * ── 为什么需要它 ─────────────────────────────────────────────
 * 以前一款游戏能不能联机、几个人，全靠管理员在后台打开开关、填人数；线上 107 款街机里
 * 有 40 多款双打游戏没人去填，玩家就看不到「联机匹配」。而 FBNeo 的每个驱动里本来就写着
 * 这个数 —— BurnDriver 的 Players 字段，上游注释原话是「so we can remove single player
 * games from netplay」。服务端按 ROM 文件短名查这张表，后台开关只用来纠错。
 *
 * 结构（burnint.h）：
 *     szShortName, szParent, szBoardROM, szSampleName, szDate,      ← 0..4
 *     szFullNameA, szCommentA, szManufacturerA, szSystemA,           ← 5..8
 *     szFullNameW, szCommentW, szManufacturerW, szSystemW,           ← 9..12
 *     Flags, Players, Hardware, Genre, Family, ...                   ← 13, 14, ...
 *
 * ── 怎么重新生成 ─────────────────────────────────────────────
 * 取 FBNeo 源码的方法见 scripts/build-arcade-romsets.mjs 头注释，然后：
 *     node scripts/build-arcade-players.mjs /tmp/fbn/src/burn/drv
 *
 * 产物进 git（构建机和生产机上都没有 FBNeo 源码）。为了小，默认的 2 人不写：
 * 文件里只列不是 2 人的 romset，以及 `known` 全量名单（用来区分「2 人」和「不认识」）。
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = process.argv[2]
if (!srcDir) {
  console.error('用法: node scripts/build-arcade-players.mjs <FBNeo>/src/burn/drv')
  process.exit(1)
}

/** 与 build-arcade-romsets.mjs 一致：这些目录不是街机 */
const SKIP = new Set(['megadrive', 'nes', 'snes', 'sms', 'pce', 'spectrum', 'msx', 'coleco', 'sg1000', 'channelf', 'gba'])
const DRV = /struct\s+BurnDriver\w*\s+BurnDrv\w+\s*=\s*\{([\s\S]*?)\n\};/g

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (n.endsWith('.cpp')) out.push(p)
  }
  return out
}

/** 按顶层逗号切字段：跳过字符串、字符字面量、注释和括号里的逗号 */
export function topLevelFields(body) {
  const fields = []
  let cur = ''
  let depth = 0
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < body.length && body[j] !== c) j += body[j] === '\\' ? 2 : 1
      cur += body.slice(i, j + 1)
      i = j
      continue
    }
    if (c === '/' && body[i + 1] === '/') {
      while (i < body.length && body[i] !== '\n') i++
      continue
    }
    if (c === '/' && body[i + 1] === '*') {
      const end = body.indexOf('*/', i + 2)
      i = end < 0 ? body.length : end + 1
      continue
    }
    if (c === '(' || c === '{' || c === '[') depth++
    else if (c === ')' || c === '}' || c === ']') depth--
    if (c === ',' && depth === 0) {
      fields.push(cur.trim())
      cur = ''
      continue
    }
    cur += c
  }
  if (cur.trim()) fields.push(cur.trim())
  return fields
}

const players = new Map()
let skipped = 0
for (const f of walk(srcDir)) {
  if (SKIP.has(relative(srcDir, f).split(sep)[0])) continue
  const src = readFileSync(f, 'utf8')
  for (const m of src.matchAll(DRV)) {
    const fields = topLevelFields(m[1])
    const short = /^"([^"]+)"$/.exec(fields[0] ?? '')?.[1]?.toLowerCase()
    const n = Number(fields[14])
    if (!short) continue
    if (!Number.isInteger(n) || n < 1 || n > 16) {
      skipped++
      continue
    }
    players.set(short, n)
  }
}

if (players.size < 5000) {
  console.error(`✖ 只解析出 ${players.size} 个 romset，明显偏少 —— FBNeo 源码结构可能变了`)
  process.exit(1)
}

const byCount = {}
for (const [name, n] of [...players].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (n === 2) continue
  ;(byCount[n] ??= []).push(name)
}
const known = [...players.keys()].sort()
const out = join(root, 'shared', 'arcade-players.json')
writeFileSync(out, JSON.stringify({ source: 'FBNeo BurnDriver.Players', defaultPlayers: 2, players: byCount, known: known.join(' ') }) + '\n')
const hist = Object.fromEntries(Object.entries(byCount).map(([k, v]) => [k, v.length]))
console.log(`✔ ${players.size} 个 romset → shared/arcade-players.json（非 2 人：${JSON.stringify(hist)}，跳过 ${skipped}）`)
