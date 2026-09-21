/**
 * 站点级设置的键值读写（表 `site_settings`）。
 *
 * ## 为什么是「库里的键值对」而不是 .env
 *
 * `config-manifest.js` 那页（后台「配置」）是**只读**的，而且该一直只读 ——
 * 它回的是基础设施信息和密钥指纹，不该跟着一张会被运营改的表一起演化。
 * 但「公告条写什么」这类东西必须能热改，不能每次都 ssh 上去改 .env 再重启。
 * 那张文件的注释里给的出路就是这张表：**env 提供默认、库只做覆盖**。
 * 这里只做后半句 —— 目前没有任何 env 默认值，读不到就是「没配」。
 *
 * ## 值为什么统一是字符串
 *
 * 存 JSON 文本（`{"level":"warn","text":"…","enabled":true}`）。键值表只认「一列文本」，
 * 形状校验交给 shared/site-notice.js 那份纯函数 —— 表这边不该知道公告有几个字段。
 */
import { query } from './db.js'

/** 公告条用的那一格。要在两个地方写，所以给它一个常量而不是散落的字面量 */
export const SITE_NOTICE_KEY = 'notice'

/** 读一格。没有返回 null（不是空串：空串是「有这一行、值是空的」） */
export async function getSiteSetting(name) {
  const rows = await query('SELECT value FROM site_settings WHERE name = ? LIMIT 1', [String(name)])
  return rows?.[0]?.value ?? null
}

/** 写一格（存在就覆盖） */
export async function setSiteSetting(name, value) {
  await query(
    `INSERT INTO site_settings (name, value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value)`,
    [String(name), String(value)],
  )
}
