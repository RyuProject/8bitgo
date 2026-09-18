/**
 * 给**已有的**街机游戏补上「要哪个 BIOS 系统包」这一列（games.arcade_bios）。
 *
 *   cd server && npm run backfill-arcade-bios             真正写入
 *   cd server && npm run backfill-arcade-bios -- --dry-run 只看结果，不改库
 *
 * ## 为什么不用重传 ROM
 *
 * 识别新上传的包靠的是**包内 CRC**（src/lib/arcadeRomset.ts）。而存量游戏不用那么麻烦：
 * 它们入库时已经按 romset 短名命名过了（后台那套自动改名），而 romset 索引里本来就存着
 * `名字 → 需要哪个 BIOS`（scripts/build-arcade-romsets.mjs 从 FBNeo 驱动表生成）。
 * 所以对一条已有的记录，只看**文件短名**就够了，一个字节都不用下。
 *
 * ## 这里只补得动「名字还是 romset 短名」的那些
 *
 * 汉化版 / 修改版走的是 RomData（包名是自定义的，如 wofcn），它们在驱动表里根本不存在 ——
 * 脚本会把它们列出来，由管理员在后台逐款手填（那也正是「识别不出来就自己选」那条路）。
 * 重复跑是安全的：默认只填空的，已经有值的不会被动。
 */
import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from '../src/db.js'

import { loadBiosByName, romsetNameFromKey } from '../src/arcade-bios-index.js'

const dryRun = process.argv.includes('--dry-run')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX = path.join(root, 'public', 'arcade-romsets.bin')

const { byName: biosByName, setCount } = loadBiosByName(INDEX)
console.log(`索引里有 ${setCount} 个 romset，其中 ${biosByName.size} 个需要 BIOS 包`)

/*
  一款游戏可能绑了好几个 ROM（各语言槽）。街机通常只有一个通用槽（lang = '*'），
  但万一多个槽的短名推出不同的 BIOS，那说明数据本身有问题 —— 记下来让人看，
  别随手挑一个写进去。
*/
const rows = await query(
  `SELECT g.id, g.slug, g.arcade_bios, r.object_key
     FROM games g
     JOIN game_roms r ON r.game_id = g.id
    WHERE g.platform = 'arcade'
    ORDER BY g.id`,
)
const byGame = new Map()
for (const r of rows) {
  const set = byGame.get(r.id) ?? { slug: r.slug, current: r.arcade_bios, keys: [] }
  set.keys.push(r.object_key)
  byGame.set(r.id, set)
}
console.log(`街机游戏 ${byGame.size} 款（含 ROM 绑定的）`)

let filled = 0
let kept = 0
let unknown = 0
let conflict = 0
const unknownSlugs = []

for (const [id, game] of byGame) {
  if (game.current) {
    kept++
    continue
  }
  const names = [...new Set(game.keys.map(romsetNameFromKey).filter(Boolean))]
  const bios = [...new Set(names.map((n) => biosByName.get(n)).filter(Boolean))]

  if (bios.length > 1) {
    conflict++
    console.warn(`⚠️ ${game.slug} 的多个 ROM 推出的 BIOS 不一致（${bios.join(' / ')}）—— 留空，请手工填`)
    continue
  }
  if (!bios.length) {
    unknown++
    if (unknownSlugs.length < 30) unknownSlugs.push(`${game.slug}（${names.join(', ') || '无文件名'}）`)
    continue
  }

  if (dryRun) {
    console.log(`· ${game.slug}: ${names.join(', ')} → ${bios[0]}`)
  } else {
    await query('UPDATE games SET arcade_bios = ? WHERE id = ? AND (arcade_bios IS NULL OR arcade_bios = ?)', [
      bios[0],
      id,
      '',
    ])
  }
  filled++
}

console.log(
  `\n${dryRun ? '（dry-run，未写库）' : '完成'}：可以补 ${filled} 款、已有值跳过 ${kept} 款、` +
    `认不出 ${unknown} 款、多槽冲突 ${conflict} 款`,
)
if (unknownSlugs.length) {
  console.log(
    '\n认不出的那些（名字不是 romset 短名，多半是汉化 / 魔改包走 RomData 的）：\n  ' +
      unknownSlugs.join('\n  ') +
      '\n在后台逐款填「BIOS 包（系统名）」；确实不需要 BIOS 的（CPS 系）留空即可。',
  )
}
process.exit(0)
