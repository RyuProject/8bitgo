/**
 * 百度普通收录补交脚本。
 *
 * 用途有三个：
 *   1. 首次启用时把库里已有的上架游戏推一遍（--all）。
 *   2. 每日兜底：把最近 N 天有变动的游戏重推一次。上架那一刻的自动推送可能因为
 *      配额用完、接口抖动或进程重启（内存队列会丢）而漏掉，只靠它不保险。
 *   3. 排查配置：--dry-run 只打印将要提交的 URL，一条都不发。
 *
 * 用法：
 *   cd server && npm run baidu                  # 最近 3 天有变动的游戏
 *   cd server && npm run baidu -- --days 7
 *   cd server && npm run baidu -- --all
 *   cd server && npm run baidu -- --dry-run
 *   cd server && npm run baidu -- --limit 10    # 手工限制最多推几条
 *   cd server && npm run baidu -- --chunk 10    # 每次请求几条（默认 10，为了先探出剩余配额）
 *
 * ⚠️ 百度的配额是站点级、按天算的，新站常见 10~100 条/天。所以这里：
 *    - 只推详情页（配额有限时聚合页远不如详情页值钱）；
 *    - 只推 BAIDU_PUSH_LANGUAGES 指定的语言（默认简体中文）；
 *    - 按 updated_at 倒序，最新改动的先推；
 *    - 每批之后读响应里的 remain，配额清零就立刻停，不再白发请求。
 */
import 'dotenv/config'
import { pool, query } from '../src/db.js'
import {
  baiduPushLanguages,
  baiduPushSite,
  baiduPushToken,
  gameBaiduDetailUrls,
  submitBaiduUrls,
} from '../src/baidu-push.js'

const argv = process.argv.slice(2)
const has = (name) => argv.includes(name)
const value = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const dryRun = has('--dry-run')
const all = has('--all')
// 必须是整数：mysql2 会把它拼进 `INTERVAL ? DAY`，2.5 这种值 MySQL 直接报语法错。
const days = Math.floor(Number(value('--days') ?? 3))
const chunkSize = Math.max(1, Number(value('--chunk') ?? 10))
const hardLimit = Number(value('--limit') ?? 0) || Infinity

if (!all && !(Number.isFinite(days) && days > 0)) {
  console.error('--days 必须是正数（或者用 --all 推全部上架游戏）')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 只有当天配额确实用完时才这样收尾 —— 那不是故障，不该以非零退出码惊动 cron。 */
const isQuotaError = (error) => /quota|配额/i.test(String(error?.message || ''))

try {
  const site = baiduPushSite()
  // token 先校验一遍：错了就没必要去查库。
  baiduPushToken()
  const languages = baiduPushLanguages()

  const rows = all
    ? await query(
        'SELECT slug, updated_at FROM games WHERE hidden = 0 ORDER BY COALESCE(updated_at, created_at, added_at) DESC',
      )
    : await query(
        `SELECT slug, updated_at FROM games
          WHERE hidden = 0
            AND COALESCE(updated_at, created_at, added_at) >= DATE_SUB(NOW(), INTERVAL ? DAY)
          ORDER BY COALESCE(updated_at, created_at, added_at) DESC`,
        [days],
      )

  const urls = rows.flatMap((row) => gameBaiduDetailUrls(row.slug, site, languages))
  const scope = all ? '全部上架游戏' : `最近 ${days} 天有变动的游戏`

  console.log(`站点：${site}`)
  console.log(`语言：${languages.join('、')}`)
  console.log(`范围：${scope} —— ${rows.length} 款，共 ${urls.length} 个 URL`)

  if (!urls.length) {
    console.log('没有需要提交的 URL。')
  } else if (dryRun) {
    console.log('--dry-run：以下 URL 不会真的提交')
    for (const url of urls.slice(0, 20)) console.log(`  ${url}`)
    if (urls.length > 20) console.log(`  …… 其余 ${urls.length - 20} 条`)
  } else {
    let submitted = 0
    let accepted = 0
    let remaining = hardLimit
    let remain
    const notSameSite = []
    const notValid = []

    for (let offset = 0; offset < urls.length && remaining > 0; offset += chunkSize) {
      const batch = urls.slice(offset, offset + chunkSize).slice(0, remaining)
      if (!batch.length) break
      let result
      try {
        result = await submitBaiduUrls(batch, { enabled: true, site })
      } catch (error) {
        if (isQuotaError(error)) {
          console.warn(`⚠️  当天配额已用完：${error.message}`)
          break
        }
        throw error
      }
      submitted += result.submitted
      accepted += result.accepted
      notSameSite.push(...result.notSameSite)
      notValid.push(...result.notValid)
      if (result.remain !== undefined) {
        remain = result.remain
        // 剩余配额比我们还想推的更少时，以它为准，避免多发几个必然被拒的请求。
        remaining = Math.min(remaining - batch.length, remain)
      } else {
        remaining -= batch.length
      }
      if (remain === 0) {
        console.warn('⚠️  当天配额已用完，剩下的明天再由同一个任务继续。')
        break
      }
      // 别把接口打太急。
      if (offset + chunkSize < urls.length) await sleep(300)
    }

    console.log(`✅ 提交 ${submitted} 个 URL，百度收下 ${accepted} 个`)
    console.log(`   当天剩余配额：${remain === undefined ? '未知（接口未返回）' : remain}`)
    if (notSameSite.length) {
      console.warn(`⚠️  ${notSameSite.length} 个 URL 不属于已验证站点，检查 BAIDU_PUSH_SITE / PUBLIC_SITE_URL 与搜索资源平台里的写法是否完全一致：`)
      for (const url of notSameSite.slice(0, 5)) console.warn(`     ${url}`)
    }
    if (notValid.length) {
      console.warn(`⚠️  ${notValid.length} 个 URL 不合法：`)
      for (const url of notValid.slice(0, 5)) console.warn(`     ${url}`)
    }
  }
} catch (error) {
  console.error(`❌ 百度推送失败：${error?.message || error}`)
  process.exitCode = 1
} finally {
  await pool.end()
}
