/**
 * AI 临时修补的接口。
 *
 *   GET  /api/hotfixes                          公开。生效中的修补（浏览器开局前读，30 秒缓存）
 *   GET  /api/admin/ai/config                   后台。配置（不含 Key 本身，只有末四位）
 *   PUT  /api/admin/ai/config                   后台。保存配置 / 换 Key / 清 Key
 *   POST /api/admin/ai/test                     后台。用当前 Key 发一句话，验证连得上
 *   GET  /api/admin/ai/hotfixes?status=         后台。修补记录 + 效果统计
 *   POST /api/admin/ai/triage { signature }     后台。手动对一个故障特征分诊（「错误诊断」页的按钮）
 *   POST /api/admin/ai/hotfixes/:id/approve | revoke | resolve | extend
 *   GET  /api/admin/ai/hotfixes/:id/report      后台。「复制给 Claude」的 Markdown
 *
 * 公开与后台分两个前缀（同 site-notice.js 的理由）：公开那份进边缘缓存，后台那份按身份变内容。
 * 公开接口只给浏览器执行需要的字段（作用范围 + 动作），诊断、建议、特征原文都不出后台。
 * 后台全部用 site:manage：Key 是站级机密，修补会影响所有玩家。
 */
import { Router } from 'express'
import { requireAbility } from '../auth.js'
import { CACHE } from '../cache.js'
import { loadAiConfig, publicAiConfig, saveAiConfig } from '../ai-config.js'
import { minimaxChat } from '../minimax.js'
import {
  HOTFIX_STATUSES,
  activePublicHotfixes,
  approveHotfix,
  extendHotfix,
  hotfixReport,
  listHotfixes,
  resolveHotfix,
  revokeHotfix,
  triageSignature,
} from '../ai-hotfix.js'

export const hotfixPublicRouter = Router()
export const adminAiRouter = Router()

hotfixPublicRouter.get('/', async (_req, res, next) => {
  try {
    // 和公告条同一档 30 秒：出事时要尽快生效，撤销时也要尽快停
    res.set('Cache-Control', CACHE.notice)
    res.json({ items: await activePublicHotfixes() })
  } catch (e) {
    next(e)
  }
})

const guard = requireAbility('site:manage')

function sendError(res, next, e) {
  if (e?.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: '缺少 ai_hotfixes / site_settings 表：cd server && npm run migrate' })
  if (e?.status && e.status < 500) return res.status(e.status).json({ error: e.message })
  if (e?.name === 'MinimaxError') return res.status(502).json({ error: e.message, code: e.code })
  return next(e)
}

adminAiRouter.use((_req, res, next) => {
  res.set('Cache-Control', CACHE.none)
  next()
})

adminAiRouter.get('/config', guard, async (_req, res, next) => {
  try {
    res.json({ config: publicAiConfig(await loadAiConfig({ fresh: true })), statuses: HOTFIX_STATUSES })
  } catch (e) {
    sendError(res, next, e)
  }
})

adminAiRouter.put('/config', guard, async (req, res, next) => {
  try {
    res.json({ config: publicAiConfig(await saveAiConfig(req.body ?? {})) })
  } catch (e) {
    sendError(res, next, e)
  }
})

adminAiRouter.post('/test', guard, async (_req, res, next) => {
  try {
    const cfg = await loadAiConfig({ fresh: true })
    if (!cfg.apiKey) return res.status(400).json({ error: '还没有配置 MiniMax API Key' })
    const reply = await minimaxChat({
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      maxTokens: 200,
      timeoutMs: 45_000,
      messages: [{ role: 'user', content: '只回复一个 JSON：{"ok":true}' }],
    })
    res.json({ ok: true, model: reply.model, latencyMs: reply.latencyMs, reply: reply.content.slice(0, 200) })
  } catch (e) {
    sendError(res, next, e)
  }
})

adminAiRouter.get('/hotfixes', guard, async (req, res, next) => {
  try {
    res.json({ items: await listHotfixes({ status: String(req.query.status ?? '') }) })
  } catch (e) {
    sendError(res, next, e)
  }
})

/*
  nginx 反代默认 60 秒读超时，模型思考久一点就会被掐断。等 50 秒还没结果就先回 202，
  分析在后台继续，结果照常落库 —— 后台到「AI 修补」页刷新就能看到。
*/
const TRIAGE_WAIT_MS = 50_000

adminAiRouter.post('/triage', guard, async (req, res, next) => {
  try {
    const job = triageSignature(String(req.body?.signature ?? ''), { trigger: 'manual' })
    job.catch(() => {})
    let timer
    const waited = await Promise.race([
      job.then((item) => ({ item })),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), TRIAGE_WAIT_MS) }),
    ]).finally(() => clearTimeout(timer))
    if (!waited) return res.status(202).json({ pending: true })
    res.json({ item: waited.item })
  } catch (e) {
    sendError(res, next, e)
  }
})

adminAiRouter.get('/hotfixes/:id/report', guard, async (req, res, next) => {
  try {
    const markdown = await hotfixReport(req.params.id)
    if (!markdown) return res.status(404).json({ error: '修补不存在' })
    res.json({ markdown })
  } catch (e) {
    sendError(res, next, e)
  }
})

const ACTIONS = {
  approve: (id, body) => approveHotfix(id, body?.note),
  revoke: (id, body) => revokeHotfix(id, body?.note ?? '管理员手动撤销'),
  resolve: (id, body) => resolveHotfix(id, body?.note ?? '已在代码中固化'),
  extend: (id, body) => extendHotfix(id, body?.hours),
}

adminAiRouter.post('/hotfixes/:id/:action', guard, async (req, res, next) => {
  try {
    const fn = ACTIONS[req.params.action]
    if (!fn || !/^\d{1,20}$/.test(req.params.id)) return res.status(404).json({ error: '未知操作' })
    res.json({ item: await fn(req.params.id, req.body) })
  } catch (e) {
    sendError(res, next, e)
  }
})
