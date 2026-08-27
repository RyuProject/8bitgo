import mysql from 'mysql2/promise'

/**
 * MySQL 连接池。凭据全部来自环境变量（server/.env），不写死在代码里。
 * 与数据库同机时 DB_HOST 用 127.0.0.1，不依赖防火墙对外放行。
 */
export const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || '8bitgo',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
  // JSON 列自动解析为 JS 对象/数组
  typeCast: true,
})

/** 简单封装：查询并返回行数组 */
export async function query(sql, params) {
  const [rows] = await pool.query(sql, params)
  return rows
}

/** 查询单行（无则返回 undefined） */
export async function queryOne(sql, params) {
  const rows = await query(sql, params)
  return rows[0]
}

export async function ping() {
  const r = await queryOne('SELECT 1 AS ok')
  return r?.ok === 1
}

/**
 * 在一个事务里跑一组语句。
 * 传进去的 run 收到一条独占连接，用 run(sql, params) 发查询；
 * 抛异常自动回滚，正常返回自动提交，连接一定会还回池里。
 *
 * 用于「删游戏顺带清收藏/最近」「批量导入」这类必须整体成败的操作 ——
 * 以前是一条条裸发，中途报错就留下删了一半的数据。
 */
export async function withTransaction(fn) {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const run = async (sql, params) => {
      const [rows] = await conn.query(sql, params)
      return rows
    }
    const result = await fn(run)
    await conn.commit()
    return result
  } catch (e) {
    try {
      await conn.rollback()
    } catch {
      /* 回滚失败也要把连接还回去 */
    }
    throw e
  } finally {
    conn.release()
  }
}
