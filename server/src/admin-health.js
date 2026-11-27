/**
 * 后台「站点健康」：一次请求把管理员最该先看的几件事收齐。
 *
 * 为什么单独一个接口而不是让概览页多打几条请求：
 *   - 这些信息原来散在五个地方（启动漏斗、错误诊断、PSP/PS1/Sockdrive 任务、评论审核、
 *     启动日志里的表结构自检、只打日志的边缘清缓存），有两样根本没有界面，只能登服务器看；
 *   - 每一块都是独立的小查询，在服务端 Promise.allSettled 并行跑，一块失败（比如没跑迁移
 *     缺表）只让那一块显示错误，不拖垮整个面板 —— 健康面板自己挂掉是最没用的失败方式。
 *
 * summarizeHealthAlerts 是纯函数：把各块数据收敛成按严重程度排好的告警列表，阈值集中在这里，
 * 测试直接喂假数据（scripts/test-admin-health.mjs）。
 */
import { query as defaultQuery } from './db.js'
import { schemaReport } from './schema-check.js'
import { edgePurgeStatus } from './edge-purge.js'

/** 转换任务里还在跑的状态（两套任务表各自的 ACTIVE 集合并起来） */
const ACTIVE_JOB = new Set(['queued', 'downloading', 'converting', 'verifying', 'uploading'])
/** 活动任务超过这么久没更新 updated_at，多半是进程卡死；正常转换至少每分钟报一次进度 */
export const STALLED_JOB_MINUTES = 30
/** 启动失败率告警线：样本太少时不报，避免凌晨三次点击里一次失败就红 */
export const STARTUP_MIN_SAMPLES = 20
export const STARTUP_WARN_RATE = 0.05
export const STARTUP_ERROR_RATE = 0.15
/** 同一错误特征一天内影响这么多次访问，值得点进诊断页看 */
export const DIAG_GROUP_WARN_VISITS = 10

const DAY_MS = 24 * 60 * 60 * 1000

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function isoOrNull(v) {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function sectionError(e) {
  return {
    error: e instanceof Error ? e.message : String(e),
    missingTable: e?.code === 'ER_NO_SUCH_TABLE',
  }
}

async function startupSection(query, cutoff) {
  const [row] = await query(
    `SELECT SUM(event = 'start_click') AS starts,
            SUM(event = 'game_playable') AS playable,
            SUM(event IN ('failed', 'timeout')) AS failures,
            SUM(event = 'slow_start') AS slow,
            SUM(event = 'startup_interrupted') AS interrupted
       FROM game_startup_events
      WHERE created_at >= ?`,
    [cutoff],
  )
  return {
    starts: num(row?.starts),
    playable: num(row?.playable),
    failures: num(row?.failures),
    slow: num(row?.slow),
    interrupted: num(row?.interrupted),
  }
}

async function diagnosticsSection(query, cutoff) {
  const rows = await query(
    `SELECT signature, MAX(signature_text) AS text, MAX(event) AS event, MAX(runtime) AS runtime,
            COUNT(*) AS count, COUNT(DISTINCT visit_id) AS visits, MAX(created_at) AS lastSeen
       FROM game_startup_diagnostics
      WHERE created_at >= ?
      GROUP BY signature
      ORDER BY visits DESC, count DESC
      LIMIT 5`,
    [cutoff],
  )
  return {
    groups: rows.map((r) => ({
      signature: String(r.signature),
      text: String(r.text ?? ''),
      event: String(r.event ?? ''),
      runtime: String(r.runtime ?? ''),
      count: num(r.count),
      visits: num(r.visits),
      lastSeen: isoOrNull(r.lastSeen),
    })),
  }
}

/**
 * 两张转换任务表的形状不同（PSP/PS1 有 disc_platform，Sockdrive 没有），这里统一成
 * `{ kind, active, queued, failed24h, stalled, recentFailures }`。
 */
async function jobsSection(query, cutoff, stalledCutoff) {
  const [disc, sock, discFail, sockFail] = await Promise.allSettled([
    query(
      `SELECT disc_platform AS kind, status, COUNT(*) AS n,
              SUM(updated_at < ?) AS stalled, SUM(updated_at >= ?) AS recent
         FROM psp_conversion_jobs
        WHERE status <> 'completed' OR completed_at >= ?
        GROUP BY disc_platform, status`,
      [stalledCutoff, cutoff, cutoff],
    ),
    query(
      `SELECT 'sockdrive' AS kind, status, COUNT(*) AS n,
              SUM(updated_at < ?) AS stalled, SUM(updated_at >= ?) AS recent
         FROM sockdrive_conversion_jobs
        WHERE status <> 'completed' OR completed_at >= ?
        GROUP BY status`,
      [stalledCutoff, cutoff, cutoff],
    ),
    query(
      `SELECT id, disc_platform AS kind, game_slug AS slug, lang, error, updated_at AS updatedAt
         FROM psp_conversion_jobs
        WHERE status = 'failed' AND updated_at >= ?
        ORDER BY updated_at DESC LIMIT 5`,
      [cutoff],
    ),
    query(
      `SELECT id, 'sockdrive' AS kind, game_slug AS slug, lang, error, updated_at AS updatedAt
         FROM sockdrive_conversion_jobs
        WHERE status = 'failed' AND updated_at >= ?
        ORDER BY updated_at DESC LIMIT 5`,
      [cutoff],
    ),
  ])
  const queues = new Map()
  const errors = []
  for (const settled of [disc, sock]) {
    if (settled.status === 'rejected') {
      errors.push(sectionError(settled.reason).error)
      continue
    }
    for (const r of settled.value) {
      const kind = String(r.kind || 'psp')
      const q = queues.get(kind) ?? { kind, active: 0, queued: 0, completed24h: 0, failed24h: 0, stalled: 0 }
      const n = num(r.n)
      const status = String(r.status)
      if (ACTIVE_JOB.has(status)) {
        q.active += n
        if (status === 'queued') q.queued += n
        q.stalled += num(r.stalled)
      } else if (status === 'failed') {
        // 失败任务行会一直留着（源文件 24 小时后才清），这里只数最近一天的
        q.failed24h += num(r.recent)
      } else if (status === 'completed') {
        q.completed24h += n
      }
      queues.set(kind, q)
    }
  }
  const recentFailures = []
  for (const settled of [discFail, sockFail]) {
    if (settled.status === 'rejected') continue
    for (const r of settled.value) {
      recentFailures.push({
        id: String(r.id),
        kind: String(r.kind || 'psp'),
        slug: r.slug ? String(r.slug) : '',
        lang: r.lang ? String(r.lang) : '',
        error: String(r.error ?? '').slice(0, 300),
        updatedAt: isoOrNull(r.updatedAt),
      })
    }
  }
  recentFailures.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  // 两张表都缺才算整块失败；只缺一张（比如还没部署 Sockdrive）照常展示另一张
  if (errors.length === 2) throw new Error(errors[0])
  return {
    queues: [...queues.values()].sort((a, b) => a.kind.localeCompare(b.kind)),
    recentFailures: recentFailures.slice(0, 5),
    partialError: errors[0] ?? null,
  }
}

async function contentSection(query) {
  const [[comments], [games], [posts], recent] = await Promise.all([
    query('SELECT COUNT(*) AS n FROM game_comments WHERE pending_review = 1 AND deleted_at IS NULL'),
    query(
      `SELECT SUM(g.hidden = 0 AND NOT EXISTS (SELECT 1 FROM game_roms gr WHERE gr.game_id = g.id)) AS visibleNoRom,
              SUM(g.hidden = 1) AS hidden
         FROM games g`,
    ),
    query('SELECT SUM(published = 0) AS drafts FROM posts'),
    query(
      `SELECT slug, COALESCE(NULLIF(title_zh, ''), title) AS title, platform, hidden, updated_at AS updatedAt
         FROM games ORDER BY updated_at DESC LIMIT 6`,
    ),
  ])
  return {
    pendingComments: num(comments?.n),
    visibleWithoutRom: num(games?.visibleNoRom),
    hiddenGames: num(games?.hidden),
    draftPosts: num(posts?.drafts),
    recentGames: recent.map((r) => ({
      slug: String(r.slug),
      title: String(r.title ?? r.slug),
      platform: String(r.platform ?? ''),
      hidden: Boolean(Number(r.hidden)),
      updatedAt: isoOrNull(r.updatedAt),
    })),
  }
}

/**
 * 收集全部分块。每块独立 settle：成功给数据，失败给 { error, missingTable }。
 * `deps` 只为测试注入（假 query / 固定时间 / 假自检与清缓存状态）。
 */
export async function collectAdminHealth(deps = {}) {
  const query = deps.query ?? defaultQuery
  const now = deps.now ?? Date.now()
  const cutoff = new Date(now - DAY_MS)
  const stalledCutoff = new Date(now - STALLED_JOB_MINUTES * 60 * 1000)
  const [startup, diagnostics, jobs, content] = await Promise.allSettled([
    startupSection(query, cutoff),
    diagnosticsSection(query, cutoff),
    jobsSection(query, cutoff, stalledCutoff),
    contentSection(query),
  ])
  const pick = (s) => (s.status === 'fulfilled' ? s.value : sectionError(s.reason))
  const sections = {
    generatedAt: new Date(now).toISOString(),
    startup: pick(startup),
    diagnostics: pick(diagnostics),
    jobs: pick(jobs),
    content: pick(content),
    schema: (deps.schemaReport ?? schemaReport)(),
    edgePurge: (deps.edgePurgeStatus ?? edgePurgeStatus)(),
  }
  return { ...sections, alerts: summarizeHealthAlerts(sections) }
}

const LEVEL_ORDER = { error: 0, warn: 1, info: 2 }

/**
 * 各块数据 → 告警列表（error > warn > info）。每条带 link 指向能处理它的后台页面，
 * 让面板不只是「告诉你坏了」，而是一点就到能修的地方。
 */
export function summarizeHealthAlerts(s) {
  const alerts = []
  const add = (level, key, text, link) => alerts.push({ level, key, text, ...(link ? { link } : {}) })
  const failed = (section) => section && typeof section === 'object' && 'error' in section && section.error

  // 表结构：缺表缺列时后台写操作会 500，是最该先修的
  const schema = s.schema
  if (schema) {
    const missing = (schema.missingTables?.length ?? 0) + (schema.missingColumns?.length ?? 0)
    if (missing) {
      const names = [
        ...(schema.missingTables ?? []).map((t) => `表 ${t.table}`),
        ...(schema.missingColumns ?? []).map((c) => `列 ${c.table}.${c.column}`),
      ]
      add('error', 'schema-missing', `数据库结构落后于代码（${names.slice(0, 4).join('、')}${names.length > 4 ? ' 等' : ''}），后台保存可能 500：cd server && npm run migrate`)
    }
    if (schema.invalidDos?.length) {
      add('error', 'schema-dos', `${schema.invalidDos.length} 款 DOS / Windows 游戏配置缺项，会在下载完后启动失败（如 ${schema.invalidDos[0].slug}）`, `/admin/games?q=${encodeURIComponent(schema.invalidDos[0].slug)}`)
    }
    if (schema.nonStreamingWindows) {
      add('info', 'schema-windows-zip', `${schema.nonStreamingWindows} 款 Windows 游戏仍走整包模式，建议转成 Sockdrive`, '/admin/games')
    }
    if (schema.error) add('warn', 'schema-error', `表结构自检没跑成：${schema.error}`)
  }

  const startup = s.startup
  if (failed(startup)) {
    add('warn', 'startup-error', `启动统计读取失败：${startup.error}`)
  } else if (startup && startup.starts >= STARTUP_MIN_SAMPLES) {
    const rate = startup.failures / startup.starts
    const pct = `${(rate * 100).toFixed(1)}%`
    if (rate >= STARTUP_ERROR_RATE) add('error', 'startup-rate', `近 24 小时启动失败率 ${pct}（${startup.failures} / ${startup.starts}）`, '/admin/diagnostics')
    else if (rate >= STARTUP_WARN_RATE) add('warn', 'startup-rate', `近 24 小时启动失败率 ${pct}（${startup.failures} / ${startup.starts}）`, '/admin/diagnostics')
  }

  const diag = s.diagnostics
  if (failed(diag)) {
    if (!diag.missingTable) add('warn', 'diag-error', `错误诊断读取失败：${diag.error}`)
  } else if (diag?.groups?.length) {
    const hot = diag.groups.filter((g) => g.visits >= DIAG_GROUP_WARN_VISITS)
    if (hot.length) {
      add('warn', 'diag-hot', `${hot.length} 类启动错误 24 小时内各影响 ≥${DIAG_GROUP_WARN_VISITS} 次访问，最多的是「${hot[0].text.slice(0, 60)}」（${hot[0].visits} 次）`, '/admin/diagnostics')
    }
  }

  const jobs = s.jobs
  if (failed(jobs)) {
    if (!jobs.missingTable) add('warn', 'jobs-error', `转换任务读取失败：${jobs.error}`)
  } else if (jobs?.queues) {
    const stalled = jobs.queues.reduce((n, q) => n + q.stalled, 0)
    const failedJobs = jobs.queues.reduce((n, q) => n + q.failed24h, 0)
    if (stalled) add('error', 'jobs-stalled', `${stalled} 个转换任务超过 ${STALLED_JOB_MINUTES} 分钟没有进度，可能卡死（看服务日志或重启服务后自动重新排队）`, '/admin/roms')
    if (failedJobs) add('warn', 'jobs-failed', `近 24 小时 ${failedJobs} 个转换任务失败，源文件保留 24 小时可重试`, '/admin/games')
  }

  const content = s.content
  if (failed(content)) {
    add('warn', 'content-error', `内容统计读取失败：${content.error}`)
  } else if (content) {
    if (content.visibleWithoutRom) add('warn', 'games-no-rom', `${content.visibleWithoutRom} 款已上架游戏没有绑定 ROM，玩家点进去玩不了`, '/admin/games')
    if (content.pendingComments) add('info', 'comments-pending', `${content.pendingComments} 条游客评论待审核`, '/admin/comments?status=pending')
  }

  const edge = s.edgePurge
  if (edge) {
    if (!edge.enabled) add('info', 'edge-off', '未配置 CF_ZONE_ID / CF_PURGE_API_TOKEN：页面边缘缓存只有 5 分钟，后台改动最多晚 5 分钟可见')
    else if (edge.last && !edge.last.ok) add('warn', 'edge-failed', `最近一次清 Cloudflare 页面缓存失败（${edge.last.error ?? '未知错误'}），后台改动可能要等一天才对访客可见`)
  }

  return alerts.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
}
