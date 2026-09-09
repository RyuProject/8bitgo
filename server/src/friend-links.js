/**
 * 首页「特别鸣谢」友情链接的数据层。
 *
 * 前台只读已启用的条目，并按 sort_order + id 保持稳定顺序；后台读全量，
 * 这样临时停用的链接不会从管理页消失，也不需要删掉后重建。
 */
import { query, queryOne } from './db.js'

function rowToApi(row) {
  return {
    id: Number(row.id),
    name: row.name,
    url: row.url,
    image: row.image || '',
    sortOrder: Number(row.sort_order) || 0,
    enabled: Boolean(Number(row.enabled)),
  }
}

/** 首页 SSR 用的公开列表；没有后台字段，也不会带停用项。 */
export async function listPublicFriendLinks() {
  const rows = await query(
    'SELECT id, name, url, image, sort_order, enabled FROM friend_links WHERE enabled = 1 ORDER BY sort_order ASC, id ASC',
  )
  return rows.map(rowToApi)
}

/** 后台管理列表。 */
export async function listAdminFriendLinks() {
  const rows = await query(
    'SELECT id, name, url, image, sort_order, enabled FROM friend_links ORDER BY sort_order ASC, id ASC',
  )
  return rows.map(rowToApi)
}

export async function createFriendLink({ name, url, image, sortOrder, enabled }) {
  const result = await query(
    'INSERT INTO friend_links (name, url, image, sort_order, enabled) VALUES (?, ?, ?, ?, ?)',
    [name, url, image, sortOrder, enabled ? 1 : 0],
  )
  return getFriendLink(result.insertId)
}

export async function updateFriendLink(id, { name, url, image, sortOrder, enabled }) {
  const result = await query(
    'UPDATE friend_links SET name = ?, url = ?, image = ?, sort_order = ?, enabled = ? WHERE id = ?',
    [name, url, image, sortOrder, enabled ? 1 : 0, id],
  )
  if (!Number(result.affectedRows)) return null
  return getFriendLink(id)
}

export async function deleteFriendLink(id) {
  const result = await query('DELETE FROM friend_links WHERE id = ?', [id])
  return Number(result.affectedRows) > 0
}

async function getFriendLink(id) {
  const row = await queryOne(
    'SELECT id, name, url, image, sort_order, enabled FROM friend_links WHERE id = ?',
    [id],
  )
  return row ? rowToApi(row) : null
}
