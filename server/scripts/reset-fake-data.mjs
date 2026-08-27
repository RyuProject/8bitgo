/**
 * 一次性脚本：把数据库里遗留的虚构数值清掉。
 *
 * 用法：cd server && npm run migrate && node scripts/reset-fake-data.mjs
 *      （先 migrate 是为了补上 games.created_at 列；顺序反了也不会出错，
 *        脚本会检测到列不存在并跳过那一步，提示你补跑 migrate。）
 *
 * 只有在「用旧版内置数据初始化过数据库」的情况下才需要跑，而且**只跑一次**。
 * 它不在 schema.sql 里，正是因为 npm run migrate 会被反复执行 ——
 * 那样每次迁移都会把真实累计的游玩次数清零。
 *
 * 加 --dry-run 只看会影响多少行，不实际写入。
 */
import 'dotenv/config'
import { pool, query, queryOne } from '../src/db.js'

/** 内置目录实际建立的日期（src/data/games.ts 首次提交） */
const CATALOG_DATE = process.env.CATALOG_DATE || '2026-08-26'
const DRY = process.argv.includes('--dry-run')

/** 某张表 / 某个列在不在，避免直接查一个不存在的列导致整个脚本崩掉 */
async function hasTable(table) {
  const r = await queryOne(
    'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE table_schema = DATABASE() AND table_name = ?',
    [table],
  )
  return Number(r?.n ?? 0) > 0
}
async function hasColumn(table, column) {
  const r = await queryOne(
    'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
    [table, column],
  )
  return Number(r?.n ?? 0) > 0
}

const steps = [
  {
    label: '游玩次数清零',
    count: 'SELECT COUNT(*) AS n FROM games WHERE plays <> 0',
    update: 'UPDATE games SET plays = 0 WHERE plays <> 0',
  },
  {
    label: '评分清零',
    count: 'SELECT COUNT(*) AS n FROM games WHERE rating <> 0 OR rating_count <> 0',
    update: 'UPDATE games SET rating = 0, rating_count = 0 WHERE rating <> 0 OR rating_count <> 0',
  },
  {
    label: 'G 币奖励清零',
    count: 'SELECT COUNT(*) AS n FROM games WHERE coin_reward <> 0',
    update: 'UPDATE games SET coin_reward = 0 WHERE coin_reward <> 0',
  },
  {
    label: '上线日期统一',
    count: 'SELECT COUNT(*) AS n FROM games WHERE added_at <> ?',
    update: 'UPDATE games SET added_at = ? WHERE added_at <> ?',
    params: { count: [CATALOG_DATE], update: [CATALOG_DATE, CATALOG_DATE] },
  },
]

try {
  if (!(await hasTable('games'))) {
    console.log('数据库里还没有 games 表。请先 `npm run migrate` 建表，再用后台「导入内置数据到数据库」或 `npm run seed` 灌数据。')
    process.exit(0)
  }

  const total = Number((await queryOne('SELECT COUNT(*) AS n FROM games'))?.n ?? 0)
  console.log(`games 表当前有 ${total} 款游戏${DRY ? '　【预演】不会写入任何数据' : ''}\n`)
  if (total === 0) {
    console.log('表是空的，没有需要清理的历史数据。')
    console.log('到后台「数据 → 导入内置数据到数据库」灌入内置目录即可 —— 新的内置数据本身就是干净的。')
    process.exit(0)
  }

  let touched = 0
  for (const step of steps) {
    const n = Number((await queryOne(step.count, step.params?.count))?.n ?? 0)
    if (!n) {
      console.log(`· ${step.label}：无需处理`)
      continue
    }
    if (DRY) {
      console.log(`· ${step.label}：将影响 ${n} 行`)
      touched += n
      continue
    }
    await query(step.update, step.params?.update)
    console.log(`✅ ${step.label}：已处理 ${n} 行`)
    touched += n
  }

  // created_at 与 added_at 对齐，让初始批次在「最新上架」里表现一致。
  // 列还没建出来（没跑过 migrate）时跳过，不当成错误。
  if (await hasColumn('games', 'created_at')) {
    if (!DRY) {
      const r = await query('UPDATE games SET created_at = ? WHERE DATE(created_at) <> ?', [`${CATALOG_DATE} 00:00:00`, CATALOG_DATE])
      console.log(r.affectedRows ? `✅ created_at 已对齐：${r.affectedRows} 行` : '· created_at：无需处理')
    }
  } else {
    console.log('\n⚠️  games 表还没有 created_at 列 —— 这一步已跳过。')
    console.log('   请跑一次 `npm run migrate` 补上该列（新增游戏的上线日期要靠它自动生成），然后可以再跑一次本脚本。')
  }

  console.log(
    DRY
      ? '\n预演结束。去掉 --dry-run 即可实际执行。'
      : touched
        ? '\n完成。这个脚本只需要跑一次，之后游玩次数会由玩家真实游玩累加。'
        : '\n数据库里没有需要清理的虚构数据，什么都没改。',
  )
} catch (e) {
  console.error('❌ 失败：', e.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
