/**
 * 百度普通收录补交脚本。
 *
 * 用途有三个：
 *   1. 首次启用时把库里已有的内容推一遍（--all）。
 *   2. 每日兜底：把最近 N 天有变动的内容重推一次。上架那一刻的自动推送可能因为
 *      配额用完、接口抖动或进程重启（内存队列会丢）而漏掉，只靠它不保险。
 *   3. 排查配置：--dry-run 只打印将要提交的 URL，一条都不发。
 *
 * 覆盖三类内容，**按价值排优先级**：游戏详情 → 文章详情 → 平台/类型聚合页。
 * 顺序是有意义的：配额从前往后花，用完就停，所以最值钱的排最前。
 * （以前这里只捞游戏 —— 文章和聚合页有独立的 H1、正文与结构化数据，
 *   却从来没被主动提交过，只能等蜘蛛自己回来。）
 *
 * 用法：
 *   cd server && npm run baidu                    # 最近 3 天有变动的内容
 *   cd server && npm run baidu -- --days 7
 *   cd server && npm run baidu -- --all
 *   cd server && npm run baidu -- --dry-run
 *   cd server && npm run baidu -- --limit 10      # 手工限制最多推几条
 *   cd server && npm run baidu -- --chunk 10      # 每次请求几条（默认 10，为了先探出剩余配额）
 *   cd server && npm run baidu -- --only games    # 只推某一类：games / posts / taxonomy
 *
 * ⚠️ 百度的配额是站点级、按天算的，新站常见 10~100 条/天。所以这里：
 *    - 只推详情页与聚合页本身，不推 /games、/blog 这种一直在变的列表页；
 *    - 只推 BAIDU_PUSH_LANGUAGES 指定的语言（默认简体中文）；
 *    - 每类内部按最近改动倒序，最新的先推；
 *    - 每批之后读响应里的 remain，配额清零就立刻停，不再白发请求。
 */
import 'dotenv/config'
import { pool, query } from '../src/db.js'
import {
  baiduPushLanguages,
  baiduPushSite,
  baiduPushToken,
  gameBaiduDetailUrls,
  postBaiduDetailUrls,
  submitBaiduUrls,
  taxonomyBaiduUrls,
} from '../src/baidu-push.js'
import { taxonomyRows } from '../src/routes/sitemaps.js'

const argv = process.argv.slice(2)
const has = (name) => argv.includes(name)
const value = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const KINDS = ['games', 'posts', 'taxonomy']

const dryRun = has('--dry-run')
const all = has('--all')
// 必须是整数：mysql2 会把它拼进 `INTERVAL ? DAY`，2.5 这种值 MySQL 直接报语法错。
const days = Math.floor(Number(value('--days') ?? 3))
const chunkSize = Math.max(1, Number(value('--chunk') ?? 10))
const hardLimit = Number(value('--limit') ?? 0) || Infinity
const only = value('--only')

if (!all && !(Number.isFinite(days) && days > 0)) {
  console.error('--days 必须是正数（或者用 --all 推全部内容）')
  process.exit(1)
}
if (only !== undefined && !KINDS.includes(only)) {
  console.error(`--only 只能是：${KINDS.join(' / ')}`)
  process.exit(1)
}
const wants = (kind) => only === undefined || only === kind

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 只有当天配额确实用完时才这样收尾 —— 那不是故障，不该以非零退出码惊动 cron。 */
const isQuotaError = (error) => /quota|配额/i.test(String(error?.message || ''))

/** 聚合页的「最近有变动」只能在 JS 里筛：它的时间是一组游戏聚合出来的，不是表上的列。 */
const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000
function changedRecently(value) {
  if (!value) return false
  const t = (value instanceof Date ? value : new Date(value)).valueOf()
  return Number.isNaN(t) ? false : t >= cutoffMs
}

try {
  const site = baiduPushSite()
  // token 先校验一遍：错了就没必要去查库。
  baiduPushToken()
  const languages = baiduPushLanguages()

  /** 按优先级排好的三段。urls 已经是最终要提交的地址。 */
  const groups = []

  if (wants('games')) {
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
    groups.push({
      label: '游戏详情页',
      items: rows.length,
      urls: rows.flatMap((row) => gameBaiduDetailUrls(row.slug, site, languages)),
    })
  }

  if (wants('posts')) {
    // 只捞已发布的：草稿在前台是 404，推过去等于主动提交一批错误页。
    const rows = all
      ? await query(
          'SELECT slug FROM posts WHERE published = 1 ORDER BY COALESCE(updated_at, created_at, `date`) DESC',
        )
      : await query(
          `SELECT slug FROM posts
            WHERE published = 1
              AND COALESCE(updated_at, created_at, \`date\`) >= DATE_SUB(NOW(), INTERVAL ? DAY)
            ORDER BY COALESCE(updated_at, created_at, \`date\`) DESC`,
          [days],
        )
    groups.push({
      label: '文章详情页',
      items: rows.length,
      urls: rows.flatMap((row) => postBaiduDetailUrls(row.slug, site, languages)),
    })
  }

  if (wants('taxonomy')) {
    // 复用 sitemap 那份筛选：空平台、白名单外的平台、已下线的类型都已经被剔掉了。
    const rows = await taxonomyRows()
    const picked = all ? rows : rows.filter((row) => changedRecently(row.latest))
    groups.push({
      label: '平台 / 类型页',
      items: picked.length,
      urls: taxonomyBaiduUrls(picked, site, languages),
    })
  }

  // 去重但保留优先级顺序：同一个 URL 只提交一次，位置以最先出现的那次为准。
  const seen = new Set()
  const urls = []
  for (const group of groups) {
    for (const url of group.urls) {
      if (seen.has(url)) continue
      seen.add(url)
      urls.push(url)
    }
  }

  const scope = all ? '全部内容' : `最近 ${days} 天有变动的内容`
  console.log(`站点：${site}`)
  console.log(`语言：${languages.join('、')}`)
  console.log(`范围：${scope}`)
  for (const group of groups) {
    console.log(`  ${group.label}：${group.items} 项 → ${group.urls.length} 个 URL`)
  }
  console.log(`合计（去重后）：${urls.length} 个 URL，按上面的顺序花配额`)

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
