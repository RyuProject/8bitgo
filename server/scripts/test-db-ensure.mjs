/**
 * `src/db-ensure.js` 的自检。用假 conn，不需要真数据库。
 *
 * 守的是一件很具体的事：**只有全局 CREATE 权限的缺失，不该挡住迁移**。
 * 生产上的应用账号通常是 `GRANT ALL ON 某库.*`，没有全局权限，
 * 而 `CREATE DATABASE IF NOT EXISTS` 在库早就存在时是纯空转 ——
 * 却会让 migrate 第一句就 Access denied 退出，逼人去翻 root 口令。
 *
 * 用法：cd server && npm run test:db-ensure
 */
import assert from 'node:assert/strict'
import { ensureDatabase } from '../src/db-ensure.js'

let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ❌ ${name}\n     ${e.message}`)
  }
}

/** 假连接：按规则决定哪些语句成功，并记下都跑了什么 */
function fakeConn({ canCreate = true, canUse = true } = {}) {
  const log = []
  return {
    log,
    async query(sql) {
      log.push(sql)
      if (/^CREATE DATABASE/i.test(sql) && !canCreate) {
        const e = new Error("Access denied for user 'eightbitgo_app'@'localhost' to database 'eightbitgo'")
        e.code = 'ER_DBACCESS_DENIED_ERROR'
        throw e
      }
      if (/^USE /i.test(sql) && !canUse) {
        const e = new Error("Unknown database 'eightbitgo'")
        e.code = 'ER_BAD_DB_ERROR'
        throw e
      }
      return [[], []]
    },
  }
}

console.log('\n库的准备：不该为了一句空转的 CREATE DATABASE 去要 root')

await check('有全局 CREATE 权限时照旧建库并选中', async () => {
  const c = fakeConn()
  assert.equal(await ensureDatabase(c, 'eightbitgo'), 'created')
  assert.ok(/^CREATE DATABASE IF NOT EXISTS `eightbitgo`/.test(c.log[0]), '第一句不是建库')
  assert.ok(c.log.some((s) => s === 'USE `eightbitgo`'), '建完没选中这个库')
})

await check('⚠️ 没有全局 CREATE 但库已存在 -> 继续，不报错', async () => {
  const c = fakeConn({ canCreate: false, canUse: true })
  assert.equal(await ensureDatabase(c, 'eightbitgo'), 'no-create-privilege')
  assert.ok(c.log.some((s) => s === 'USE `eightbitgo`'), '没有选中这个库，后续 ALTER 会落到错的地方')
})

await check('⚠️ 建不了、也用不了 -> 报错，而且把两种原因都说清楚', async () => {
  const c = fakeConn({ canCreate: false, canUse: false })
  await assert.rejects(
    () => ensureDatabase(c, 'eightbitgo'),
    (e) => {
      assert.match(e.message, /全局 CREATE/, '没说「全新部署要用有全局 CREATE 的账号」')
      assert.match(e.message, /DB_NAME/, '没说「库已经有的话检查 DB_NAME / DB_USER」')
      assert.match(e.message, /Access denied/, '把原始错误吞了 —— 那是排查时最有用的一行')
      return true
    },
  )
})

await check('⚠️ 库名要过滤（这一句是拼串，不是占位符）', async () => {
  /*
    MySQL 的库名不能用 ? 绑定，所以这句是拼进 SQL 的。
    一个手滑写进 DB_NAME 的反引号就能把语句劈开。
  */
  for (const bad of ['a`b', 'a; DROP DATABASE x', 'a b', '', '  ', 'a-b']) {
    await assert.rejects(
      () => ensureDatabase(fakeConn(), bad),
      /DB_NAME 不合法/,
      `${JSON.stringify(bad)} 被当成了合法库名`,
    )
  }
  // 合法的别误伤
  for (const ok of ['eightbitgo', '8bitgo', 'my_db$2', 'A1']) {
    await assert.doesNotReject(() => ensureDatabase(fakeConn(), ok), `${ok} 被误判成非法`)
  }
})

await check('⚠️ 拒绝非法库名时一条 SQL 都不发出去', async () => {
  // 先拼再验的写法（先 query 再 throw）会把那条奇怪的 SQL 真的送到服务器
  const c = fakeConn()
  await assert.rejects(() => ensureDatabase(c, 'a`b'))
  assert.deepEqual(c.log, [], `拒绝之前已经发了 ${c.log.length} 条 SQL`)
})

console.log(failed ? `\n❌ ${failed} 条失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
