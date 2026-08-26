/**
 * 数据库连接自测：读取 server/.env 里的 DB_* 配置，连库并打印结果（只读，不改数据）。
 * 用法：cd server && npm install && cp .env.example .env  （填好 DB_PASSWORD 等）
 *       npm run test:db
 * 与 MySQL 同机时 .env 里 DB_HOST 用 127.0.0.1。
 */
import 'dotenv/config'
import mysql from 'mysql2/promise'

const cfg = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  connectTimeout: 10000,
}
const dbName = process.env.DB_NAME || '8bitgo'

console.log(`\n正在连接  ${cfg.user}@${cfg.host}:${cfg.port} …\n`)
const t = Date.now()

try {
  const c = await mysql.createConnection(cfg)
  const [[v]] = await c.query('SELECT VERSION() AS v, NOW() AS now')
  console.log(`✅ 连接成功（${Date.now() - t} ms）`)
  console.log('   MySQL 版本:', v.v)
  console.log('   服务器时间:', v.now)

  const [dbs] = await c.query('SHOW DATABASES')
  console.log('   全部数据库:', dbs.map((r) => Object.values(r)[0]).join(', '))

  const [has] = await c.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [dbName])
  if (has.length) {
    const [tables] = await c.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [dbName])
    const names = tables.map((r) => Object.values(r)[0])
    console.log(`   「${dbName}」库: 存在，表 ${names.length} 张${names.length ? '：' + names.join(', ') : '（空，请先 npm run migrate）'}`)
    for (const t of ['games', 'posts', 'users']) {
      if (names.includes(t)) {
        const [[cnt]] = await c.query(`SELECT COUNT(*) AS n FROM \`${dbName}\`.\`${t}\``)
        console.log(`     - ${t}: ${cnt.n} 行`)
      }
    }
  } else {
    console.log(`   「${dbName}」库: 不存在 —— 跑 npm run migrate 建库建表，再 npm run seed 导入内置数据`)
  }

  await c.end()
  console.log('\n✅ 数据库测试完成\n')
} catch (e) {
  console.error(`\n❌ 连接失败（${Date.now() - t} ms）：`, e.code || '', e.message)
  console.error('\n排查建议：')
  console.error('  1) 账号 / 密码是否正确（.env 里的 DB_USER / DB_PASSWORD）')
  console.error('  2) 与 MySQL 同机运行请把 DB_HOST 设为 127.0.0.1')
  console.error('  3) 从别的机器连：需要 MySQL 监听公网（bind-address=0.0.0.0）、防火墙/安全组放行该机器 IP 的 3306，且该账号允许从该主机登录')
  console.error('  4) ETIMEDOUT 通常是网络/防火墙不通；ER_ACCESS_DENIED 是账号密码或授权主机不对\n')
  process.exit(1)
}
