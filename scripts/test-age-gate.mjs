/**
 * 成人内容年龄验证的边界测试。
 *
 * 覆盖三件事：
 *   1. 生日边界 —— 重点防止「只减年份」造成生日未到也被提前放行；
 *   2. 数据库字段映射 —— games.adult 和 users.birth_date 两条；
 *   3. GET /api/games/:slug/access 的放行判定 —— 登录 / 填出生日期 / 未成年 / 放行四种情形。
 *
 * 不再需要 esbuild：年龄算法本体已经搬到 shared/age.js（前后端共用），直接 import 就能跑，
 * 所以这个测试在 Linux 侧也能跑起来，不用非得回 macOS。
 */
import assert from 'node:assert/strict'
import {
  ADULT_AGE,
  MIN_BIRTH_YEAR,
  checkAdultBirthDate,
  isAdultByBirthDate,
  localDateInputValue,
  parseBirthDate,
} from '../shared/age.js'
import { gameApiToPartialRow, gameApiToRow, gameRowToApi, userRowToPublic } from '../server/src/mappers.js'
import { adultAccessVerdict, dbFlag } from '../server/src/routes/games.js'

const today = new Date(2026, 7, 29, 12)

/* ---------------- 1. 生日边界 ---------------- */

assert.equal(ADULT_AGE, 18)
assert.equal(checkAdultBirthDate('2008-08-29', today), 'adult', '18 岁生日当天应放行')
assert.equal(checkAdultBirthDate('2008-08-30', today), 'underage', '生日只差一天仍未满 18 岁')
assert.equal(checkAdultBirthDate('2008-09-01', today), 'underage', '生日在本月晚些时候，年份差 18 也不能放行')
assert.equal(checkAdultBirthDate('2000-01-01', today), 'adult')
assert.equal(checkAdultBirthDate('2020-01-01', today), 'underage')
assert.equal(checkAdultBirthDate('2027-01-01', today), 'invalid', '未来日期无效')
assert.equal(checkAdultBirthDate('2000-02-30', today), 'invalid', '不存在的日期无效')
assert.equal(checkAdultBirthDate('', today), 'invalid')
assert.equal(checkAdultBirthDate(null, today), 'invalid')
// 年份多敲一位是 <input type="date"> 上最常见的手滑，而这里填一次就锁定，必须当场拦下
assert.equal(checkAdultBirthDate(`${MIN_BIRTH_YEAR - 1}-12-31`, today), 'invalid', '1900 年之前一律当作填错')
assert.equal(checkAdultBirthDate('0200-01-01', today), 'invalid')
assert.equal(localDateInputValue(today), '2026-08-29')
assert.deepEqual(parseBirthDate('2008-08-29'), { year: 2008, month: 8, day: 29 })
assert.equal(parseBirthDate('2008-8-9'), null, '必须是零填充的 YYYY-MM-DD')

// 闰日：2 月 29 日出生的人，在平年应该在 3 月 1 日之前就满 18（2 月 28 日仍未满）
assert.equal(checkAdultBirthDate('2008-02-29', new Date(2026, 1, 28, 12)), 'underage')
assert.equal(checkAdultBirthDate('2008-02-29', new Date(2026, 2, 1, 12)), 'adult')

assert.equal(isAdultByBirthDate(null), false, '没填过出生日期一律不算成年')
assert.equal(isAdultByBirthDate(''), false)
assert.equal(isAdultByBirthDate('2020-01-01', today), false)
assert.equal(isAdultByBirthDate('2000-01-01', today), true)

/* ---------------- 2. 数据库字段映射 ---------------- */

assert.equal(gameRowToApi({ slug: 'x', adult: 1 }).adult, true)
assert.equal(gameRowToApi({ slug: 'x', adult: 0 }).adult, false)
assert.equal(gameApiToRow({ slug: 'x', adult: true }).adult, 1)
assert.deepEqual(gameApiToPartialRow({ adult: false }), { adult: 0 })

// /:slug/access 曾用查询串专用的 truthy() 判数据库布尔列，mysql2 回的 1 被判成 false，
// 前端拿到 adult:false 就把年龄门整个撤掉了。
assert.equal(dbFlag(1), true, 'tinyint(1) 的 1 必须判成真')
assert.equal(dbFlag(true), true)
assert.equal(dbFlag('1'), true)
assert.equal(dbFlag(0), false)
assert.equal(dbFlag(null), false)
assert.equal(dbFlag(undefined), false)

// users.birth_date -> 对外的 birthDate / adultVerified
const baseRow = { id: 'u1', email: 'a@b.c', nickname: 'n', coins: 0, role: 'user', status: 'active', created_at: '2026-01-01' }
assert.equal(userRowToPublic({ ...baseRow }).birthDate, null, '老库还没跑 migrate 时当作没填，不能报错')
assert.equal(userRowToPublic({ ...baseRow }).adultVerified, false)
assert.equal(userRowToPublic({ ...baseRow, birth_date: null }).adultVerified, false)
assert.equal(userRowToPublic({ ...baseRow, birth_date: '2000-01-01' }).birthDate, '2000-01-01')
assert.equal(userRowToPublic({ ...baseRow, birth_date: '2000-01-01' }).adultVerified, true)
assert.equal(userRowToPublic({ ...baseRow, birth_date: '2020-01-01' }).adultVerified, false)
// mysql2 的 DATE 列读出来是 JS Date，不能被 toISOString 的 UTC 偏移挪掉一天
assert.equal(userRowToPublic({ ...baseRow, birth_date: new Date(2000, 0, 1, 0, 0, 0) }).birthDate, '2000-01-01')

/* ---------------- 3. access 接口的放行判定 ---------------- */

// 非成人游戏：谁都能玩，不问登录也不问出生日期
assert.deepEqual(adultAccessVerdict(false, undefined), { adult: false, allowed: true, reason: null })
assert.deepEqual(adultAccessVerdict(false, { birth_date: null }), { adult: false, allowed: true, reason: null })

// 成人游戏的四种情形
assert.deepEqual(adultAccessVerdict(true, undefined), { adult: true, allowed: false, reason: 'login' }, '没登录必须先登录')
assert.deepEqual(adultAccessVerdict(true, { birth_date: null }), { adult: true, allowed: false, reason: 'birthDate' })
assert.deepEqual(adultAccessVerdict(true, { birth_date: '2020-01-01' }), { adult: true, allowed: false, reason: 'underage' })
assert.deepEqual(adultAccessVerdict(true, { birth_date: '2000-01-01' }), { adult: true, allowed: true, reason: null })
// 空串 / 0 这类假值不能被当成「填过了」
assert.equal(adultAccessVerdict(true, { birth_date: '' }).reason, 'birthDate')

console.log('成人内容年龄验证测试通过：生日边界（含闰日 / 年份下限）/ 数据库字段映射 / access 四种放行情形')
