/**
 * 「确保库在、并选中它」。从 scripts/migrate.mjs 里抽出来，单独一个文件是为了**能测** ——
 * migrate.mjs 在模块顶层就连了真实数据库，import 它等于要一台 MySQL。
 *
 * ## 为什么值得单独一段
 *
 * 原来 migrate 第一句无条件执行 `CREATE DATABASE IF NOT EXISTS`。
 * 那句话在**库早就存在**的机器上是纯空转，却要求一个**全局** CREATE 权限 ——
 * 而生产上的应用账号通常只有 `GRANT ALL ON 某个库.*`，没有全局权限。
 *
 * 后果不是「少建一个库」，是**整个 migrate 第一句就 Access denied 退出**，
 * 于是每次加一张表都要去翻 root 口令。而「为了跑迁移用 root 连库」本身是个坏习惯：
 * 那条命令行会进 shell history，权限也远超实际需要。
 *
 * 所以：建不了就试试能不能用。能 `USE` 就说明库在、账号进得去，剩下的
 * CREATE TABLE / ALTER TABLE 都是**库级**权限，应用账号一般都有。
 */

/**
 * @param {{ query: (sql: string) => Promise<unknown> }} conn
 * @param {string} dbName
 * @returns {Promise<'created'|'existed'|'no-create-privilege'>}
 *   created             —— 真的建了（或 IF NOT EXISTS 顺利通过）
 *   no-create-privilege —— 没有全局 CREATE，但库在、能用。**这是正常情况，不是降级**
 */
export async function ensureDatabase(conn, dbName) {
  const name = String(dbName || '').trim()
  /*
    ⚠️ 库名拼进 SQL 前必须先过滤。它来自 .env，不是用户输入，但这一句是
    **拼串**而不是占位符（MySQL 的库名不能用 ? 绑定），所以一个手滑写进
    DB_NAME 的反引号就能把语句劈开。宁可在这里拒绝，也不要拼出一条奇怪的 SQL。
  */
  if (!/^[A-Za-z0-9_$]+$/.test(name)) {
    throw new Error(`DB_NAME 不合法：${JSON.stringify(dbName)}（只允许字母、数字、下划线、$）`)
  }

  let created = true
  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  } catch (e) {
    created = false
    /*
      ⚠️ 不要在这里按错误码分支（ER_DBACCESS_DENIED_ERROR / ER_ACCESS_DENIED_ERROR /
      不同版本还不一样）。真正要回答的问题只有一个：**这个库现在能不能用**。
      下面这句 USE 就是那个问题本身，比猜错误码可靠。
    */
    try {
      await conn.query(`USE \`${name}\``)
    } catch {
      // 建不了、也用不了 —— 这才是真的要更高权限
      throw new Error(
        `建不了库 \`${name}\`，也连不进去。原始错误：${e instanceof Error ? e.message : String(e)}\n` +
          `  · 库还不存在（全新部署）：这一次要用有全局 CREATE 权限的账号跑，比如\n` +
          `      DB_USER=root DB_PASSWORD='…' npm run migrate\n` +
          `  · 库已经有了：确认 DB_NAME / DB_USER 有没有写错，以及这个账号被授权的是不是这个库`,
      )
    }
  }

  await conn.query(`USE \`${name}\``)
  return created ? 'created' : 'no-create-privilege'
}
