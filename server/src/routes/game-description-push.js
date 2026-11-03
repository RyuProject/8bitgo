import { Router } from 'express'
import { invalidateContent } from '../content.js'
import { getGameBySlug, listLocalizedGameDescriptions, writeLocalizedGameDescription } from '../games-repo.js'
import { queueGameSearchPush } from '../search-push.js'
import { takeAnonymous } from '../rateLimit.js'
import {
  decodeGameDescriptionCursor,
  encodeGameDescriptionCursor,
  gameDescriptionPushConfig,
  isGameDescriptionPushAuthorized,
  validateGameDescriptionListQuery,
  validateGameDescriptionPush,
} from '../game-description-push.js'

function requirePushToken(req, res, env, limiterName) {
  const config = gameDescriptionPushConfig(typeof env === 'function' ? env() : env)
  if (!config.enabled) {
    res.status(503).json({ error: '简介推送 API 尚未配置有效的服务端密钥' })
    return false
  }
  const gate = takeAnonymous(req, limiterName, { perIp: 30, global: 600 })
  if (!gate.ok) {
    res.status(429).json({ error: '请求过于频繁，请稍后重试', retryAfter: gate.retryAfter })
    return false
  }
  if (!isGameDescriptionPushAuthorized(req.get('authorization'), config.token)) {
    res.status(401).json({ error: 'Bearer token 无效' })
    return false
  }
  return true
}

/**
 * 独立给 Doubao / OpenClaw / MCP 等外部自动化调用的窄权限读写入口。
 * 读取语言简介状态，或只写一个已绑定 ROM 语言的简介；不复用后台通用写权限。
 */
export function createGameDescriptionPushRouter({
  env = () => process.env,
  findGame = getGameBySlug,
  listDescriptions = listLocalizedGameDescriptions,
  writeDescription = writeLocalizedGameDescription,
  afterWrite = (game) => {
    invalidateContent()
    queueGameSearchPush(game)
  },
} = {}) {
  const router = Router()

  router.get('/', async (req, res, next) => {
    try {
      if (!requirePushToken(req, res, env, 'game-description-list')) return
      const checked = validateGameDescriptionListQuery(req.query)
      if (checked.error) return res.status(400).json({ error: checked.error })
      const filters = checked.value
      const cursor = decodeGameDescriptionCursor(filters.cursor, {
        status: filters.status,
        filterLang: filters.lang,
      })
      if (cursor.error) return res.status(400).json({ error: cursor.error })

      const rows = await listDescriptions({
        status: filters.status,
        lang: filters.lang,
        after: cursor.value,
        limit: filters.limit,
      })
      const hasMore = rows.length > filters.limit
      const page = hasMore ? rows.slice(0, filters.limit) : rows
      const last = page.at(-1)
      const nextCursor = hasMore && last
        ? encodeGameDescriptionCursor({ id: last.cursorId, lang: last.lang }, {
          status: filters.status,
          filterLang: filters.lang,
        })
        : null
      return res.json({
        items: page.map(({ slug, lang, text, sourceText, sourceLang }) => ({
          slug,
          lang,
          text,
          missing: !text,
          sourceText,
          sourceLang,
          translatable: Boolean(sourceText),
        })),
        status: filters.status,
        lang: filters.lang,
        limit: filters.limit,
        hasMore,
        nextCursor,
      })
    } catch (error) {
      next(error)
    }
  })

  router.put('/', async (req, res, next) => {
    try {
      if (!requirePushToken(req, res, env, 'game-description-push')) return

      const checked = validateGameDescriptionPush(req.body)
      if (checked.error) return res.status(400).json({ error: checked.error })
      const { slug, lang, text } = checked.value
      const game = await findGame(slug)
      if (!game) return res.status(404).json({ error: '游戏不存在' })

      // 与后台表单一致：本地化简介只对应实际绑定的 ROM 语言，避免误建无法游玩的 SEO 语言页。
      if (!String(game.roms?.[lang] ?? '').trim()) {
        return res.status(409).json({ error: `游戏「${slug}」尚未绑定 ${lang} ROM，不能写入该语言简介` })
      }

      const wrote = await writeDescription(slug, lang, text)
      if (wrote === false && !(await findGame(slug))) {
        // 初次查询后游戏可能恰好被删除；同文重复 PUT 的 affectedRows=0 则仍算成功。
        return res.status(404).json({ error: '写入期间游戏已删除' })
      }
      const updated = {
        ...game,
        descriptionLocalized: { ...game.descriptionLocalized, [lang]: text },
      }
      try {
        afterWrite(updated)
      } catch (error) {
        // 数据已保存；缓存 / 搜索引擎通知失败不能伪装成写库失败，避免调用方重试误判。
        console.error('[game-description-push] 保存后刷新通知失败：', error?.message || error)
      }
      return res.json({ ok: true, slug, lang, characters: text.length })
    } catch (error) {
      next(error)
    }
  })

  return router
}

export const gameDescriptionPushRouter = createGameDescriptionPushRouter()
