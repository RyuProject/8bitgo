/**
 * 建库建表：读取 schema.sql 并执行。
 * 用法：cd server && npm run migrate
 * 需要 .env 里的 DB_* 有建库权限（root 或有 CREATE 权限的账号）。
 */
import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'

const schemaPath = fileURLToPath(new URL('../schema.sql', import.meta.url))
const sql = await readFile(schemaPath, 'utf8')

// 不指定 database，让 CREATE DATABASE / USE 生效；开启多语句
const conn = await mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  multipleStatements: true,
})

try {
  await conn.query(sql)
  console.log('✅ 建库建表完成（schema.sql 已执行）')
} catch (e) {
  console.error('❌ 迁移失败：', e.message)
  process.exitCode = 1
} finally {
  await conn.end()
}
