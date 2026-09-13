/**
 * 开放平台沙箱 ROM 样本：每个平台至多一款，由站长挑选。
 *
 * 不能让每个应用自己挑一款：同一个人反复建应用，就能把「每机型一款」
 * 拼成整库下载。样本是全站共用的，且只选确认可供第三方测试的内容。
 */
import { query, queryOne } from '../db.js'
import { isPlatformEnabledId } from '../../../shared/site-taxonomy.js'
import { parseScopes } from './scopes.js'

/** 令牌有 scope 只是第一道门；应用状态和当前审批结果每次领票都重新核对。 */
export async function romAccessForApp(appId) {
  const app = await queryOne(
    'SELECT status, approved_scopes, requested_scopes FROM oauth_apps WHERE id = ?',
    [String(appId)],
  )
  if (!app) return null
  if (app.status === 'live' && parseScopes(app.approved_scopes).scopes.includes('games.rom')) return 'live'
  if (app.status === 'sandbox' && parseScopes(app.requested_scopes).scopes.includes('games.rom')) return 'sandbox'
  return null
}

/** 公共目录只露平台、slug 和标题，不露对象 key。 */
export async function listSandboxRomSamples() {
  const rows = await query(
    `SELECT s.platform, g.slug, g.title
       FROM open_rom_samples s JOIN games g ON g.id = s.game_id
      WHERE g.platform = s.platform AND g.hidden = 0 AND g.adult = 0
        AND EXISTS (SELECT 1 FROM game_roms gr WHERE gr.game_id = g.id)
      ORDER BY s.platform`,
  )
  return rows.filter((row) => isPlatformEnabledId(row.platform))
}

/** 样本在领取凭据时仍须是当前平台的那一款。 */
export async function isSandboxRomSample(game) {
  if (!isPlatformEnabledId(game.platform)) return false
  const row = await queryOne(
    'SELECT 1 AS ok FROM open_rom_samples WHERE platform = ? AND game_id = ?',
    [String(game.platform), game.id],
  )
  return Boolean(row)
}

/**
 * 兑换时再查一次：站长撤换样本、解绑 ROM 或下架游戏后，旧票不能继续兑现。
 * 查询用完整对象 key 只在服务器内部比较，不发给调用方。
 */
export async function canRedeemSandboxRom({ slug, key }) {
  const row = await queryOne(
    `SELECT s.platform
       FROM open_rom_samples s
       JOIN games g ON g.id = s.game_id AND g.platform = s.platform
       JOIN game_roms gr ON gr.game_id = g.id
      WHERE g.slug = ? AND g.hidden = 0 AND g.adult = 0 AND gr.object_key = ? LIMIT 1`,
    [String(slug), String(key)],
  )
  return Boolean(row && isPlatformEnabledId(row.platform))
}

/** 后台设样本：主键是 platform，数据库天然挡住每平台配置两款。 */
export async function setSandboxRomSample(platform, slug) {
  if (!slug) {
    await query('DELETE FROM open_rom_samples WHERE platform = ?', [platform])
    return
  }
  const game = await queryOne(
    `SELECT g.id
       FROM games g
      WHERE g.slug = ? AND g.platform = ? AND g.hidden = 0 AND g.adult = 0
        AND EXISTS (SELECT 1 FROM game_roms gr WHERE gr.game_id = g.id)
      LIMIT 1`,
    [slug, platform],
  )
  if (!game) {
    const error = new Error('找不到该平台已上架、非成人且绑定了 ROM 的游戏')
    error.code = 'invalid_rom_sample'
    throw error
  }
  await query(
    'INSERT INTO open_rom_samples (platform, game_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE game_id = VALUES(game_id)',
    [platform, game.id],
  )
}
