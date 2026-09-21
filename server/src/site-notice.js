/**
 * 公告条的读写用例（不含 HTTP）。
 *
 * 单独一层是为了让 `content.js`（首页数据）和路由都能用同一份逻辑：
 * 「库里那一份」→「要不要显示、显示什么」这件事只能有一处实现，
 * 否则首页和接口迟早会给出两种答案（一个显示、一个不显示）。
 * 形状与清洗规则在 shared/site-notice.js。
 */
import { SITE_NOTICE_KEY, getSiteSetting, setSiteSetting } from './site-settings.js'
import { sanitizeNotice, visibleNotice } from '../../shared/site-notice.js'

/** 库里那一份（原始形状；可能是坏值、也可能没有） */
export async function readStoredNotice() {
  const raw = await getSiteSetting(SITE_NOTICE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    // 手工改库 / 旧版本写坏的值：说一句，前台按「没有公告」处理
    console.warn(`[site-notice] ${SITE_NOTICE_KEY} 不是合法 JSON，按没有公告处理`)
    return null
  }
}

/**
 * 同上，但**连查询失败也吞掉**。
 *
 * 「先上代码、后跑迁移」在这个仓库里是常态（见 content.js 里那两处注释）：
 * 表还不存在时，首页该做的是「没有公告」，而不是整页 500。
 * ⚠️ 只有**读取**这么宽容 —— 后台保存会把真实错误抛出去，那时管理员正看着屏幕。
 */
export async function readStoredNoticeSoft() {
  try {
    return await readStoredNotice()
  } catch (e) {
    console.warn('[site-notice] 读取失败，按没有公告处理：', e?.message || e)
    return null
  }
}

/** 前台要画的那一份：不可见时是 null（首页数据里带的就是它） */
export async function loadVisibleNotice() {
  return visibleNotice(await readStoredNoticeSoft())
}

/** 后台保存。回存下来的那一份（编辑器拿它更新本地状态） */
export async function saveNotice(input) {
  const value = sanitizeNotice(input)
  await setSiteSetting(SITE_NOTICE_KEY, JSON.stringify(value))
  return value
}
