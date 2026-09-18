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
  /*
    空闲连接保活。

    池子里的连接平时是**空着**的，而空闲的 TCP 连接会被两边先后收掉：MySQL 自己的
    wait_timeout 默认 8 小时，云主机的 NAT / 安全组往往几十分钟就悄悄清掉会话。
    问题是**连接对象自己不知道**，池仍然认为它是好的，下一个请求撞上去就得先等一次
    TCP 重传超时才失败重连（表现为「偶尔有一条接口特别慢，然后自己好了」）。
    开了 keepAlive 之后内核会定期发探测包，中间设备不会把这条连接当作僵死会话，
    也就省掉了重建连接那一次三次握手 + 认证。
  */
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
  /*
    连不上的时候**多久放弃**。写出来（而不是吃默认值）是为了让「数据库挂了」有一个
    自己说了算的失败时间：默认 10 秒能覆盖本机与同机房，同时不会让请求无限期挂着
    —— 挂着的那条会一直占着 Express 的连接不放。
  */
  connectTimeout: 10_000,
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

/**
 * 把一个成员名拼成 MySQL 的 JSON 路径表达式，**带双引号**。
 *
 * ## 这是 2026-09-07 一条线上故障的修复
 *
 * 原来三处调用点都直接写 `` `$.${lang}` ``。对 `en` / `es` / `fr` / `it` / `de` / `ja`
 * 完全正常，所以一直没人发现 —— 但 `zh-Hant` 里有个连字符：
 *
 *     mysql> SELECT JSON_SET('{}', '$.zh-Hant', '合金彈頭');
 *     ERROR 3143 (42000): Invalid JSON path expression. The error is around character position 9.
 *
 * MySQL 的路径里，成员名**只有在它是合法 ECMAScript 标识符时**才能裸写；
 * 带连字符（还有空格、点、数字开头…）的必须加双引号：`$."zh-Hant"`。
 *
 * 后果是繁体中文的译文缓存**从来没写进去过一次**：每次都抛 ER_INVALID_JSON_PATH。
 * 站点八种语言里只有 zh-Hans / zh-Hant 带连字符，而 zh-Hans 是源文不需要写 ——
 * 于是恰好只有繁体全军覆没，而且失败被调用方吞掉了，日志里看不出来。
 *
 * ## 为什么一律加引号，而不是「需要时才加」
 *
 * `$."en"` 和 `$.en` 在 MySQL 里等价，都合法。判断「这个名字要不要引号」需要实现一遍
 * ECMAScript 标识符的规则（还得考虑 Unicode），而那正是最初出错的那类聪明写法。
 * 无条件加引号是**一种写法应付所有情况**，读代码的人也不用再想一遍。
 *
 * @param {string} name 成员名（本仓库里都是语言代码）
 * @returns {string} 形如 `$."zh-Hant"`
 */
export function jsonMemberPath(name) {
  const raw = String(name ?? '')
  if (!raw) throw new Error('JSON 路径的成员名不能为空')
  // 调用方通常已经用更严的正则校验过 lang 了，这里是这个函数自己的兜底 ——
  // 它不该依赖调用方做对，否则换个调用方就又是一个注入点
  if (/[\u0000-\u001f]/.test(raw)) throw new Error('JSON 路径的成员名不能含控制字符')
  const escaped = raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `$."${escaped}"`
}
