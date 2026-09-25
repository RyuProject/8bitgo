/** PSP ISO → CHD 后台任务接口。大文件本体始终走 R2，这里只收对象 key。 */
import { Router } from 'express'
import { requireAbility } from '../auth.js'
import {
  createPspConversion,
  getPspConversion,
  pspConversionCapability,
  retryPspConversion,
} from '../psp-conversion.js'

export const pspConversionsRouter = Router()

// 转换会消耗源站 CPU / 磁盘并能覆盖 R2 对象，权限必须和「ROM 存储」一致，不能只给内容编辑。
pspConversionsRouter.use(requireAbility('site:manage'))

pspConversionsRouter.get('/capability', async (_req, res, next) => {
  try {
    res.json(await pspConversionCapability())
  } catch (error) {
    next(error)
  }
})

pspConversionsRouter.post('/', async (req, res, next) => {
  try {
    const job = await createPspConversion(req.body, req.user?.id || null)
    res.status(202).json(job)
  } catch (error) {
    if (Number(error?.status) >= 400 && Number(error?.status) < 600) {
      return res.status(Number(error.status)).json({ error: error.message })
    }
    next(error)
  }
})

pspConversionsRouter.get('/:id', async (req, res, next) => {
  try {
    if (!/^[a-f0-9-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: '任务 ID 无效' })
    const job = await getPspConversion(req.params.id)
    if (!job) return res.status(404).json({ error: '转换任务不存在' })
    res.json(job)
  } catch (error) {
    next(error)
  }
})

pspConversionsRouter.post('/:id/retry', async (req, res, next) => {
  try {
    if (!/^[a-f0-9-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: '任务 ID 无效' })
    const job = await retryPspConversion(req.params.id)
    if (!job) return res.status(404).json({ error: '转换任务不存在' })
    res.status(job.status === 'completed' ? 200 : 202).json(job)
  } catch (error) {
    if (Number(error?.status) >= 400 && Number(error?.status) < 600) {
      return res.status(Number(error.status)).json({ error: error.message })
    }
    next(error)
  }
})

