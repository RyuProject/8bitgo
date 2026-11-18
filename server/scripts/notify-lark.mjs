#!/usr/bin/env node
/**
 * 给 shell 用的飞书告警入口（部署失败 / 回滚、定时开局巡检、看门狗重启都调它）。
 *
 *   node server/scripts/notify-lark.mjs --title "部署失败" --text "……"
 *   node server/scripts/notify-lark.mjs --title "…" --text - < body.txt          正文从 stdin 读
 *   node server/scripts/notify-lark.mjs --dedupe smoke-down --cooldown 7200 …    同一个 key 两小时内只发一次
 *   node server/scripts/notify-lark.mjs --clear smoke-down                       故障恢复：清掉去重记录，下次故障立刻报
 *   node server/scripts/notify-lark.mjs --test                                   发一条测试消息（配置验收用）
 *
 * webhook 从环境变量 ALERT_LARK_WEBHOOK 读；没有就读 server/.env（systemd 跑的看门狗 / 巡检拿不到 Node 进程的环境）。
 * 默认**永远退出 0**：告警是锦上添花，发不出去不能让部署脚本、看门狗跟着失败。`--strict` 时失败退出 1（验收用）。
 * 去重记录在 ALERT_STATE_DIR（默认 /var/lib/8bitgo/alerts），只在发送成功后写。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { larkConfig, sendLark } from '../src/lark-notify.js'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name, fallback = '') => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const strict = flag('--strict')
const done = (code, line) => {
  if (line) (code ? console.error : console.log)(line)
  process.exit(strict ? code : 0)
}

if (!process.env.ALERT_LARK_WEBHOOK) {
  const envFile = join(dirname(fileURLToPath(import.meta.url)), '..', '.env')
  try {
    if (existsSync(envFile)) process.loadEnvFile(envFile)
  } catch {
    // .env 解析不了就当没配置
  }
}

const stateDir = process.env.ALERT_STATE_DIR || '/var/lib/8bitgo/alerts'
const keyFile = (key) => join(stateDir, `${String(key).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)}.last`)

const clearKey = opt('--clear')
if (clearKey) {
  rmSync(keyFile(clearKey), { force: true })
  done(0)
}

const isTest = flag('--test')
let title = isTest ? '告警通道测试' : opt('--title')
let text = isTest
  ? '这是一条配置验收消息：部署失败 / 回滚、定时开局巡检失败、玩家启动失败聚集、看门狗重启时，都会发到这个群。'
  : opt('--text')
if (text === '-') text = readFileSync(0, 'utf8')
if (!title && !text) done(1, '用法：notify-lark.mjs --title <标题> --text <正文|-> [--dedupe <key> --cooldown <秒>] | --clear <key> | --test')

const dedupe = opt('--dedupe')
const cooldownSec = Number(opt('--cooldown', '1800')) || 1800
if (dedupe) {
  try {
    const last = Number(readFileSync(keyFile(dedupe), 'utf8'))
    if (Number.isFinite(last) && Date.now() - last < cooldownSec * 1000) done(0, `[notify-lark] ${dedupe} 在冷却期内，这次不发`)
  } catch {
    // 没有记录 = 没发过
  }
}

const stamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
text = `${String(text || '').trim()}\n\n时间：${stamp}（北京时间）· 主机：${hostname()}`

const cfg = larkConfig()
if (!cfg.webhook) done(1, cfg.invalid ? '[notify-lark] ALERT_LARK_WEBHOOK 不是飞书官方机器人地址，没发' : '[notify-lark] 没配 ALERT_LARK_WEBHOOK，没发')

try {
  await sendLark({ title, text }, { config: cfg })
  if (dedupe) {
    try {
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(keyFile(dedupe), String(Date.now()))
    } catch {
      // 写不了去重记录只会多发，不影响这一条
    }
  }
  done(0, `[notify-lark] 已发送：${title}`)
} catch (error) {
  done(1, `[notify-lark] 发送失败：${error?.message || error}`)
}
