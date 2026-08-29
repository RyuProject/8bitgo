/** 成人游戏年龄门的边界测试：重点防止“只减年份”造成生日未到也被提前放行。 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { gameApiToPartialRow, gameApiToRow, gameRowToApi } from '../server/src/mappers.js'

const temp = await mkdtemp(path.join(tmpdir(), '8bitgo-age-gate-'))
try {
  const outfile = path.join(temp, 'age.mjs')
  await build({
    entryPoints: [path.resolve('src/lib/age.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'silent',
  })
  const { checkAdultBirthDate, localDateInputValue } = await import(`${pathToFileURL(outfile).href}?${Date.now()}`)
  const today = new Date(2026, 7, 29, 12)

  assert.equal(checkAdultBirthDate('2008-08-29', today), 'adult', '18 岁生日当天应放行')
  assert.equal(checkAdultBirthDate('2008-08-30', today), 'underage', '生日只差一天仍未满 18 岁')
  assert.equal(checkAdultBirthDate('2000-01-01', today), 'adult')
  assert.equal(checkAdultBirthDate('2020-01-01', today), 'underage')
  assert.equal(checkAdultBirthDate('2027-01-01', today), 'invalid', '未来日期无效')
  assert.equal(checkAdultBirthDate('2000-02-30', today), 'invalid', '不存在的日期无效')
  assert.equal(checkAdultBirthDate('', today), 'invalid')
  assert.equal(localDateInputValue(today), '2026-08-29')

  assert.equal(gameRowToApi({ slug: 'x', adult: 1 }).adult, true)
  assert.equal(gameRowToApi({ slug: 'x', adult: 0 }).adult, false)
  assert.equal(gameApiToRow({ slug: 'x', adult: true }).adult, 1)
  assert.deepEqual(gameApiToPartialRow({ adult: false }), { adult: 0 })

  console.log('成人游戏年龄验证测试通过：生日边界 / 非法日期 / 数据库字段映射')
} finally {
  await rm(temp, { recursive: true, force: true })
}
