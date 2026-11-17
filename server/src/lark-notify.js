/**
 * 飞书 / Lark 自定义机器人告警（webhook）。
 *
 * 为什么（2026-11-17 全站 EmulatorJS 事故）：所有 EmulatorJS 游戏打不开了几个小时，没有任何人被通知 ——
 * 启动失败聚集报警只会发邮件，而生产上 DIAG_ALERT_EMAIL 根本没配。飞书群消息是运营能第一时间看到的渠道。
 *
 * 用在：
 *   - diag-alert.js：真实玩家的启动失败按特征聚集；
 *   - server/scripts/notify-lark.mjs：给 shell 用（部署失败 / 回滚、定时开局巡检、看门狗重启）。
 *
 * 配置（server/.env，不进 git —— webhook 地址本身就是发消息的口令）：
 *   ALERT_LARK_WEBHOOK   https://open.larksuite.com/open-apis/bot/v2/hook/<token>（或 open.feishu.cn）
 *   ALERT_LARK_SECRET    可选：机器人开了「签名校验」时填，按飞书文档算 timestamp + sign
 *
 * 任何失败只抛给调用方处理（调用方都是「报警是锦上添花」的语义，自己吞掉）；这里不重试，免得刷屏。
 */
import { createHmac } from 'node:crypto'

/** 只接受飞书 / Lark 官方的机器人 webhook 地址：配置写错时别把告警（含内部信息）发到别处去 */
const WEBHOOK_RE = /^https:\/\/open\.(?:larksuite\.com|feishu\.cn)\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]{8,128}$/

export function larkConfig(env = process.env) {
  const webhook = String(env.ALERT_LARK_WEBHOOK || '').trim()
  return {
    webhook: WEBHOOK_RE.test(webhook) ? webhook : '',
    invalid: Boolean(webhook) && !WEBHOOK_RE.test(webhook),
    secret: String(env.ALERT_LARK_SECRET || '').trim(),
  }
}

/** 飞书签名：以 `timestamp + "\n" + secret` 为 key，对空串做 HmacSHA256，再 base64 */
export function larkSign(timestampSeconds, secret) {
  return createHmac('sha256', `${timestampSeconds}\n${secret}`).update('').digest('base64')
}

/** 单条消息上限：飞书文本消息约 30KB，留足余量，也避免把整份日志贴进群里 */
const MAX_TEXT = 4000

export function buildLarkPayload({ title, text }, { secret = '', now = Date.now() } = {}) {
  const body = [title ? `【8BitGo】${title}` : '【8BitGo】', text || ''].filter(Boolean).join('\n')
  const payload = {
    msg_type: 'text',
    content: { text: body.length > MAX_TEXT ? `${body.slice(0, MAX_TEXT)}\n…（已截断）` : body },
  }
  if (secret) {
    const timestamp = String(Math.floor(now / 1000))
    payload.timestamp = timestamp
    payload.sign = larkSign(timestamp, secret)
  }
  return payload
}

/**
 * 发一条文本消息。成功返回 true；未配置返回 false；发送失败抛错（带飞书返回的 code / msg）。
 * @param {{ title?: string, text?: string }} message
 * @param {{ config?: ReturnType<typeof larkConfig>, fetchImpl?: typeof fetch, now?: number, timeoutMs?: number }} [deps]
 */
export async function sendLark(message, deps = {}) {
  const cfg = deps.config ?? larkConfig()
  if (cfg.invalid) throw new Error('ALERT_LARK_WEBHOOK 不是飞书 / Lark 官方机器人地址，已拒绝发送')
  if (!cfg.webhook) return false
  const fetchImpl = deps.fetchImpl ?? fetch
  const res = await fetchImpl(cfg.webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(buildLarkPayload(message, { secret: cfg.secret, now: deps.now })),
    signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  // 飞书成功是 HTTP 200 + {code:0}；老接口是 {StatusCode:0}。签名错 19021、关键词不匹配 19024、频率限制 9499
  const code = data?.code ?? data?.StatusCode
  if (!res.ok || (code !== undefined && code !== 0)) {
    throw new Error(`飞书机器人返回 HTTP ${res.status}，code=${code ?? '?'}，${data?.msg ?? data?.StatusMessage ?? ''}`.trim())
  }
  return true
}
