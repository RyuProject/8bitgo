/** 大型 DOS / Windows ZIP → Sockdrive 后台任务接口；大文件本体始终只走 R2 multipart。 */
import { Router } from 'express'
import { requireAbility } from '../auth.js'
import {
  createSockdriveConversion,
  getSockdriveConversion,
  retrySockdriveConversion,
  sockdriveConversionCapability,
} from '../sockdrive-conversion.js'

export const sockdriveConversionsRouter = Router()

function taskError(res, error) {
  const status = Number(error?.status)
  if (!Number.isInteger(status) || status < 400 || status >= 600) return false
  if (status === 503) res.set('Retry-After', String(Number(error?.retryAfter) || 2))
  res.status(status).json({ error: error.message })
  return true
}

// 转换能消耗数 GB 磁盘并写入公开 R2，权限必须与 ROM 存储管理一致。
sockdriveConversionsRouter.use(requireAbility('site:manage'))

sockdriveConversionsRouter.get('/capability', async (_req, res, next) => {
  try { res.json(await sockdriveConversionCapability()) } catch (error) { next(error) }
})

sockdriveConversionsRouter.post('/', async (req, res, next) => {
  try {
    res.status(202).json(await createSockdriveConversion(req.body, req.user?.id || null))
  } catch (error) {
    if (taskError(res, error)) return
    next(error)
  }
})

sockdriveConversionsRouter.get('/:id', async (req, res, next) => {
  try {
    if (!/^[a-f0-9-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: '任务 ID 无效' })
    const job = await getSockdriveConversion(req.params.id)
    if (!job) return res.status(404).json({ error: '转换任务不存在' })
    res.json(job)
  } catch (error) { next(error) }
})

sockdriveConversionsRouter.post('/:id/retry', async (req, res, next) => {
  try {
    if (!/^[a-f0-9-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: '任务 ID 无效' })
    const job = await retrySockdriveConversion(req.params.id)
    if (!job) return res.status(404).json({ error: '转换任务不存在' })
    res.status(job.status === 'completed' ? 200 : 202).json(job)
  } catch (error) {
    if (taskError(res, error)) return
    next(error)
  }
})
