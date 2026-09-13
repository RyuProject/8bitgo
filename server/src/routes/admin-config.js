/**
 * `GET /api/admin/config` —— 后台「当前生效配置」那一页的数据。
 *
 * **只读，而且永远只读。** 为什么不做成可写，见 config-manifest.js 的文件头。
 *
 * ## 为什么用 requireAdmin 而不是 requireAbility('site:manage')
 *
 * 今天 site:manage 只给 admin（shared/roles.js 的 ROLE_ABILITIES），所以两者等价。
 * 但这一页回的是基础设施信息 + 密钥指纹，而 ROLE_ABILITIES 是一张**会被改**的表 ——
 * 哪天有人想「让运营也能管 ROM 存储」，把 site:manage 放给 volunteer，
 * 这一页会**跟着**一起放开，而改表的人根本不会想到这里。
 * 权限点是给业务用的，基础设施这一页直接钉死在 admin 上，不参与那张表的演化。
 */
import { Router } from 'express'
import { requireAdmin } from '../auth.js'
import { effectiveConfig, configChecks, configDigest } from '../config-report.js'

export const adminConfigRouter = Router()

adminConfigRouter.get('/', requireAdmin, (_req, res) => {
  /*
    ⚠️ 这一条**必须** no-store。

    /api 全局默认就是 no-store（index.js 的 app.use('/api', noStore)），这里再写一遍
    不是冗余 —— 是因为将来有人给某个 /api/admin 子路径开了缓存时，
    这一条会跟着被缓存，而它带着密钥指纹和整份基础设施配置。
    显式写死，比依赖上游的默认值安全。
  */
  res.set('Cache-Control', 'private, no-store')
  res.json({
    ...effectiveConfig(process.env),
    checks: configChecks(process.env),
    digest: configDigest(process.env),
    /** 进程起来多久了。看到告警时第一个要问的就是「改完重启了吗」 */
    uptimeSec: Math.floor(process.uptime()),
    nodeVersion: process.version,
    generatedAt: new Date().toISOString(),
  })
})
