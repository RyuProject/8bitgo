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
 *   cd server && npm run baidu -- --probe         # 只推 1 条，把原始响应整段打出来
 *
 * ## 「推了半天，success 一直是 0」怎么查
 *
 * 先跑 `--probe`。它只花 1 条配额，但会把**原始响应**原样打出来 ——
 * 而那是唯一能分辨下面几件事的东西，解析后的字段做不到：
 *
 *   · `{"remain":N,"success":1}`            → 接口和配置都是好的，问题在别处（比如推的 URL 本身）
 *   · `{"remain":N,"success":0,"not_same_site":[...]}` → site 写法和平台上验证的那个对不上
 *   · `{"error":401,"message":"token is not valid"}`   → 准入密钥不对或已被重置
 *   · `{"error":400,"message":"site error"}`            → 站点在平台里没验证通过
 *   · `{"error":400,"message":"over quota"}`            → 当天配额已用完
 *   · `{"error":400,"message":"empty content"}`         → 请求体是空的（用浏览器直接打开那条地址就是这种）
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
  baiduPushEndpoint,
  baiduPushLanguages,
  baiduPushSite,
  baiduPushToken,
  redactEndpoint,
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
const probe = has('--probe')
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

/** 把原始响应整段打出来。排查时它比我们解析后的字段值钱得多 */
function dumpRaw(raw) {
  if (!raw) {
    console.warn('（没有拿到响应 —— 请求根本没发出去，多半是网络或 DNS）')
    return
  }
  console.log(`HTTP ${raw.status}`)
  console.log('原始响应：')
  console.log(String(raw.text).slice(0, 2000) || '（空）')
}

/**
 * 把百度的错误码翻成下一步动作。
 * message 原文取自百度搜索资源平台的错误说明；认不出来的原样交回，**不猜**。
 */
function explainBaiduError(error) {
  const msg = String(error?.message || '')
  if (/token is not valid/i.test(msg)) {
    return '   → 准入密钥不对，或者在平台点过「更新准入密钥」把旧的废了。去平台重新复制一把，填进 server/.env 的 BAIDU_PUSH_TOKEN。'
  }
  if (/site error/i.test(msg)) {
    return '   → 这个站点在搜索资源平台里没有验证通过，或者 site 参数和验证过的写法对不上。'
  }
  if (/over quota/i.test(msg)) {
    return '   → 当天配额已用完，明天再推。配额是站点级的，别的脚本/别人用同一把密钥也会吃掉它。'
  }
  if (/empty content/i.test(msg)) {
    return '   → 请求体是空的。用浏览器直接打开那条推送地址就是这种（浏览器发的是 GET，没有请求体）—— 它必须是 POST + text/plain + 每行一个 URL。'
  }
  if (/only 2000 urls/i.test(msg)) {
    return '   → 单次最多 2000 条。'
  }
  return '   → 这条错误不在已知清单里，把上面那段原始响应留好。'
}

try {
  const site = baiduPushSite()
  // token 先校验一遍：错了就没必要去查库。
  baiduPushToken()
  const languages = baiduPushLanguages()

  /*
    ── --probe：只推一条，把原始响应整段打出来 ───────────────────────────

    为什么要单独做一个模式：原来只有「什么都不发」（--dry-run）和「按配额全发」
    两档。而「success 一直是 0」这个问题，两档都答不了 ——
    前者根本不碰接口，后者把配额花光之后给你一行「收下 0 个」，
    不告诉你百度到底回了什么。

    它**会花掉 1 条配额**，这是故意的：只有真的发一次，回来的东西才算证据。
  */
  if (probe) {
    const target = argv[argv.indexOf('--probe') + 1]
    const url = target && !target.startsWith('--') ? target : `${site}/`
    console.log(`站点：${site}`)
    console.log(`端点：${redactEndpoint(baiduPushEndpoint({ site }))}`)
    console.log(`探针 URL：${url}`)
    console.log('⚠️  这会真的提交一次，花掉 1 条当天配额。\n')

    let raw
    try {
      const result = await submitBaiduUrls([url], {
        enabled: true,
        site,
        onRawResponse: (r) => { raw = r },
      })
      dumpRaw(raw)
      console.log(`\n解析结果：提交 ${result.submitted}，收下 ${result.accepted}，` +
        `剩余配额 ${result.remain === undefined ? '未知' : result.remain}`)
      if (result.notSameSite.length) {
        console.warn('\n❌ not_same_site —— site 参数和搜索资源平台里验证过的写法对不上。')
        console.warn(`   我们发出去的是：site=${site}`)
        console.warn('   去平台「普通收录 → API 提交」页面把那条地址整条复制下来，对一下 site 的写法')
        console.warn('   （带不带 www、http 还是 https、结尾有没有斜杠，都算不同站点）')
      } else if (result.accepted > 0) {
        console.log('\n✅ 接口、密钥、site 写法都是好的。')
        console.log('   那么「一直是 0」多半不在这一层：先看 npm run baidu 那边到底攒出了几个 URL，')
        console.log('   以及 server/.env 里 BAIDU_PUSH_ENABLED 是不是 1（是 0 的话内容保存时一条都不会推）。')
      } else {
        console.warn('\n⚠️  推了 1 条，百度收下 0 条，而且没说原因。上面那段原始响应就是全部线索。')
      }
    } catch (error) {
      dumpRaw(raw)
      console.error(`\n❌ ${error?.message || error}`)
      console.error(explainBaiduError(error))
      process.exitCode = 1
    }
  } else {

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
    let failed = 0
    let unexplained = 0
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
      failed += result.failed
      unexplained += result.unexplained
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
    if (failed > notSameSite.length + notValid.length) {
      console.warn(`⚠️  百度报了 ${failed} 条失败，但只说明了其中 ${notSameSite.length + notValid.length} 条。`)
    }
    /*
      ⚠️ 「提交了 N 条、收下 0 条，而且没有任何报错」是这个脚本最需要说话的时刻。
      原来它只打一行绿色的 ✅，看上去像跑成功了。
    */
    if (unexplained > 0) {
      console.warn(`⚠️  ${unexplained} 个 URL 既没被收下、百度也没说原因。常见顺序：`)
      console.warn('     1) site 写法和搜索资源平台里验证过的那个是否一字不差（带不带 www、http 还是 https）')
      console.warn('     2) 当天配额是不是已经被别的推送用光了（remain 看上面那行）')
      console.warn('     3) 站点在平台里是不是还处于「未验证 / 已失效」状态')
      console.warn('     跑一条看原始响应：npm run baidu -- --probe')
    }
    }
  }
} catch (error) {
  console.error(`❌ 百度推送失败：${error?.message || error}`)
  process.exitCode = 1
} finally {
  await pool.end()
}
