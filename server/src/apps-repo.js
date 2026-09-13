/**
 * 应用中心的数据层。一张表 `apps`，用 `kind` 区分三个模块：
 *   sdk       官方 SDK（Linux / ESP32 / Windows ……，平台名后台自由填）
 *   app       官方客户端 / APP 下载
 *   community 社区自建 APP（后台审核通过后上架的；访客的提交只发邮件，不直接落这个表）
 *
 * 列表只回 `published = 1` 的；后台管理能看到全部（含下架的）。
 */
import { query, queryOne } from './db.js'

export const APP_KINDS = ['sdk', 'app', 'community']

/** 前端字段名 -> 数据库列名。更新时只允许这里列出的字段，杜绝动态列名注入 */
const COLUMNS = {
  kind: 'kind',
  name: 'name',
  platform: 'platform',
  version: 'version',
  description: 'description',
  downloadUrl: 'download_url',
  icon: 'icon',
  sortOrder: 'sort_order',
  published: 'published',
  submitterName: 'submitter_name',
  submitterContact: 'submitter_contact',
}

const SELECT =
  'id, kind, name, platform, version, description, download_url, icon, sort_order, published, submitter_name, submitter_contact, created_at, updated_at'

export function listApps() {
  return query(`SELECT ${SELECT} FROM apps WHERE published = 1 ORDER BY kind, sort_order ASC, id DESC`)
}

export function listAllApps() {
  return query(`SELECT ${SELECT} FROM apps ORDER BY kind, sort_order ASC, id DESC`)
}

export function getApp(id) {
  return queryOne(`SELECT ${SELECT} FROM apps WHERE id = ?`, [id])
}

export async function createApp(value) {
  const r = await query(
    `INSERT INTO apps
       (kind, name, platform, version, description, download_url, icon, sort_order, published, submitter_name, submitter_contact)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      value.kind,
      value.name,
      value.platform || '',
      value.version || null,
      value.description || null,
      value.downloadUrl || null,
      value.icon || null,
      value.sortOrder || 0,
      value.published ? 1 : 0,
      value.submitterName || null,
      value.submitterContact || null,
    ],
  )
  return getApp(Number(r.insertId))
}

export function updateApp(id, value) {
  const sets = []
  const params = []
  for (const [field, column] of Object.entries(COLUMNS)) {
    if (!(field in value)) continue
    let v = value[field]
    if (field === 'published') v = v ? 1 : 0
    if (field === 'version' || field === 'description' || field === 'downloadUrl' || field === 'icon' || field === 'submitterName' || field === 'submitterContact') {
      if (v === '') v = null
    }
    sets.push(`\`${column}\` = ?`)
    params.push(v)
  }
  if (!sets.length) return getApp(id)
  params.push(id)
  return query(`UPDATE apps SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`, params).then(() => getApp(id))
}

export function deleteApp(id) {
  return query('DELETE FROM apps WHERE id = ?', [id])
}
